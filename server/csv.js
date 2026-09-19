// CSV in/out for the Property Enrichment tab, plus address-column detection.
//
// Zero dependencies on purpose: Google Sheets and Excel export RFC-4180 CSV
// (quoted fields, "" for a literal quote, newlines allowed inside quotes) and
// that is exactly what we parse and write back, so the enriched file imports
// straight into the same sheet.

// ---- parse -------------------------------------------------------------------

// Parse CSV text into an array of rows (arrays of strings). Handles a UTF-8 BOM,
// CRLF / LF / lone CR line endings, quoted fields, escaped quotes and embedded
// newlines. Fully empty trailing rows are dropped.
export function parseCsv(text) {
  let s = String(text || '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } // escaped quote
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\r') {
      // CRLF: let the \n end the row. Lone CR: ends the row itself.
      if (s[i + 1] !== '\n') { row.push(field); field = ''; rows.push(row); row = [] }
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop()
  return rows
}

// Parse CSV text into { headers, records } where each record is an object keyed
// by header. Duplicate headers get a " (2)", " (3)" suffix so no column is lost.
// Rows that are entirely blank are skipped.
export function csvToRecords(text) {
  const rows = parseCsv(text)
  if (!rows.length) return { headers: [], records: [] }
  const seen = new Map()
  const headers = rows[0].map((h, i) => {
    const base = String(h).trim() || `Column ${i + 1}`
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    return n > 1 ? `${base} (${n})` : base
  })
  const records = rows
    .slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const o = {}
      headers.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i] })
      return o
    })
  return { headers, records }
}

// ---- serialize ----------------------------------------------------------------

// Records -> CSV text (CRLF line endings, UTF-8 BOM so Excel reads accents).
export function toCsv(headers, records) {
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [headers.map(esc).join(',')]
  for (const r of records) lines.push(headers.map((h) => esc(r[h])).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}

// ---- address columns ----------------------------------------------------------

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Header names we recognise, in priority order, after normalisation
// ("Street Address" -> "streetaddress").
const CANDIDATES = {
  full: ['fulladdress', 'propertyaddress', 'siteaddress', 'situsaddress', 'address', 'fulladdr', 'location'],
  street: ['streetaddress', 'street', 'address1', 'addressline1', 'addr1', 'situsstreet', 'streetaddr', 'addressline'],
  city: ['city', 'postalcity', 'situscity', 'town', 'municipality'],
  state: ['state', 'st', 'stateprovince', 'province', 'region'],
  zip: ['zip', 'zipcode', 'postalcode', 'zip5', 'postal', 'situszip'],
}

// Work out which columns hold the address. Returns
//   { mode: 'parts', street, city, state, zip }   several columns, or
//   { mode: 'full',  full }                        one column with the whole address, or
//   { mode: 'none' }                               nothing recognised (operator must pick).
export function detectAddressColumns(headers) {
  const byNorm = new Map()
  for (const h of headers) if (!byNorm.has(norm(h))) byNorm.set(norm(h), h)
  const pick = (list) => { for (const c of list) if (byNorm.has(c)) return byNorm.get(c); return '' }
  let street = pick(CANDIDATES.street)
  const city = pick(CANDIDATES.city)
  const state = pick(CANDIDATES.state)
  const zip = pick(CANDIDATES.zip)
  let full = pick(CANDIDATES.full)
  // "Address" next to a "City" column is the street part, not the whole thing.
  if (!street && full && city) { street = full; full = '' }
  if (street && city) return { mode: 'parts', full: '', street, city, state, zip }
  if (full) return { mode: 'full', full, street: '', city: '', state: '', zip: '' }
  // A lone street column with no city probably holds the whole address.
  if (street) return { mode: 'full', full: street, street: '', city: '', state: '', zip: '' }
  return { mode: 'none', full: '', street: '', city: '', state: '', zip: '' }
}

// Build "Street, City, ST ZIP" from a record using the column map.
export function buildAddress(rec, map) {
  const v = (k) => (k && rec[k] != null ? String(rec[k]).trim() : '')
  if (!map || map.mode === 'none') return ''
  if (map.mode === 'full') return tidyAddress(v(map.full))
  const street = v(map.street)
  if (!street) return '' // a city/ZIP with no street is not a property to look up
  const city = v(map.city)
  const state = v(map.state).toUpperCase()
  const zip = tidyZip(v(map.zip))
  const tail = [state, zip].filter(Boolean).join(' ')
  return tidyAddress([street, city, tail].filter(Boolean).join(', '))
}

// Spreadsheets mangle ZIPs: "94112.0" (numeric cell) or "2134" (lost leading 0).
export function tidyZip(z) {
  let s = String(z || '').trim()
  s = s.replace(/^(\d{5})(?:\.0+)?$/, '$1')
  if (/^\d{3,4}$/.test(s)) s = s.padStart(5, '0')
  return s
}

export function tidyAddress(a) {
  return String(a || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()
}

// ---- address comparison -------------------------------------------------------
// Used to flag a PropertyRadar result whose address does not look like the one
// we asked for — a silent wrong match is worse than no match.

const SUFFIX = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR', ROAD: 'RD', LANE: 'LN',
  COURT: 'CT', PLACE: 'PL', TERRACE: 'TER', TERR: 'TER', CIRCLE: 'CIR', PARKWAY: 'PKWY', HIGHWAY: 'HWY',
  SQUARE: 'SQ', TRAIL: 'TRL', ALLEY: 'ALY', PLAZA: 'PLZ', MOUNT: 'MT', POINT: 'PT', CRESCENT: 'CRES',
}
const DIR = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW' }
// Tokens that say nothing about WHICH street it is. Sharing only "ST" or "N"
// must never count as a match ("135 Prague St" vs "135 Oak St").
const GENERIC = new Set([...Object.values(SUFFIX), ...Object.values(DIR), 'WAY', 'LOOP', 'ROW', 'WALK', 'PATH', 'PIKE', 'RUN', 'PASS'])

// Street line -> normalised tokens: "135 Prague Street #4" -> ["135","PRAGUE","ST"].
export function normalizeStreet(addr) {
  let s = String(addr || '').toUpperCase().split(',')[0]
  s = s.replace(/#\s*\S+/g, ' ').replace(/\b(APT|UNIT|STE|SUITE|FL|FLOOR|BLDG)\b\s*\S*/g, ' ')
  s = s.replace(/[^A-Z0-9 ]/g, ' ')
  return s.split(/\s+/).filter(Boolean).map((t) => SUFFIX[t] || DIR[t] || t)
}

// 'match' | 'mismatch' | 'unknown'. Same house number + at least one shared
// street-name token = match.
export function addressMatch(a, b) {
  const A = normalizeStreet(a)
  const B = normalizeStreet(b)
  if (!A.length || !B.length) return 'unknown'
  const isNum = (t) => /^\d+$/.test(t)
  const numA = A.find(isNum)
  const numB = B.find(isNum)
  if (!numA || !numB) return 'unknown'
  if (numA !== numB) return 'mismatch'
  const nameA = A.filter((t) => !isNum(t) && !GENERIC.has(t))
  const nameB = B.filter((t) => !isNum(t) && !GENERIC.has(t))
  if (!nameA.length || !nameB.length) {
    // One side is just a number and a suffix — compare whatever is there.
    const restA = A.filter((t) => !isNum(t))
    const restB = B.filter((t) => !isNum(t))
    return restA.some((t) => restB.includes(t)) ? 'match' : 'mismatch'
  }
  return nameA.some((t) => nameB.includes(t)) ? 'match' : 'mismatch'
}
