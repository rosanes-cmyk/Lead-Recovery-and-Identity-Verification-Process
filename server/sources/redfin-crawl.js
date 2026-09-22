// Walking a Redfin search, so nobody has to download forty files by hand.
//
// What is actually confirmed about their search URLs, checked live on
// 22 Sep 2026 and nothing assumed beyond it:
//
//   /city/17151/CA/San-Francisco/filter/include=sold-2yr      328 pages
//   ...,property-type=house                                   138 pages
//   .../page-2                                                41 more, none repeated
//   .../page-40 (past the end)                                no properties
//
// The sold window and property type genuinely filter. The keyword box in
// Redfin's own filter panel does NOT survive into the URL: keyword=probate and
// keyword=fixer returned the identical 41 properties, so it is ignored. Nor can
// the search page stand in for the property page — only 5 of its 41 cards
// carried listing remarks. The remarks filter therefore happens where it always
// did, when we read each property page, and this crawler's job is only to
// enumerate the universe.
//
// Rate limiting is real and was hit while probing this. Pace accordingly.

const PROPERTY_HREF = /href="(\/[A-Z]{2}\/[^"]+?\/home\/\d+)"/g
const PAGE_COUNT = /Viewing page \d+ of ([\d,]+)/i
// A result card, as the live page writes it: the price, then the address
// anchor. Both were present on all 41 cards of the page this was built from.
const CARD_PRICE = /bp-Homecard__Price--value">([^<]{2,20})</g
const CARD_ADDRESS = /class="bp-Homecard__Address[^"]*"\s+href="(\/[A-Z]{2}\/[^"]+?\/home\/\d+)"[^>]*>([^<]{4,120})</g

export function parsePropertyLinks(html = '', origin = 'https://www.redfin.com') {
  const out = new Set()
  for (const m of String(html).matchAll(PROPERTY_HREF)) out.add(origin + m[1])
  return [...out]
}

const money = (s = '') => {
  const n = Number(String(s).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The result cards, with the address and last sold price the card shows.
 *
 * Each card writes its price before its address anchor, so walking both in
 * document order and taking the most recent price pairs them without needing a
 * DOM. A card whose price we cannot find still yields its address and link —
 * the link is the part the run actually needs.
 *
 * Falls back to bare links for any property whose card did not parse, so a
 * markup change costs us the price column rather than the whole crawl.
 */
export function parsePropertyCards(html = '', origin = 'https://www.redfin.com') {
  const s = String(html)
  const marks = []
  for (const m of s.matchAll(CARD_PRICE)) marks.push({ at: m.index, price: money(m[1]) })
  for (const m of s.matchAll(CARD_ADDRESS)) marks.push({ at: m.index, url: origin + m[1], address: m[2].trim() })
  marks.sort((a, b) => a.at - b.at)

  const byUrl = new Map()
  let lastPrice = null
  for (const mark of marks) {
    if (!mark.url) { lastPrice = mark.price; continue }
    if (!byUrl.has(mark.url)) byUrl.set(mark.url, { url: mark.url, address: mark.address, price: lastPrice })
    lastPrice = null
  }
  for (const url of parsePropertyLinks(s, origin)) {
    if (!byUrl.has(url)) byUrl.set(url, { url, address: '', price: null })
  }
  return [...byUrl.values()]
}

export function parseTotalPages(html = '') {
  const m = String(html).match(PAGE_COUNT)
  if (!m) return 0
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

// Page 1 is the bare filter URL; later pages take a /page-N suffix.
export function pageUrl(baseUrl, page) {
  const base = String(baseUrl).replace(/\/+$/, '').replace(/\/page-\d+$/, '')
  return page <= 1 ? base : `${base}/page-${page}`
}

// A sold search for one city. `region` is Redfin's own id for it — San
// Francisco is 17151, which is visible in the address bar of any search.
export function soldSearchUrl({ region = '17151', state = 'CA', city = 'San-Francisco', months = 24, propertyTypes = ['house'] } = {}) {
  const parts = [`include=sold-${months >= 24 ? '2yr' : months >= 12 ? '1yr' : '3mo'}`]
  if (propertyTypes.length) parts.push(`property-type=${propertyTypes.join('+')}`)
  return `https://www.redfin.com/city/${region}/${state}/${city}/filter/${parts.join(',')}`
}

// Reject anything that is not a Redfin search, so a pasted property URL or a
// stray link cannot send the crawler somewhere it has no business being.
export function normaliseSearchUrl(input = '') {
  const raw = String(input).trim()
  if (!raw) return { ok: false, error: 'Paste a Redfin search URL.' }
  let u
  try {
    u = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: 'That is not a URL.' }
  }
  if (!/(^|\.)redfin\.com$/i.test(u.hostname)) return { ok: false, error: 'That is not a Redfin URL.' }
  if (/\/home\/\d+/.test(u.pathname)) return { ok: false, error: 'That is one property, not a search. Use the URL of a search results page.' }
  if (!/^\/(city|county|zipcode|neighborhood)\//i.test(u.pathname)) {
    return { ok: false, error: 'That is not a Redfin search. Open a city, county, zip or neighbourhood search and copy the URL from the address bar.' }
  }
  const url = `https://www.redfin.com${u.pathname.replace(/\/+$/, '').replace(/\/page-\d+$/, '')}`
  const sold = /include=sold/i.test(url)
  return { ok: true, url, sold }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

async function getPage(url, { signal, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    })
    if (!res.ok) return { html: '', status: res.status, error: `HTTP ${res.status}` }
    return { html: await res.text(), status: res.status, error: '' }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Every property in a search, page by page.
 *
 * Stops on the first page that yields nothing new — that is how the end
 * announces itself, since page-40 of a 26-page search returns no properties
 * rather than an error. An empty page is also what a refusal looks like, so
 * `refused` distinguishes "we reached the end" from "we were turned away on the
 * first page", and the caller is told which.
 */
export async function crawlSearch(baseUrl, { maxPages = 400, delayMs = 1200, signal, onPage, fetchImpl = fetch, timeoutMs } = {}) {
  const properties = []
  const seen = new Set()
  let totalPages = 0
  let pagesRead = 0
  let error = ''

  for (let page = 1; page <= maxPages; page++) {
    if (signal?.aborted) break
    const url = pageUrl(baseUrl, page)
    let got
    try {
      got = await getPage(url, { signal, fetchImpl, timeoutMs })
    } catch (err) {
      error = String(err?.message || err).slice(0, 160)
      break
    }
    if (got.error) { error = got.error; break }
    if (page === 1) totalPages = parseTotalPages(got.html)
    const found = parsePropertyCards(got.html)
    const fresh = found.filter((p) => !seen.has(p.url))
    for (const p of fresh) { seen.add(p.url); properties.push(p) }
    pagesRead++
    onPage?.({ page, totalPages, found: found.length, fresh: fresh.length, collected: properties.length })
    if (!found.length) break // the end, or a refusal — the caller is told which
    if (totalPages && page >= totalPages) break
    if (page < maxPages) await new Promise((r) => setTimeout(r, delayMs + Math.round(Math.random() * delayMs * 0.4)))
  }

  return {
    ok: properties.length > 0,
    properties,
    urls: properties.map((p) => p.url),
    pagesRead,
    totalPages,
    // Nothing at all on the first page means we were turned away, not that the
    // city has no sales.
    refused: pagesRead > 0 && properties.length === 0,
    partial: Boolean(totalPages) && pagesRead < totalPages,
    error,
  }
}
