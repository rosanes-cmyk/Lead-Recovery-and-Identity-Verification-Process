// Property Enrichment tests. No browser and no network: the pure helpers are
// checked directly, and the engine runs in DEMO_MODE (synthetic lookups) so the
// queue / checkpoint / resume / CSV-output logic is proven end to end.

process.env.DEMO_MODE = 'true' // must be set before config.js loads (dynamic imports below)
import fs from 'node:fs'
const { parseCsv, csvToRecords, toCsv, detectAddressColumns, buildAddress, tidyZip, addressMatch } = await import('../server/csv.js')
const { parseDdgHtml, classifyLink, extractSoldFacts } = await import('../server/sources/websearch.js')
const { Enrichment, ENRICH_COLUMNS } = await import('../server/enrich.js')
const { parseZillowText, zillowSearchUrl, parseZillowAgents, parseAgentBlock } = await import('../server/sources/zillow.js')

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- CSV ------------------------------------------------------------------------
console.log('\n[Enrich] CSV parse / serialize')
const raw = '﻿A,B,C\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",z\r\n'
const rows = parseCsv(raw)
check('BOM + CRLF + 3 rows', rows.length === 3 && rows[0][0] === 'A')
check('quoted comma kept', rows[1][1] === 'x, y')
check('escaped quote', rows[1][2] === 'say "hi"')
check('embedded newline', rows[2][1] === 'multi\nline')
const recs = csvToRecords(raw)
check('records keyed by header', recs.records[0].B === 'x, y')
check('round-trip', JSON.stringify(csvToRecords(toCsv(recs.headers, recs.records)).records) === JSON.stringify(recs.records))
check('duplicate headers suffixed', csvToRecords('A,A,B\n1,2,3').headers.join('|') === 'A|A (2)|B')
check('blank rows skipped', csvToRecords('A,B\n1,2\n,\n3,4\n').records.length === 2)

// ---- Zillow agents (the attribution block, verbatim from a live page) ------------
console.log('\n[Enrich] Zillow listing attribution')
const ZTEXT = `Zillow last checked: 29 minutes ago
Listing updated: February 10, 2026 at 10:02am
Listed by:
Perry Kayasone DRE #01943235 415-290-0736,
Sequoia Real Estate 888-499-7773
Bought with:
Donna Chan, DRE #01774693
Exp Realty of California Inc.
Source: SFAR,  MLS#: 426097788
Originating MLS: San Francisco Association of REALTORS`
const za = parseZillowAgents(ZTEXT)
check('listing agent name', za.listingAgent?.name === 'Perry Kayasone', za.listingAgent?.name)
check('listing agent licence', za.listingAgent?.license === 'DRE #01943235')
check('listing agent phone', za.listingAgent?.phone === '415-290-0736')
check('brokerage, not the phone number', za.listingAgent?.brokerage === 'Sequoia Real Estate', za.listingAgent?.brokerage)
check('broker phone kept separately', za.listingAgent?.brokerPhone === '888-499-7773')
check('buyer agent name', za.buyerAgent?.name === 'Donna Chan', za.buyerAgent?.name)
check('buyer agent licence', za.buyerAgent?.license === 'DRE #01774693')
check('buyer brokerage across a line break', za.buyerAgent?.brokerage === 'Exp Realty of California Inc.', za.buyerAgent?.brokerage)
check('MLS number', za.mlsNumber === '426097788')
check('MLS source', za.mlsSource === 'SFAR', za.mlsSource)
const none = parseZillowAgents('Zillow last checked: 3 minutes ago\nNo listing attribution here.')
check('no attribution -> no agents invented', !none.listingAgent && !none.buyerAgent)
check('empty text is safe', !parseZillowAgents('').listingAgent)
check('a name with digits is rejected', parseAgentBlock('12345 DRE #01943235') === null)
check('placeholder name rejected', parseAgentBlock('N/A, DRE #01943235') === null)
check('agent with no licence still read', parseAgentBlock('Jane Doe, Compass')?.name === 'Jane Doe')
// A "Listed by" block can name a co-listing agent; only the first is wanted, and
// the second must not end up inside the first one's brokerage.
const co = parseAgentBlock('Peter Iskandar DRE #01481566 415-297-5185, Trident Real Estate , Yulia Iskandar DRE #02034288 , Trident Real Estate')
check('co-listing agent ignored', co?.name === 'Peter Iskandar', co?.name)
check('brokerage stops before the co-agent', co?.brokerage === 'Trident Real Estate', co?.brokerage)
check('a comma inside a brokerage name survives', parseAgentBlock('Donna Chan, DRE #01774693 eXp Realty of California, Inc.')?.brokerage === 'eXp Realty of California, Inc.')
check('agent with no brokerage', parseAgentBlock('Robert R. Callan Jr. DRE #01469224 415-748-1481')?.name === 'Robert R. Callan Jr.')

