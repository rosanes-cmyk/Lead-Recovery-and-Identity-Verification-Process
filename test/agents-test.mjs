// Goal 2: reading Redfin's search export, and rolling properties up into a
// ranked list of listing agents.
import { parseSearchExport, mergeSearchExports, findUrlColumn, looksLikePropertyUrl } from '../server/sources/redfin-search.js'
import { rollupAgents, personKey, surnameOf, mergeAbbreviatedKeys, agentsToRows, rollupSummary, AGENT_COLUMNS } from '../server/agents.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// Redfin's export header is long and has changed over the years, which is why
// the URL column is found by its values rather than its name.
const EXPORT = `SALE TYPE,SOLD DATE,PROPERTY TYPE,ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS,BATHS,SQUARE FEET,DAYS ON MARKET,MLS#,URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)
PAST SALE,October-31-2025,Single Family Residential,71 Bradford St,San Francisco,CA,94110,"$2,950,000",2,1,1238,30,425073325,https://www.redfin.com/CA/San-Francisco/71-Bradford-St-94110/home/2014378
PAST SALE,September-8-2023,Single Family Residential,3752 Folsom St,San Francisco,CA,94110,"$912,500",3,3,1175,21,423760651,https://www.redfin.com/CA/San-Francisco/3752-Folsom-St-94110/home/760710
,,,,,,,,,,,,,
PAST SALE,October-23-2023,Single Family Residential,547 Missouri St,San Francisco,CA,94107,"$4,850,000",5,5,0,12,423907901,https://www.redfin.com/CA/San-Francisco/547-Missouri-St-94107/home/1094197
`

