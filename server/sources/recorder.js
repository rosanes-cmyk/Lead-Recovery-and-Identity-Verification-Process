// San Francisco Assessor-Recorder — the recorded chain of title, which is
// where liens live.
//
// The public index at recorder.sfgov.org covers everything recorded from
// 28 Dec 1989 onward, free to search, and it is keyed by BLOCK and LOT — the
// parcel number this tool already reads off PropertyRadar.
//
// Search by parcel, never by name. Proven on 547 Missouri St: the parcel
// search returned 55 documents, the whole history of the property. A name
// search for its owner returned six, three of which were abstracts of judgment
// against a MICHAEL A WINTERS and a MICHAEL P WINTERS — different people with
// the same common name. Keying on a name would attach a stranger's collections
// judgment to your seller.
//
// What the index does and does not say: it records that a document exists, its
// type, its date and the parties to it. It does not carry amounts, and it does
// not link a release back to the specific loan it cleared. So this module
// reports what is *unreleased in the index*, never "a lien is owed".

export const RECORDER_HOST = 'https://recorder.sfgov.org'
export const SEARCH_PATH = '/SearchService/api/Search/GetSearchResults'
// The index starts here; asking for earlier returns nothing.
export const INDEX_STARTS = '12/28/1989'

// Document kinds, matched against the rendered title text. A single filing can
// carry several titles, joined by <br/> — "SUBSTITUTION TRUSTEE<br/>RECONVEYANCE".
// Order matters. A release is matched before the thing it releases, and an
// assignment before the loan it mentions: "ASSGN DEED OF TRUST" moves an
// existing loan between lenders, it does not add a second loan.
const KINDS = [
  // No trailing \b after these stems: the recorder writes RECONVEYANCE, and
  // \bRECONVEY\b would never match it.
  ['release', /\b(RECONVEY|RELEAS|SATISF|CANCELLATION|WITHDRAWAL OF|TERMINATION)/i],
  ['default', /\b(NOTICE OF DEFAULT|NOD\b|NOTICE OF TRUSTEE|NOTICE OF SALE|TRUSTEES? SALE)/i],
  ['judgment', /\b(ABSTRACT OF JUDG|JUDGMENT|JUDGEMENT)/i],
  // A Notice of Special Tax Lien is a Mello-Roos community facilities district
  // recorded against EVERY parcel in the district, not a debt of this owner. It
  // appeared on 15 of 15 San Francisco parcels in a live run, so counting it as
  // an unreleased lien makes the column pure noise. Matched before tax-lien so
  // a genuine federal or state tax lien is still caught.
  ['special-assessment', /\b(SPECIAL TAX|SPCL TAX|SPEC TAX|MELLO[- ]?ROOS|COMMUNITY FACILITIES)/i],
  ['tax-lien', /\b(TAX LIEN|FEDERAL TAX|STATE TAX|NOTICE OF LIEN)/i],
  ['mechanics-lien', /\b(MECHANIC|CLAIM OF LIEN|STOP NOTICE)/i],
  ['assessment-lien', /\b(ASSESSMENT (DISTRICT|LIEN)|HOA\b|HOMEOWNER.{0,3}ASSOC)/i],
  ['loan-assignment', /\b(ASSGN|ASGT|ASSIGNMENT)\b/i],
  ['loan', /\b(DEED OF TRUST|MORTGAGE)\b/i],
  ['transfer', /\b(GRANT DEED|QUITCLAIM|QUIT CLAIM|INTERSPOUSAL|TRUSTEES? DEED|DEED IN LIEU|DEED)\b/i],
]

// Anything that encumbers the property and is not a loan. These are what people
// mean by "liens" in the everyday sense.
const ENCUMBRANCES = new Set(['judgment', 'tax-lien', 'mechanics-lien', 'assessment-lien'])

export function classifyTitle(title = '') {
  const t = String(title || '').trim()
  if (!t) return 'other'
  // A release wins over whatever it releases: "SUBSTITUTION TRUSTEE +
  // RECONVEYANCE" clears a loan, it does not create one.
  for (const [kind, re] of KINDS) if (re.test(t)) return kind
  return 'other'
}

export function splitTitles(raw = '') {
  return String(raw || '')
    .split(/<br\s*\/?>|\n/i)
    .map((s) => s.trim())
    .filter(Boolean)
}