// ---- address columns ------------------------------------------------------------
console.log('\n[Enrich] Address column detection')
const SF = ['Street Address', 'Postal City', 'State', 'Zip Code', 'Price', 'DOM', "Buyer's Agent Full Name", "Buyer's Agent Email"]
const m = detectAddressColumns(SF)
check('SF export -> parts', m.mode === 'parts' && m.street === 'Street Address' && m.city === 'Postal City' && m.state === 'State' && m.zip === 'Zip Code', JSON.stringify(m))
check('buildAddress + zip fix', buildAddress({ 'Street Address': '135 Prague St', 'Postal City': 'San Francisco', State: 'ca', 'Zip Code': '94112.0' }, m) === '135 Prague St, San Francisco, CA 94112')
check('blank city still builds street + ZIP', buildAddress({ 'Street Address': '324 5th Street', 'Postal City': '', State: 'CA', 'Zip Code': '94107' }, m) === '324 5th Street, CA 94107')
check('blank street -> no address (row is skipped)', buildAddress({ 'Street Address': '', 'Postal City': 'San Francisco', State: 'CA', 'Zip Code': '94107' }, m) === '')
check('single Address column -> full', detectAddressColumns(['Name', 'Address']).mode === 'full')
check('Address + City -> parts', detectAddressColumns(['Address', 'City', 'State', 'Zip']).mode === 'parts')
check('nothing recognised -> none', detectAddressColumns(['Name', 'Phone']).mode === 'none')
check('zip leading zero restored', tidyZip('2134') === '02134')

console.log('\n[Enrich] Address match (PropertyRadar result vs. input)')
check('abbreviations match', addressMatch('135 Prague Street, San Francisco, CA', '135 PRAGUE ST, SAN FRANCISCO, CA 94112') === 'match')
check('unit ignored', addressMatch('2200 Pacific Ave #4', '2200 PACIFIC AVENUE UNIT 4') === 'match')
check('different number -> mismatch', addressMatch('135 Prague St', '136 Prague St') === 'mismatch')
check('different street -> mismatch', addressMatch('135 Prague St', '135 Oak St') === 'mismatch')
check('shared direction alone is not a match', addressMatch('10 N Main St', '10 N Oak Ave') === 'mismatch')
check('numbered street', addressMatch('324 5th Street', '324 5TH ST, SAN FRANCISCO, CA 94107') === 'match')
check('suffix change still matches', addressMatch('135 Prague Way', '135 PRAGUE ST') === 'match')
check('empty -> unknown', addressMatch('135 Prague St', '') === 'unknown')

// ---- web search parsing ---------------------------------------------------------
console.log('\n[Enrich] DuckDuckGo HTML parsing')
const ddg =
  '<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.redfin.com%2FCA%2FSan-Francisco%2F135-Prague-St-94112%2Fhome%2F1234&amp;rut=abc">135 Prague St | Redfin</a></h2>' +
  '<a class="result__snippet" href="x">Sold for &#36;1,150,000 on Mar 15, 2024. 3 beds &amp; 2 baths.</a></div>' +
  '<div class="result"><a class="result__a" href="https://sfassessor.org/property/135-prague">SF Assessor</a><div class="result__snippet">Parcel lookup</div></div>' +
  '<div class="result"><a class="result__a" href="https://duckduckgo.com/settings">Settings</a></div>'
