// Goal 2 — the ranked listing-agent list.
//
// Goal 1 run backwards. Instead of one address in, the whole city: every San
// Francisco sale for 24 months, filtered to the kind of property we buy,
// grouped by the agent who listed it.
//
// The brief says "groups by listing agent and counts", and count is the primary
// ranking here. The other measures ride alongside as columns rather than being
// folded into a score, because a score hides its own reasoning and an operator
// ranking a call list should be able to sort on what they care about.

import { AGENT_DEAL_SIGNALS } from './sources/redfin.js'

// Two spellings of one person. Middle initials and suffixes vary between
// listings, so compare first and last name, and keep the brokerage out of it —
// agents move firms and are still the same person.
export function personKey(name = '') {
  const words = String(name)
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^(jr|sr|ii|iii|iv|md|esq|dr|mr|mrs|ms)$/.test(w))
    .filter((w) => w.length > 1)
  if (!words.length) return ''
  return `${words[0]} ${words[words.length - 1]}`
}

// The surname on its own, used only to reunite an abbreviated name with a full
// one. "K. Kohlmyer" loses its initial to the length filter above and would
// otherwise become a second, phantom agent.
export function surnameOf(name = '') {
  const key = personKey(name)
  return key ? key.split(' ').pop() : ''
}

/**
 * Fold abbreviated names into full ones, but only when it is unambiguous.
 *
 * "K. Kohlmyer" joins "Kenneth Kohlmyer" when Kohlmyer is the only full name
 * with that surname. If two Kohlmyers are listing in the city, the abbreviated
 * one stays on its own — splitting one agent into two rows is an annoyance,
 * while merging two people into one is a wrong phone number on a call list.
 */
export function mergeAbbreviatedKeys(keys = []) {
  const map = new Map(keys.map((k) => [k, k]))
  const bySurname = new Map()
  for (const k of keys) {
    const [first, last] = k.split(' ')
    if (first === last) continue // surname-only, nothing to be the target of
    if (!bySurname.has(last)) bySurname.set(last, [])
    bySurname.get(last).push(k)
  }
  for (const k of keys) {
    const [first, last] = k.split(' ')
    if (first !== last) continue
    const candidates = bySurname.get(last) || []
    if (candidates.length === 1) map.set(k, candidates[0])
  }
  return map
}

const median = (ns) => {
  const v = ns.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2)
}

// The best-filled version of a value across a person's listings: agents appear
// with a phone on one listing and an email on another.
const firstFilled = (rows, pick) => rows.map(pick).map((v) => String(v || '').trim()).find(Boolean) || ''

/**
 * Property rows into ranked agents.
 *
 * Each row is what one Redfin property page gave us:
 *   { url, address, soldDate, price, dom, listingAgent, signals, buyerBrokerage }
 *
 * A row counts as "our kind of deal" when its remarks carried at least one of
 * the deal signals goal 1 already matches.
 */
/**
 * @param {object} opts
 * @param {number} [opts.minDeals]
 *   Drop agents below this many of our deals. Deliberately not offered in the
 *   tab: the list comes out ranked, so the cut to a callable size is better
 *   made after seeing it than guessed at before a four-hour run. A raw count
 *   is also the crudest measure here — share of their business says more about
 *   who works our kind of property than the count alone does.
 * @param {boolean} [opts.prefiltered]
 *   True when the search itself only returned our kind of deal. Redfin's
 *   Fixer-upper checkbox does that; its keyword box does NOT, whatever the
 *   filter panel suggests — the keyword never reaches the URL, so it cannot
 *   narrow a crawl. The cost of a genuinely pre-filtered run is the
 *   denominator: with nothing but our kind in it, "share of their business"
 *   would read 100% for everyone, which is worse than useless. So it is left
 *   blank instead.
 */
