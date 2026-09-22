// Walking a Redfin search: reading result pages, paging through them, and
// knowing the difference between the end of a search and being turned away.
//
// The fixture is four result cards lifted verbatim out of a real sold search
// for San Francisco on 22 Sep 2026, plus that page's own page counter.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parsePropertyLinks,
  parsePropertyCards,
  parseTotalPages,
  pageUrl,
  soldSearchUrl,
  normaliseSearchUrl,
  crawlSearch,
  readSearchInBrowser,
} from '../server/sources/redfin-crawl.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const SEARCH = fs.readFileSync(path.join(here, 'fixtures', 'redfin-search-sold.html'), 'utf-8')

console.log('\n[Crawl] Reading a real search results page')
const links = parsePropertyLinks(SEARCH)
check('property links found', links.length === 4, String(links.length))
check('links are absolute', links.every((u) => u.startsWith('https://www.redfin.com/CA/')), links[0])
check('the page counter is read', parseTotalPages(SEARCH) === 328, String(parseTotalPages(SEARCH)))
check('no counter means no count, not a crash', parseTotalPages('<html>nothing here</html>') === 0)
check('a thousands separator survives', parseTotalPages('Viewing page 1 of 1,204') === 1204)

const cards = parsePropertyCards(SEARCH)
check('a card per property', cards.length === 4, String(cards.length))
check('the address comes off the card', cards[0].address === '629 Chestnut St #401, San Francisco, CA 94133', cards[0].address)
// The price sits before the address in the markup, so pairing them means
// reading both in document order. Getting this wrong shifts every price by one
// property, which is the kind of error that looks fine until someone checks.
check('the price belongs to its own card', cards[0].price === 1795000, String(cards[0].price))
check('and the next card gets the next price', cards[1].price === 590000, String(cards[1].price))
check('and the last card too', cards[3].price === 490000 && /601 Van Ness/.test(cards[3].address), JSON.stringify(cards[3]))
check('every card has a link', cards.every((c) => /\/home\/\d+$/.test(c.url)))

// A markup change should cost the price column, not the crawl.
const noPrices = SEARCH.replace(/bp-Homecard__Price--value/g, 'bp-Homecard__Price--renamed')
const degraded = parsePropertyCards(noPrices)
check('links survive a markup change that breaks prices', degraded.length === 4, String(degraded.length))
check('and the price is simply absent', degraded.every((c) => c.price === null))

const noAddr = SEARCH.replace(/bp-Homecard__Address/g, 'bp-Homecard__Renamed')
check('links survive a markup change that breaks addresses', parsePropertyCards(noAddr).length === 4)

console.log('\n[Crawl] Page URLs')
const base = 'https://www.redfin.com/city/17151/CA/San-Francisco/filter/include=sold-2yr'
check('page 1 is the bare URL', pageUrl(base, 1) === base)
check('page 7 takes a suffix', pageUrl(base, 7) === `${base}/page-7`)
check('a URL that already names a page is re-paged, not stacked', pageUrl(`${base}/page-3`, 7) === `${base}/page-7`)
check('a trailing slash is not doubled', pageUrl(`${base}/`, 2) === `${base}/page-2`)

console.log('\n[Crawl] Building a search')
check('the standard search is sold, 2 years, houses', soldSearchUrl() === 'https://www.redfin.com/city/17151/CA/San-Francisco/filter/include=sold-2yr,property-type=house', soldSearchUrl())
check('a shorter window', /include=sold-3mo/.test(soldSearchUrl({ months: 3 })), soldSearchUrl({ months: 3 }))
check('several property types join with a plus', /property-type=house\+multifamily/.test(soldSearchUrl({ propertyTypes: ['house', 'multifamily'] })))
check('no property type means no property filter', !/property-type/.test(soldSearchUrl({ propertyTypes: [] })))