console.log('\n[Agents] Reading a Redfin search export')
const ex = parseSearchExport(EXPORT)
check('export read', ex.ok === true, ex.error)
check('three properties, blank row skipped', ex.rows.length === 3, String(ex.rows.length))
check('url column found by its values, not its name', /^URL \(SEE/.test(ex.urlColumn), ex.urlColumn)
check('address assembled', ex.rows[0].address === '71 Bradford St, San Francisco, 94110', ex.rows[0].address)
check('price read', ex.rows[0].price === 2950000, String(ex.rows[0].price))
check('days on market read', ex.rows[0].dom === 30)
check('sold date kept', /2025/.test(ex.rows[0].soldDate))
check('a property link is recognised', looksLikePropertyUrl('https://www.redfin.com/CA/San-Francisco/71-Bradford-St-94110/home/2014378'))
check('a search link is not a property link', !looksLikePropertyUrl('https://www.redfin.com/city/17151/CA/San-Francisco'))
check('nothing is not a link', !looksLikePropertyUrl(''))

console.log('\n[Agents] Exports that are not what we asked for')
check('a file with no links is refused, with a reason', /Download All/.test(parseSearchExport('A,B\n1,2\n').error))
check('an empty file is refused', parseSearchExport('').ok === false)
const merged = mergeSearchExports([EXPORT, EXPORT])
check('the same file twice yields no duplicates', merged.rows.length === 3, String(merged.rows.length))
const partial = mergeSearchExports([EXPORT, 'A,B\n1,2\n'])
check('one bad file among good ones is reported, not fatal', partial.ok === true && partial.errors.length === 1, partial.errors[0])
check('url column ignores a column of search links', findUrlColumn(['a'], [{ a: 'https://www.redfin.com/city/17151' }]) === '')

console.log('\n[Agents] One person, however their name is written')
check('middle initial ignored', personKey('Alexander T. Clark') === personKey('Alexander Clark'))
check('suffix ignored', personKey('Robert R. Callan Jr.') === personKey('Robert Callan'))
check('different people stay different', personKey('Alexander Clark') !== personKey('Claudia Goytia'))
check('surname extracted', surnameOf('Kenneth Kohlmyer') === 'kohlmyer')
check('an abbreviated name joins the only full one', mergeAbbreviatedKeys(['kenneth kohlmyer', 'kohlmyer kohlmyer']).get('kohlmyer kohlmyer') === 'kenneth kohlmyer')
check('but not when two people share the surname', mergeAbbreviatedKeys(['kenneth kohlmyer', 'karen kohlmyer', 'kohlmyer kohlmyer']).get('kohlmyer kohlmyer') === 'kohlmyer kohlmyer')
check('an empty name has no key', personKey('') === '')

console.log('\n[Agents] The roll-up')
const ROWS = [
  { address: '71 Bradford St', soldDate: '2025-10-31', price: 2950000, dom: 30, signals: ['fixer'], listingAgent: { name: 'Kenneth Kohlmyer', brokerage: 'City Real Estate', license: 'DRE #01399332', phone: '415-672-1354', email: 'kj@cityrealestatesf.com' } },
  { address: '3752 Folsom St', soldDate: '2023-09-08', price: 912500, dom: 21, signals: ['needs work'], listingAgent: { name: 'K. Kohlmyer' } },
  { address: '1 Nice St', soldDate: '2024-01-01', price: 3000000, dom: 7, signals: [], listingAgent: { name: 'Kenneth Kohlmyer' } },
  { address: '2 Big Ave', soldDate: '2025-01-01', price: 5000000, dom: 9, signals: ['probate'], listingAgent: { name: 'Isabelle Grotte', brokerage: 'Compass', phone: '415-342-5010' } },
  { address: '3 Plain Rd', soldDate: '2025-02-01', price: 1000000, dom: 5, signals: [], listingAgent: { name: 'Never Ours' } },
  { address: 'no agent', soldDate: '2025-01-01', price: 1, dom: 1, signals: ['fixer'], listingAgent: null },
]
const agents = rollupAgents(ROWS)
check('an agent with none of our deals is left out', !agents.some((a) => a.name === 'Never Ours'))
check('a property with no agent is skipped, not crashed on', agents.length === 2, String(agents.length))
const ken = agents.find((a) => /Kohlmyer/.test(a.name))
check('abbreviated listing folded into the person', ken.ourDeals === 2 && ken.totalSales === 3, `${ken.ourDeals} of ${ken.totalSales}`)
check('the fullest spelling of the name is used', ken.name === 'Kenneth Kohlmyer', ken.name)
check('contact details gathered across listings', ken.phone === '415-672-1354' && ken.email === 'kj@cityrealestatesf.com')
check('share of their business computed', ken.share === 67, String(ken.share))
check('most recent of our deals dated', ken.lastDeal === '2025-10-31', ken.lastDeal)
check('median days on market across our deals', ken.medianDom === 26, String(ken.medianDom))
check('which signals they see, most common first', /fixer/.test(ken.signals) && /needs work/.test(ken.signals), ken.signals)
check('example properties carried for a sanity check', /Bradford/.test(ken.examples))
check('ranked by our deals first', agents[0].ourDeals >= agents[1].ourDeals)
check('a specialist outranks a generalist on a tie', rollupAgents([ROWS[3], ROWS[0], ROWS[2]])[0].name === 'Isabelle Grotte')
check('minDeals filters the long tail', rollupAgents(ROWS, { minDeals: 2 }).length === 1)
// Redfin's own Fixer-upper checkbox and keyword search can do the filtering,
// which collapses the job from 13,000 pages to about a thousand. The cost is
// the denominator: everyone would read 100%, so share is left blank instead.
const pre = rollupAgents(ROWS, { prefiltered: true })
check('a pre-filtered run reports no share rather than a fake 100%', pre.every((a) => a.share === null))
check('and its share column is blank, not zero', agentsToRows(pre).every((r) => r['Share %'] === ''))
check('an unfiltered run still reports share', rollupAgents(ROWS)[0].share > 0)

console.log('\n[Agents] Output')
const out = agentsToRows(agents)
check('every column filled', AGENT_COLUMNS.every((c) => c in out[0]), AGENT_COLUMNS.find((c) => !(c in out[0])))
check('price formatted for a person', /^\$[\d,]+$/.test(out[0]['Median Price']), out[0]['Median Price'])
check('a missing median is blank, not zero', agentsToRows([{ ...agents[0], medianDom: null }])[0]['Median DOM'] === '')
const sum = rollupSummary(ROWS, agents)
check('summary counts the run', sum.properties === 6 && sum.withAgent === 5 && sum.ourKind === 4)
check('summary names the filter', sum.namedSignals.includes('probate') && sum.namedSignals.includes('fixer'))
check('an empty run summarises without dividing by zero', rollupSummary([], []).ourKindPercent === 0)

// ---- the runner ------------------------------------------------------------------
console.log('\n[Agents] The runner')
const fs = await import('node:fs')
const { AgentList } = await import('../server/agents.js')
const { dealSignals } = await import('../server/sources/redfin.js')
const made = []
try {
  const a = AgentList.create({ files: [{ name: 'sf-1.csv', text: EXPORT }, { name: 'sf-2.csv', text: EXPORT }] })
  made.push(a)
  check('the same export twice is de-duplicated', a.properties.length === 3, String(a.properties.length))
  check('a run starts ready', a.state === 'ready' && a.counts().read === 0)
  // Three properties really is under a minute; what matters is that the estimate
  // scales, because the real job is ten thousand of them.
  check('a tiny job estimates under a minute', a.status().etaMinutes === 0, String(a.status().etaMinutes))
  const big = { ...a, properties: new Array(10000).fill(a.properties[0]), results: new Map(), options: a.options }
  const bigEta = AgentList.prototype._eta.call(big)
  check('ten thousand properties estimates in hours, not minutes', bigEta > 200 && bigEta < 1000, `${bigEta} min`)

  const PAGES = {
    '2014378': { agent: { name: 'Kenneth Kohlmyer', brokerage: 'City Real Estate', phone: '415-672-1354' }, remarks: 'This fixer-upper home presents an incredible opportunity.' },
    '760710': { agent: { name: 'Craig Ackerman', brokerage: 'Proof Real Estate' }, remarks: 'The property needs some TLC, so bring your contractor!' },
    '1094197': { agent: { name: 'Alexander Clark', brokerage: 'The Front Steps' }, remarks: 'Sophisticated luxury throughout.' },
  }
  for (const p of a.properties) {
    const page = PAGES[p.url.split('/home/')[1]]
    a._record(p, { ok: true, listingAgent: page.agent, signals: dealSignals(page.remarks), remarks: page.remarks }, 10)
  }
  const c = a.counts()
  check('every property recorded', c.read === 3 && c.withAgent === 3)
  check('only our kind counted as ours', c.ourKind === 2, String(c.ourKind))
  const list = a.agents()
  check('the luxury listing agent is left off the list', !list.some((x) => /Alexander Clark/.test(x.name)))
  check('two agents make the list', list.length === 2)

  // A stopped run must not redo work.
  const again = AgentList.load(a.id)
  made.push(again)
  check('results survive a reload', again.counts().read === 3, String(again.counts().read))
  check('a reloaded run offers no work left', again.properties.filter((p) => !again.results.has(p.url)).length === 0)

  const csv = a.outputCsv()
  check('the list downloads with a header', /Agent,Brokerage,DRE/.test(csv))
  check('the list holds the ranked agents', /Kenneth Kohlmyer/.test(csv) && /Craig Ackerman/.test(csv))
  check('the luxury agent is not in the download', !/Alexander Clark/.test(csv))
  const work = a.propertiesCsv()
  check('the working downloads too, all three properties', (work.match(/redfin\.com/g) || []).length === 3)
  check('the working keeps the luxury property, marked read', /Alexander Clark/.test(work))
  check('the filename says what it is', /^sf-listing-agents-\d{4}-\d{2}-\d{2}\.csv$/.test(a.outputFilename()), a.outputFilename())

  // A blocked page is not a property with no agent.
  const b = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(b)
  b._record(b.properties[0], { ok: false, blocked: true, error: 'Redfin returned a bot check.' }, 5)
  check('a block is recorded as a block', b.counts().blocked === 1 && b.counts().withAgent === 0)
  check('a blocked property is not counted as read-and-empty', /blocked by Redfin/.test(b.propertiesCsv()))
  check('a short run is not assumed pre-filtered', a.isPrefiltered() === false)

  let threw = ''
  try { AgentList.create({ files: [{ name: 'junk.csv', text: 'A,B\n1,2\n' }] }) } catch (err) { threw = err.message }
  check('a file with no Redfin links is refused', /Redfin/.test(threw), threw)

  // --- a run that starts from a search rather than from files ---------------
  console.log('\n[Agents] Starting from a Redfin search')
  const SEARCH_URL = 'https://www.redfin.com/city/17151/CA/San-Francisco/filter/include=sold-2yr,property-type=house'
  const sr = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(sr)
  check('the run is created with no properties yet', sr.properties.length === 0)
  check('and knows where they will come from', sr.search.url === SEARCH_URL, sr.search.url)
  check('the status says it came from a search', sr.status().source === 'search')
  check('a sold search raises no warning', sr.status().warnings.length === 0)
  // "0 minutes left" before anything has been walked reads as nearly done.
  check('there is no estimate before the search is walked', sr.status().etaMinutes === null, String(sr.status().etaMinutes))

  const loose = AgentList.createFromSearch({ searchUrl: 'https://www.redfin.com/city/17151/CA/San-Francisco' })
  made.push(loose)
  check('a search that is not limited to sold homes is flagged', /sold/i.test(loose.status().warnings[0] || ''), loose.status().warnings[0])

  const standard = AgentList.createFromSearch({})
  made.push(standard)
  check('no URL falls back to the standard San Francisco search', /include=sold-2yr/.test(standard.search.url), standard.search.url)

  let badSearch = ''
  try { AgentList.createFromSearch({ searchUrl: 'https://www.zillow.com/san-francisco-ca/' }) } catch (err) { badSearch = err.message }
  check('a non-Redfin URL is refused', /Redfin/.test(badSearch), badSearch)

  // The crawl itself, against a stand-in Redfin.
  const page = (n, total) => `<html>Viewing page ${n} of ${total}` +
    Array.from({ length: 2 }, (_, i) => {
      const id = n * 10 + i
      return `<div class="bp-Homecard__Price"><span class="bp-Homecard__Price--value">$${id}0,000</span></div><a class="bp-Homecard__Address" href="/CA/San-Francisco/${id}-Test-St-94110/home/${id}" target="_blank">${id} Test St, San Francisco, CA 94110</a>`
    }).join('') + '</html>'
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const m = String(url).match(/\/page-(\d+)$/)
    const n = m ? Number(m[1]) : 1
    return { ok: true, status: 200, text: async () => (n > 2 ? '<html>nothing</html>' : page(n, 2)) }
  }
  try {
    sr.setOptions({ crawlDelayMs: 250 })
    const crawled = await sr.findProperties()
    check('the search was walked', sr.crawl.pagesRead === 2, String(sr.crawl.pagesRead))
    check('and its properties collected', sr.properties.length === 4, String(sr.properties.length))
    check('the address came off the search card', /Test St/.test(sr.properties[0].address), sr.properties[0].address)
    check('so did the price', sr.properties[0].price === 100000, String(sr.properties[0].price))
    check('the run is ready to read them', crawled.state === 'ready', crawled.state)
    check('and now has an estimate', crawled.etaMinutes !== null)
    check('the crawl is saved, so a restart does not walk it again', AgentList.load(sr.id).properties.length === 4)

    // Walking the same search twice must not double the list.
    await sr.findProperties()
    check('walking it again does not duplicate the properties', sr.properties.length === 4, String(sr.properties.length))
  } finally {
    globalThis.fetch = origFetch
  }

  let noSearch = ''
  try { await b.findProperties() } catch (err) { noSearch = err.message }
  check('a file-built run has no search to walk', /files/.test(noSearch), noSearch)

  // Pressing Start without pressing "Find the properties first" has to do both,
  // because that is what most operators will do.
  const oneGo = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(oneGo)
  const escaped = (obj) => JSON.stringify(JSON.stringify(obj)).slice(1, -1)
  globalThis.fetch = async (url) => {
    const s = String(url)
    if (/\/home\/\d+$/.test(s)) {
      const body = `<html>\\"listingAgents\\":${escaped([{ agentInfo: { agentName: 'Dana Fixer' }, brokerName: 'Smoke Realty' }])}` +
        ',\\"marketingRemarks\\":[{\\"marketingRemark\\":\\"Contractor special, sold as-is.\\"}]</html>'
      return { ok: true, status: 200, text: async () => body }
    }
    const m = s.match(/\/page-(\d+)$/)
    const n = m ? Number(m[1]) : 1
    return { ok: true, status: 200, text: async () => (n > 1 ? '<html>nothing</html>' : page(1, 1)) }
  }
  try {
    oneGo.setOptions({ crawlDelayMs: 250, delayMs: 250 })
    await oneGo.start()
    check('Start walks the search first', oneGo.crawl?.pagesRead === 1, String(oneGo.crawl?.pagesRead))
    check('and then reads what it found', oneGo.counts().read === 2, String(oneGo.counts().read))
    check('the listing agent came off the property page', oneGo.counts().withAgent === 2)
    check('and the deal signals off its remarks', oneGo.counts().ourKind === 2)
    check('the run finished', oneGo.state === 'done', oneGo.state)
    check('an agent made the list', oneGo.agents().some((x) => x.name === 'Dana Fixer'), JSON.stringify(oneGo.agents().map((x) => x.name)))
    // The crawl card had no sold date; the property page's own history does.
    check('the address came from the search card', /10 Test St/.test(oneGo.propertiesCsv()), oneGo.propertiesCsv().split('\n')[1])
  } finally {
    globalThis.fetch = origFetch
  }
} finally {
  for (const j of made) { try { fs.rmSync(j.dir, { recursive: true, force: true }) } catch { /* already gone */ } }
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
