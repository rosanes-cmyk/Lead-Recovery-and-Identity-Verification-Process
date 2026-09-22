// Property Enrichment engine.
//
// Takes a CSV of property addresses and runs each one through PropertyRadar
// (one warm browser session, no cold reload per row) and a web search, then
// writes the findings back as extra columns. Every finished row is checkpointed
// to disk, so a long batch can be paused, stopped, or interrupted and resumed
// without redoing work.
//
// Read-only like the investigation engine: it looks things up and writes a CSV.
// It never adds to PropertyRadar lists, exports, skip-traces, or touches the CRM.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { getPage, getContext, closeBrowser, looksLikeLogin, capture } from './browser.js'
import { goto, emptyResult } from './sources/base.js'
import { selectors } from './sources/selectors.js'
import { FIELD_NOT_FOUND } from './sources/extract.js'
import * as pr from './sources/propertyradar.js'
import { searchAddress } from './sources/websearch.js'
import { checkZillow } from './sources/zillow.js'
import { lookupRedfin, dealSignals, readRedfinInBrowser } from './sources/redfin.js'
import { lookupLiens, encumbranceSummary, splitApn } from './sources/recorder.js'
import { lookupPermits } from './sources/permits.js'
import { csvToRecords, toCsv, detectAddressColumns, buildAddress, addressMatch } from './csv.js'

// Columns appended to the input sheet, in this order.
export const ENRICH_COLUMNS = [
  'Enriched Address',
  'PR Owner of Record',
  'PR Taxpayer',
  'PR Entity Owner',
  'PR Title Holder',
  'PR Ownership Type',
  'PR Vesting',
  'PR Owner Mailing Address',
  'PR Occupancy',
  'PR APN',
  'PR Trust / Entity',
  'PR County',
  'PR Property Type',
  'PR Est. Value',
  'PR Equity',
  'PR Assessed Value',
  'PR Loan Balance',
  'PR Purchase Price',
  'PR Purchase Date',
  'PR Purchase Type',
  'PR Owned Since',
  'PR Year Built',
  'PR Distress Score',
  'PR Homeowner Exemption',
  'PR Likely to List for Sale',
  'PR Prior Owner',
  'PR Last Transfer',
  'PR Property Address',
  'PR Address Match',
  'PR Status',
  'Web Zillow',
  'Web Redfin',
  'Web Realtor.com',
  'Web County Records',
  'Web Sold Price',
  'Web Sold Date',
  'Web Property Type',
  'Web Listing Status',
  'Web County',
  'Zillow Listing Agent',
  'Zillow Listing Brokerage',
  'Zillow Listing Agent Phone',
  'Zillow Buyer Agent',
  'Agents Agree',
  'Web Status',
  'Redfin Listing Agent',
  'Redfin Listing Brokerage',
  'Redfin Listing Agent DRE',
  'Redfin Listing Agent Phone',
  'Redfin Listing Agent Email',
  'Redfin Buyer Agent',
  'Redfin Buyer Brokerage',
  'Redfin Buyer Agent Phone',
  'Redfin MLS #',
  'Redfin Agents For',
  'Redfin Deal Signals',
  'Redfin Remarks',
  'Redfin Status',
  'Liens Open Loans',
  'Liens Unreleased',
  'Liens Notice of Default',
  'Liens Special Assessment',
  'Liens Last Transfer',
  'Liens Documents',
  'Liens Summary',
  'Liens Status',
  'Permits Count',
  'Permits Open',
  'Permits Last Date',
  'Permits Last Work',
  'Permits Total Value',
  'Violations Active',
  'Permits Status',
  'Enrichment Notes',
  'Enriched At',
]

// Profile tabs read per row (seen live): Contacts (owner, mailing), Property
// (APN, county, taxpayer, exemption), Value & Equity (estimated value, equity,
// loans, purchase date), Transactions (deed, prior owner, likely-to-list).
const BATCH_TABS = ['Contacts', 'Property', 'Value & Equity', 'Transactions']
const NETWORK_SAMPLE_ROWS = 3 // rows whose PropertyRadar JSON responses are logged for calibration
const PR_FAIL_PAUSE_AFTER = 3
// How long to wait on a captcha before giving up on that site for the run.
const CAPTCHA_WAIT_MS = 4 * 60 * 1000 // consecutive PropertyRadar misses before pausing to ask the operator
const LOG_KEEP = 300 // events replayed to a reconnecting UI
const ACTIVE = ['running', 'paused', 'login']

const blankFields = () => Object.fromEntries(ENRICH_COLUMNS.map((c) => [c, '']))
const jobDir = (id) => path.join(config.runsDir, id)

export class Enrichment extends EventEmitter {
  constructor(job) {
    super()
    this.id = job.id
    this.filename = job.filename || 'addresses.csv'
    this.createdAt = job.createdAt
    this.headers = job.headers
    this.records = job.records
    this.addressMap = job.addressMap
    this.options = {
      webSearch: config.enrichWebSearch,
      screenshots: config.enrichScreenshots,
      zillowCheck: config.enrichZillow,
      redfin: config.enrichRedfin,
      liens: config.enrichLiens,
      permits: config.enrichPermits,
      delayMs: config.enrichDelayMs,
      headless: null, // null = leave the browser mode as configured
      ...(job.options || {}),
    }
    this.state = job.state || 'ready' // ready | running | paused | login | done | stopped | error
    this.startedAt = job.startedAt || null
    this.finishedAt = job.finishedAt || null
    this.error = job.error || ''
    this.results = new Map() // row index -> { i, fields, ok, ms, at, evidence }
    this.current = -1
    this.log = []
    this.durations = []
    this._abort = new AbortController()
    this._pauseGate = null
    this._resume = null
    this._netRows = 0
    this._restoreHeadless = null
    this._prFailStreak = 0
    this._page = null // the PropertyRadar tab (may be replaced by a fresh one mid-run)
    this._zpage = null // a second tab for Zillow, so it never disturbs PropertyRadar's
    this._rpage = null // a third for the SF recorder, for the same reason
    this.dir = jobDir(this.id)
    // Output column names, suffixed if the input sheet already has them (re-run
    // of an enriched file) so nothing in the original is overwritten.
    const taken = new Set(this.headers)
    this.outColumns = ENRICH_COLUMNS.map((c) => (taken.has(c) ? `${c} (new)` : c))
  }

  // ---- creation / persistence ------------------------------------------------

  // One typed address, run through exactly the same pipeline as a sheet. Goal 1
  // was described as "you type in an address", and a one-row job keeps a single
  // code path rather than a second, thinner one that would drift.
  static createFromAddress(address) {
    const one = String(address || '').replace(/\s+/g, ' ').trim()
    if (!one) throw new Error('Type an address first.')
    if (one.length > 200) throw new Error('That does not look like an address.')
    if (!/\d/.test(one)) throw new Error('An address needs a street number — try "547 Missouri St, San Francisco, CA 94107".')
    const e = Enrichment.create({ csvText: `${toCsv(['Address'], [{ Address: one }])}`, filename: `${one.slice(0, 60)}.csv` })
    e.setAddressMap({ mode: 'full', full: 'Address' })
    return e
  }

