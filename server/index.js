// HTTP server: serves the operator UI, starts investigations, streams live
// progress over Server-Sent Events, and exposes the approval endpoints.
//
// Approval endpoints refuse to make CRM changes while the app is in dry-run
// mode — which, in the first version, it always is.

import './ensureEnv.js' // must run before config.js loads dotenv
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config, safetySummary, canWrite, ROOT } from './config.js'
import { Investigation } from './orchestrator.js'
import { loadReport, listRuns, runDir, saveReport } from './store.js'
import { Enrichment } from './enrich.js'
import { createShare } from './share.js'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

// --- temporary sharing -------------------------------------------------------
// With SHARE_PASSWORD set, everything below (UI files, API, SSE, downloads) is
// behind one shared password. Mounted before express.static on purpose.
const share = createShare({ password: config.sharePassword, ttlHours: config.shareTtlHours })
app.use('/login', express.urlencoded({ extended: false, limit: '4kb' }))
app.use(share.middleware)
// Never cache the operator UI files, so pulling an update always shows the
// latest HTML/CSS/JS on a normal reload (no hard-refresh needed).
app.use(
  express.static(path.join(ROOT, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, max-age=0'),
  }),
)

// One active investigation at a time (Phase 1 is single-lead).
let current = null
const sseClients = new Set()

function sseWrite(res, ev) {
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
  } catch (err) {
    console.error('SSE write failed:', err.message)
  }
}
function broadcast(ev) {
  for (const res of sseClients) sseWrite(res, ev)
}

// --- config / safety ---------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    safety: safetySummary(),
    limits: { standard: config.standardLimitMin, enhanced: config.enhancedLimitMin },
    headless: config.headless,
    shared: share.enabled, // UI shows a Sign out link when the app is shared
  })
})

// --- start an investigation --------------------------------------------------
app.post('/api/investigate', async (req, res) => {
  try {
    if (current && ['running', 'paused', 'login'].includes(current.state)) {
      return res.status(409).json({ error: 'An investigation is already running. Stop it first.' })
    }
    if (activeEnrich()) {
      return res.status(409).json({ error: 'A Property Enrichment job is running and uses the same browser. Stop it first (Property Enrichment tab).' })
    }
    const input = req.body || {}
    if (!input.address && !input.reiLink && !input.name && !input.phone && !input.email) {
      return res.status(400).json({ error: 'Provide at least an address, REI BlackBook link, name, phone, or email.' })
    }
    const inv = new Investigation(input)
    current = inv
    inv.on('event', (ev) => broadcast({ runId: inv.runId, ...ev }))
    // Respond immediately so the UI never hangs; the run proceeds over SSE. The
    // browser launch happens inside run() and reports failures as SSE 'error'
    // events (e.g. a leftover Chrome locking the profile).
    res.json({ runId: inv.runId, state: inv.state })
    inv.run().catch((err) => broadcast({ runId: inv.runId, type: 'error', message: String(err) }))
  } catch (err) {
    // Never leave the request hanging — an async throw before res.json() would
    // otherwise stall the client on "Starting…" forever.
    console.error('investigate failed:', err)
    if (!res.headersSent) res.status(500).json({ error: 'Could not start: ' + String(err?.message || err) })
  }
})

// --- live progress stream ----------------------------------------------------
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders?.()
  sseClients.add(res)
  // Replay current run's log so a late-joining client catches up.
  if (current) {
    sseWrite(res, { runId: current.runId, type: 'hello', state: current.state })
    for (const ev of current.log) sseWrite(res, { runId: current.runId, ...ev })
    if (current.report) sseWrite(res, { runId: current.runId, type: 'report', state: current.state, report: current.report })
  }
  // Same for a running enrichment job, so the Property Enrichment tab re-attaches.
  const ae = activeEnrich()
  if (ae) {
    sseWrite(res, { type: 'enrich', enrichId: ae.id, sub: 'hello', status: ae.status() })
    for (const ev of ae.log) sseWrite(res, ev)
  }
  req.on('close', () => sseClients.delete(res))
})

// --- controls ----------------------------------------------------------------
app.post('/api/control/:action', (req, res) => {
  if (!current) return res.status(404).json({ error: 'No active investigation.' })
  const { action } = req.params
  switch (action) {
    case 'pause': current.pause(); break
    case 'resume': current.resume(); break
    case 'stop': current.stop(); break
    default: return res.status(400).json({ error: `Unknown action: ${action}` })
  }
  res.json({ state: current.state })
})

// --- report read / edit / export --------------------------------------------
app.get('/api/report/:runId', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  res.json(report)
})