const p = parseDdgHtml(ddg)
check('two external results (internal link dropped)', p.results.length === 2 && !p.challenged)
check('uddg redirect decoded', p.results[0].url === 'https://www.redfin.com/CA/San-Francisco/135-Prague-St-94112/home/1234', p.results[0].url)
check('snippet paired with its result', p.results[0].snippet.includes('1,150,000') && p.results[1].snippet === 'Parcel lookup')
check('classification', classifyLink(p.results[0].url) === 'redfin' && classifyLink(p.results[1].url) === 'county' && classifyLink('https://www.zillow.com/x') === 'zillow')
const facts = extractSoldFacts(p.results[0].snippet)
check('sold price + date from snippet', facts.soldPrice === '$1,150,000' && facts.soldDate === 'Mar 15, 2024', JSON.stringify(facts))
check('bot challenge detected', parseDdgHtml('<form class="challenge-form" action="//duckduckgo.com/anomaly.js">').challenged === true)
check('data broker is not "county"', classifyLink('https://www.countyoffice.org/property-record-547-missouri-st-san-francisco-ca-94107/') === 'other')
check('largest price near "sold" wins', extractSoldFacts('Sold $35,000 over asking. Sold: $6,375,000 on Oct 13, 2023').soldPrice === '$6,375,000')

// ---- Zillow page text -------------------------------------------------------------
console.log('\n[Enrich] Zillow page parsing')
const zt = 'Buy Rent Sell\n324 5th St, San Francisco, CA 94107\nCalifornia • San Francisco County • San Francisco • 94107\nOff market\nZestimate: $1,925,000\nMobileManufactured  Built in 2017  4.38 Acres Lot\n... nearby homes for sale ...'
const zp = parseZillowText(zt)
check('county from breadcrumb', zp.county === 'San Francisco', zp.county)
check('property type badge', zp.propertyType === 'MobileManufactured', zp.propertyType)
check('listing status', zp.listingStatus === 'Off Market', zp.listingStatus)
check('bot check detected', parseZillowText('Press & Hold to confirm you are a human').blocked === true)
check('own badge beats later noise', parseZillowText('For sale\n$1,200,000\n3 bd 2 ba\nSingle family residence\n... similar condos off market nearby ...').listingStatus === 'For Sale')
check('type: own badge beats later noise', parseZillowText('Condo\nBuilt in 1999\n... nearby single family homes ...').propertyType === 'Condo')
check('tax table "Land" column is not Lot/Land', parseZillowText('Single family residence\nBuilt in 1900\nTax history\nYear Property taxes Land Improvement\n2025 $22,000 $600,000 $300,000').propertyType === 'Single Family')
check('search url slug', zillowSearchUrl('324 5th St, San Francisco, CA 94107') === 'https://www.zillow.com/homes/324-5th-St-San-Francisco-CA-94107/')

