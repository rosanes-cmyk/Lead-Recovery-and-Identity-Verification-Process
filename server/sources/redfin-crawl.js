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
// Redfin's refusals, by status. 202 with an empty body is one of them, which is
// why a 2xx cannot be taken at face value here.
const isRefusal = (status) => [202, 403, 429, 503].includes(Number(status))

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
    const html = await res.text()
    // Redfin answers a throttled request with 202 and an empty body. Taking a
    // 2xx at face value turns that into "this page has no properties", which
    // then reads as the end of the search.
    if (!html.trim()) return { html: '', status: res.status, error: `Redfin answered HTTP ${res.status} with an empty page, which is a refusal.` }
    return { html, status: res.status, error: '' }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The same search page, read in the browser instead.
 *
 * Plain fetch is what makes a 190-page crawl cheap, but Redfin soft-blocks it:
 * a 202 with an empty body, or a 200 carrying no results. A real browser on the
 * persistent profile has cookies and runs their JS, so it is served the actual
 * page — and when it is challenged, a person can clear the challenge in the
 * window and the run carries on.
 */
export async function readSearchInBrowser(page, url, { timeoutMs = 45000, settleMs = 1500 } = {}) {
  if (!page || !url) return { ok: false, properties: [], totalPages: 0, error: 'No search page to read.' }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForTimeout(settleMs)
    const html = await page.content()
    const properties = parsePropertyCards(html)
    return {
      ok: properties.length > 0,
      properties,
      totalPages: parseTotalPages(html),
      // A browser page with no results on it is the challenge, not the end.
      blocked: properties.length === 0,
      error: properties.length ? '' : 'The browser was served a search page with no properties on it.',
    }
  } catch (err) {
    return { ok: false, properties: [], totalPages: 0, error: String(err?.message || err).slice(0, 160) }
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
export async function crawlSearch(baseUrl, { maxPages = 400, delayMs = 1200, startPage = 1, signal, onPage, onRefused, fetchImpl = fetch, timeoutMs } = {}) {
  const properties = []
  const seen = new Set()
  const first = Math.max(1, startPage)
  let totalPages = 0
  let pagesRead = 0
  let through = first - 1 // the highest page actually read
  let refusedMidway = false
  let error = ''

  for (let page = first; page < first + maxPages; page++) {
    if (signal?.aborted) break
    const url = pageUrl(baseUrl, page)
    let got
    try {
      got = await getPage(url, { signal, fetchImpl, timeoutMs })
    } catch (err) {
      error = String(err?.message || err).slice(0, 160)
      break
    }
    if (got.error && !isRefusal(got.status)) { error = got.error; break }
    // Every page carries the counter, not just the first — which matters when
    // resuming part-way, where page 1 is never fetched.
    if (!totalPages) totalPages = parseTotalPages(got.html)
    let found = parsePropertyCards(got.html)

    // Refused, by status or by an empty page where the counter says there is
    // more. Give the caller a chance to fetch it another way before treating
    // this as the end of the road.
    const refusedHere = Boolean(got.error) || (!found.length && totalPages && page < totalPages)
    if (refusedHere && onRefused) {
      const via = await onRefused({ url, page, totalPages })
      if (via?.properties?.length) {
        found = via.properties
        if (!totalPages && via.totalPages) totalPages = via.totalPages
      }
    }
    if (got.error && !found.length) { error = got.error; break }
    const fresh = found.filter((p) => !seen.has(p.url))
    for (const p of fresh) { seen.add(p.url); properties.push(p) }
    pagesRead++
    through = page
    onPage?.({ page, totalPages, found: found.length, fresh: fresh.length, collected: properties.length })
    if (!found.length) {
      // An empty page is how the end announces itself — but only at the end.
      // Page 40 of a 26-page search is genuinely empty; page 8 of 190 is
      // Redfin declining to answer, and calling that "finished" hands back a
      // twentieth of the city with no sign anything went wrong.
      if (totalPages && page < totalPages) {
        refusedMidway = true
        error = error || `Redfin served page ${page} of ${totalPages} with no properties on it, which is a refusal rather than the end of the search.`
      }
      break
    }
    if (totalPages && page >= totalPages) break
    await new Promise((r) => setTimeout(r, delayMs + Math.round(Math.random() * delayMs * 0.4)))
  }

  return {
    ok: properties.length > 0,
    properties,
    urls: properties.map((p) => p.url),
    pagesRead,
    startPage: first,
    // How far into the search this pass got. With a resume, that is not the
    // same as how many pages it read, and it is coverage the caller needs.
    through,
    totalPages,
    // Two shapes of refusal: nothing at all on the first page (turned away from
    // the start, which is not the same as the city having no sales), and an
    // empty page part-way through a search we know to be longer.
    refused: (pagesRead > 0 && properties.length === 0) || refusedMidway,
    partial: Boolean(totalPages) && through < totalPages,
    error,
  }
}