  static create({ csvText, filename }) {
    const { headers, records } = csvToRecords(csvText)
    if (!headers.length) throw new Error('The file has no header row.')
    if (!records.length) throw new Error('The file has no data rows under the header.')
    const id = `enrich_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const job = {
      id,
      filename: String(filename || 'addresses.csv').replace(/[^\w.\- ()]+/g, '_').slice(0, 120),
      createdAt: new Date().toISOString(),
      headers,
      records,
      addressMap: detectAddressColumns(headers),
      options: {},
      state: 'ready',
    }
    const e = new Enrichment(job)
    fs.mkdirSync(e.dir, { recursive: true })
    e._saveJob()
    return e
  }

  static load(id) {
    if (!/^enrich_[\w-]+$/.test(String(id))) return null
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf-8'))
      // A job that was mid-run when the server stopped is resumable, not running.
      if (ACTIVE.includes(job.state)) job.state = 'stopped'
      const e = new Enrichment(job)
      e._loadResults()
      return e
    } catch {
      return null
    }
  }

  static list() {
    try {
      if (!fs.existsSync(config.runsDir)) return []
      return fs
        .readdirSync(config.runsDir)
        .filter((d) => d.startsWith('enrich_'))
        .map((d) => Enrichment.load(d))
        .filter(Boolean)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((e) => e.status())
    } catch {
      return []
    }
  }

  _saveJob() {
    const job = {
      id: this.id,
      filename: this.filename,
      createdAt: this.createdAt,
      headers: this.headers,
      records: this.records,
      addressMap: this.addressMap,
      options: this.options,
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
    }
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(path.join(this.dir, 'job.json'), JSON.stringify(job))
  }

  _loadResults() {
    const f = path.join(this.dir, 'results.jsonl')
    if (!fs.existsSync(f)) return
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (Number.isInteger(r.i)) this.results.set(r.i, r)
      } catch {
        /* skip a torn line from an interrupted write */
      }
    }
  }

  // ---- status ---------------------------------------------------------------

  counts() {
    let found = 0
    for (const r of this.results.values()) if (r.ok) found++
    return { total: this.records.length, done: this.results.size, found, notFound: this.results.size - found }
  }

  etaMs() {
    const c = this.counts()
    const remaining = c.total - c.done
    if (!remaining || !this.durations.length) return null
    const avg = this.durations.reduce((a, b) => a + b, 0) / this.durations.length
    return Math.round(remaining * (avg + (this.options.delayMs || 0) * 1.2))
  }

  status() {
    const c = this.counts()
    return {
      id: this.id,
      filename: this.filename,
      createdAt: this.createdAt,
      state: this.state,
      error: this.error,
      ...c,
      current: this.current,
      currentAddress: this.current >= 0 ? this.addressFor(this.current) : '',
      etaMs: this.etaMs(),
      options: this.options,
      addressMap: this.addressMap,
      headers: this.headers,
      outColumns: this.outColumns,
      sample: this.records.slice(0, 3).map((r) => buildAddress(r, this.addressMap)),
      unresolved: this.records.filter((r) => !buildAddress(r, this.addressMap)).length,
      demo: config.demoMode,
    }
  }

  rowsView() {
    return [...this.results.values()].sort((a, b) => a.i - b.i)
  }

  addressFor(i) {
    return buildAddress(this.records[i] || {}, this.addressMap)
  }

  isActive() {
    return ACTIVE.includes(this.state)
  }

  // ---- options ---------------------------------------------------------------

  setOptions(opts = {}) {
    if (this.isActive()) throw new Error('Options cannot change while the job is running.')
    if (opts.addressMap) this.setAddressMap(opts.addressMap)
    if (typeof opts.webSearch === 'boolean') this.options.webSearch = opts.webSearch
    if (typeof opts.screenshots === 'boolean') this.options.screenshots = opts.screenshots
    if (typeof opts.zillowCheck === 'boolean') this.options.zillowCheck = opts.zillowCheck
    if (typeof opts.redfin === 'boolean') this.options.redfin = opts.redfin
    if (typeof opts.liens === 'boolean') this.options.liens = opts.liens
    if (typeof opts.permits === 'boolean') this.options.permits = opts.permits
    if (typeof opts.headless === 'boolean') this.options.headless = opts.headless
    if (opts.delayMs != null) {
      const n = parseInt(opts.delayMs, 10)
      if (!Number.isNaN(n)) this.options.delayMs = Math.min(Math.max(n, 0), 120000)
    }
    this._saveJob()
  }

  setAddressMap(map) {
    const has = (c) => !c || this.headers.includes(c)
    if (map.mode === 'full') {
      if (!map.full || !has(map.full)) throw new Error('Pick the column that holds the full address.')
      this.addressMap = { mode: 'full', full: map.full, street: '', city: '', state: '', zip: '' }
    } else if (map.mode === 'parts') {
      if (!map.street || !has(map.street)) throw new Error('Pick the street-address column.')
      if (![map.city, map.state, map.zip].every(has)) throw new Error('One of the city/state/zip columns does not exist.')
      this.addressMap = { mode: 'parts', full: '', street: map.street, city: map.city || '', state: map.state || '', zip: map.zip || '' }
    } else throw new Error('Unknown address mapping.')
  }

  // ---- events -----------------------------------------------------------------

  _emit(sub, payload = {}) {
    const ev = { type: 'enrich', enrichId: this.id, sub, ...payload, t: new Date().toISOString() }
    this.log.push(ev)
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP)
    super.emit('event', ev)
  }

  _log(message, level = 'info') {
    this._emit('log', { message, level })
  }

  _setState(state, message) {
    this.state = state
    this._saveJob()
    this._emit('state', { state, message })
  }

  _progress() {
    this._emit('progress', { ...this.counts(), current: this.current, currentAddress: this.current >= 0 ? this.addressFor(this.current) : '', etaMs: this.etaMs(), state: this.state })
  }

  // ---- controls ---------------------------------------------------------------

  pause() {
    if (this.state !== 'running') return
    this._pauseGate = new Promise((res) => (this._resume = res))
    this._setState('paused', 'Paused by operator.')
  }

  resume() {
    if (this.state !== 'paused' && this.state !== 'login') return
    this._setState('running', 'Resumed.')
    this._resume?.()
    this._pauseGate = null
    this._resume = null
  }

  stop() {
    if (!this.isActive()) return
    this.state = 'stopped'
    this._abort.abort()
    this._resume?.()
    this._pauseGate = null
    this._resume = null
    this._log('Stopping after the current row…', 'state')
  }

  async _waitIfPaused() {
    if (this._pauseGate) await this._pauseGate
  }

  // Interruptible sleep: returns early on Stop.
  _sleep(ms) {
    if (ms <= 0 || this._abort.signal.aborted) return Promise.resolve()
    return new Promise((res) => {
      const t = setTimeout(res, ms)
      this._abort.signal.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
    })
  }

  // Pause for a login (or a kicked session) and auto-resume once the page no
  // longer looks blocked. Manual Resume works too. Gives up auto after 10 min.
  // A captcha is not a dead row. Bring the tab to the front, ask the operator to
  // clear it (they press and hold), and carry on by itself once it is gone —
  // the same shape as the PropertyRadar login pause.
  async _requireOperator(page, { message, isClear, label = 'site', site = '' }) {
    if (this.state === 'stopped' || this._headlessNow()) return false
    try { await page?.bringToFront?.() } catch { /* best effort */ }
    this._pauseGate = new Promise((res) => (this._resume = res))
    this._skipSite = site // what "Skip" on the banner turns off
    this.state = 'login'
    this._saveJob()
    this._emit('login-required', { message, reason: 'captcha', site, label })
    const gate = this._pauseGate
    const started = Date.now()
    ;(async () => {
      while (this.state === 'login' && this._pauseGate === gate && !this._abort.signal.aborted) {
        await new Promise((r) => setTimeout(r, 2500))
        if (this.state !== 'login' || this._pauseGate !== gate) break
        let clear = false
        try { clear = await isClear() } catch { clear = false }
        if (clear) { this._log(`${label} check cleared — continuing.`, 'state'); this.resume(); break }
        // Never hang on a check that will not clear. Carry on without that site
        // rather than leaving the rest of the sheet unprocessed.
        if (Date.now() - started > CAPTCHA_WAIT_MS) {
          this._log(`${label} is still asking for a captcha after ${Math.round(CAPTCHA_WAIT_MS / 60000)} minutes — carrying on without it for the rest of this run.`, 'warn')
          this.skipSite(site)
          break
        }
      }
    })()
    await gate
    this._skipSite = ''
    return this.state !== 'stopped'
  }

  // Turn one blocked source off for the remainder of the run and carry on. The
  // other sources still answer, so a row keeps most of its value.
  skipSite(site) {
    const which = site || this._skipSite
    if (which === 'zillow') { this.options.zillowCheck = false; this._log('Zillow turned off for the rest of this run.', 'state') }
    else if (which === 'redfin') { this.options.redfin = false; this._log('Redfin turned off for the rest of this run.', 'state') }
    else if (which === 'liens') { this.options.liens = false; this._log('The recorder lookup is off for the rest of this run.', 'state') }
    else return false
    this._saveJob()
    if (this.state === 'login' || this.state === 'paused') this.resume()
    return true
  }

  async _requireLogin(page, reason) {
    if (this.state === 'stopped') return
    this._pauseGate = new Promise((res) => (this._resume = res))
    this.state = 'login'
    this._saveJob()
    const message =
      reason === 'session kicked'
        ? 'PropertyRadar logged this session out (only ONE active login is allowed). Close other PropertyRadar tabs/browsers, sign in again in the automation window — I will continue automatically.'
        : 'PropertyRadar needs a login. Sign in in the browser window — I will continue automatically once you are in (or click Resume).'
    this._emit('login-required', { message, reason })
    const gate = this._pauseGate
    const started = Date.now()
    ;(async () => {
      while (this.state === 'login' && this._pauseGate === gate && !this._abort.signal.aborted) {
        await new Promise((r) => setTimeout(r, 2500))
        if (this.state !== 'login' || this._pauseGate !== gate) break
        let clear = false
        const cur = this._page || page
        try { clear = !(await looksLikeLogin(cur)) && !(await pr.sessionKicked(cur)) } catch { clear = false }
        if (clear) { this._log('Login detected — continuing.', 'state'); this.resume(); break }
        if (Date.now() - started > 10 * 60 * 1000) break
      }
    })()
    await gate
  }

  // ---- run ----------------------------------------------------------------------

  // Public entry: anything unexpected becomes a clean 'error' state instead of a
  // job stuck on 'running' with nobody watching it.
  async start() {
    if (this.isActive()) return this.status()
    if (this.addressMap?.mode === 'none') throw new Error('No address columns are mapped yet.')
    try {
      return await this._run()
    } catch (err) {
      return this._fail(`Enrichment stopped unexpectedly: ${String(err?.message || err)}`)
    }
  }

  async _run() {
    this._abort = new AbortController()
    this.startedAt = this.startedAt || new Date().toISOString()
    this.finishedAt = null
    this.error = ''
    this.durations = []
    const pending = this.records.map((_, i) => i).filter((i) => !this.results.has(i))
    this._setState('running', `${pending.length ? 'Starting' : 'Nothing left to do'} — ${this.counts().done} of ${this.records.length} rows already done.`)
    if (!pending.length) return this._finalize('done')

    let page = null
    if (!config.demoMode) {
      try {
        page = await this._openBrowser()
        this._page = page
      } catch (err) {
        return this._fail(`Could not start the browser: ${String(err?.message || err)}`)
      }
      // One readiness / login check up front so the operator signs in once, not per row.
      const pre = await this._openPropertyRadar(page)
      if (pre === 'login required' || pre === 'session kicked') {
        if (this._headlessNow()) {
          return this._fail('PropertyRadar needs a login, but the browser is hidden (headless). Run once with the browser visible, sign in, then start again — the session is saved in the browser profile.')
        }
        await this._requireLogin(page, pre)
        if (this.state === 'stopped') return this._finalize('stopped')
      }
    } else {
      this._log('DEMO MODE: synthetic lookups, no real browser.')
    }

    for (let k = 0; k < pending.length; k++) {
      const i = pending[k]
      if (this.state === 'stopped') break
      await this._waitIfPaused()
      if (this.state === 'stopped') break
      // Recorded by hand during a pause (and found): nothing left to do for it —
      // except the web columns, if it never had a normal pass.
      if (this.results.get(i)?.ok) {
        if (this.results.get(i).fields['Web Status'] === 'pending' && !config.demoMode) await this._fillWebOnly(i)
        continue
      }

      this.current = i
      this._progress()
      const t0 = Date.now()
      let fields
      try {
        fields = await this._processRow(i)
      } catch (err) {
        // A closed automation window is recoverable: relaunch and retry once.
        if (page && /closed|crashed|Target page|browser has been/i.test(String(err))) {
          this._log('Browser window closed — reopening it and retrying this row.', 'warn')
          try {
            page = await this._openBrowser()
            this._page = page
            this._zpage = null
            this._rpage = null
            fields = await this._processRow(i)
          } catch (err2) {
            fields = this._errorFields(i, err2)
          }
        } else fields = this._errorFields(i, err)
      }

      // Login wall / kicked session mid-run: pause, let the operator fix it, retry the row once.
      const st = fields['PR Status']
      if ((st === 'login required' || st === 'session kicked') && this.state !== 'stopped') {
        if (this._headlessNow()) return this._fail(`PropertyRadar reported "${st}" but the browser is hidden (headless). Run with the browser visible to sign in.`)
        await this._requireLogin(this._page, st)
        if (this.state === 'stopped') break
        try { fields = await this._processRow(i) } catch (err) { fields = this._errorFields(i, err) }
      }

      this._record(i, fields, Date.now() - t0)

      // Several PropertyRadar misses in a row means something is off (layout
      // change, stale search criteria, not really signed in). Pause and show the
      // operator rather than spending 45s a row on nothing.
      if (!config.demoMode && page) {
        if (fields['PR Status'] === 'found') this._prFailStreak = 0
        else if (fields['PR Status'] === 'not found') this._prFailStreak++
        if (this._prFailStreak >= PR_FAIL_PAUSE_AFTER && k < pending.length - 1 && this.state !== 'stopped') {
          await this._pauseForFailures(this._page, fields['Enriched Address'], this.addressFor(pending[k + 1]))
          this._prFailStreak = 0
          if (this.state === 'stopped') break
        }
      }

      if (k < pending.length - 1 && this.state !== 'stopped') {
        const base = this.options.delayMs || 0
        await this._sleep(base + Math.round(Math.random() * base * 0.4))
      }
    }
    this.current = -1
    return this._finalize(this.state === 'stopped' ? 'stopped' : 'done')
  }

  _headlessNow() {
    return this.options.headless === true || (this.options.headless === null && config.headless)
  }

  // Get the shared browser page, relaunching in the requested visible/hidden mode
  // when the job asks for one different from the current setting.
  async _openBrowser() {
    if (typeof this.options.headless === 'boolean' && this.options.headless !== config.headless) {
      await closeBrowser()
      if (this._restoreHeadless === null) this._restoreHeadless = config.headless
      config.headless = this.options.headless
      this._log(`Browser will run ${config.headless ? 'hidden (headless)' : 'visible'} for this job.`)
    }
    return getPage()
  }

  // Open the PropertyRadar app (warm) and wait until it is usable. Returns
  // 'ready' | 'login required' | 'session kicked' | 'not ready'.
  async _openPropertyRadar(page) {
    const cfg = selectors.propertyradar
    const signal = this._abort.signal
    try {
      await goto(page, cfg.loginUrl, { signal })
    } catch (err) {
      if (signal.aborted) return 'not ready'
      throw err
    }
    const ready = await pr.waitForAppReady(page, this._prEmit(), signal)
    if (ready) return 'ready'
    if (await pr.sessionKicked(page)) return 'session kicked'
    if (await looksLikeLogin(page)) return 'login required'
    return 'not ready'
  }

  // The PropertyRadar module narrates every step. In a batch the UI log gets
  // only the problems; the full step trail goes into the row's notes (when a
  // `trail` array is given) so a failed row explains itself in the sheet.
  _prEmit(trail = null) {
    return (ev) => {
      if (ev?.type !== 'log' || !ev.message) return
      if (trail) trail.push(String(ev.message).slice(0, 140))
      if (/kicked|did not finish|Auto-search issue|No autocomplete|Still loading|asking operator|Could not click|detail link was not found|no record|did not open the address box|No address search box/i.test(ev.message)) {
        this._log(`PropertyRadar: ${ev.message}`, 'warn')
      }
    }
  }

  // ---- one row ------------------------------------------------------------------

  async _processRow(i) {
    const address = this.addressFor(i)
    const fields = blankFields()
    fields['Enriched Address'] = address
    fields['Enriched At'] = new Date().toISOString()
    if (!address) {
      fields['PR Status'] = 'skipped'
      fields['Web Status'] = 'skipped'
      fields['Enrichment Notes'] = 'No address in this row.'
      return fields
    }
    const partial = this._partialAddressNote(i)
    const notes = partial ? [partial] : []
    const signal = this._abort.signal

    if (config.demoMode) {
      const out = await this._demoRow(fields, address)
      if (partial) out['Enrichment Notes'] = [partial, out['Enrichment Notes']].filter(Boolean).join(' | ')
      return out
    }

    // Web search runs in the background (plain fetch, no browser) while the
    // browser works PropertyRadar, so it costs no wall-clock time on the fast path.
    const webPromise = this.options.webSearch
      ? searchAddress(address, { signal, runDir: this.dir }).catch((e) => ({ ok: false, links: {}, notes: [String(e?.message || e)] }))
      : Promise.resolve(null)
    // Zillow runs in its own tab alongside PropertyRadar, so it costs no wall-clock time.
    const zillowPromise = this.options.zillowCheck ? this._zillow(address) : Promise.resolve(null)

    let prRes = await this._lookupPropertyRadar(address, i)
    // A miss that never opened a property gets ONE retry in a fresh tab: a wedged
    // ExtJS state or criteria left over from the previous search start clean.
    if (prRes.status === 'not found' && !prRes.opened && !signal.aborted && this._page) {
      this._log(`Row ${i + 1}: PropertyRadar did not open a property — retrying once in a fresh tab.`, 'warn')
      await this._freshPage()
      const again = await this._lookupPropertyRadar(address, i)
      if (again.status !== 'not found' || again.opened) prRes = again
      else prRes = { ...prRes, notes: [...(prRes.notes || []), ...(again.notes || []).map((n) => 'Retry: ' + n)], evidence: [...(prRes.evidence || []), ...(again.evidence || [])] }
    }
    this._applyPr(fields, prRes, address)
    notes.push(...(prRes.notes || []))

    let web = await webPromise
    // Challenged or failed on the direct path -> retry through the browser (after
    // PropertyRadar, since the two share the page).
    if (this.options.webSearch && web && !web.ok && !signal.aborted && this._page) {
      web = await searchAddress(address, { page: this._page, signal, runDir: this.dir, direct: false }).catch(() => web)
    }
    this._applyWeb(fields, web)
    if (web?.notes?.length && !web.ok) notes.push(...web.notes)

    // The recorded chain of title, keyed by the parcel number PropertyRadar just
    // read. Must run after it, and in its own tab.
    const lien = await this._liens(fields['PR APN'], signal)
    this._applyLiens(fields, lien)
    if (lien && !lien.ok && lien.error) notes.push(`Recorder: ${lien.error}`)

    // Permits and code violations, from the city's own open data. Same parcel
    // number as the recorder, plain fetch, about a second.
    const perm = await this._permits(fields['PR APN'], signal)
    this._applyPermits(fields, perm)
    if (perm && !perm.ok && perm.error) notes.push(`Permits: ${perm.error}`)

    // Redfin names the agents PropertyRadar does not carry. Plain fetch of the
    // page the web search already found, so it costs a second, not a tab.
    let rf = await this._redfin(fields['Web Redfin'], signal)
    // Nothing from the fetch: try the same page in the browser, where cookies
    // exist and a check can be cleared by hand.
    if (rf && !rf.ok && fields['Web Redfin'] && !this._headlessNow() && this.state !== 'stopped') {
      const viaBrowser = await this._redfinInBrowser(fields['Web Redfin'])
      if (viaBrowser?.ok) rf = viaBrowser
      else if (viaBrowser?.blocked) {
        const ok = await this._requireOperator(this._zpage, {
          label: 'Redfin',
          site: 'redfin',
          message:
            'Redfin is showing a captcha. Clear it in the browser window (press and hold), and I will carry on by myself. ' +
            'If it will not clear, click "Skip Redfin" and the run continues with Zillow and the rest.',
          isClear: async () => {
            const again = await this._redfinInBrowser(fields['Web Redfin'])
            if (again?.ok) { rf = again; return true }
            return false
          },
        })
        if (!ok) this._log('Stopped while waiting for the Redfin check.', 'warn')
      }
    }
    this._applyRedfin(fields, rf)
    if (rf && !rf.ok && rf.error) notes.push(`Redfin: ${rf.error}`)

    let z = await zillowPromise
    // Zillow is the second opinion on agents. If Redfin already named them there
    // is nothing worth stopping the operator for, so a block is just a note.
    const zillowStillNeeded = !fields['Redfin Listing Agent'] && !fields['Redfin Buyer Agent']
    if (z?.blocked && zillowStillNeeded && !this._headlessNow() && this.state !== 'stopped') {
      const ok = await this._requireOperator(this._zpage, {
        label: 'Zillow',
        site: 'zillow',
        message:
          'Zillow is showing a captcha and Redfin did not name the agents for this one. Clear it in the browser window (press and hold), and I will carry on by myself. ' +
          'If it will not clear, click "Skip Zillow" and the run continues with the other sources.',
        isClear: async () => {
          const again = await this._zillow(address)
          if (again && !again.blocked) { z = again; return true }
          return false
        },
      })
      if (!ok) this._log('Stopped while waiting for the Zillow check.', 'warn')
    }
    this._applyZillow(fields, z)
    if (z && !z.ok && z.error) notes.push(`Zillow: ${z.error}`)

    this._crossCheckAgents(fields)
    fields['Enrichment Notes'] = notes.filter(Boolean).join(' | ').slice(0, 600)
    fields._evidence = (prRes.evidence || []).filter((e) => e.file).map((e) => ({ file: e.file, label: e.label }))
    return fields
  }

  // Say so when a row's address was only partly filled in (city / state / ZIP
  // blank in the sheet). The ZIP usually pins the property down anyway, but the
  // operator should see exactly what was searched.
  _partialAddressNote(i) {
    const m = this.addressMap
    if (!m || m.mode !== 'parts') return ''
    const rec = this.records[i] || {}
    const blank = (k) => Boolean(k) && !String(rec[k] ?? '').trim()
    const missing = [blank(m.city) && 'city', blank(m.state) && 'state', blank(m.zip) && 'ZIP'].filter(Boolean)
    return missing.length ? `${missing.join(' + ')} blank in the sheet; searched as "${this.addressFor(i)}".` : ''
  }

  // After several PropertyRadar misses in a row, pause and hand over: while
  // paused, every property profile the operator opens by hand is read and
  // recorded into the row whose address it matches (open as many as you like —
  // each is saved the moment it is on screen). Resume continues automatically
  // with whatever is still missing; Stop stops.
  async _pauseForFailures(page, lastAddress, nextAddress) {
    if (this.state === 'stopped') return
    this._pauseGate = new Promise((res) => (this._resume = res))
    this.state = 'login'
    this._saveJob()
    const message =
      `PropertyRadar has not returned a property for ${PR_FAIL_PAUSE_AFTER} rows in a row (last: "${lastAddress}"). ` +
      'Look at the PropertyRadar browser window: are you signed in, and did the search actually run? ' +
      'While this is paused you can open properties by hand in that window — each one is read and saved into its row the moment it is on screen' +
      (nextAddress ? ` (next up: ${nextAddress})` : '') +
      '. Click Resume when you want me to try automatically again, or Stop.'
    this._emit('login-required', { message, reason: 'pr-failures' })
    this._log(message, 'warn')
    const gate = this._pauseGate
    let lastSeen = ''
    ;(async () => {
      while (this.state === 'login' && this._pauseGate === gate && !this._abort.signal.aborted) {
        await new Promise((r) => setTimeout(r, 2000))
        if (this.state !== 'login' || this._pauseGate !== gate) break
        const cur = this._page || page
        if (!(await this._profileOpen(cur))) continue
        let key = ''
        try { key = cur.url() } catch { key = '' }
        if (!key || key === lastSeen) continue
        lastSeen = key
        try {
          const r = await this._recordOpenProfile()
          if (r) this._log(`Saved row ${r.row + 1} (${r.address}) from the property you opened${r.ok ? '' : ' — but no owner could be read from it'}. Open the next one, or click Resume.`, 'state')
        } catch (err) {
          this._log(`Could not read the open property: ${String(err?.message || err)}`, 'warn')
        }
      }
    })()
    await gate
  }

  // Read the property profile currently on screen and record it into the row
  // whose address matches. Returns { row, address, ok } or null when it matches
  // no row. Web/Zillow columns already gathered for that row are kept.
  async _recordOpenProfile() {
    const page = this._page
    const cfg = selectors.propertyradar
    const signal = this._abort.signal
    const res = emptyResult('PropertyRadar')
    res.audit = []
    const tabsText = await pr.readProfileTabs(page, this._prEmit(), signal, BATCH_TABS)
    const out = await pr.extractAndBuild(page, cfg, res, this.dir, {}, tabsText, { screenshot: true })
    const prAddr = res.data?.propertyAddress && res.data.propertyAddress !== FIELD_NOT_FOUND ? res.data.propertyAddress : ''
    let row = -1
    if (prAddr) for (let i = 0; i < this.records.length; i++) if (addressMatch(this.addressFor(i), prAddr) === 'match') { row = i; break }
    if (row < 0) {
      this._log(`The open property (${prAddr || 'address not readable'}) does not match any row in the sheet — not saved.`, 'warn')
      return null
    }
    const address = this.addressFor(row)
    const fields = blankFields()
    fields['Enriched Address'] = address
    fields['Enriched At'] = new Date().toISOString()
    this._applyPr(fields, { status: out.ok ? 'found' : 'not found', data: res.data, notes: res.notes, evidence: res.evidence }, address)
    const prev = this.results.get(row)
    if (prev) for (const c of ENRICH_COLUMNS) if ((c.startsWith('Web ') || c.startsWith('Redfin ') || c.startsWith('Liens ') || c.startsWith('Permits ') || c.startsWith('Violations ') || c.startsWith('Zillow ') || c === 'Agents Agree') && !fields[c]) fields[c] = prev.fields[c] || ''
    if (!prev) {
      fields['Web Status'] = this.options.webSearch ? 'pending' : 'skipped'
      fields['Redfin Status'] = this.options.redfin ? 'pending' : 'skipped'
      fields['Liens Status'] = this.options.liens ? 'pending' : 'skipped'
      fields['Permits Status'] = this.options.permits ? 'pending' : 'skipped'
    }
    fields['Enrichment Notes'] = ['Read from a property the operator opened by hand — check PR Address Match.', ...res.notes].join(' | ').slice(0, 600)
    fields._evidence = (res.evidence || []).filter((e) => e.file).map((e) => ({ file: e.file, label: e.label }))
    this._record(row, fields, 0)
    return { row, address, ok: out.ok }
  }

  // A PropertyRadar property profile is on screen: the /detail/ URL, or the
  // profile's own labels in the rendered text.
  async _profileOpen(page) {
    try {
      if (/\/detail\//i.test(page.url())) return true
      const txt = await page.innerText('body')
      return /\btaxpayer\b/i.test(txt) && /(assessor parcel number|\btransactions\b|value,?\s*equity)/i.test(txt)
    } catch {
      return false
    }
  }

  // Where the browser ended up, in one line, for the notes of a failed row.
  async _pageGlimpse(page) {
    try {
      const url = page.url()
      const text = ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 220)
      return `Screen: ${url}${text ? ` — "${text}"` : ''}`
    } catch {
      return ''
    }
  }

  async _lookupPropertyRadar(address, i) {
    const page = this._page
    const cfg = selectors.propertyradar
    const signal = this._abort.signal
    const trail = []
    const emit = this._prEmit(trail)
    const manual = false
    const state = await this._openPropertyRadar(page)
    if (state !== 'ready') return { status: state === 'not ready' ? 'not found' : state, notes: state === 'not ready' ? ['PropertyRadar did not finish loading.'] : [] }

    const detach = this._attachNetworkCapture(page, i)
    try {
      const res = emptyResult('PropertyRadar')
      res.audit = []
      // Quiet search: no per-step screenshots (pass null instead of the result).
      const opened = await pr.autoSearch(page, address, cfg, emit, signal, null, this.dir)
      if (!opened) {
        if (await pr.sessionKicked(page)) return { status: 'session kicked' }
        if (await looksLikeLogin(page)) return { status: 'login required' }
        // Always keep a picture of the screen we got stuck on, whatever the
        // screenshots option says — it is the evidence needed to fix the search.
        res.evidence.push(await capture(page, this.dir, `row${i + 1}-stuck`))
        res.notes.push('PropertyRadar search did not open a property for this address. ' + (await this._pageGlimpse(page)))
        if (trail.length) res.notes.push('Steps: ' + trail.join(' → ').slice(0, 500))
      }
      const tabsText = opened ? await pr.readProfileTabs(page, emit, signal, BATCH_TABS) : ''
      const out = await pr.extractAndBuild(page, cfg, res, this.dir, { address }, tabsText, { screenshot: Boolean(this.options.screenshots) || manual })
      if (!out.ok && (await pr.sessionKicked(page))) return { status: 'session kicked', evidence: res.evidence }
      for (const m of trail) if (/Could not confirm/.test(m)) res.notes.push(m)
      if (manual) res.notes.push('Read from the property the operator opened by hand — check PR Address Match.')
      return { status: out.ok ? 'found' : 'not found', opened: Boolean(opened), data: res.data, notes: res.notes, evidence: res.evidence }
    } finally {
      detach?.()
    }
  }

  // Web + Zillow columns for a row whose PropertyRadar part was recorded by hand.
  async _fillWebOnly(i) {
    const row = this.results.get(i)
    if (!row) return
    const address = row.address
    const signal = this._abort.signal
    const fields = { ...row.fields }
    try {
      const [web, z] = await Promise.all([
        this.options.webSearch ? searchAddress(address, { signal, runDir: this.dir }).catch(() => null) : null,
        this.options.zillowCheck ? this._zillow(address) : null,
      ])
      this._applyWeb(fields, web)
      this._applyZillow(fields, z)
      this._applyRedfin(fields, await this._redfin(fields['Web Redfin'], signal))
    } catch { /* best effort */ }
    if (fields['Web Status'] === 'pending') fields['Web Status'] = 'none'
    if (fields['Redfin Status'] === 'pending') fields['Redfin Status'] = 'none'
    if (fields['Liens Status'] === 'pending') fields['Liens Status'] = 'none'
    if (fields['Permits Status'] === 'pending') fields['Permits Status'] = 'none'
    this._crossCheckAgents(fields)
    fields._evidence = row.evidence
    this._record(i, fields, row.ms || 0)
  }

  // Replace the PropertyRadar tab with a fresh one in the same (logged-in) browser.
  async _freshPage() {
    const old = this._page
    try {
      const ctx = old && !old.isClosed?.() ? old.context() : await getContext()
      this._page = await ctx.newPage()
      if (old && old !== this._page) await old.close().catch(() => {})
    } catch (err) {
      this._log(`Could not open a fresh tab: ${String(err?.message || err)}`, 'warn')
    }
    return this._page
  }

  // Zillow gets its own tab so it never navigates PropertyRadar's away.
  async _zillow(address) {
    try {
      if (!this._zpage || this._zpage.isClosed?.()) {
        const ctx = this._page && !this._page.isClosed?.() ? this._page.context() : await getContext()
        this._zpage = await ctx.newPage()
      }
      return await checkZillow(this._zpage, address, { signal: this._abort.signal })
    } catch (err) {
      return { ok: false, url: '', county: '', propertyType: '', listingStatus: '', blocked: false, error: String(err?.message || err).slice(0, 160) }
    }
  }

  // Redfin is the only source we have that names the listing and buyer agents.
  // Best effort: a block or a missing page leaves the columns empty and says so.
  async _redfin(url, signal) {
    if (!this.options.redfin) return null
    if (!url) return { ok: false, error: 'no Redfin page found for this address' }
    try {
      return await lookupRedfin(url, {
        signal,
        onMiss: async (html) => {
          // Keep the head of any page that loaded but yielded nothing, so a
          // miss can be diagnosed instead of guessed at.
          try {
            const dir = path.join(this.dir, 'redfin-misses')
            fs.mkdirSync(dir, { recursive: true })
            const name = `row-${String(this.current + 1).padStart(4, '0')}.html`
            fs.writeFileSync(path.join(dir, name), String(html).slice(0, 40000))
          } catch { /* evidence is best effort */ }
        },
      })
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 160) }
    }
  }

  // The SF recorder gets its own tab so it never navigates PropertyRadar away.
  async _liens(apn, signal) {
    if (!this.options.liens) return null
    const clean = String(apn || '').trim()
    if (!clean || clean === FIELD_NOT_FOUND) return { ok: false, error: 'no parcel number, so no recorder search' }
    try {
      if (!this._rpage || this._rpage.isClosed?.()) {
        const ctx = this._page && !this._page.isClosed?.() ? this._page.context() : await getContext()
        this._rpage = await ctx.newPage()
      }
      return await lookupLiens(this._rpage, clean, { signal })
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 160) }
    }
  }

  _applyLiens(fields, res) {
    if (!this.options.liens) { fields['Liens Status'] = 'skipped'; return }
    if (!res) { fields['Liens Status'] = 'none'; return }
    if (!res.ok || !res.summary) {
      fields['Liens Status'] = /no parcel/i.test(res.error || '') ? 'no parcel number' : 'not found'
      return
    }
    const s = res.summary
    fields['Liens Open Loans'] = String(s.likelyOpenLoans)
    fields['Liens Unreleased'] = s.unreleasedEncumbrances.map((r) => `${r.titles.join(' + ')} ${r.date}`).join('; ')
    fields['Liens Notice of Default'] = s.noticesOfDefault.map((r) => r.date).join('; ')
    // District-wide, not this owner's debt — kept out of the lien list above.
    fields['Liens Special Assessment'] = (s.specialAssessments || []).map((r) => r.date).join('; ')
    fields['Liens Last Transfer'] = s.lastTransfer ? `${s.lastTransfer.date} ${s.lastTransfer.parties.map((p) => p.name).join(' -> ')}` : ''
    fields['Liens Documents'] = String(res.total || s.total)
    fields['Liens Summary'] = encumbranceSummary(s)
    // A short read must say so: a missing page of documents could hide a lien.
    fields['Liens Status'] = res.partial ? `partial (${s.total} of ${res.total} read)` : 'found'
  }

  async _redfinInBrowser(url) {
    try {
      if (!this._zpage || this._zpage.isClosed?.()) {
        const ctx = this._page && !this._page.isClosed?.() ? this._page.context() : await getContext()
        this._zpage = await ctx.newPage()
      }
      return await readRedfinInBrowser(this._zpage, url)
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 160) }
    }
  }

  async _permits(apn, signal) {
    if (!this.options.permits) return null
    const clean = String(apn || '').trim()
    if (!clean || clean === FIELD_NOT_FOUND) return { ok: false, error: 'no parcel number, so no permit search' }
    try {
      return await lookupPermits(clean, { splitApn, signal })
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 160) }
    }
  }

  _applyPermits(fields, res) {
    if (!this.options.permits) { fields['Permits Status'] = 'skipped'; return }
    if (!res) { fields['Permits Status'] = 'none'; return }
    if (!res.ok) {
      fields['Permits Status'] = /no parcel/i.test(res.error || '') ? 'no parcel number' : 'not found'
      return
    }
    const p = res.permits
    const v = res.violations
    // Street-space and sign permits say nothing about the building, so the count
    // is the substantive work, with the raw total behind it.
    fields['Permits Count'] = p.substantive === p.total ? String(p.total) : `${p.substantive} of ${p.total}`
    fields['Permits Open'] = String(p.open)
    fields['Permits Last Date'] = p.lastDate
    fields['Permits Last Work'] = p.lastDescription
    fields['Permits Total Value'] = p.totalValue ? `$${p.totalValue.toLocaleString('en-US')}` : ''
    fields['Violations Active'] = v.active ? `${v.active}${v.activeKinds ? ` (${v.activeKinds})` : ''}` : ''
    fields['Permits Status'] = 'found'
  }

  _applyRedfin(fields, rf) {
    if (!this.options.redfin) { fields['Redfin Status'] = 'skipped'; return }
    if (!rf) { fields['Redfin Status'] = 'none'; return }
    const la = rf.listingAgent || {}
    const ba = rf.buyerAgent || {}
    fields['Redfin Listing Agent'] = la.name || ''
    fields['Redfin Listing Brokerage'] = la.brokerage || ''
    fields['Redfin Listing Agent DRE'] = la.license || ''
    fields['Redfin Listing Agent Phone'] = la.phone || la.brokerPhone || ''
    fields['Redfin Listing Agent Email'] = la.email || ''
    fields['Redfin Buyer Agent'] = ba.name || ''
    fields['Redfin Buyer Brokerage'] = ba.brokerage || ''
    fields['Redfin Buyer Agent Phone'] = ba.phone || ba.brokerPhone || ''
    fields['Redfin MLS #'] = rf.mlsNumber || ''
    // Which sale the agents above belong to. Redfin names the most recent
    // listing's agents, so on a property that sold again this will not be the
    // sale in the operator's sheet.
    fields['Redfin Agents For'] = rf.agentsFor || ''
    fields['Redfin Deal Signals'] = (rf.signals || []).join(', ')
    // Remarks are what make the fixer / as-is filter possible, but a full MLS
    // write-up bloats the sheet, so keep the front of it.
    fields['Redfin Remarks'] = String(rf.remarks || '').slice(0, 500)
    fields['Redfin Status'] = rf.blocked ? 'blocked by Redfin' : rf.ok ? 'found' : 'not found'
  }

  // Do the two sites name the same agents? A disagreement is worth seeing: it
  // usually means one of them is showing a different listing.
  _crossCheckAgents(fields) {
    // "Alexander T. Clark" and "Alexander Clark" are one person. Compare first
    // and last name only, dropping middle initials and suffixes, so a middle
    // initial is not reported as the two sites disagreeing.
    const parts = (v) => {
      const words = String(v || '')
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((w) => !/^(jr|sr|ii|iii|iv|md|esq)$/.test(w))
        .filter((w) => w.length > 1)
      return words.length ? { first: words[0], last: words[words.length - 1] } : null
    }
    const same = (a, b) => {
      const x = parts(a)
      const y = parts(b)
      return Boolean(x && y) && x.first === y.first && x.last === y.last
    }
    const r = fields['Redfin Listing Agent']
    const z = fields['Zillow Listing Agent']
    if (r && z) fields['Agents Agree'] = same(r, z) ? 'yes' : 'no — the sites name different agents'
    else if (r) fields['Agents Agree'] = 'Redfin only'
    else if (z) fields['Agents Agree'] = 'Zillow only'
    else fields['Agents Agree'] = ''
  }

  _applyZillow(fields, z) {
    if (!this.options.zillowCheck || !z) return
    if (z.listingAgent) {
      fields['Zillow Listing Agent'] = z.listingAgent.name || ''
      fields['Zillow Listing Brokerage'] = z.listingAgent.brokerage || ''
      fields['Zillow Listing Agent Phone'] = z.listingAgent.phone || z.listingAgent.brokerPhone || ''
    }
    if (z.buyerAgent) fields['Zillow Buyer Agent'] = z.buyerAgent.name || ''
    if (z.propertyType) fields['Web Property Type'] = z.propertyType
    if (z.listingStatus) fields['Web Listing Status'] = z.listingStatus
    if (z.county) fields['Web County'] = z.county
    // The property page URL (with zpid) beats a search-result link.
    if (z.ok && /_zpid|homedetails/i.test(z.url || '')) fields['Web Zillow'] = z.url
    else if (!fields['Web Zillow'] && z.url) fields['Web Zillow'] = z.url
    if (z.blocked) fields['Web Listing Status'] = fields['Web Listing Status'] || 'blocked by Zillow'
  }

  // For the first few rows, log the JSON responses PropertyRadar's page fetches.
  // That sample (runs/<job>/network-sample.jsonl) is what lets us later read the
  // app's own data instead of the rendered text — the real speed-up.
  _attachNetworkCapture(page, i) {
    if (this._netRows >= NETWORK_SAMPLE_ROWS || !page) return null
    const lines = []
    const handler = async (resp) => {
      try {
        const url = resp.url()
        if (!/propertyradar\.com/i.test(url)) return
        const ct = resp.headers()['content-type'] || ''
        if (!/json/i.test(ct)) return
        let preview = ''
        try { preview = (await resp.text()).slice(0, 500) } catch { /* body gone */ }
        lines.push(JSON.stringify({ row: i, url, status: resp.status(), contentType: ct, preview }))
      } catch { /* ignore */ }
    }
    page.on('response', handler)
    return () => {
      page.off('response', handler)
      this._netRows++
      if (lines.length) {
        try { fs.appendFileSync(path.join(this.dir, 'network-sample.jsonl'), lines.join('\n') + '\n') } catch { /* ignore */ }
      }
    }
  }

  _applyPr(fields, prRes, address) {
    const d = prRes.data || {}
    const nf = (v) => (v && v !== FIELD_NOT_FOUND ? String(v).trim() : '')
    fields['PR Status'] = prRes.status
    if (prRes.status === 'found') {
      fields['PR Owner of Record'] = nf(d.ownerOfRecord) || nf(d.ownerName) || FIELD_NOT_FOUND
      fields['PR Taxpayer'] = nf(d.taxpayer)
      fields['PR Entity Owner'] = d.isEntityOwner ? 'Yes' : 'No'
      fields['PR Title Holder'] = nf(d.titleHolder)
      fields['PR Ownership Type'] = nf(d.ownershipType)
      fields['PR Vesting'] = nf(d.vesting)
      fields['PR Owner Mailing Address'] = nf(d.mailingAddress)
      fields['PR Occupancy'] = nf(d.occupancy)
      fields['PR APN'] = nf(d.apn)
      fields['PR Trust / Entity'] = nf(d.trustEntity)
      fields['PR County'] = nf(d.county)
      fields['PR Property Type'] = nf(d.propertyType)
      fields['PR Est. Value'] = nf(d.estValue)
      fields['PR Equity'] = nf(d.equity)
      fields['PR Assessed Value'] = nf(d.assessedValue)
      fields['PR Loan Balance'] = nf(d.loanBalance)
      fields['PR Purchase Price'] = nf(d.purchasePrice)
      fields['PR Purchase Date'] = nf(d.purchaseDate)
      fields['PR Purchase Type'] = nf(d.purchaseType)
      fields['PR Owned Since'] = nf(d.ownedSince)
      fields['PR Year Built'] = nf(d.yearBuilt)
      fields['PR Distress Score'] = nf(d.distressScore)
      fields['PR Homeowner Exemption'] = nf(d.homeownerExemption)
      fields['PR Likely to List for Sale'] = nf(d.likelyToList)
      fields['PR Prior Owner'] = nf(d.priorOwner)
      fields['PR Last Transfer'] = nf(d.lastTransfer)
      fields['PR Property Address'] = nf(d.propertyAddress)
      fields['PR Address Match'] = addressMatch(address, fields['PR Property Address'])
    } else if (prRes.status === 'not found') {
      // Never guess: the sheet says so explicitly where an owner was expected.
      fields['PR Owner of Record'] = FIELD_NOT_FOUND
    }
  }

  _applyWeb(fields, web) {
    if (!this.options.webSearch) { fields['Web Status'] = 'skipped'; return }
    if (!web) { fields['Web Status'] = 'none'; return }
    const L = web.links || {}
    fields['Web Zillow'] = L.zillow || ''
    fields['Web Redfin'] = L.redfin || ''
    fields['Web Realtor.com'] = L.realtor || ''
    fields['Web County Records'] = L.county || ''
    fields['Web Sold Price'] = web.soldPrice || ''
    fields['Web Sold Date'] = web.soldDate || ''
    fields['Web Status'] = web.ok ? `found (${web.provider})` : 'none'
  }

  _errorFields(i, err) {
    const fields = blankFields()
    fields['Enriched Address'] = this.addressFor(i)
    fields['Enriched At'] = new Date().toISOString()
    fields['PR Status'] = this._abort.signal.aborted ? 'stopped' : 'error'
    fields['Web Status'] = this._abort.signal.aborted ? 'stopped' : 'none'
    fields['Enrichment Notes'] = String(err?.message || err).slice(0, 300)
    return fields
  }

  // Synthetic row for DEMO_MODE: shows the shape of the output without any site.
  async _demoRow(fields, address) {
    await this._sleep(500 + Math.random() * 400)
    const n = (address.match(/^\d+/) || ['100'])[0]
    const entity = Number(n) % 7 === 0
    const missing = Number(n) % 11 === 0
    if (missing) {
      fields['PR Status'] = 'not found'
      fields['PR Owner of Record'] = FIELD_NOT_FOUND
      fields['Enrichment Notes'] = 'Demo: PropertyRadar found no match for this address.'
    } else {
      const owner = entity ? 'LAKEVIEW LN SERVICING LLC' : `Demo Owner ${n}`
      fields['PR Status'] = 'found'
      fields['PR Owner of Record'] = owner
      fields['PR Taxpayer'] = entity ? owner : `DEMO,OWNER ${n}`
      fields['PR Entity Owner'] = entity ? 'Yes' : 'No'
      fields['PR Title Holder'] = entity ? owner : ''
      fields['PR Ownership Type'] = entity ? 'Entity / REO' : 'Individual'
      fields['PR Vesting'] = entity ? '' : 'Husband and Wife as Joint Tenants'
      fields['PR Owner Mailing Address'] = entity ? 'PO Box 9000, Dallas, TX 75201' : address
      fields['PR Occupancy'] = entity ? 'Non-Owner Occupied' : 'Owner Occupied'
      fields['PR APN'] = `${String(n).padStart(4, '0')}-${String(Number(n) * 3).padStart(3, '0')}-${String(Number(n) % 100).padStart(3, '0')}`
      fields['PR Trust / Entity'] = entity ? owner : ''
      fields['PR Property Type'] = 'Single Family'
      fields['PR Est. Value'] = `$${(Number(n) * 9137 + 900000).toLocaleString('en-US')}`
      fields['PR Purchase Price'] = `$${(Number(n) * 9137 + 515000).toLocaleString('en-US')}`
      fields['PR Owned Since'] = 'Oct 2023'
      fields['PR Year Built'] = String(1900 + (Number(n) % 120))
      fields['PR County'] = 'SAN FRANCISCO'
      fields['PR Likely to List for Sale'] = `${40 + (Number(n) % 55)} - ${Number(n) % 2 ? 'High' : 'Medium'} (demo)`
      fields['PR Property Address'] = address.toUpperCase()
      fields['PR Address Match'] = 'match'
      fields['Enrichment Notes'] = entity ? `Demo: title held by entity "${owner}" — likely post-foreclosure/REO.` : 'Demo data — not a real record.'
    }
    if (this.options.webSearch) {
      const slug = address.replace(/[^A-Za-z0-9]+/g, '-')
      fields['Web Zillow'] = `https://www.zillow.com/homedetails/${slug}/demo_zpid/`
      fields['Web Redfin'] = `https://www.redfin.com/demo/${slug}`
      fields['Web Sold Price'] = `$${(Number(n) * 9137 + 515000).toLocaleString('en-US')}`
      fields['Web Sold Date'] = 'Mar 15, 2024'
      fields['Web Status'] = 'found (demo)'
    } else fields['Web Status'] = 'skipped'
    if (this.options.zillowCheck) {
      fields['Web Property Type'] = Number(n) % 5 === 0 ? 'Condo' : 'Single Family'
      fields['Web Listing Status'] = 'Off Market'
      fields['Web County'] = 'San Francisco'
      fields['Zillow Listing Agent'] = `Demo Listing Agent ${n}`
      fields['Zillow Listing Brokerage'] = Number(n) % 2 ? 'Compass' : 'The Front Steps'
      fields['Zillow Listing Agent Phone'] = '415-555-0100'
      fields['Zillow Buyer Agent'] = `Demo Buyer Agent ${n}`
    }
    if (this.options.redfin) {
      const fixer = Number(n) % 3 === 0
      const remarks = fixer
        ? 'Probate sale, sold strictly as-is. Contractor special, needs work throughout.'
        : 'Beautifully remodelled home with designer finishes throughout.'
      fields['Redfin Listing Agent'] = `Demo Listing Agent ${n}`
      fields['Redfin Listing Brokerage'] = Number(n) % 2 ? 'Compass' : 'The Front Steps'
      fields['Redfin Listing Agent DRE'] = `DRE #0${1000000 + Number(n)}`
      fields['Redfin Listing Agent Phone'] = '415-555-0100'
      fields['Redfin Listing Agent Email'] = `agent${n}@example.com`
      fields['Redfin Buyer Agent'] = `Demo Buyer Agent ${n}`
      fields['Redfin Buyer Brokerage'] = 'Demo Realty'
      fields['Redfin Buyer Agent Phone'] = '415-555-0199'
      fields['Redfin MLS #'] = `42${String(n).padStart(7, '0')}`
      fields['Redfin Agents For'] = 'Sold (MLS) Oct 23, 2023 for $1,850,000'
      fields['Redfin Remarks'] = remarks
      fields['Redfin Deal Signals'] = dealSignals(remarks).join(', ')
      fields['Redfin Status'] = 'found'
    } else fields['Redfin Status'] = 'skipped'
    if (this.options.liens) {
      const owes = Number(n) % 4 === 0
      fields['Liens Open Loans'] = owes ? '2' : '1'
      fields['Liens Unreleased'] = owes ? `ABSTRACT OF JUDGMENT 3/${(Number(n) % 27) + 1}/2019` : ''
      fields['Liens Last Transfer'] = `Oct 2023 DEMO SELLER -> Demo Owner ${n}`
      fields['Liens Documents'] = String(12 + (Number(n) % 40))
      fields['Liens Summary'] = owes ? '2 loans not shown released; ABSTRACT OF JUDGMENT (no release recorded)' : '1 loan not shown released'
      fields['Liens Status'] = 'found'
    } else fields['Liens Status'] = 'skipped'
    if (this.options.permits) {
      fields['Permits Count'] = String(3 + (Number(n) % 9))
      fields['Permits Open'] = String(Number(n) % 2)
      fields['Permits Last Date'] = 'Mar 27, 2019'
      fields['Permits Last Work'] = 'kitchen and bathroom remodel, demo only'
      fields['Permits Total Value'] = `$${(50000 + Number(n) * 37).toLocaleString('en-US')}`
      fields['Violations Active'] = Number(n) % 5 === 0 ? '1 (building section)' : ''
      fields['Permits Status'] = 'found'
    } else fields['Permits Status'] = 'skipped'
    this._crossCheckAgents(fields)
    return fields
  }

  // ---- results ------------------------------------------------------------------

  _record(i, fields, ms) {
    const evidence = fields._evidence || []
    delete fields._evidence
    const row = { i, address: fields['Enriched Address'], fields, ok: fields['PR Status'] === 'found', ms, at: new Date().toISOString(), evidence }
    this.results.set(i, row)
    this.durations.push(ms)
    if (this.durations.length > 10) this.durations.shift()
    try { fs.appendFileSync(path.join(this.dir, 'results.jsonl'), JSON.stringify(row) + '\n') } catch (err) { this._log(`Could not save row ${i + 1}: ${err.message}`, 'error') }
    this._emit('row', row)
    this._progress()
  }

  _finalize(state) {
    this.current = -1
    this.finishedAt = new Date().toISOString()
    this._closeZillowTab()
    if (this._restoreHeadless !== null) {
      config.headless = this._restoreHeadless
      this._restoreHeadless = null
    }
    const c = this.counts()
    const message =
      state === 'done'
        ? `Done. ${c.found} of ${c.total} rows found an owner; ${c.notFound} did not. Download the CSV to review.`
        : `Stopped at ${c.done} of ${c.total} rows. Start again to resume — finished rows are kept.`
    this._setState(state, message)
    this._emit('done', { state, ...c, message })
    return this.status()
  }

  _fail(message) {
    this.error = message
    this._log(message, 'error')
    this.current = -1
    this.finishedAt = new Date().toISOString()
    this._closeZillowTab()
    if (this._restoreHeadless !== null) {
      config.headless = this._restoreHeadless
      this._restoreHeadless = null
    }
    this._setState('error', message)
    this._emit('done', { state: 'error', ...this.counts(), message })
    return this.status()
  }

  _closeZillowTab() {
    const z = this._zpage
    this._zpage = null
    if (z) z.close().catch(() => {})
    const r = this._rpage
    this._rpage = null
    if (r) r.close().catch(() => {})
  }

  // The original sheet plus the enrichment columns. Rows not yet processed have
  // the new columns blank, so a partial download mid-run is still a valid file.
  outputCsv() {
    const headers = [...this.headers, ...this.outColumns]
    const records = this.records.map((rec, i) => {
      const r = this.results.get(i)
      const o = { ...rec }
      this.outColumns.forEach((col, k) => { o[col] = r ? r.fields[ENRICH_COLUMNS[k]] ?? '' : '' })
      return o
    })
    return toCsv(headers, records)
  }

  outputFilename() {
    return this.filename.replace(/\.csv$/i, '') + '-enriched.csv'
  }
}