// ---- engine (demo mode) -----------------------------------------------------------
console.log('\n[Enrich] Engine: run, checkpoint, output CSV')
const csv = [
  'Street Address,Postal City,State,Zip Code,Price,"Buyer\'s Agent Full Name"',
  '135 Prague St,San Francisco,CA,94112,1000000,Peter Iskandar',
  '70 Oak Ave,San Francisco,CA,94117,2000000,"Shinbori, James"', // demo: 70 % 7 == 0 -> entity owner
  '121 Pine St,San Francisco,CA,94108,3000000,Jack Burrows', // demo: 121 % 11 == 0 -> not found
  ',,,,,Blank Row Agent', // no address -> skipped, row kept in place
  '2200 Pacific Ave #4,San Francisco,CA,94115,4000000,Ron Sebahar',
  '9 Hill Ct,,CA,94110,5000000,Robin Hubinsky', // city blank -> searched by street + ZIP, noted
].join('\r\n') + '\r\n'
const made = []
try {
  const e = Enrichment.create({ csvText: csv, filename: 'SF test.csv' })
  made.push(e)
  e.setOptions({ delayMs: 10 })
  const events = []
  e.on('event', (ev) => events.push(ev))
  const st = await e.start()
  check('finishes done', st.state === 'done' && e.results.size === 6, `${st.state} ${e.results.size}`)
  check('row + done events', events.filter((v) => v.sub === 'row').length === 6 && events.some((v) => v.sub === 'done'))
  const f = (i) => e.results.get(i).fields
  check('owner found', f(0)['PR Status'] === 'found' && f(0)['PR Owner of Record'] === 'Demo Owner 135')
  check('entity owner flagged', f(1)['PR Entity Owner'] === 'Yes' && /LLC/.test(f(1)['PR Title Holder']))
  check('not found -> FIELD NOT FOUND, never a guess', f(2)['PR Status'] === 'not found' && f(2)['PR Owner of Record'] === 'FIELD NOT FOUND')
  check('blank address -> skipped', f(3)['PR Status'] === 'skipped' && f(3)['Web Status'] === 'skipped')
  check('web links filled', /zillow\.com/.test(f(0)['Web Zillow']) && f(0)['Web Status'] === 'found (demo)')
  check('partial address is noted', /^city blank in the sheet; searched as "9 Hill Ct, CA 94110"/.test(f(5)['Enrichment Notes']), f(5)['Enrichment Notes'])
  check('checkpoint has one line per row', fs.readFileSync(e.dir + '/results.jsonl', 'utf-8').trim().split('\n').length === 6)
  const out = csvToRecords(e.outputCsv())
  check('output = original + enrichment columns', out.headers.length === 6 + ENRICH_COLUMNS.length)
  check('rows aligned with originals', out.records[1]["Buyer's Agent Full Name"] === 'Shinbori, James' && out.records[1]['PR Entity Owner'] === 'Yes')
  check('blank row stays in place', out.records[3]["Buyer's Agent Full Name"] === 'Blank Row Agent' && out.records[3]['PR Status'] === 'skipped')
  check('output filename', e.outputFilename() === 'SF test-enriched.csv')
  check('agent columns present', ENRICH_COLUMNS.includes('Redfin Listing Agent') && ENRICH_COLUMNS.includes('Redfin Buyer Agent'))
  check('agent contact columns present', ['Redfin Listing Brokerage', 'Redfin Listing Agent DRE', 'Redfin Listing Agent Phone', 'Redfin Listing Agent Email'].every((c) => ENRICH_COLUMNS.includes(c)))
  check('special assessments get their own column', ENRICH_COLUMNS.includes('Liens Special Assessment'))
  check('deal-signal column present', ENRICH_COLUMNS.includes('Redfin Deal Signals'))
  check('Redfin read per row', /Demo Listing Agent/.test(f(0)['Redfin Listing Agent']) && f(0)['Redfin Status'] === 'found', f(0)['Redfin Status'])
  check('skipped row has no Redfin agent', f(3)['Redfin Listing Agent'] === '')
  check('Zillow agent columns present', ['Zillow Listing Agent', 'Zillow Listing Brokerage', 'Zillow Buyer Agent', 'Agents Agree'].every((c) => ENRICH_COLUMNS.includes(c)))
  check('agents cross-checked between the two sites', f(0)['Agents Agree'] === 'yes', f(0)['Agents Agree'])
  check('a middle initial is not a disagreement', (() => {
    const j = Enrichment.create({ csvText: csv, filename: 'names.csv' })
    made.push(j)
    const row = { 'Redfin Listing Agent': 'Alexander Clark', 'Zillow Listing Agent': 'Alexander T. Clark' }
    j._crossCheckAgents(row)
    return row['Agents Agree'] === 'yes'
  })())
  check('a suffix is not a disagreement', (() => {
    const j = made[made.length - 1]
    const row = { 'Redfin Listing Agent': 'Robert Callan', 'Zillow Listing Agent': 'Robert R. Callan Jr.' }
    j._crossCheckAgents(row)
    return row['Agents Agree'] === 'yes'
  })())
  check('genuinely different agents still flagged', (() => {
    const j = made[made.length - 1]
    const row = { 'Redfin Listing Agent': 'Alexander Clark', 'Zillow Listing Agent': 'Claudia Goytia' }
    j._crossCheckAgents(row)
    return /^no —/.test(row['Agents Agree'])
  })())
  check('one site only is said so', (() => {
    const j = made[made.length - 1]
    const row = { 'Redfin Listing Agent': 'Alexander Clark', 'Zillow Listing Agent': '' }
    j._crossCheckAgents(row)
    return row['Agents Agree'] === 'Redfin only'
  })())
  check('a stuck site can be skipped for the run', (() => {
    const j = made[made.length - 1]
    j.options.zillowCheck = true
    const done = j.skipSite('zillow')
    return done === true && j.options.zillowCheck === false
  })())
  check('an unknown site is not skippable', made[made.length - 1].skipSite('nonsense') === false)
  check('lien columns present', ['Liens Open Loans', 'Liens Unreleased', 'Liens Notice of Default', 'Liens Summary', 'Liens Status'].every((c) => ENRICH_COLUMNS.includes(c)))
  check('liens read per row', f(0)['Liens Status'] === 'found' && /loan/.test(f(0)['Liens Summary']), f(0)['Liens Summary'])
  check('skipped row has no lien data', f(3)['Liens Status'] !== 'found')
  check('liens can be turned off', (() => {
    const off = Enrichment.create({ csvText: csv, filename: 'noliens.csv' })
    made.push(off)
    off.setOptions({ liens: false })
    return off.options.liens === false
  })())
  check('Redfin can be turned off', (() => {
    const off = Enrichment.create({ csvText: csv, filename: 'off.csv' })
    made.push(off)
    off.setOptions({ redfin: false })
    return off.options.redfin === false
  })())

  console.log('\n[Enrich] Engine: stop, reload from disk, resume')
  const e2 = Enrichment.create({ csvText: csv, filename: 'resume.csv' })
  made.push(e2)
  e2.setOptions({ delayMs: 10 })
  e2.on('event', (ev) => { if (ev.sub === 'row' && e2.results.size === 2) e2.stop() })
  const st2 = await e2.start()
  check('stopped after 2 rows', st2.state === 'stopped' && e2.results.size === 2, `${st2.state} ${e2.results.size}`)
  const e3 = Enrichment.load(e2.id)
  check('reloaded as resumable', e3 && e3.state === 'stopped' && e3.results.size === 2)
  const seen = []
  e3.on('event', (ev) => { if (ev.sub === 'row') seen.push(ev.i) })
  const st3 = await e3.start()
  check('resumed to done', st3.state === 'done' && e3.results.size === 6)
  check('only the remaining rows were processed', JSON.stringify(seen) === '[2,3,4,5]', JSON.stringify(seen))
  check('no duplicate checkpoint lines', fs.readFileSync(e3.dir + '/results.jsonl', 'utf-8').trim().split('\n').length === 6)
  check('partial download mid-way is a valid sheet', csvToRecords(Enrichment.load(e2.id).outputCsv()).records.length === 6)
  check('jobs listed', Enrichment.list().filter((s) => [e.id, e2.id].includes(s.id)).length === 2)

  console.log('\n[Enrich] Engine: pauses after repeated PropertyRadar misses (mocked lookups)')
  const { config } = await import('../server/config.js')
  const e5 = Enrichment.create({ csvText: csv, filename: 'streak.csv' })
  made.push(e5)
  e5.setOptions({ delayMs: 5, webSearch: false, screenshots: false, zillowCheck: false })
  config.demoMode = false
  try {
    const fakePage = { url: () => 'about:blank', innerText: async () => '' }
    e5._openBrowser = async () => fakePage
    e5._openPropertyRadar = async () => 'ready'
    e5._lookupPropertyRadar = async () => ({ status: 'not found', opened: false, notes: ['mock miss'] })
    e5._freshPage = async () => fakePage
    e5._attachNetworkCapture = () => null
    let pauses = 0
    let pausedAt = -1
    e5.on('event', (ev) => {
      if (ev.sub === 'login-required' && ev.reason === 'pr-failures') { pauses++; pausedAt = e5.results.size; setTimeout(() => e5.resume(), 30) }
    })
    const st5 = await e5.start()
    check('paused once, after the 3rd miss', pauses === 1 && pausedAt === 3, `pauses=${pauses} at row ${pausedAt}`)
    check('continued to the end after Resume', st5.state === 'done' && e5.results.size === 6, `${st5.state} ${e5.results.size}`)
    check('misses still say FIELD NOT FOUND', e5.results.get(0).fields['PR Owner of Record'] === 'FIELD NOT FOUND')

    console.log('\n[Enrich] Engine: hand-feed — a property opened by hand is saved into the row it matches')
    const e6 = Enrichment.create({ csvText: csv, filename: 'handfeed.csv' })
    made.push(e6)
    e6.setOptions({ delayMs: 5, webSearch: false, screenshots: false, zillowCheck: false })
    let detailOpen = false
    const fakePage2 = { url: () => (detailOpen ? 'https://app.propertyradar.com/detail/777' : 'https://app.propertyradar.com/'), innerText: async () => '' }
    e6._openBrowser = async () => fakePage2
    e6._openPropertyRadar = async () => 'ready'
    e6._lookupPropertyRadar = async () => ({ status: 'not found', opened: false, notes: ['mock miss'] })
    e6._freshPage = async () => fakePage2
    e6._attachNetworkCapture = () => null
    // The "open profile" reads as 2200 Pacific Ave (row index 4), owner found.
    e6._recordOpenProfile = async function () {
      const row = 4
      const fields = Object.fromEntries(ENRICH_COLUMNS.map((c) => [c, '']))
      fields['Enriched Address'] = this.addressFor(row)
      fields['PR Status'] = 'found'
      fields['PR Owner of Record'] = 'HAND OPENED OWNER'
      fields['Web Status'] = 'skipped'
      this._record(row, fields, 0)
      return { row, address: this.addressFor(row), ok: true }
    }
    let saved = 0
    e6.on('event', (ev) => {
      if (ev.sub === 'login-required' && ev.reason === 'pr-failures') { setTimeout(() => { detailOpen = true }, 50); setTimeout(() => { detailOpen = false; e6.resume() }, 2600) }
      if (ev.sub === 'log' && /Saved row 5/.test(ev.message)) saved++
    })
    const st6 = await e6.start()
    check('hand-opened property saved into row 5 while paused', saved === 1 && e6.results.get(4)?.fields['PR Owner of Record'] === 'HAND OPENED OWNER', `saved=${saved} owner=${e6.results.get(4)?.fields['PR Owner of Record']}`)
    check('row 5 was not searched again after Resume', e6.results.get(4)?.fields['PR Status'] === 'found' && st6.state === 'done' && e6.results.size === 6)
    check('found count reflects the hand-saved row', e6.counts().found === 1, `found=${e6.counts().found}`)
  } finally {
    config.demoMode = true
  }

  const e4 = Enrichment.create({ csvText: e.outputCsv(), filename: 'again.csv' })
  made.push(e4)
  check('re-enriching an enriched file suffixes new columns', e4.outColumns[1] === 'PR Owner of Record (new)')
  let threw = ''
  try { Enrichment.create({ csvText: 'A,B\n', filename: 'empty.csv' }) } catch (err) { threw = err.message }
  check('empty file rejected', /no data rows/i.test(threw), threw)
} finally {
  for (const j of made) fs.rmSync(j.dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