export function rollupAgents(rows = [], { minDeals = 1, prefiltered = false } = {}) {
  const first = new Map()
  for (const r of rows) {
    const key = personKey(r?.listingAgent?.name)
    if (!key) continue
    if (!first.has(key)) first.set(key, [])
    first.get(key).push(r)
  }
  // Second pass: "K. Kohlmyer" is Kenneth, when there is only one Kohlmyer.
  const merge = mergeAbbreviatedKeys([...first.keys()])
  const byPerson = new Map()
  for (const [key, listings] of first) {
    const target = merge.get(key) || key
    if (!byPerson.has(target)) byPerson.set(target, [])
    byPerson.get(target).push(...listings)
  }

  const agents = []
  for (const [key, listings] of byPerson) {
    const ours = listings.filter((r) => (r.signals || []).length)
    if (ours.length < minDeals) continue
    const dates = ours.map((r) => (r.soldDate ? new Date(r.soldDate) : null)).filter((d) => d && !Number.isNaN(d.getTime()))
    dates.sort((a, b) => b - a)
    // Which signals this agent actually sees, most common first.
    const tally = {}
    for (const r of ours) for (const s of r.signals || []) tally[s] = (tally[s] || 0) + 1
    const kinds = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} (${n})`)
    agents.push({
      key,
      // Prefer the fullest spelling seen: "Kenneth Kohlmyer" over "K. Kohlmyer".
      name: listings
        .map((r) => String(r.listingAgent?.name || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] || '',
      brokerage: firstFilled(listings, (r) => r.listingAgent?.brokerage),
      license: firstFilled(listings, (r) => r.listingAgent?.license),
      phone: firstFilled(listings, (r) => r.listingAgent?.phone || r.listingAgent?.brokerPhone),
      email: firstFilled(listings, (r) => r.listingAgent?.email),
      ourDeals: ours.length,
      totalSales: listings.length,
      // How much of their business we are. An agent doing 3 of 5 cares far more
      // than one doing 3 of 90.
      share: prefiltered ? null : listings.length ? Math.round((ours.length / listings.length) * 100) : 0,
      lastDeal: dates[0] ? dates[0].toISOString().slice(0, 10) : '',
      // Their as-is listings sitting on the market is the opening line of the
      // call: that is the problem a cash buyer solves.
      medianDom: median(ours.map((r) => r.dom)),
      medianPrice: median(ours.map((r) => r.price)),
      signals: kinds.join(', '),
      examples: ours.slice(0, 3).map((r) => r.address).filter(Boolean).join(' | '),
    })
  }

  // The brief's ranking: how many of our kind of deal they closed. Ties broken
  // by share, then by recency, so a specialist beats a generalist.
  agents.sort((a, b) => b.ourDeals - a.ourDeals || b.share - a.share || String(b.lastDeal).localeCompare(String(a.lastDeal)))
  return agents
}

export const AGENT_COLUMNS = [
  'Agent',
  'Brokerage',
  'DRE',
  'Phone',
  'Email',
  'Our Deals',
  'Total Sales',
  'Share %',
  'Last Deal',
  'Median DOM',
  'Median Price',
  'Signals',
  'Example Properties',
]

export function agentsToRows(agents = []) {
  return agents.map((a) => ({
    Agent: a.name,
    Brokerage: a.brokerage,
    DRE: a.license,
    Phone: a.phone,
    Email: a.email,
    'Our Deals': String(a.ourDeals),
    'Total Sales': String(a.totalSales),
    'Share %': a.share == null ? '' : String(a.share),
    'Last Deal': a.lastDeal,
    'Median DOM': a.medianDom == null ? '' : String(a.medianDom),
    'Median Price': a.medianPrice == null ? '' : `$${a.medianPrice.toLocaleString('en-US')}`,
    Signals: a.signals,
    'Example Properties': a.examples,
  }))
}

// What the whole run found, for the operator to sanity-check the shape of the
// answer before acting on it.
export function rollupSummary(rows = [], agents = []) {
  const withAgent = rows.filter((r) => r?.listingAgent?.name).length
  const ours = rows.filter((r) => (r.signals || []).length).length
  return {
    properties: rows.length,
    withAgent,
    ourKind: ours,
    ourKindPercent: rows.length ? Math.round((ours / rows.length) * 100) : 0,
    agents: agents.length,
    namedSignals: AGENT_DEAL_SIGNALS,
  }
}

// ---------------------------------------------------------------------------------
// The runner.
//
// No browser. Every property is a plain fetch of a page Redfin serves, which is
// what makes a ten-thousand-row job practical at all: nothing to log into,
// nothing to kick, and a stopped run picks up where it left off.
// ---------------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { toCsv } from './csv.js'
import { lookupRedfin, describePage } from './sources/redfin.js'
import { mergeSearchExports } from './sources/redfin-search.js'
import { crawlSearch, normaliseSearchUrl, soldSearchUrl } from './sources/redfin-crawl.js'

const jobDir = (id) => path.join(config.runsDir, id)
// Redfin serves these pages to anyone, but ten thousand of them in a night is
// not nothing. Default to a pace a person could plausibly browse at.
const DEFAULT_DELAY_MS = 1500
// Consecutive blocks that mean "stop asking" rather than "try again".
const BLOCK_PAUSE_AFTER = 5
// Whole pages kept when a property reads but yields nothing.
const MISS_PAGES_KEPT = 3
// Walking the search is lighter than reading properties — one page hands back
// forty of them — but it is still Redfin, so it gets its own gentler pace.
const DEFAULT_CRAWL_DELAY_MS = 1200

export class AgentList extends EventEmitter {
  constructor(job) {
    super()
    Object.assign(this, job)
    this.dir = jobDir(this.id)
    this.results = new Map()
    this.state = job.state || 'ready'
    this.options = { delayMs: DEFAULT_DELAY_MS, minDeals: 1, crawlDelayMs: DEFAULT_CRAWL_DELAY_MS, maxPages: 400, ...(job.options || {}) }
    this.search = job.search || null
    this.crawl = job.crawl || null
    this._abort = new AbortController()
    this._pauseGate = null
    this._resume = null
    this._blockStreak = 0
    this._loadResults()
  }

  static create({ files = [] }) {
    const merged = mergeSearchExports(files.map((f) => f.text))
    if (!merged.ok) throw new Error(merged.errors[0] || 'No Redfin property links in those files.')
    const id = `agents_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const job = {
      id,
      createdAt: new Date().toISOString(),
      filenames: files.map((f) => String(f.name || 'export.csv').slice(0, 80)),
      properties: merged.rows,
      warnings: merged.errors,
      options: {},
      state: 'ready',
    }
    const a = new AgentList(job)
    fs.mkdirSync(a.dir, { recursive: true })
    a._saveJob()
    return a
  }

  /**
   * Start from a Redfin search instead of downloaded files.
   *
   * Redfin's own "Download All" caps at 350 rows a file, so covering the city
   * that way is roughly forty downloads by hand. This walks the same pages
   * instead. Nothing is fetched here — the job is created empty and the crawl
   * runs when the operator starts it, so a mistyped URL costs nothing.
   */
  static createFromSearch({ searchUrl, months, propertyTypes } = {}) {
    const wanted = searchUrl ? normaliseSearchUrl(searchUrl) : { ok: true, url: soldSearchUrl({ months, propertyTypes }), sold: true }
    if (!wanted.ok) throw new Error(wanted.error)
    const id = `agents_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const job = {
      id,
      createdAt: new Date().toISOString(),
      filenames: [],
      search: { url: wanted.url, sold: wanted.sold },
      properties: [],
      // A search that is not restricted to sold homes will hand back listings
      // that are still for sale, which have no selling agent yet. Say so rather
      // than letting it show up later as a column of blanks.
      warnings: wanted.sold ? [] : ['This search is not limited to sold homes, so some properties will have no sale and no agent to group by. Add the "Sold" filter on Redfin and paste the URL again if that is not what you meant.'],
      options: {},
      state: 'ready',
    }
    const a = new AgentList(job)
    fs.mkdirSync(a.dir, { recursive: true })
    a._saveJob()
    return a
  }

  static load(id) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf-8'))
      return new AgentList(job)
    } catch {
      return null
    }
  }

  static list() {
    try {
      return fs
        .readdirSync(config.runsDir)
        .filter((d) => d.startsWith('agents_'))
        .map((d) => AgentList.load(d))
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((a) => a.status())
    } catch {
      return []
    }
  }

  _saveJob() {
    fs.mkdirSync(this.dir, { recursive: true })
    const job = {
      id: this.id,
      createdAt: this.createdAt,
      filenames: this.filenames,
      search: this.search,
      crawl: this.crawl,
      properties: this.properties,
      warnings: this.warnings,
      options: this.options,
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
    }
    fs.writeFileSync(path.join(this.dir, 'job.json'), JSON.stringify(job))
  }

  // Every property already read, so a restart costs nothing.
  _loadResults() {
    try {
      for (const line of fs.readFileSync(path.join(this.dir, 'results.jsonl'), 'utf-8').split('\n')) {
        if (!line.trim()) continue
        const row = JSON.parse(line)
        if (row?.url) this.results.set(row.url, row)
      }
    } catch { /* nothing read yet */ }
  }

  _emit(sub, data) { this.emit('event', { type: 'agents', id: this.id, sub, ...data }) }
  _log(message, level = 'info') { this._emit('log', { message, level }) }

  _setState(state, message) {
    if (state === 'paused' && message) this._lastPauseMessage = message
    this.state = state
    this._saveJob()
    this._emit('state', { state, message })
    if (message) this._log(message, 'state')
  }

  isActive() { return ['running', 'paused', 'crawling'].includes(this.state) }

  setOptions(opts = {}) {
    if (this.isActive()) throw new Error('Options cannot change while the run is going.')
    if (opts.delayMs != null) {
      const n = parseInt(opts.delayMs, 10)
      if (!Number.isNaN(n)) this.options.delayMs = Math.min(Math.max(n, 250), 60000)
    }
    if (opts.minDeals != null) {
      const n = parseInt(opts.minDeals, 10)
      if (!Number.isNaN(n)) this.options.minDeals = Math.min(Math.max(n, 1), 50)
    }
    if (opts.crawlDelayMs != null) {
      const n = parseInt(opts.crawlDelayMs, 10)
      if (!Number.isNaN(n)) this.options.crawlDelayMs = Math.min(Math.max(n, 250), 60000)
    }
    if (opts.maxPages != null) {
      const n = parseInt(opts.maxPages, 10)
      if (!Number.isNaN(n)) this.options.maxPages = Math.min(Math.max(n, 1), 1000)
    }
    this._saveJob()
  }

  pause() {
    if (this.state !== 'running') return
    this._pauseGate = new Promise((res) => (this._resume = res))
    this._setState('paused', 'Paused.')
  }

  resume() {
    if (this.state !== 'paused') return
    this._setState('running', 'Resumed.')
    this._resume?.()
    this._pauseGate = null
    this._resume = null
    this._blockStreak = 0
  }

  stop() {
    if (!this.isActive()) return
    this._abort.abort()
    this._resume?.()
    this._setState('stopped', 'Stopped.')
  }

  counts() {
    const read = [...this.results.values()]
    return {
      total: this.properties.length,
      read: read.length,
      withAgent: read.filter((r) => r.listingAgent?.name).length,
      ourKind: read.filter((r) => (r.signals || []).length).length,
      blocked: read.filter((r) => r.blocked).length,
    }
  }

  status() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      filenames: this.filenames,
      source: this.search?.url ? 'search' : 'files',
      searchUrl: this.search?.url || '',
      crawl: this.crawl || null,
      warnings: this.warnings || [],
      state: this.state,
      options: this.options,
      error: this.error,
      ...this.counts(),
      etaMinutes: this._eta(),
    }
  }

  _eta() {
    // Before the search has been walked there is nothing to estimate from, and
    // "0 minutes" would read as "nearly done".
    if (!this.properties.length && this.search?.url) return null
    const left = this.properties.length - this.results.size
    if (left <= 0) return 0
    return Math.round((left * (this.options.delayMs + 900)) / 60000)
  }

  async _sleep(ms) {
    await new Promise((r) => {
      const t = setTimeout(r, ms)
      this._abort.signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
    })
  }

  async _waitIfPaused() { if (this._pauseGate) await this._pauseGate }

  /**
   * Walk the search and collect the properties to read.
   *
   * Kept separate from the reading pass so an operator can see how big the job
   * is before committing to hours of it, and so a run that was stopped during
   * the crawl resumes from the pages it already has rather than starting over.
   */
  async findProperties() {
    if (!this.search?.url) throw new Error('This run was built from files, not a search.')
    if (this.isActive()) throw new Error('This run is already going.')
    this._abort = new AbortController()

    // Pick up where the last pass stopped rather than re-walking the whole
    // search. Two pages of overlap, because the result order shifts as new
    // sales land and resuming exactly where we stopped could step over a
    // property that moved down a page. Duplicates are free; a skipped
    // property is invisible.
    const done = this.crawl?.through || 0
    const startPage = done > 0 && this.crawl?.totalPages && done < this.crawl.totalPages ? Math.max(1, done - 1) : 1
    this._setState('crawling', startPage > 1 ? `Walking ${this.search.url} from page ${startPage}.` : `Walking ${this.search.url}`)

    const res = await crawlSearch(this.search.url, {
      maxPages: this.options.maxPages,
      delayMs: this.options.crawlDelayMs,
      startPage,
      signal: this._abort.signal,
      onPage: (p) => {
        this._emit('crawl', p)
        if (p.page === 1 || p.page % 10 === 0) this._log(`Page ${p.page}${p.totalPages ? ` of ${p.totalPages}` : ''} — ${p.collected} properties so far.`)
      },
    })

    // Keep whatever was collected even on a partial or failed crawl: a stopped
    // run with 2,000 properties is worth more than nothing, and the operator
    // can crawl again to top it up.
    const known = new Set(this.properties.map((p) => p.url))
    for (const p of res.properties) {
      if (!known.has(p.url)) { known.add(p.url); this.properties.push({ url: p.url, address: p.address, price: p.price, soldDate: '', dom: null, propertyType: '' }) }
    }
    this.crawl = {
      at: new Date().toISOString(),
      // How far into the search we have got, not how many pages this pass
      // fetched — a resume reads few pages but covers many.
      through: Math.max(done, res.through),
      pagesRead: (this.crawl?.pagesRead || 0) + res.pagesRead,
      totalPages: res.totalPages || this.crawl?.totalPages || 0,
      partial: res.partial,
      refused: res.refused,
      error: res.error,
    }
    this.crawl.partial = Boolean(this.crawl.totalPages) && this.crawl.through < this.crawl.totalPages
    this._saveJob()

    if (res.refused) {
      const got = this.properties.length ? `${this.properties.length} properties collected so far are saved. ` : ''
      this._setState('ready', `${res.error || 'Redfin returned a page with no properties on it.'} ${got}Wait a while, raise the pause between pages, then press "Walk the rest of the search" — it picks up where it stopped.`)
    } else if (res.error) {
      this._setState('ready', `Stopped at page ${this.crawl.through}${this.crawl.totalPages ? ` of ${this.crawl.totalPages}` : ''}: ${res.error}. ${this.properties.length} properties collected — walk it again to pick up the rest, or start the run on what there is.`)
    } else if (this.crawl.partial) {
      this._setState('ready', `Stopped at page ${this.crawl.through} of ${this.crawl.totalPages}. ${this.properties.length} properties collected — that is part of the search, not all of it. Walk it again to pick up the rest.`)
    } else {
      this._setState('ready', `${this.properties.length} properties found across ${this.crawl.through} page${this.crawl.through === 1 ? '' : 's'} — the whole search.`)
    }
    this._emit('crawled', { ...this.status(), properties: this.properties.length })
    return this.status()
  }

  async start() {
    if (this.isActive()) throw new Error('This run is already going.')
    // A run started straight from a search walks it first; a run that already
    // has its properties goes straight to reading them.
    if (!this.properties.length && this.search?.url) {
      await this.findProperties()
      if (this.state === 'stopped' || !this.properties.length) return this.status()
    }
    this._abort = new AbortController()
    this.startedAt = new Date().toISOString()
    this.error = ''
    this._setState('running', `Reading ${this.properties.length - this.results.size} properties.`)

    const pending = this.properties.filter((p) => !this.results.has(p.url))
    for (const [k, prop] of pending.entries()) {
      if (this.state === 'stopped') break
      await this._waitIfPaused()
      if (this.state === 'stopped') break

      const t0 = Date.now()
      let res
      let miss = null
      try {
        res = await lookupRedfin(prop.url, {
          signal: this._abort.signal,
          retries: 1,
          // A page that loaded and gave us nothing is the failure worth keeping.
          // Describe every one of them, and save the first few in full, so
          // "no agent or remarks" can be told apart from a soft block without
          // anyone having to reproduce it.
          onMiss: (html) => { miss = describePage(html); this._keepMiss(prop, html) },
        })
      } catch (err) {
        res = { ok: false, error: String(err?.message || err).slice(0, 160) }
      }

      // A block is not a miss: the page exists, we were told to go away. Record
      // it as such so a later pass can pick these up rather than treating them
      // as properties with no agent.
      //
      // The streak counts every consecutive failure, not only the refusals we
      // recognise. A run that cannot read anything must stop and say so —
      // whatever the reason — rather than spend three hours proving it. Only a
      // property actually read clears it.
      if (res?.ok) {
        this._blockStreak = 0
      } else {
        this._blockStreak++
        if (this._blockStreak >= BLOCK_PAUSE_AFTER) {
          const why = res?.blocked
            ? `Redfin has refused ${this._blockStreak} properties in a row.`
            : `${this._blockStreak} properties in a row failed to read. The last said: ${String(res?.error || 'no reason given').slice(0, 120)}. ${this.missSummary()}`.trim()
          this._setState('paused', `${why} Paused rather than working through the rest of the list getting nothing. Wait a while, raise the pause between properties, then Resume. Everything read so far is saved.`)
          this._pauseGate = new Promise((r) => (this._resume = r))
          await this._waitIfPaused()
          if (this.state === 'stopped') break
        }
      }

      this._record(prop, res, Date.now() - t0, miss)

      if (k < pending.length - 1 && this.state !== 'stopped') {
        const base = this.options.delayMs
        await this._sleep(base + Math.round(Math.random() * base * 0.4))
      }
    }
    return this._finalize(this.state === 'stopped' ? 'stopped' : 'done')
  }

  // Keep at most a handful of whole pages: enough to diagnose, not enough to
  // fill the disk when a run of 8,000 properties goes wrong from the start.
  _keepMiss(prop, html) {
    this._missesKept = this._missesKept || 0
    if (this._missesKept >= MISS_PAGES_KEPT || !html) return
    this._missesKept++
    try {
      const dir = path.join(this.dir, 'evidence')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `miss-${this._missesKept}.html`), String(html))
      this._log(`Kept the page that gave nothing for ${prop.address || prop.url} as evidence/miss-${this._missesKept}.html`, 'warn')
    } catch { /* evidence is best effort */ }
  }

  _record(prop, res, ms, miss = null) {
    const row = {
      url: prop.url,
      // A crawl gives us the address and price off the search card and no sale
      // date; the property page gives us all three. Prefer what the crawl or
      // the export said, and fill the gaps from the page we just read.
      address: prop.address || '',
      soldDate: prop.soldDate || res?.latestSale?.date || '',
      price: prop.price ?? res?.latestSale?.price ?? null,
      dom: prop.dom,
      propertyType: prop.propertyType,
      listingAgent: res?.listingAgent || null,
      buyerAgent: res?.buyerAgent || null,
      signals: res?.signals || [],
      remarks: String(res?.remarks || '').slice(0, 300),
      blocked: Boolean(res?.blocked),
      error: res?.ok ? '' : String(res?.error || '').slice(0, 160),
      miss,
      at: new Date().toISOString(),
      ms,
    }
    this.results.set(row.url, row)
    try { fs.appendFileSync(path.join(this.dir, 'results.jsonl'), JSON.stringify(row) + '\n') } catch (err) { this._log(`Could not save ${row.url}: ${err.message}`, 'error') }
    this._emit('row', { row, ...this.counts(), etaMinutes: this._eta() })
  }

  /**
   * Why a run produced no agents.
   *
   * "0 agents" on its own is indistinguishable between Redfin refusing every
   * page, a layout change that broke the agent parser, and a search that
   * genuinely holds none of our kind of property. Those need three different
   * responses from the operator, so the run has to say which it was.
   */
  /**
   * What the pages that gave us nothing actually were.
   *
   * Present-but-unparsed means the reader has stopped understanding Redfin's
   * markup and needs fixing. Absent means we were served something that is not
   * the property page, which is a soft block and needs waiting, not code.
   */
  missSummary() {
    const misses = [...this.results.values()].map((r) => r.miss).filter(Boolean)
    if (!misses.length) return ''
    const withKeys = misses.filter((m) => m.hasListingAgents || m.hasRemarks).length
    const tiny = misses.filter((m) => m.bytes < 5000).length
    const titles = [...new Set(misses.map((m) => m.title).filter(Boolean))].slice(0, 2)
    if (withKeys >= misses.length * 0.5) {
      return `${withKeys} of ${misses.length} still carried Redfin's own agent data, so the pages are real and the reader has stopped understanding them. That is a bug here, not a block — send me evidence/miss-1.html.`
    }
    const what = tiny >= misses.length * 0.5
      ? `${tiny} of ${misses.length} came back nearly empty`
      : `none of the ${misses.length} carried Redfin's agent data`
    return `${what}${titles.length ? `, titled ${titles.map((t) => `"${t}"`).join(' / ')}` : ''}, so Redfin is serving something other than the property page. That is a soft block: wait, raise the pause, then Resume.`
  }

  diagnosis() {
    const c = this.counts()
    if (!c.read) return ''
    if (c.blocked >= c.read * 0.5) {
      return `Redfin refused ${c.blocked} of ${c.read} properties, so this is about being blocked, not about the search. Wait a few hours, raise the pause between properties to 4 or 5 seconds, and Resume — the ones already read are kept.`
    }
    if (!c.withAgent) {
      const why = this.missSummary()
      return `${c.read} properties were read but not one carried a listing agent. ${why || 'Download the working to see what came back.'}`
    }
    if (!c.ourKind) {
      return `${c.withAgent} listing agents were found, but none of the ${c.read} properties read as fixer, probate, trust sale or as-is, so there is nothing to rank. Either the search is pointed at the wrong kind of property, or it is too small a slice to contain any.`
    }
    return ''
  }

  _finalize(state) {
    this.finishedAt = new Date().toISOString()
    const c = this.counts()
    this._setState(state)
    const agents = this.agents()
    const why = agents.length ? '' : this.diagnosis()
    const headline = state === 'stopped'
      ? `Stopped — ${c.read} of ${c.total} properties read, ${agents.length} agents so far.`
      : `Done — ${c.read} properties, ${c.ourKind} of our kind, ${agents.length} agents.`
    this._emit('done', { state, ...c, agents: agents.length, diagnosis: why, message: why ? `${headline} ${why}` : headline })
    return this.status()
  }

  // Everything read was our kind of deal, so the search did the filtering and
  // "share of their business" has no denominator to work from.
  isPrefiltered() {
    const read = [...this.results.values()].filter((r) => r.listingAgent?.name)
    if (read.length < 5) return false
    return read.every((r) => (r.signals || []).length)
  }

  agents() {
    return rollupAgents([...this.results.values()], { minDeals: this.options.minDeals, prefiltered: this.isPrefiltered() })
  }

  summary() { return rollupSummary([...this.results.values()], this.agents()) }

  // The deliverable: the ranked list.
  outputCsv() { return toCsv(AGENT_COLUMNS, agentsToRows(this.agents())) }

  // The working behind it, so any name on the list can be checked.
  propertiesCsv() {
    const cols = ['Address', 'Sold Date', 'Price', 'DOM', 'Listing Agent', 'Brokerage', 'DRE', 'Phone', 'Email', 'Signals', 'Remarks', 'Status', 'URL']
    const rows = [...this.results.values()].map((r) => ({
      Address: r.address,
      'Sold Date': r.soldDate,
      Price: r.price == null ? '' : `$${Number(r.price).toLocaleString('en-US')}`,
      DOM: r.dom == null ? '' : String(r.dom),
      'Listing Agent': r.listingAgent?.name || '',
      Brokerage: r.listingAgent?.brokerage || '',
      DRE: r.listingAgent?.license || '',
      Phone: r.listingAgent?.phone || r.listingAgent?.brokerPhone || '',
      Email: r.listingAgent?.email || '',
      Signals: (r.signals || []).join(', '),
      Remarks: r.remarks,
      Status: r.blocked ? 'blocked by Redfin' : r.listingAgent?.name ? 'read' : r.error || 'no agent on the page',
      URL: r.url,
    }))
    return toCsv(cols, rows)
  }

  outputFilename() { return `sf-listing-agents-${String(this.createdAt).slice(0, 10)}.csv` }
}
