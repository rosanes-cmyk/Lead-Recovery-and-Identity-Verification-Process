// Property Enrichment tests. No browser and no network: the pure helpers are
// checked directly, and the engine runs in DEMO_MODE (synthetic lookups) so the
// queue / checkpoint / resume / CSV-output logic is proven end to end.

process.env.DEMO_MODE = 'true' // must be set before config.js loads (dynamic imports below)
import fs from 'node:fs'
const { parseCsv, csvToRecords, toCsv, detectAddressColumns, buildAddress, tidyZip, addressMatch } = await import('../server/csv.js')
const { parseDdgHtml, classifyLink, extractSoldFacts } = await import('../server/sources/websearch.js')
const { Enrichment, ENRICH_COLUMNS } = await import('../server/enrich.js')

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

// ---- address columns ------------------------------------------------------------
console.log('\n[Enrich] Address column detection')
const SF = ['Street Address', 'Postal City', 'State', 'Zip Code', 'Price', 'DOM', "Buyer's Agent Full Name", "Buyer's Agent Email"]
const m = detectAddressColumns(SF)
check('SF export -> parts', m.mode === 'parts' && m.street === 'Street Address' && m.city === 'Postal City' && m.state === 'State' && m.zip === 'Zip Code', JSON.stringify(m))
check('buildAddress + zip fix', buildAddress({ 'Street Address': '135 Prague St', 'Postal City': 'San Francisco', State: 'ca', 'Zip Code': '94112.0' }, m) === '135 Prague St, San Francisco, CA 94112')
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

// ---- engine (demo mode) -----------------------------------------------------------
console.log('\n[Enrich] Engine: run, checkpoint, output CSV')
const csv = [
  'Street Address,Postal City,State,Zip Code,Price,"Buyer\'s Agent Full Name"',
  '135 Prague St,San Francisco,CA,94112,1000000,Peter Iskandar',
  '70 Oak Ave,San Francisco,CA,94117,2000000,"Shinbori, James"', // demo: 70 % 7 == 0 -> entity owner
  '121 Pine St,San Francisco,CA,94108,3000000,Jack Burrows', // demo: 121 % 11 == 0 -> not found
  ',,,,,Blank Row Agent', // no address -> skipped, row kept in place
  '2200 Pacific Ave #4,San Francisco,CA,94115,4000000,Ron Sebahar',
  '9 Hill Ct,San Francisco,CA,94110,5000000,Robin Hubinsky',
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
  check('checkpoint has one line per row', fs.readFileSync(e.dir + '/results.jsonl', 'utf-8').trim().split('\n').length === 6)
  const out = csvToRecords(e.outputCsv())
  check('output = original + enrichment columns', out.headers.length === 6 + ENRICH_COLUMNS.length)
  check('rows aligned with originals', out.records[1]["Buyer's Agent Full Name"] === 'Shinbori, James' && out.records[1]['PR Entity Owner'] === 'Yes')
  check('blank row stays in place', out.records[3]["Buyer's Agent Full Name"] === 'Blank Row Agent' && out.records[3]['PR Status'] === 'skipped')
  check('output filename', e.outputFilename() === 'SF test-enriched.csv')

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