// "(R) WESTEN DAVID<br/>(E) WINTERS MICHAEL" — R is the grantor (the party
// giving something up), E the grantee (the party receiving).
export function splitParties(raw = '') {
  return splitTitles(raw)
    .map((line) => {
      const m = line.match(/^\(([RE])\)\s*(.+)$/i)
      if (!m) return { role: 'unknown', name: line.trim() }
      return { role: m[1].toUpperCase() === 'R' ? 'grantor' : 'grantee', name: m[2].trim() }
    })
    .filter((p) => p.name)
}

function toDate(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseSearchResults(payload) {
  let data = payload
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload) } catch { return { ok: false, total: 0, rows: [], error: 'Recorder returned something that is not JSON.' } }
  }
  if (!data || !Array.isArray(data.SearchResults)) return { ok: false, total: 0, rows: [], error: 'Recorder returned no result list.' }
  const rows = data.SearchResults.map((r) => {
    const titles = splitTitles(r.FilingCode)
    const kinds = titles.map(classifyTitle)
    return {
      docNumber: String(r.PrimaryDocNumber || '').trim(),
      date: String(r.DocumentDate || '').trim(),
      when: toDate(r.DocumentDate),
      titles,
      kinds,
      // One filing, one headline kind: a release first, then anything that
      // encumbers, then the rest.
      kind: kinds.includes('release') ? 'release' : kinds.find((k) => k !== 'other') || 'other',
      parties: splitParties(r.Names),
    }
  })
  return { ok: true, total: Number(data.ResultCount) || rows.length, rows, error: '' }
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

// Two party names that plainly refer to the same party. Deliberately strict:
// a shared surname is not a match, because that is the trap the name search
// walked into.
export function samePartyName(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  return x.startsWith(y + ' ') || y.startsWith(x + ' ')
}

/**
 * What the index says is still hanging over this parcel.
 *
 * Loans and releases are counted from the most recent transfer onward, because
 * a sale clears the seller's loans and the reconveyances often land weeks after
 * the deed. Encumbrances (judgments, tax and mechanics liens) are matched to a
 * later release naming the same party.
 */
export function summariseEncumbrances(rows = []) {
  // Kept out of the encumbrance list on purpose; reported on its own so it is
  // visible without being mistaken for a judgment against the owner.
  const assessments = rows.filter((r) => r.kind === 'special-assessment')
  const sorted = [...rows].filter((r) => r.when).sort((a, b) => b.when - a.when)
  const lastTransfer = sorted.find((r) => r.kind === 'transfer') || null
  const since = lastTransfer ? lastTransfer.when : null

  const after = (r) => !since || r.when >= since
  const loans = sorted.filter((r) => r.kind === 'loan' && after(r))
  // A release only counts against the current owner's loans if it was recorded
  // after the transfer AND does not name the previous owner as the borrower.
  const priorOwners = lastTransfer ? lastTransfer.parties.filter((p) => p.role === 'grantor').map((p) => p.name) : []
  const releases = sorted.filter(
    (r) => r.kind === 'release' && after(r) && !r.parties.some((p) => priorOwners.some((o) => samePartyName(p.name, o))),
  )

  const open = []
  for (const kind of ENCUMBRANCES) {
    for (const r of sorted.filter((x) => x.kind === kind)) {
      const cleared = sorted.some(
        (rel) => rel.kind === 'release' && rel.when >= r.when && rel.parties.some((p) => r.parties.some((q) => samePartyName(p.name, q.name))),
      )
      if (!cleared) open.push(r)
    }
  }
  open.sort((a, b) => b.when - a.when)

  const defaults = sorted.filter((r) => r.kind === 'default')
  return {
    specialAssessments: assessments,
    lastTransfer,
    loansSinceTransfer: loans.length,
    releasesSinceTransfer: releases.length,
    // Never stated as fact: the index carries no amounts and does not link a
    // release to the loan it cleared.
    likelyOpenLoans: Math.max(0, loans.length - releases.length),
    unreleasedEncumbrances: open,
    noticesOfDefault: defaults,
    counts: sorted.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {}),
    total: rows.length,
  }
}

// One line for the spreadsheet: what a person needs to see at a glance.
export function encumbranceSummary(s) {
  if (!s || !s.total) return ''
  const bits = []
  if (s.likelyOpenLoans) bits.push(`${s.likelyOpenLoans} loan${s.likelyOpenLoans === 1 ? '' : 's'} not shown released`)
  for (const r of s.unreleasedEncumbrances) bits.push(`${r.titles.join(' + ')} ${r.date} (no release recorded)`)
  for (const r of s.noticesOfDefault) bits.push(`${r.titles.join(' + ')} ${r.date}`)
  return bits.join('; ')
}