console.log('\n[Crawl] Checking what someone pasted')
check('a real search is accepted', normaliseSearchUrl(base).ok === true)
check('and recognised as sold', normaliseSearchUrl(base).sold === true)
check('a page suffix is stripped so the crawl starts at page 1', normaliseSearchUrl(`${base}/page-9`).url === base)
check('a search that is not sold is flagged', normaliseSearchUrl('https://www.redfin.com/city/17151/CA/San-Francisco').sold === false)
check('a property page is refused', normaliseSearchUrl('https://www.redfin.com/CA/San-Francisco/2475-47th-Ave-94116/home/660516').ok === false)
check('and says why', /one property/.test(normaliseSearchUrl('https://www.redfin.com/CA/San-Francisco/2475-47th-Ave-94116/home/660516').error))
check('another site is refused', normaliseSearchUrl('https://www.zillow.com/san-francisco-ca/sold/').ok === false)
check('a lookalike domain is refused', normaliseSearchUrl('https://redfin.com.evil.test/city/1/CA/x').ok === false)
check('the bare domain is accepted', normaliseSearchUrl('www.redfin.com/city/17151/CA/San-Francisco/filter/include=sold-2yr').ok === true)
check('nothing pasted is refused', normaliseSearchUrl('').ok === false)
check('nonsense is refused', normaliseSearchUrl('not a url at all').ok === false)
check('the home page is refused', normaliseSearchUrl('https://www.redfin.com/').ok === false)

console.log('\n[Crawl] Walking the pages')
// A stand-in Redfin: three pages of results, then nothing, which is how a real
// search announces its end (page-40 of a 26-page search is empty, not an error).
function fakeRedfin({ pages = 3, perPage = 2, total = 3, fail = null } = {}) {
  const seen = []
  const impl = async (url) => {
    seen.push(url)
    if (fail && seen.length === fail.onCall) return { ok: false, status: fail.status || 429, text: async () => '' }
    const m = url.match(/\/page-(\d+)$/)
    const page = m ? Number(m[1]) : 1
    if (page > pages) return { ok: true, status: 200, text: async () => '<html>no results</html>' }
    const cards = Array.from({ length: perPage }, (_, i) => {
      const id = page * 100 + i
      return `<div class="bp-Homecard__Price flex"><span class="bp-Homecard__Price--value">$${id},000</span></div><a class="bp-Homecard__Address flex" href="/CA/San-Francisco/${id}-Test-St-94110/home/${id}" target="_blank">${id} Test St, San Francisco, CA 94110</a>`
    }).join('')
    return { ok: true, status: 200, text: async () => `<html>Viewing page ${page} of ${total}${cards}</html>` }
  }
  return { impl, seen }
}

const fx = fakeRedfin()
const walked = await crawlSearch(base, { fetchImpl: fx.impl, delayMs: 0 })
check('every page was walked', walked.pagesRead === 3, String(walked.pagesRead))
check('every property collected', walked.properties.length === 6, String(walked.properties.length))
check('urls come back alongside the cards', walked.urls.length === 6 && walked.urls[0] === walked.properties[0].url)
check('the total page count is reported', walked.totalPages === 3)
check('it knows it finished', walked.partial === false && walked.ok === true)
check('it stopped at the last page rather than probing past it', fx.seen.length === 3, fx.seen.join(' '))
check('page 1 was fetched bare', fx.seen[0] === base, fx.seen[0])
check('page 2 took the suffix', fx.seen[1] === `${base}/page-2`, fx.seen[1])
check('no error', walked.error === '')

// The same property listed on two pages is one property.
const dupes = fakeRedfin({ pages: 2, perPage: 2, total: 2 })
let call = 0
const dupImpl = async (url) => {
  call++
  const res = await dupes.impl(url)
  if (call === 2) return { ok: true, status: 200, text: async () => (await res.text()).replace(/200/g, '100').replace(/201/g, '101') }
  return res
}
const deduped = await crawlSearch(base, { fetchImpl: dupImpl, delayMs: 0 })
check('a property seen twice is kept once', deduped.properties.length === 2, String(deduped.properties.length))
check('both pages still counted as read', deduped.pagesRead === 2)

