// Web search for a property address — the "internet" half of enrichment.
//
// Provider chain, best-effort, never throws to the caller:
//   1. DuckDuckGo's plain-HTML endpoint via a direct backend fetch (no browser,
//      no login — the fast path)
//   2. the same endpoint loaded in the Playwright browser, if the direct request
//      was challenged as a bot
//   3. the existing Google search module (browser)
// Returns classified links (Zillow / Redfin / Realtor.com / Trulia / county
// records) and any sold price / date visible in the result snippets. These are
// research clues only — nothing here is treated as a record.

import { searchWeb } from './google.js'
import { goto } from './base.js'

export const id = 'websearch'
export const label = 'Web Search'
export const loginGated = false

const DDG_HTML = 'https://html.duckduckgo.com/html/?q='
// A normal desktop UA; DDG's HTML endpoint serves a stripped page to blank UAs.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export function ddgUrl(query) {
  return DDG_HTML + encodeURIComponent(query)
}

// ---- HTML parsing ------------------------------------------------------------

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => {
    const l = e.toLowerCase()
    if (l === 'amp') return '&'
    if (l === 'lt') return '<'
    if (l === 'gt') return '>'
    if (l === 'quot') return '"'
    if (l === 'apos' || l === '#39') return "'"
    if (l === 'nbsp') return ' '
    if (l[0] === '#') {
      const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return m
  })
}

export function stripTags(h) {
  return decodeEntities(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

// DDG wraps result links as //duckduckgo.com/l/?uddg=<real url>&rut=...
function resolveDdgHref(href) {
  let h = decodeEntities(href || '')
  if (!h) return ''
  if (h.startsWith('//')) h = 'https:' + h
  try {
    const u = new URL(h, 'https://duckduckgo.com')
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
      if (u.pathname.startsWith('/l/')) return u.searchParams.get('uddg') || ''
      return '' // internal DDG link (settings, feedback, …)
    }
    return u.href
  } catch {
    return ''
  }
}

// Parse DDG's HTML results page into { results: [{ title, url, snippet }], challenged }.
// `challenged` is true when DDG served its bot-check page instead of results.
export function parseDdgHtml(html) {
  const s = String(html || '')
  if (/anomaly-modal|challenge-form|anomaly\.js/i.test(s)) return { results: [], challenged: true }
  const anchors = []
  const anchorRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = anchorRe.exec(s))) anchors.push({ tag: m[0], inner: m[1], index: m.index })
  const snippets = []
  const snipRe = /<(a|div|span)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi
  while ((m = snipRe.exec(s))) snippets.push({ text: stripTags(m[2]), index: m.index })
  const results = []
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]
    const href = (a.tag.match(/\bhref="([^"]*)"/i) || [])[1] || ''
    const url = resolveDdgHref(href)
    if (!url) continue
    const next = anchors[i + 1]
    const snip = snippets.find((sn) => sn.index > a.index && (!next || sn.index < next.index))
    results.push({ title: stripTags(a.inner), url, snippet: snip ? snip.text : '' })
  }
  return { results, challenged: false }
}

// ---- classification ------------------------------------------------------------

const SITES = [
  ['zillow', /(^|\.)zillow\.com$/i],
  ['redfin', /(^|\.)redfin\.com$/i],
  ['realtor', /(^|\.)realtor\.com$/i],
  ['trulia', /(^|\.)trulia\.com$/i],
  ['homes', /(^|\.)homes\.com$/i],
  ['propertyradar', /(^|\.)propertyradar\.com$/i],
  ['county', /\.(gov|us)$/i],
]
// Data brokers that look like "county" or "property records" sites but are not
// official sources — never filed under County Records.
const AGGREGATOR = /countyoffice\.org|propertyshark|publicrecords|propertyrecord|neighborwho|ownerly|homemetry|rehold|blockshopper|spokeo|whitepages|fastpeoplesearch|truepeoplesearch|realtytrac|loopnet/i
const COUNTY_HINT = /assessor|recorder|parcel|\bgis\b|treasurer|tax-?collector|propertytax/i

export function classifyLink(url) {
  try {
    const u = new URL(url)
    const h = u.hostname
    if (AGGREGATOR.test(h)) return 'other'
    for (const [k, re] of SITES) if (re.test(h)) return k
    if (COUNTY_HINT.test(h + u.pathname)) return 'county'
    return 'other'
  } catch {
    return 'other'
  }
}
// Prefer listing sites for sold facts, in this order.
const RANK = { redfin: 0, zillow: 1, realtor: 2, trulia: 3, homes: 4, propertyradar: 5, county: 6, other: 9 }

