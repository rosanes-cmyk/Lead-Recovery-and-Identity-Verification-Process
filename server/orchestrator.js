// The investigation engine. Runs one lead through the source pipeline, emits
// live progress, honors Start/Pause/Resume/Stop, enforces the time limit, then
// scores the findings, builds the report + note, and STOPS at approval.
//
// It never writes to any CRM. Approval/execution is handled by the server's
// approval endpoints, which refuse to act while the app is in dry-run mode.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { getPage, closeBrowser } from './browser.js'
import { sources } from './sources/index.js'
import { score } from './scoring.js'
import { buildNote, buildNextTask } from './note.js'
import { ensureRunDir, runDir, saveReport, newRunId } from './store.js'
import { runDemo } from './demo.js'

export class Investigation extends EventEmitter {
  constructor(input) {
    super()
    this.input = normalizeInput(input)
    this.runId = newRunId()
    this.type = this.input.enhanced ? 'Enhanced' : 'Standard'
    this.limitMin = this.input.enhanced ? config.enhancedLimitMin : config.standardLimitMin
    this.state = 'idle' // idle | running | paused | login | done | stopped | error
    this.startedAt = null
    this.log = []
    this.data = { input: this.input, crm: {}, ownership: {}, corroboration: {}, peoplesearch: {}, county: {}, google: {} }
    this.sourcesChecked = []
    this.evidence = []
    this.audit = []
    this.report = null
    this._abort = new AbortController()
    this._pauseGate = null // Promise resolved on resume
    this._resume = null
  }

  emit(ev) {
    const stamped = { ...ev, t: new Date().toISOString() }
    // Buffer every event EXCEPT the heavy 'report' payload, so a reconnecting
    // client can replay progress. Storing the report here would create a
    // circular reference (report.log -> this.log -> report).
    if (ev.type !== 'report') this.log.push(stamped)
    super.emit('event', stamped)
  }

  minutesUsed() {
    if (!this.startedAt) return 0
    return Math.round(((Date.now() - this.startedAt) / 60000) * 10) / 10
  }

  timeExceeded() {
    return this.minutesUsed() >= this.limitMin
  }

  pause() {
    if (this.state !== 'running') return
    this.state = 'paused'
    this._pauseGate = new Promise((res) => (this._resume = res))
    this.emit({ type: 'state', state: 'paused', message: 'Paused by operator.' })
  }

  resume() {
    if (this.state === 'paused' || this.state === 'login') {
      this.state = 'running'
      this.emit({ type: 'state', state: 'running', message: 'Resumed.' })
      this._resume?.()
      this._pauseGate = null
      this._resume = null
    }
  }

  stop() {
    if (['done', 'stopped', 'error'].includes(this.state)) return
    this.state = 'stopped'
    this._abort.abort()
    this._resume?.()
    this.emit({ type: 'state', state: 'stopped', message: 'Stopped by operator.' })
  }

  // Pause and ask the operator to log in; resolves when they hit Resume.
  async requireLogin(source) {
    this.state = 'login'
    this._pauseGate = new Promise((res) => (this._resume = res))
    this.emit({
      type: 'login-required',
      source,
      message: `Login required for ${source}. Log in in the browser window, then click Resume.`,
    })
    await this._pauseGate
  }

  async _waitIfPaused() {
    if (this._pauseGate) await this._pauseGate
  }

  async run() {
    this.state = 'running'
    this.startedAt = Date.now()
    ensureRunDir(this.runId)
    this.emit({ type: 'state', state: 'running', message: `Investigation started (${this.type}, limit ${this.limitMin} min).` })
    this.emit({ type: 'safety', safety: safetyLine() })

    if (config.demoMode) {
      this.emit({ type: 'log', message: 'DEMO MODE: using synthetic data, no real browser.' })
      return runDemo(this)
    }

    let page
    try {
      page = await getPage()
    } catch (err) {
      this.state = 'error'
      this.emit({ type: 'error', message: `Could not start browser: ${String(err)}` })
      return this.finalize('error')
    }

    for (const source of sources) {
      if (this.state === 'stopped') break
      if (this.timeExceeded()) {
        this.emit({ type: 'time-limit', message: `Time limit reached (${this.limitMin} min). Stopping and finalizing with what was found.` })
        break
      }
      await this._waitIfPaused()
      if (this.state === 'stopped') break

      this.emit({ type: 'source-start', source: source.label })
      let result
      try {
        result = await source.run({
          page,
          input: this.input,
          data: this.data,
          emit: (e) => this.emit(e),
          runDir: runDir(this.runId),
          signal: this._abort.signal,
        })
      } catch (err) {
        result = { source: source.label, ok: false, loginRequired: false, data: {}, evidence: [], notes: [`Unexpected error: ${String(err)}`] }
      }

      // Handle login-required: pause, let operator sign in, retry once.
      if (result.loginRequired && this.state !== 'stopped') {
        await this.requireLogin(source.label)
        if (this.state !== 'stopped') {
          try {
            result = await source.run({
              page, input: this.input, data: this.data,
              emit: (e) => this.emit(e), runDir: runDir(this.runId), signal: this._abort.signal,
            })
          } catch (err) {
            result.notes.push(`Retry after login failed: ${String(err)}`)
          }
        }
      }

      this._absorb(source, result)
      this.emit({
        type: 'source-done',
        source: source.label,
        ok: result.ok,
        notes: result.notes,
        evidenceCount: result.evidence?.length || 0,
      })
      saveReport(this.runId, this._draftReport()) // checkpoint after each source
    }

    return this.finalize(this.state === 'stopped' ? 'stopped' : 'done')
  }

