// Redfin's own search export — the universe of sales, without scraping a
// search page.
//
// Redfin's sold-homes search has a "Download All" link that hands the operator
// a CSV of the results (a few hundred rows at a time, so a city is a handful of
// downloads split by neighbourhood or price band). Each row carries the
// property's Redfin URL, which is all we need: the per-property read that goal
// 1 already does supplies the listing agent and the remarks.
//
// The header names in that file are long and have changed over time — the URL
// column has carried a parenthetical about pricing for years. So nothing here
// matches on a header name. The URL column is found by looking at the values.

import { parseCsv, csvToRecords } from '../csv.js'

const PROPERTY_URL = /^https?:\/\/(www\.)?redfin\.com\/[^\s,]+\/home\/\d+/i

export function looksLikePropertyUrl(v) {
  return PROPERTY_URL.test(String(v || '').trim())
}

// The column whose values are Redfin property links, whatever it is called.
export function findUrlColumn(headers = [], records = []) {
  let best = ''
  let bestHits = 0
  for (const h of headers) {
    const hits = records.reduce((n, r) => n + (looksLikePropertyUrl(r[h]) ? 1 : 0), 0)
    if (hits > bestHits) { bestHits = hits; best = h }
  }
  return bestHits ? best : ''
}

// Any column whose name contains one of these words, first match wins. Used
// only for the extra facts; a missing one costs nothing.
function columnLike(headers, ...words) {
  for (const w of words) {
    const hit = headers.find((h) => new RegExp(`\\b${w}\\b`, 'i').test(h))
    if (hit) return hit
  }
  return ''
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * One Redfin search export into the rows the agent roll-up needs.
 *
 * Only rows with a property URL survive: a Redfin export can carry blank
 * separator lines and the odd summary row, and a row without a URL is one we
 * cannot read anyway.
 */
export function parseSearchExport(csvText) {
  const rows = parseCsv(String(csvText || ''))
  if (!rows.length) return { ok: false, rows: [], error: 'That file is empty.' }
  const { headers, records } = csvToRecords(csvText)
  const urlCol = findUrlColumn(headers, records)
  if (!urlCol) {
    return { ok: false, rows: [], error: 'No column in that file holds Redfin property links. Use the "Download All" link on a Redfin search.' }
  }
  const addressCol = columnLike(headers, 'address')
  const cityCol = columnLike(headers, 'city')
  const zipCol = columnLike(headers, 'zip', 'postal')
  const priceCol = columnLike(headers, 'price')
  const soldCol = columnLike(headers, 'sold')
  const domCol = columnLike(headers, 'days')
  const typeCol = columnLike(headers, 'type')

  const seen = new Set()
  const out = []
  for (const r of records) {
    const url = String(r[urlCol] || '').trim()
    if (!looksLikePropertyUrl(url) || seen.has(url)) continue
    seen.add(url)
    out.push({
      url,
      address: [r[addressCol], r[cityCol], r[zipCol]].map((v) => String(v || '').trim()).filter(Boolean).join(', '),
      price: priceCol ? num(r[priceCol]) : null,
      soldDate: soldCol ? String(r[soldCol] || '').trim() : '',
      dom: domCol ? num(r[domCol]) : null,
      propertyType: typeCol ? String(r[typeCol] || '').trim() : '',
    })
  }
  if (!out.length) return { ok: false, rows: [], error: 'That file has a link column but no property rows in it.' }
  return { ok: true, rows: out, error: '', urlColumn: urlCol }
}

// Several exports at once: a city comes down in batches, and the batches
// overlap at the edges.
export function mergeSearchExports(texts = []) {
  const rows = []
  const seen = new Set()
  const errors = []
  for (const [i, text] of texts.entries()) {
    const one = parseSearchExport(text)
    if (!one.ok) { errors.push(`File ${i + 1}: ${one.error}`); continue }
    for (const r of one.rows) {
      if (seen.has(r.url)) continue
      seen.add(r.url)
      rows.push(r)
    }
  }
  return { ok: rows.length > 0, rows, errors, duplicates: texts.length ? seen.size : 0 }
}