// A search whose counter is missing still ends when the results do.
const noCount = fakeRedfin({ pages: 2, perPage: 3, total: 0 })
const untotalled = await crawlSearch(base, { fetchImpl: noCount.impl, delayMs: 0 })
check('with no page counter it walks until the results run out', untotalled.properties.length === 6, String(untotalled.properties.length))
check('and reads one empty page to find that out', untotalled.pagesRead === 3, String(untotalled.pagesRead))

// An empty first page is a refusal, not an empty city. Treating it as "the
// search found nothing" would quietly produce an agent list of nobody.
const refusing = { impl: async () => ({ ok: true, status: 200, text: async () => '<html>Viewing page 1 of 328</html>' }) }
const refused = await crawlSearch(base, { fetchImpl: refusing.impl, delayMs: 0 })
check('an empty first page is reported as a refusal', refused.refused === true)
check('and not as a successful crawl', refused.ok === false)
check('and not as a completed one', refused.partial === true)

const broke = fakeRedfin({ pages: 5, perPage: 2, total: 5, fail: { onCall: 3, status: 429 } })
const partial = await crawlSearch(base, { fetchImpl: broke.impl, delayMs: 0 })
check('a refusal part-way keeps what it had', partial.properties.length === 4, String(partial.properties.length))
check('and says it is partial', partial.partial === true)
check('and names the status', /429/.test(partial.error), partial.error)

const capped = await crawlSearch(base, { fetchImpl: fakeRedfin({ pages: 50, total: 50 }).impl, delayMs: 0, maxPages: 2 })
check('the page cap is honoured', capped.pagesRead === 2 && capped.properties.length === 4)
check('and a capped crawl is partial', capped.partial === true)

const ctl = new AbortController()
ctl.abort()
const stopped = await crawlSearch(base, { fetchImpl: fakeRedfin().impl, delayMs: 0, signal: ctl.signal })
check('an already-stopped crawl fetches nothing', stopped.pagesRead === 0 && stopped.properties.length === 0)

const thrower = { impl: async () => { throw new Error('socket hang up') } }
const threw = await crawlSearch(base, { fetchImpl: thrower.impl, delayMs: 0 })
check('a thrown error is caught and reported', /socket hang up/.test(threw.error), threw.error)
check('and is not a refusal', threw.refused === false)

// An empty page BEFORE the known end is a refusal, not the end of the search.
// Getting this wrong hands back a twentieth of the city looking like a clean
// finish, which is what happened on the first real run.
const earlyStop = {
  impl: async (url) => {
    const m = String(url).match(/\/page-(\d+)$/)
    const n = m ? Number(m[1]) : 1
    const cards = n <= 3
      ? `<div class="bp-Homecard__Price"><span class="bp-Homecard__Price--value">$${n}00,000</span></div><a class="bp-Homecard__Address" href="/CA/San-Francisco/${n}-A-St-94110/home/${n}" target="_blank">${n} A St</a>`
      : ''
    return { ok: true, status: 200, text: async () => `<html>Viewing page ${n} of 190${cards}</html>` }
  },
}
const cutOff = await crawlSearch(base, { fetchImpl: earlyStop.impl, delayMs: 0 })
check('an empty page before the end is a refusal', cutOff.refused === true)
check('and names the page it happened on', /page 4 of 190/.test(cutOff.error), cutOff.error)
check('and says it is a refusal, not the end', /refusal rather than the end/.test(cutOff.error))
check('but keeps everything collected', cutOff.properties.length === 3, String(cutOff.properties.length))
check('and is still partial', cutOff.partial === true)

// The genuine end must not be mistaken for a refusal.
const trueEnd = await crawlSearch(base, { fetchImpl: fakeRedfin({ pages: 3, total: 3 }).impl, delayMs: 0 })
check('reaching the real end is not a refusal', trueEnd.refused === false)
// A search with no page counter cannot tell the two apart, and must not
// invent a refusal out of an ordinary finish.
const noCounter = await crawlSearch(base, { fetchImpl: fakeRedfin({ pages: 2, total: 0 }).impl, delayMs: 0 })
check('with no counter an empty page is still just the end', noCounter.refused === false)

