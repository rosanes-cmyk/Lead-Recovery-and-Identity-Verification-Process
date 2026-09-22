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

console.log('\n[Agents] Output')
const out = agentsToRows(agents)
check('every column filled', AGENT_COLUMNS.every((c) => c in out[0]), AGENT_COLUMNS.find((c) => !(c in out[0])))
check('price formatted for a person', /^\$[\d,]+$/.test(out[0]['Median Price']), out[0]['Median Price'])
check('a missing median is blank, not zero', agentsToRows([{ ...agents[0], medianDom: null }])[0]['Median DOM'] === '')
const sum = rollupSummary(ROWS, agents)
check('summary counts the run', sum.properties === 6 && sum.withAgent === 5 && sum.ourKind === 4)
check('summary names the filter', sum.namedSignals.includes('probate') && sum.namedSignals.includes('fixer'))
check('an empty run summarises without dividing by zero', rollupSummary([], []).ourKindPercent === 0)

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