app.get('/api/runs', (req, res) => {
  res.json(
    listRuns().map((r) => ({
      runId: r.runId,
      name: r.scored?.verifiedName || r.input?.name || r.input?.address || 'Lead',
      address: r.input?.address || '',
      status: r.scored?.recommendedStatus || 'In Progress',
      approval: r.approval?.decision || null,
      date: r.meta?.date,
    })),
  )
})

// Operator edits to the note or next task before approval.
app.post('/api/report/:runId/edit', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  const { note, nextTask, recommendedStatus } = req.body || {}
  if (typeof note === 'string') report.note = note
  if (nextTask && typeof nextTask === 'object') report.nextTask = { ...report.nextTask, ...nextTask }
  if (recommendedStatus) report.scored.recommendedStatus = recommendedStatus
  report.edited = true
  saveReport(report.runId, report)
  res.json({ ok: true, report })
})

// Approve / reject. Approval NEVER writes to the CRM in dry-run mode — it
// records the human decision and returns exactly what a live run WOULD do.
app.post('/api/approve/:runId', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  const wouldDo = [
    config.autoSaveNote ? 'save the note' : null,
    config.autoChangeStatus ? `set status to "${report.scored.recommendedStatus}"` : null,
    config.autoCreateTask ? 'create the next task' : null,
    config.autoReassign ? `reassign to ${report.nextTask.reassignTo}` : null,
  ].filter(Boolean)

  report.approval = {
    decision: 'approved',
    by: 'operator',
    at: new Date().toISOString(),
    executed: canWrite(),
  }

  if (!canWrite()) {
    report.approval.note =
      'DRY-RUN: approval recorded, but no CRM change was made. Enable LIVE_MODE=true and DRY_RUN=false (and the relevant AUTO_* flags) to let approval execute.'
    saveReport(report.runId, report)
    return res.json({
      ok: true,
      executed: false,
      message: 'Approved (dry-run). No CRM changes were made.',
      wouldExecute: wouldDo,
      approval: report.approval,
    })
  }

  // LIVE path is intentionally not implemented in the first version: writing to
  // REI BlackBook needs calibrated selectors and a deliberate go-live decision.
  report.approval.note = 'LIVE mode is enabled but CRM write-back is not implemented in this version.'
  saveReport(report.runId, report)
  res.json({ ok: true, executed: false, message: 'Approved. CRM write-back is not enabled in this version.', approval: report.approval })
})

app.post('/api/reject/:runId', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  report.approval = { decision: 'rejected', by: 'operator', at: new Date().toISOString(), reason: req.body?.reason || '' }
  saveReport(report.runId, report)
  res.json({ ok: true, approval: report.approval })
})

app.get('/api/report/:runId/export', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  if (req.query.format === 'note') {
    res.set('Content-Type', 'text/plain')
    res.set('Content-Disposition', `attachment; filename="${report.runId}-note.txt"`)
    return res.send(report.note || '')
  }
  res.set('Content-Disposition', `attachment; filename="${report.runId}-report.json"`)
  res.json(report)
})

// --- property enrichment (batch: CSV of addresses -> PropertyRadar + web) -----
// Jobs persist under runs/enrich_*. Loaded instances are cached so each one's
// events attach to the SSE bus exactly once. The browser is shared with the
// investigation flow, so only one of the two may run at a time.
const enrichJobs = new Map()
function loadEnrich(id) {
  if (enrichJobs.has(id)) return enrichJobs.get(id)
  const e = Enrichment.load(id)
  if (e) {
    e.on('event', (ev) => broadcast(ev))
    enrichJobs.set(id, e)
  }
  return e
}
function activeEnrich() {
  for (const e of enrichJobs.values()) if (e.isActive()) return e
  return null
}
const investigationActive = () => Boolean(current && ['running', 'paused', 'login'].includes(current.state))

// Upload a CSV (raw text body). Returns the job status incl. detected columns.
app.post('/api/enrich/upload', express.text({ type: () => true, limit: '25mb' }), (req, res) => {
  try {
    let filename = 'addresses.csv'
    try { filename = decodeURIComponent(req.get('x-filename') || '') || filename } catch { /* keep default */ }
    const e = Enrichment.create({ csvText: req.body, filename })
    e.on('event', (ev) => broadcast(ev))
    enrichJobs.set(e.id, e)
    res.json(e.status())
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) })
  }
})

// One typed address: same pipeline, one row.
app.post('/api/enrich/address', (req, res) => {
  try {
    const e = Enrichment.createFromAddress(req.body?.address)
    e.on('event', (ev) => broadcast(ev))
    enrichJobs.set(e.id, e)
    res.json(e.status())
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) })
  }
})

app.get('/api/enrich', (req, res) => {
  res.json(Enrichment.list().map((s) => (enrichJobs.has(s.id) ? enrichJobs.get(s.id).status() : s)))
})