console.log('\n[Crawl] Falling back to the browser')
// Redfin answers a throttled plain request with 202 and an empty body. Taking
// that 2xx at face value turned it into "this page has no properties", which
// then read as the end of the search.
const emptyTwoOhTwo = { impl: async () => ({ ok: true, status: 202, text: async () => '' }) }
const soft = await crawlSearch(base, { fetchImpl: emptyTwoOhTwo.impl, delayMs: 0 })
check('a 202 with an empty body is a refusal, not an empty page', /refusal/.test(soft.error), soft.error)
check('and names the status', /202/.test(soft.error))

// The fallback gets a chance before the crawl gives up.
let handed = []
const viaBrowser = await crawlSearch(base, {
  fetchImpl: emptyTwoOhTwo.impl,
  delayMs: 0,
  onRefused: async ({ url, page }) => {
    handed.push(page)
    if (page > 2) return null
    return { properties: [{ url: `https://www.redfin.com/CA/San-Francisco/${page}-B-St/home/${page}`, address: `${page} B St`, price: 1 }], totalPages: 3 }
  },
})
check('a refused page is handed to the fallback', handed[0] === 1, JSON.stringify(handed))
check('and what it returns is collected', viaBrowser.properties.length === 2, String(viaBrowser.properties.length))
check('the crawl carries on through the refusals', viaBrowser.through === 2, String(viaBrowser.through))
check('and stops when the fallback cannot help either', viaBrowser.pagesRead === 2, String(viaBrowser.pagesRead))

// The browser reader itself, against a stand-in page object.
const fakePage = (html) => ({ goto: async () => {}, waitForTimeout: async () => {}, content: async () => html })
const fx2 = fs.readFileSync(path.join(here, 'fixtures', 'redfin-search-sold.html'), 'utf-8')
const read = await readSearchInBrowser(fakePage(fx2), base)
check('the browser reader parses a real search page', read.ok && read.properties.length === 4, String(read.properties.length))
check('and reads its page count', read.totalPages === 328)
const challenged = await readSearchInBrowser(fakePage('<html>Just a moment...</html>'), base)
check('a challenge in the browser is reported as blocked', challenged.blocked === true && challenged.ok === false)
const bust = await readSearchInBrowser({ goto: async () => { throw new Error('net::ERR_ABORTED') } }, base)
check('a browser crash is caught, not thrown', /ERR_ABORTED/.test(bust.error), bust.error)
check('no page means no crash', (await readSearchInBrowser(null, base)).ok === false)

console.log('\n[Crawl] Resuming part-way')
const resumed = fakeRedfin({ pages: 6, perPage: 2, total: 6 })
const rest = await crawlSearch(base, { fetchImpl: resumed.impl, delayMs: 0, startPage: 4 })
check('it starts where it was told to', resumed.seen[0] === `${base}/page-4`, resumed.seen[0])
check('and does not refetch the pages already walked', !resumed.seen.some((u) => /page-[123]$/.test(u) || u === base))
check('it reads to the end', rest.through === 6, String(rest.through))
check('pages read is this pass, not the whole search', rest.pagesRead === 3, String(rest.pagesRead))
check('coverage is what says whether it finished', rest.partial === false)
// Page 1 is never fetched on a resume, so the counter has to be read from
// whichever page comes first or a resumed crawl never knows how big it is.
check('the page counter is read from a later page', rest.totalPages === 6, String(rest.totalPages))
check('the start page is reported back', rest.startPage === 4)

const cappedResume = await crawlSearch(base, { fetchImpl: fakeRedfin({ pages: 20, total: 20 }).impl, delayMs: 0, startPage: 5, maxPages: 3 })
check('the cap counts pages walked in this pass', cappedResume.pagesRead === 3, String(cappedResume.pagesRead))
check('and coverage reflects where it got to', cappedResume.through === 7, String(cappedResume.through))
check('a capped resume is still partial', cappedResume.partial === true)

let pagesSeen = 0
await crawlSearch(base, { fetchImpl: fakeRedfin().impl, delayMs: 0, onPage: () => pagesSeen++ })
check('progress is reported for each page', pagesSeen === 3, String(pagesSeen))

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