// The request the site's own page makes. Kept here so the browser flow and any
// future direct reader agree on one shape.
export function searchQuery({ block, lot, from = INDEX_STARTS, to, rows = 100, startRow = 0 } = {}) {
  const today = to || new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  return {
    DocumentClass: 'OfficialRecords',
    Block: String(block || '').trim(),
    LowLot: String(lot || '').trim(),
    MinRecordedDate: from,
    MaxRecordedDate: today,
    NameTypeID: '0',
    ProfileID: 'Public',
    IsBasicSearch: 'false',
    Rows: String(rows),
    StartRow: String(startRow),
  }
}

// PropertyRadar gives the parcel as "4101-032" or "4101 032"; the recorder
// wants the two halves separately, and keeps the lot's leading zeros.
export function splitApn(apn = '') {
  const m = String(apn || '').trim().match(/^(\d{3,5})\s*[-\s/]\s*(\w{1,5})$/)
  if (!m) return { block: '', lot: '' }
  return { block: m[1], lot: m[2].toUpperCase() }
}

// ---------------------------------------------------------------------------------
// Driving the page.
//
// The service will not take a direct call: every endpoint needs a single-use key
// that the app mints and encrypts for itself. So we use the site the way a person
// does, and read the JSON the page fetches for its own table. That gives clean
// records instead of scraped HTML, without going near their key machinery.
// ---------------------------------------------------------------------------------

export const SEARCH_URL = `${RECORDER_HOST}/#!/simple`

// The form's inputs all share name="last-name", so the ng-model is the only thing
// that identifies them. Label text is the fallback if the app is ever rebuilt.
const FIELD = {
  block: ['input[ng-model="SearchRequestModel.Block"]', 'input[ng-model$=".Block"]'],
  lot: ['input[ng-model="SearchRequestModel.LowLot"]', 'input[ng-model$=".LowLot"]'],
}
// Two elements share id="btnSearch" and the first is a hidden modal button, so
// the click has to find the visible one rather than simply the first.
const SEARCH_BUTTON = ['button#btnSearch[ng-click^="Search"]', 'button#btnSearch', 'button:has-text("Search")', 'input[type="button"][value="Search"]']
const NEXT_PAGE = ['a.page-link[aria-label="Next"]', 'a[ng-click*="CurrentPage + 1"]', 'a.page-link[title="Next"]']
const PER_PAGE_MENU = ['#ddlDocsPerPage']
const PER_PAGE_MAX = ['#ddlDocsPerPage li[value="100"]', 'li[value="100"]', 'li[value="50"]']
const CLEAR_BUTTON = ['a:has-text("Clear All")', 'button:has-text("Clear All")']
const AGREE_BUTTON = [
  'button:has-text("I Agree")', 'button:has-text("Agree")', 'button:has-text("Accept")',
  'input[type="button"][value*="Agree" i]', 'button:has-text("Continue")',
]

// Clicks the first VISIBLE match, not simply the first match. This page reuses
// ids across hidden modal copies, so `.first()` lands on something invisible and
// the click times out even though the real control is right there.
async function clickAny(page, selectors, { timeout = 4000, required = false } = {}) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel)
      await loc.first().waitFor({ state: 'attached', timeout })
      const n = Math.min(await loc.count(), 10)
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i)
        if (!(await el.isVisible().catch(() => false))) continue
        await el.click({ timeout })
        return true
      }
    } catch { /* try the next one */ }
  }
  if (required) throw new Error(`Could not find a visible: ${selectors[0]}`)
  return false
}

async function fillAny(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first()
      await el.waitFor({ state: 'visible', timeout: 8000 })
      await el.fill('')
      await el.fill(String(value))
      return true
    } catch { /* try the next one */ }
  }
  return false
}

/**
 * Every document recorded against one parcel.
 *
 * Returns whole records, deduplicated by document number, plus what the service
 * said the total was — so a short read announces itself rather than looking
 * like a clean answer.
 */