  // Merge a source result into the consolidated data model.
  _absorb(source, result) {
    ;(result.evidence || []).forEach((e) => this.evidence.push({ ...e, source: source.label }))
    ;(result.audit || []).forEach((a) => this.audit.push({ source: source.label, ...a }))
    this.sourcesChecked.push({
      source: source.label,
      summary: result.ok ? 'checked' : (result.notes?.[0] || 'not available'),
      notes: result.notes || [],
    })
    const d = cleanFields(result.data || {})
    switch (source.id) {
      case 'reiblackbook':
        this.data.crm = { ...this.data.crm, ...d }
        break
      case 'propertyradar':
        this.data.ownership = {
          ...this.data.ownership,
          recordedOwner: d.ownerName || this.data.ownership.recordedOwner,
          ownershipType: d.ownershipType || this.data.ownership.ownershipType,
          vesting: d.vesting || this.data.ownership.vesting,
          mailingAddress: d.mailingAddress || this.data.ownership.mailingAddress,
          occupancy: d.occupancy || this.data.ownership.occupancy,
          apn: d.apn || this.data.ownership.apn,
          trustEntity: d.trustEntity || this.data.ownership.trustEntity,
          source: d.ownerName ? 'PropertyRadar' : this.data.ownership.source,
        }
        break
      case 'dealmachine':
        this.data.corroboration.dealmachine = d
        if (!this.data.ownership.recordedOwner && d.ownerName) {
          this.data.ownership.recordedOwner = d.ownerName
          this.data.ownership.source = 'DealMachine'
        }
        break
      case 'county':
        this.data.county = d
        // County is a strong ownership source; fill gaps.
        if (d.recordedOwner) {
          if (!this.data.ownership.recordedOwner) {
            this.data.ownership.recordedOwner = d.recordedOwner
            this.data.ownership.source = 'County Records'
          }
          this.data.ownership.apn = this.data.ownership.apn || d.apn
          this.data.ownership.vesting = this.data.ownership.vesting || d.vesting
          this.data.ownership.mailingAddress = this.data.ownership.mailingAddress || d.ownerMailingAddress
          this.data.ownership.documentNumber = d.documentNumber
          this.data.ownership.recordingDate = d.recordingDate
        }
        break
      case 'google':
        this.data.google = d
        break
      case 'peoplesearch':
        this.data.peoplesearch = d
        break
    }
  }

  _draftReport() {
    return {
      runId: this.runId,
      input: this.input,
      data: this.data,
      evidence: this.evidence,
      audit: this.audit,
      log: this.log,
      meta: this._meta(),
      state: this.state,
    }
  }

  // Persist the extraction audit trail as a JSONL file (one line per field).
  _writeAuditLog() {
    try {
      const dir = runDir(this.runId)
      const lines = this.audit.map((a) => JSON.stringify(a)).join('\n')
      fs.writeFileSync(path.join(dir, 'audit.jsonl'), lines + '\n')
      return path.join(dir, 'audit.jsonl')
    } catch {
      return ''
    }
  }

  _meta(extra = {}) {
    return {
      date: new Date().toISOString(),
      type: this.type,
      limitMin: this.limitMin,
      minutesUsed: this.minutesUsed(),
      sourcesChecked: this.sourcesChecked,
      timeExceeded: this.timeExceeded(),
      ...extra,
    }
  }

  finalize(finalState) {
    const scored = score(this.data)
    const dateChecked = new Date().toISOString().slice(0, 10)
    const auditLogPath = this._writeAuditLog()
    const meta = this._meta({
      dueDate: this.input.dueDate || '',
      dateChecked,
      auditLogPath,
      screenshotsDir: path.join(runDir(this.runId), 'evidence'),
      peopleSearchEnabled: config.peopleSearchEnabled,
    })
    const nextTask = buildNextTask(scored, meta)
    const report = {
      runId: this.runId,
      input: this.input,
      data: this.data,
      scored,
      nextTask,
      evidence: this.evidence,
      audit: this.audit,
      log: this.log,
      meta,
      state: finalState,
    }
    report.note = buildNote(report)
    this.report = report
    this.state = finalState === 'error' ? 'error' : finalState
    saveReport(this.runId, report)
    this.emit({
      type: 'report',
      state: this.state,
      message:
        finalState === 'stopped'
          ? 'Stopped. Report prepared from findings so far — review and approve.'
          : 'Investigation complete. Review the report and approve before any CRM change.',
      report,
    })
    return report
  }
}

function safetyLine() {
  return {
    dryRun: config.dryRun,
    liveMode: config.liveMode,
    message: config.dryRun || !config.liveMode
      ? 'DRY-RUN: research only. No CRM changes will be made.'
      : 'LIVE MODE ENABLED.',
  }
}

function normalizeInput(raw = {}) {
  const address = (raw.address || '').trim()
  return {
    reiLink: (raw.reiLink || '').trim(),
    address,
    name: (raw.name || '').trim(),
    phone: (raw.phone || '').trim(),
    email: (raw.email || '').trim(),
    leadId: (raw.leadId || '').trim(),
    city: (raw.city || '').trim(),
    state: (raw.state || '').trim(),
    enhanced: Boolean(raw.enhanced),
    dueDate: (raw.dueDate || '').trim(),
  }
}

// Normalize a source's extracted fields: turn the FIELD NOT FOUND sentinel and
// empty lists into empty values so downstream merge/scoring treats them as
// "absent" (never as a real value), while the note still shows FIELD NOT FOUND
// where the field was expected.
function cleanFields(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === 'FIELD NOT FOUND') out[k] = ''
    else if (Array.isArray(v)) out[k] = v
    else out[k] = v
  }
  return out
}

export { closeBrowser }