app.get('/api/enrich/:id', (req, res) => {
  const e = loadEnrich(req.params.id)
  if (!e) return res.status(404).json({ error: 'Job not found.' })
  res.json({ ...e.status(), rows: e.rowsView(), log: e.log })
})

// Change column mapping / options before (re)starting; returns the refreshed preview.
app.post('/api/enrich/:id/options', (req, res) => {
  const e = loadEnrich(req.params.id)
  if (!e) return res.status(404).json({ error: 'Job not found.' })
  try {
    e.setOptions(req.body || {})
    res.json({ ok: true, status: e.status() })
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) })
  }
})

// Start (or resume — finished rows are skipped). Responds immediately; progress
// streams over SSE as 'enrich' events.
app.post('/api/enrich/:id/start', (req, res) => {
  const e = loadEnrich(req.params.id)
  if (!e) return res.status(404).json({ error: 'Job not found.' })
  if (investigationActive()) return res.status(409).json({ error: 'An investigation is running and uses the same browser. Stop it first (Investigation tab).' })
  const other = activeEnrich()
  if (other && other.id !== e.id) return res.status(409).json({ error: `Another enrichment job (${other.filename}) is running. Stop it first.` })
  if (e.isActive()) return res.status(409).json({ error: 'This job is already running.' })
  try {
    if (req.body && Object.keys(req.body).length) e.setOptions(req.body)
  } catch (err) {
    return res.status(400).json({ error: String(err?.message || err) })
  }
  if (e.addressMap?.mode === 'none') return res.status(400).json({ error: 'Pick which columns hold the address first.' })
  res.json({ ok: true, status: e.status() })
  e.start().catch((err) => broadcast({ type: 'enrich', enrichId: e.id, sub: 'log', level: 'error', message: String(err?.message || err), t: new Date().toISOString() }))
})

app.post('/api/enrich/:id/control/:action', (req, res) => {
  const e = loadEnrich(req.params.id)
  if (!e) return res.status(404).json({ error: 'Job not found.' })
  const { action } = req.params
  if (action === 'pause') e.pause()
  else if (action === 'resume') e.resume()
  else if (action === 'stop') e.stop()
  // Skip a source that is stuck behind a captcha, for the rest of this run.
  else if (action.startsWith('skip-')) {
    if (!e.skipSite(action.slice(5))) return res.status(400).json({ error: `Nothing to skip: ${action.slice(5)}` })
  }
  else return res.status(400).json({ error: `Unknown action: ${action}` })
  res.json({ state: e.state })
})

// The original sheet plus the enrichment columns (partial mid-run is fine).
app.get('/api/enrich/:id/download', (req, res) => {
  const e = loadEnrich(req.params.id)
  if (!e) return res.status(404).json({ error: 'Job not found.' })
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="${e.outputFilename().replace(/"/g, '')}"`)
  res.send(e.outputCsv())
})

// --- evidence screenshots ----------------------------------------------------
app.get('/evidence/:runId/:file', (req, res) => {
  const { runId, file } = req.params
  if (!/^[\w.-]+$/.test(file)) return res.status(400).end()
  const abs = path.join(runDir(runId), 'evidence', file)
  if (!abs.startsWith(runDir(runId))) return res.status(400).end()
  if (!fs.existsSync(abs)) return res.status(404).end()
  res.sendFile(abs)
})

app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`
  console.log('\n  Lead Recovery & Seller Identity Verification Automation')
  console.log('  ' + '-'.repeat(54))
  console.log(`  Open:      ${url}`)
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    for (const addr of lanAddresses()) console.log(`  Share:     http://${addr}:${config.port}   (same Wi-Fi / network)`)
  }
  console.log(
    share.enabled
      ? `  Access:    password required (SHARE_PASSWORD), sign-in lasts ${config.shareTtlHours}h`
      : '  Access:    this machine only (set SHARE_PASSWORD in .env to share)',
  )
  console.log(`  Mode:      ${canWrite() ? 'LIVE (writes enabled)' : 'DRY-RUN (research only, no CRM changes)'}`)
  console.log(`  Browser:   ${config.headless ? 'headless' : 'visible (log in when prompted)'}`)
  console.log(`  Time:      Standard ${config.standardLimitMin}m / Enhanced ${config.enhancedLimitMin}m`)
  if (config.demoMode) console.log('  Demo:      ON (synthetic data, no real browser)')
  console.log('  ' + '-'.repeat(54) + '\n')
  openInBrowser(url)
})

// Every non-internal IPv4 address of this machine, so the banner can print a
// link other people on the same network can open.
function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

// Best-effort: open the operator UI in the default browser on start.
function openInBrowser(url) {
  if (process.env.NO_OPEN === 'true') return
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* operator can open the URL manually */
  }
}
