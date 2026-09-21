// Extraction against the PropertyRadar profile layout seen live in Sept 2026
// (fixtures modelled on the operator's screenshots): no "Taxpayer" line, owners
// as ALL-CAPS header lines with ages, a header grid whose text renders as a row
// of labels then a row of values, Contacts tab as label/value cells.

import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractAndBuild, readProfileTabs, ownersFromProfileText, headerFields, textLabelValue } from '../server/sources/propertyradar.js'
import { selectors } from '../server/sources/selectors.js'
import { emptyResult } from '../server/sources/base.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fx = (f) => pathToFileURL(path.join(__dirname, 'fixtures', f)).href
const runDir = path.join(__dirname, '..', 'runs', '_pr_profile_test')
fs.mkdirSync(runDir, { recursive: true })
let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const emit = () => {}
const signal = { aborted: false }

console.log('\n[Profile] pure helpers')
const owners = ownersFromProfileText('PropertyRadar\nMY LISTS\n212 TEXAS ST, SAN FRANCISCO, CA 94107\nJAMES W PACE, 60\nSANDRA H PACE, 59\nContacts\nJAMES W PACE edit\nADD NOTE\nSAN FRANCISCO')
check('owners: ages stripped, chrome + city + address excluded, deduped', JSON.stringify(owners) === '["JAMES W PACE","SANDRA H PACE"]', JSON.stringify(owners))
const grid = headerFields('Beds / Baths\nYear Built\nSquare Feet\n3 / 1\n1900\n732\nEst. Value\nEquity\nLot Size\n$1,898,856\n$1,541,432\n2,495\nPurchase Price\nOwned Since\nDistress Score\n$1,685,000\nOct 2023\n25')
check('header grid mapped positionally', grid['Equity'] === '$1,541,432' && grid['Est. Value'] === '$1,898,856' && grid['Owned Since'] === 'Oct 2023' && grid['Distress Score'] === '25', JSON.stringify(grid))
check('header pairs (label/value) still work', headerFields('Year Built\n1925\nLot Size\n2,303')['Lot Size'] === '2,303')
check('label + value on one line', textLabelValue('Mailing Address 212 TEXAS ST, SAN FRANCISCO, CA 94107\nPhone edit', 'Mailing Address') === '212 TEXAS ST, SAN FRANCISCO, CA 94107')
check('"Phone edit" is not a value', textLabelValue('Phone edit\nUnlock Phone', 'Phone') === '')
check('wrapped address joined', textLabelValue('Address\n212 TEXAS ST,\nSAN FRANCISCO, CA 94107', 'Address') === '212 TEXAS ST, SAN FRANCISCO, CA 94107')

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH })
try {
  console.log('\n[Profile] two individual owners (212 Texas St)')
  const page = await browser.newPage()
  await page.goto(fx('propertyradar-profile.html'), { waitUntil: 'domcontentloaded' })
  const tabs = await readProfileTabs(page, emit, signal, ['Contacts', 'Property', 'Transactions'])
  const res = emptyResult('PropertyRadar'); res.audit = []
  const out = await extractAndBuild(page, selectors.propertyradar, res, runDir, { address: '212 Texas Street, CA 94107' }, tabs, { screenshot: false })
  const d = res.data
  check('found', out.ok === true)
  check('owners joined', d.ownerOfRecord === 'JAMES W PACE and SANDRA H PACE', d.ownerOfRecord)
  check('not an entity', d.isEntityOwner === false)
  check('ownership type from Person Type', d.ownershipType === 'Person', d.ownershipType)
  check('property address (wrapped) read', d.propertyAddress === '212 TEXAS ST, SAN FRANCISCO, CA 94107', d.propertyAddress)
  check('mailing address', d.mailingAddress === '212 TEXAS ST, SAN FRANCISCO, CA 94107', d.mailingAddress)
  check('occupancy derived from Primary Residence', d.occupancy === 'Owner Occupied', d.occupancy)
  check('property type', d.propertyType === 'Single Family', d.propertyType)
  check('est value / equity from the grid', d.estValue === '$1,898,856' && d.equity === '$1,541,432', `${d.estValue} / ${d.equity}`)
  check('purchase price / owned since / year built / distress', d.purchasePrice === '$1,685,000' && d.ownedSince === 'Oct 2023' && d.yearBuilt === '1900' && d.distressScore === '25', `${d.purchasePrice} ${d.ownedSince} ${d.yearBuilt} ${d.distressScore}`)

  console.log('\n[Profile] trust owner, mailing elsewhere (2841 Larkin St)')
  const page2 = await browser.newPage()
  await page2.goto(fx('propertyradar-profile-trust.html'), { waitUntil: 'domcontentloaded' })
  const tabs2 = await readProfileTabs(page2, emit, signal, ['Contacts', 'Property', 'Transactions'])
  const res2 = emptyResult('PropertyRadar'); res2.audit = []
  const out2 = await extractAndBuild(page2, selectors.propertyradar, res2, runDir, { address: '2841 Larkin Street, San Francisco, CA 94109' }, tabs2, { screenshot: false })
  const e = res2.data
  check('found', out2.ok === true)
  check('trust is the owner of record', e.ownerOfRecord === 'CHAN FAMILY LIVING TRUST', e.ownerOfRecord)
  check('flagged as entity, title holder set', e.isEntityOwner === true && e.titleHolder === 'CHAN FAMILY LIVING TRUST')
  check('ownership type Trust', e.ownershipType === 'Trust', e.ownershipType)
  check('mailing address elsewhere', e.mailingAddress === '2240 OAKDALE RD, HILLSBOROUGH, CA 94010', e.mailingAddress)
  check('owner occupied (primary residence = property)', e.occupancy === 'Owner Occupied', e.occupancy)
  check('assessed value / loan balance labels', e.assessedValue === '$3,111,000' && e.loanBalance === '$1,932,208', `${e.assessedValue} / ${e.loanBalance}`)
  check('no est value on this layout (not invented)', e.estValue === '')
} finally {
  await browser.close()
  fs.rmSync(runDir, { recursive: true, force: true })
}
console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