export async function readParcel(page, { block, lot, signal, timeoutMs = 45000, maxPages = 30, url = SEARCH_URL } = {}) {
  if (!block || !lot) return { ok: false, total: 0, rows: [], partial: false, error: 'No parcel number for this property.' }

  const seen = new Map()
  let reported = 0
  let sawResponse = false
  // Reading a response body is asynchronous, and the listener is not awaited by
  // the page. Every parse is tracked so the results are read only once they have
  // all landed — otherwise a fast return sees an empty map.
  const inFlight = []
  const collect = (resp) => {
    if (!resp.url().includes('GetSearchResults')) return
    inFlight.push(
      (async () => {
        try {
          if (!resp.ok()) return
          const parsed = parseSearchResults(await resp.json())
          if (!parsed.ok) return
          sawResponse = true
          reported = Math.max(reported, parsed.total)
          for (const r of parsed.rows) if (r.docNumber && !seen.has(r.docNumber)) seen.set(r.docNumber, r)
        } catch { /* a body we could not read is no worse than one we never saw */ }
      })(),
    )
  }
  const settle = async () => { await Promise.allSettled(inFlight.splice(0)) }
  page.on('response', collect)

  try {
    // Only navigate when the tab is not already on the search site. Comparing
    // hosts rather than matching the recorder by name keeps this drivable
    // against a stand-in, which is how the flow is tested.
    let host = ''
    try { host = new URL(url).host } catch { /* fall through to a plain navigate */ }
    let onSite = false
    try { onSite = Boolean(host) && new URL(page.url()).host === host } catch { onSite = false }
    if (!onSite) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await clickAny(page, AGREE_BUTTON, { timeout: 3000 })
    // A second search in the same tab must not inherit the first one's criteria.
    await clickAny(page, CLEAR_BUTTON, { timeout: 3000 })

    if (!(await fillAny(page, FIELD.block, block))) throw new Error('Could not find the Block box on the recorder search form.')
    if (!(await fillAny(page, FIELD.lot, lot))) throw new Error('Could not find the Lot box on the recorder search form.')

    const first = page.waitForResponse((r) => r.url().includes('GetSearchResults'), { timeout: timeoutMs }).catch(() => null)
    await clickAny(page, SEARCH_BUTTON, { required: true })
    await first
    await settle()

    // 100 rows a page turns a six-page parcel into one. Best effort: if the
    // control has moved, the pager below still gets everything.
    if (seen.size < reported) {
      if (await clickAny(page, PER_PAGE_MENU, { timeout: 2500 })) {
        const bigger = page.waitForResponse((r) => r.url().includes('GetSearchResults'), { timeout: 15000 }).catch(() => null)
        if (await clickAny(page, PER_PAGE_MAX, { timeout: 2500 })) { await bigger; await settle() }
      }
    }

    // Page until we have everything the service said exists. The pager is the
    // only way through, since asking for more rows directly needs their key.
    for (let i = 0; i < maxPages && seen.size < reported; i++) {
      if (signal?.aborted) break
      const before = seen.size
      const next = page.waitForResponse((r) => r.url().includes('GetSearchResults'), { timeout: 15000 }).catch(() => null)
      const moved = await clickAny(page, NEXT_PAGE, { timeout: 3000 })
      if (!moved) break
      await next
      await settle()
      if (seen.size === before) break // the pager moved but nothing new arrived
    }

    const rows = [...seen.values()]
    const total = reported || rows.length
    // "ok" means the service answered, not that it found something. A parcel
    // with no recorded documents is a real answer; never hearing back is not.
    return { ok: sawResponse, total, rows, partial: rows.length < total, error: sawResponse ? '' : 'The recorder never returned a result list.' }
  } catch (err) {
    await settle()
    const rows = [...seen.values()]
    return { ok: false, total: reported, rows, partial: rows.length < reported, error: String(err?.message || err).slice(0, 180) }
  } finally {
    page.off('response', collect)
  }
}

// One parcel, start to finish: search, read, classify, pair.
export async function lookupLiens(page, apn, opts = {}) {
  const { block, lot } = splitApn(apn)
  if (!block) return { ok: false, error: `Parcel number not usable: "${apn}"`, summary: null, rows: [] }
  // opts carries `url` through, so the whole lookup is testable end to end.
  const res = await readParcel(page, { block, lot, ...opts })
  if (!res.ok && !res.rows.length) return { ok: false, error: res.error || 'No recorded documents found.', summary: null, rows: [] }
  return {
    ok: true,
    error: res.error,
    partial: res.partial,
    total: res.total,
    rows: res.rows,
    summary: summariseEncumbrances(res.rows),
  }
}
