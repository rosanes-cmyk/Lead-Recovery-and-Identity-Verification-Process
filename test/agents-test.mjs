// Goal 2: reading Redfin's search export, and rolling properties up into a
// ranked list of listing agents.
import { parseSearchExport, mergeSearchExports, findUrlColumn, looksLikePropertyUrl } from '../server/sources/redfin-search.js'
import { rollupAgents, personKey, surnameOf, mergeAbbreviatedKeys, agentsToRows, rollupSummary, AGENT_COLUMNS } from '../server/agents.js'
import { coreSignals, CORE_DEAL_SIGNALS, CONTEXT_SIGNALS, dealSignals as sigs } from '../server/sources/redfin.js'

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
// --- what counts as our kind of deal ----------------------------------------
// The brief says "fixers, probate, trust and as-is". "Vacant" was counted as a
// deal signal and should not have been: in San Francisco "delivered vacant at
// close of escrow" is a premium, not distress, and on the first real run it put
// ten of twenty-one agents on the call list on its own.
console.log('\n[Agents] Vacant is context, not a deal')
check('vacant is not a deal signal', !CORE_DEAL_SIGNALS.includes('vacant'))
check('neither is investor', !CORE_DEAL_SIGNALS.includes('investor'))
check('but both are still matched', CONTEXT_SIGNALS.includes('vacant') && CONTEXT_SIGNALS.includes('investor'))
check('the brief\'s four families are all there', ['fixer', 'as-is', 'probate', 'trust sale'].every((x) => CORE_DEAL_SIGNALS.includes(x)))
check('a vacant listing carries the signal', sigs('Delivered vacant at close of escrow.').includes('vacant'))
check('but it is not a deal', coreSignals(sigs('Delivered vacant at close of escrow.')).length === 0)
check('a fixer that is also vacant is still a deal', coreSignals(sigs('Fixer, delivered vacant.')).join() === 'fixer')

