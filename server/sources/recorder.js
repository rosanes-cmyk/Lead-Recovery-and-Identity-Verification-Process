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
  ['tax-lien', /\b(TAX LIEN|FEDERAL TAX|STATE TAX|NOTICE OF LIEN|SPECIAL TAX)/i],
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