// Pull "Sold for $1,150,000 on Mar 15, 2024" style facts out of snippet text.
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?'
const DATE_RE = new RegExp(`(${MONTH}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|${MONTH}\\s+\\d{4})`, 'i')
export function extractSoldFacts(text) {
  const t = String(text || '')
  const num = (v) => parseInt(String(v).replace(/,/g, ''), 10)
  const prices = []
  for (const re of [/\bsold\b.{0,40}?\$\s?(\d{1,3}(?:,\d{3}){1,3}|\d{5,})/gi, /\$\s?(\d{1,3}(?:,\d{3}){1,3}|\d{5,}).{0,30}?\bsold\b/gi]) {
    let m
    while ((m = re.exec(t))) prices.push(m[1])
  }
  // A snippet can mention several figures ("$35,000 over asking … sold for
  // $6,375,000"); the sale price is the largest one near "sold".
  const best = prices.sort((a, b) => num(b) - num(a))[0] || ''
  const dateM = t.match(new RegExp(`\\bsold\\b.{0,60}?${DATE_RE.source}`, 'i'))
  return { soldPrice: best ? '$' + best : '', soldDate: dateM ? dateM[1] : '' }
}

// ---- providers -----------------------------------------------------------------

async function fetchDdg(query, timeoutMs) {
  if (typeof fetch !== 'function') throw new Error('fetch unavailable (Node 18+ required)')
  const r = await fetch(ddgUrl(query), {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  const html = await r.text()
  const p = parseDdgHtml(html)
  if (!p.results.length && !p.challenged && r.status >= 400) p.error = `HTTP ${r.status}`
  return p
}

// Search the web for one address. `page` (Playwright) is optional — without it
// only the direct-fetch provider runs. Never throws.
export async function searchAddress(address, { page = null, signal = null, runDir = '', timeoutMs = 10000, direct = true } = {}) {
  const res = { ok: false, provider: '', results: [], links: {}, soldPrice: '', soldDate: '', notes: [] }
  const query = String(address || '').trim()
  if (!query) { res.notes.push('No address to search.'); return res }

  // direct=false skips the backend fetch (used when a fetch was just challenged
  // and the caller is retrying through the browser).
  let parsed = direct
    ? await fetchDdg(query, timeoutMs).catch((e) => ({ results: [], challenged: false, error: String(e?.message || e) }))
    : { results: [], challenged: false }
  if (parsed.results.length) res.provider = 'duckduckgo (direct)'
  else {
    if (parsed.challenged) res.notes.push('DuckDuckGo challenged the direct request; trying the browser.')
    else if (parsed.error) res.notes.push(`Direct search failed: ${parsed.error}`)
    if (page && !signal?.aborted) {
      try {
        await goto(page, ddgUrl(query), { signal })
        const p2 = parseDdgHtml(await page.content())
        if (p2.results.length) { parsed = p2; res.provider = 'duckduckgo (browser)' }
        else if (p2.challenged) res.notes.push('DuckDuckGo challenged the browser too.')
      } catch (e) {
        res.notes.push(`Browser search failed: ${String(e?.message || e).slice(0, 100)}`)
      }
    }
    if (!parsed.results.length && page && !signal?.aborted) {
      try {
        const g = await searchWeb(page, query, runDir || process.cwd(), signal)
        if (g.links?.length) {
          parsed = { results: g.links.map((l) => ({ title: l.title, url: l.url, snippet: '' })), challenged: false }
          res.provider = 'google (browser)'
        }
      } catch { /* fall through */ }
    }
  }

  res.results = parsed.results.slice(0, 10)
  for (const r of res.results) {
    const k = classifyLink(r.url)
    if (k !== 'other' && !res.links[k]) res.links[k] = r.url
  }
  // Across all results, take the largest sale price seen near "sold" and the
  // date that came with it (falling back to any sold date found).
  const ranked = [...res.results].sort((a, b) => (RANK[classifyLink(a.url)] ?? 9) - (RANK[classifyLink(b.url)] ?? 9))
  let best = 0
  let anyDate = ''
  for (const r of ranked) {
    const f = extractSoldFacts(`${r.title} ${r.snippet}`)
    const n = f.soldPrice ? parseInt(f.soldPrice.replace(/[^0-9]/g, ''), 10) : 0
    if (n > best) { best = n; res.soldPrice = f.soldPrice; res.soldDate = f.soldDate }
    if (!anyDate && f.soldDate) anyDate = f.soldDate
  }
  res.soldDate = res.soldDate || anyDate
  res.ok = res.results.length > 0
  if (!res.ok && !res.notes.length) res.notes.push('No web results.')
  return res
}

// Source-module shape, so this can also be added to the investigation registry.
export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const query = [input.address].filter(Boolean).join(' ')
  const out = { source: label, ok: false, loginRequired: false, data: {}, evidence: [], notes: [] }
  if (!query) { out.notes.push('No address to search.'); return out }
  emit?.({ type: 'log', source: label, message: `Searching the web: ${query}` })
  const r = await searchAddress(query, { page, signal, runDir })
  out.ok = r.ok
  out.data = { links: r.links, results: r.results, soldPrice: r.soldPrice, soldDate: r.soldDate, provider: r.provider }
  out.notes.push(...r.notes)
  return out
}