const MIXED = [
  { listingAgent: { name: 'Shameran Anderer', brokerage: 'BarbCo' }, signals: ['as-is', 'probate', 'court confirmation'], address: '225 Granville Way', soldDate: '2026-05-28', price: 2925000 },
  { listingAgent: { name: 'Ning Ho', brokerage: 'Marcus & Millichap' }, signals: ['vacant'], address: '863 Greenwich St', soldDate: '2025-11-21', price: 1200000 },
  { listingAgent: { name: 'Ali Mafi', brokerage: 'Redfin' }, signals: ['investor'], address: '47 Curtis St', soldDate: '2025-06-20', price: 1160000 },
  { listingAgent: { name: 'Kevin Wong', brokerage: 'Compass' }, signals: ['fixer', 'vacant'], address: '1285 45th Ave', soldDate: '2025-03-24', price: 1100000 },
  { listingAgent: { name: 'Kevin Wong', brokerage: 'Compass' }, signals: ['vacant'], address: '9 Other St', soldDate: '2025-04-01', price: 1000000 },
]
const mixed = rollupAgents(MIXED)
check('a vacant-only agent is off the list', !mixed.some((a) => a.name === 'Ning Ho'), JSON.stringify(mixed.map((a) => a.name)))
check('an investor-only agent is off the list', !mixed.some((a) => a.name === 'Ali Mafi'))
check('a probate agent is on it', mixed.some((a) => a.name === 'Shameran Anderer'))
const kw = mixed.find((a) => a.name === 'Kevin Wong')
check('a fixer that was also vacant counts once, as a fixer', kw?.ourDeals === 1, String(kw?.ourDeals))
check('and the signal column shows only the deal', kw?.signals === 'fixer (1)', kw?.signals)
// Nothing is thrown away: context is counted across everything they listed,
// because "most of their sales were vacant" is itself worth knowing.
check('vacant survives as context', kw?.context === 'vacant (2)', kw?.context)
check('an agent with no context says nothing', mixed.find((a) => a.name === 'Shameran Anderer')?.context === '')
check('the column is in the output', AGENT_COLUMNS.includes('Also Seen'))
check('and is filled in', agentsToRows(mixed).find((r) => r.Agent === 'Kevin Wong')['Also Seen'] === 'vacant (2)')
// Share is still measured against everything they listed, not just the deals.
check('total sales still counts every listing', kw?.totalSales === 2, String(kw?.totalSales))

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
    check('the search was walked', sr.crawl.through === 2, String(sr.crawl.through))
    check('and its properties collected', sr.properties.length === 4, String(sr.properties.length))
    check('the address came off the search card', /Test St/.test(sr.properties[0].address), sr.properties[0].address)
    check('so did the price', sr.properties[0].price === 100000, String(sr.properties[0].price))
    check('the run is ready to read them', crawled.state === 'ready', crawled.state)
    check('and now has an estimate', crawled.etaMinutes !== null)
    check('the crawl is saved, so a restart does not walk it again', AgentList.load(sr.id).properties.length === 4)

    // Walking the same search twice must not double the list.
    await sr.findProperties()
    check('walking it again does not duplicate the properties', sr.properties.length === 4, String(sr.properties.length))
    check('a finished crawl is not partial', sr.crawl.partial === false)
  } finally {
    globalThis.fetch = origFetch
  }

  // A crawl cut short is the failure that looks most like a success, so it has
  // to be recorded as partial and has to pick up where it stopped.
  const cut = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(cut)
  let allow = 3
  globalThis.fetch = async (url) => {
    const m = String(url).match(/\/page-(\d+)$/)
    const n = m ? Number(m[1]) : 1
    if (n > allow) return { ok: false, status: 429, text: async () => '' }
    return { ok: true, status: 200, text: async () => page(n, 8) }
  }
  const walkedPages = []
  try {
    cut.setOptions({ crawlDelayMs: 250 })
    await cut.findProperties()
    check('a cut-short crawl records how far it got', cut.crawl.through === 3, String(cut.crawl.through))
    check('and how far it should have got', cut.crawl.totalPages === 8, String(cut.crawl.totalPages))
    check('and flags itself partial', cut.crawl.partial === true)
    check('and says it was refused', /429/.test(cut.crawl.error), cut.crawl.error)
    check('but keeps what it collected', cut.properties.length === 6, String(cut.properties.length))

    // Now let it through and walk again.
    allow = 8
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => { walkedPages.push(String(url)); return realFetch(url) }
    await cut.findProperties()
    check('walking again picks up where it stopped', !walkedPages.some((u) => /page-1$/.test(u)), walkedPages[0])
    check('with a page of overlap against shifting results', /page-2$/.test(walkedPages[0]), walkedPages[0])
    check('and finishes the search', cut.crawl.through === 8 && cut.crawl.partial === false, String(cut.crawl.through))
    check('collecting the rest', cut.properties.length === 16, String(cut.properties.length))
  } finally {
    globalThis.fetch = origFetch
  }

  // --- a run that reads nothing must stop and say why ----------------------
  console.log('\n[Agents] When nothing can be read')
  const { isRefusalStatus } = await import('../server/sources/redfin.js')
  check('403 is a refusal', isRefusalStatus(403) === true)
  check('429 is a refusal', isRefusalStatus(429) === true)
  check('503 is a refusal', isRefusalStatus(503) === true)
  // A 404 is about that one page. Pausing the whole run on it would stop a
  // good run dead on one dead link.
  check('404 is not a refusal', isRefusalStatus(404) === false)
  check('500 is not a refusal', isRefusalStatus(500) === false)

  const blocked = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(blocked)
  for (const p of blocked.properties) blocked._record(p, { ok: false, blocked: true, error: 'Redfin returned HTTP 403.' }, 5)
  check('a wholly blocked run is diagnosed as blocked', /refused/.test(blocked.diagnosis()), blocked.diagnosis())
  check('and says to wait and raise the pause', /Resume/.test(blocked.diagnosis()))

  // "No agent or remarks" has two causes needing opposite responses, and the
  // run has to say which. This is the gap that left the first real run
  // undiagnosable.
  const { describePage } = await import('../server/sources/redfin.js')
  const realPage = '<html><head><title>2625 Broderick St</title></head><body>' + 'x'.repeat(200000) + '\\"listingAgents\\":[] \\"marketingRemarks\\":[]</body></html>'
  const d = describePage(realPage)
  check('a real page is recognised by the keys it carries', d.hasListingAgents && d.hasRemarks)
  check('and its title is kept', d.title === '2625 Broderick St', d.title)
  check('an empty body carries nothing', describePage('').hasListingAgents === false)

  const brokenReader = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(brokenReader)
  for (const p of brokenReader.properties) {
    brokenReader._record(p, { ok: false, error: 'Redfin page had no agent or remarks.' }, 5, describePage(realPage))
  }
  check('pages that still carry the data point at the reader', /reader has stopped understanding/.test(brokenReader.missSummary()), brokenReader.missSummary())
  check('and ask for the evidence file', /miss-1\.html/.test(brokenReader.missSummary()))

  const softBlocked = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(softBlocked)
  for (const p of softBlocked.properties) {
    softBlocked._record(p, { ok: false, error: 'Redfin page had no agent or remarks.' }, 5, describePage('<html><head><title>Just a moment...</title></head><body>checking</body></html>'))
  }
  check('pages missing the data point at a soft block', /soft block/.test(softBlocked.missSummary()), softBlocked.missSummary())
  check('and name what was served instead', /Just a moment/.test(softBlocked.missSummary()))
  const noMisses = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(noMisses)
  check('a run with no misses says nothing', noMisses.missSummary() === '')

  const noAgents = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(noAgents)
  for (const p of noAgents.properties) noAgents._record(p, { ok: true, listingAgent: null, signals: [], remarks: 'A home.' }, 5)
  check('no agents anywhere is reported', /not one carried a listing agent/.test(noAgents.diagnosis()), noAgents.diagnosis())
  // With nothing recorded about the pages, the run must not guess at a cause.
  check('and with no evidence it points at the working file rather than guessing', /Download the working/.test(noAgents.diagnosis()))
  // With evidence, the same shortfall names its cause instead.
  check('the same shortfall with evidence names the cause', /reader has stopped understanding/.test(brokenReader.diagnosis()), brokenReader.diagnosis())

  const noDeals = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(noDeals)
  for (const p of noDeals.properties) noDeals._record(p, { ok: true, listingAgent: { name: 'Jane Luxury', brokerage: 'Nice Homes' }, signals: [], remarks: 'Sophisticated luxury throughout.' }, 5)
  check('agents but no deals points at the search', /wrong kind of property/.test(noDeals.diagnosis()), noDeals.diagnosis())

  const fine = AgentList.create({ files: [{ name: 'x.csv', text: EXPORT }] })
  made.push(fine)
  for (const p of fine.properties) fine._record(p, { ok: true, listingAgent: { name: 'Kenneth Kohlmyer' }, signals: ['fixer'], remarks: 'Fixer-upper.' }, 5)
  check('a run that worked is not diagnosed at all', fine.diagnosis() === '', fine.diagnosis())

  // The streak must count every consecutive failure, not only the refusals we
  // recognise — that gap is what let a run grind through 238 properties
  // collecting nothing and report "done".
  const stall = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(stall)
  stall.properties = Array.from({ length: 30 }, (_, i) => ({ url: `https://www.redfin.com/CA/San-Francisco/${i}-X-St-94110/home/${i}`, address: `${i} X St`, price: null, soldDate: '', dom: null, propertyType: '' }))
  stall._saveJob()
  let asked = 0
  globalThis.fetch = async () => { asked++; return { ok: false, status: 403, text: async () => '' } }
  try {
    stall.setOptions({ delayMs: 250 })
    // start() parks on the pause gate waiting for an operator, which is the
    // whole point, so drive it from outside rather than awaiting it.
    const running = stall.start()
    const until = Date.now() + 8000
    while (stall.state !== 'paused' && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    check('a run that cannot read anything pauses instead of grinding on', stall.state === 'paused', stall.state)
    check('and stops after a handful, not all thirty', stall.counts().read <= 6, String(stall.counts().read))
    check('a refusal is not retried, which would only ask faster', asked <= 6, String(asked))
    check('the refusals are recorded as blocks, not as empty properties', stall.counts().blocked === stall.counts().read, `${stall.counts().blocked}/${stall.counts().read}`)
    check('the pause says it is Redfin refusing, not a broken search', /refused/.test(stall._lastPauseMessage || ''), stall._lastPauseMessage)
    stall.stop()
    await running
  } finally {
    globalThis.fetch = origFetch
  }

  // --- the browser fallback ------------------------------------------------
  console.log('\n[Agents] Falling back to the browser when plain requests are refused')
  const rescued = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(rescued)
  rescued.properties = [
    { url: 'https://www.redfin.com/CA/San-Francisco/1-R-St-94110/home/1', address: '1 R St', price: null, soldDate: '', dom: null, propertyType: '' },
    { url: 'https://www.redfin.com/CA/San-Francisco/2-R-St-94110/home/2', address: '2 R St', price: null, soldDate: '', dom: null, propertyType: '' },
  ]
  rescued._saveJob()
  // Plain fetch is refused for everything, exactly as the live run was.
  globalThis.fetch = async () => ({ ok: true, status: 202, text: async () => '' })
  const agentJson = JSON.stringify(JSON.stringify([{ agentInfo: { agentName: 'Rescued Agent' }, brokerName: 'Browser Realty' }])).slice(1, -1)
  const goodPage = `<html>\\"listingAgents\\":${agentJson},\\"marketingRemarks\\":[{\\"marketingRemark\\":\\"Probate sale, sold as-is.\\"}]</html>`
  let browserReads = 0
  rescued._browserPage = async () => ({
    goto: async () => { browserReads++ },
    waitForTimeout: async () => {},
    content: async () => goodPage,
  })
  try {
    rescued.setOptions({ delayMs: 250 })
    await rescued.start()
    check('the browser is used once plain requests are refused', browserReads === 2, String(browserReads))
    check('and the properties are read after all', rescued.counts().read === 2 && rescued.counts().withAgent === 2, JSON.stringify(rescued.counts()))
    check('nothing is left marked blocked', rescued.counts().blocked === 0)
    check('the agent makes the list', rescued.agents().some((a) => a.name === 'Rescued Agent'), JSON.stringify(rescued.agents().map((a) => a.name)))
    check('the run finished rather than pausing', rescued.state === 'done', rescued.state)
    // A rescued property is no longer a miss, so nothing should be diagnosed.
    check('no diagnosis on a rescued run', rescued.diagnosis() === '', rescued.diagnosis())
  } finally {
    globalThis.fetch = origFetch
  }

  // Once plain requests are reliably refused, trying one first is a wasted
  // round trip on every property. On six thousand of them that is hours.
  const thrifty = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(thrifty)
  thrifty.properties = Array.from({ length: 12 }, (_, i) => ({ url: `https://www.redfin.com/CA/San-Francisco/${i}-T-St-94110/home/${i}`, address: `${i} T St`, price: null, soldDate: '', dom: null, propertyType: '' }))
  thrifty._saveJob()
  let plainTries = 0
  globalThis.fetch = async () => { plainTries++; return { ok: true, status: 202, text: async () => '' } }
  thrifty._browserPage = async () => ({ goto: async () => {}, waitForTimeout: async () => {}, content: async () => goodPage })
  try {
    thrifty.setOptions({ delayMs: 250 })
    await thrifty.start()
    check('all twelve are read through the browser', thrifty.counts().read === 12 && thrifty.counts().withAgent === 12, JSON.stringify(thrifty.counts()))
    // Five to establish the refusal, then it stops asking.
    check('it stops trying plain requests once they are hopeless', plainTries <= 6, `${plainTries} plain attempts for 12 properties`)
  } finally {
    globalThis.fetch = origFetch
  }

  // ...but it must try again eventually, or a refusal that lifts is never noticed.
  const patient = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(patient)
  patient._rescues = 99
  check('a run that has given up skips the plain request', patient._shouldFetch(7) === false)
  check('and tries one again on the interval', patient._shouldFetch(50) === true)
  patient._rescues = 0
  check('a fresh run always tries the cheap way first', patient._shouldFetch(7) === true)

  // With the browser turned off, the same run has to fail rather than pretend.
  const noBrowser = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(noBrowser)
  noBrowser.properties = [...rescued.properties]
  noBrowser._saveJob()
  noBrowser.setOptions({ delayMs: 250, useBrowser: false })
  check('the browser can be turned off', noBrowser.options.useBrowser === false)
  let opened = 0
  noBrowser._browserPage = async () => { opened++; return null }
  globalThis.fetch = async () => ({ ok: true, status: 202, text: async () => '' })
  try {
    await noBrowser.start()
    check('and then it is never opened', opened === 0, String(opened))
    check('and the properties are recorded as blocked', noBrowser.counts().blocked === 2, String(noBrowser.counts().blocked))
  } finally {
    globalThis.fetch = origFetch
  }

  // --- runs the server died in the middle of --------------------------------
  // "running" describes a process; the process does not survive a restart but
  // the state on disk does, so the run is refused by every button that checks
  // isActive() and can never be started again. This is what stranded a live
  // run at 127 of 6,449.
  console.log('\n[Agents] Recovering a run the server died during')
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const stranded = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(stranded)
  stranded.properties = [{ url: 'https://www.redfin.com/CA/San-Francisco/1-S-St/home/1', address: '1 S St', price: null, soldDate: '', dom: null, propertyType: '' }]
  stranded.state = 'running'
  stranded._saveJob()
  check('the stranded run is refused before recovery', AgentList.load(stranded.id).isActive() === true)

  const pausedToo = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(pausedToo)
  pausedToo.state = 'paused'
  pausedToo._saveJob()
  const crawling = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(crawling)
  crawling.state = 'crawling'
  crawling._saveJob()
  const finished = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(finished)
  finished.state = 'done'
  finished._saveJob()

  const recovered = AgentList.recoverInterrupted()
  const ids = recovered.map((r) => r.id)
  check('a run left running is recovered', ids.includes(stranded.id), JSON.stringify(recovered))
  check('so is one left paused, whose gate died with the process', ids.includes(pausedToo.id))
  check('and one left mid-crawl', ids.includes(crawling.id))
  check('a finished run is left alone', !ids.includes(finished.id))
  check('it reports what each one was', recovered.find((r) => r.id === stranded.id)?.was === 'running')

  const back = AgentList.load(stranded.id)
  check('the recovered run can be started again', back.isActive() === false && back.state === 'ready', back.state)
  check('and keeps its properties', back.properties.length === 1)
  check('recovering twice is harmless', AgentList.recoverInterrupted().every((r) => r.id !== stranded.id))

  // A phase that throws must not leave the same wreckage behind.
  const thrower = AgentList.createFromSearch({ searchUrl: SEARCH_URL })
  made.push(thrower)
  thrower.properties = [{ url: 'https://www.redfin.com/CA/San-Francisco/2-S-St/home/2', address: '2 S St', price: null, soldDate: '', dom: null, propertyType: '' }]
  thrower.start = async () => { thrower._setState('running'); throw new Error('the wheels came off') }
  await thrower.startSafely()
  check('a run whose start throws does not stay marked running', thrower.isActive() === false, thrower.state)
  check('and says what happened', /wheels came off/.test(thrower._lastStateMessage || ''), thrower._lastStateMessage)

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
