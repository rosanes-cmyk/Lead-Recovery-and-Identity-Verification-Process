// Extraction against the PropertyRadar profile layout seen live in Sept 2026
// (fixtures modelled on the operator's screenshots): no "Taxpayer" line, owners
// as ALL-CAPS header lines with ages, a header grid whose text renders as a row
// of labels then a row of values, Contacts tab as label/value cells.

import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractAndBuild, readProfileTabs, ownersFromProfileText, headerFields, textLabelValue, taxpayerBlock, lastTransfer, sameParty } from '../server/sources/propertyradar.js'
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
const tp = taxpayerBlock('Annual Taxes\n$77,852\nTaxpayer\nGOLDEN PROPERTIES LLC\n2170 SUTTER ST\nSAN FRANCISCO,CA 94115\nMail Vacant\nNo')
check('taxpayer block: name + mailing lines', tp.name === 'GOLDEN PROPERTIES LLC' && tp.address === '2170 SUTTER ST, SAN FRANCISCO,CA 94115', JSON.stringify(tp))
const lt = lastTransfer('Grant Deed\tMarket\t\t84224\n10/31/23\tSPERLING JOHN 1994 TRUST\nGOLDEN PROPERTIES LLC\t$6,375,000\n100%', 'GOLDEN PROPERTIES LLC')
check('last transfer: grantor + summary', lt.priorOwner === 'SPERLING JOHN 1994 TRUST' && lt.summary === 'Grant Deed · 10/31/23 · $6,375,000', JSON.stringify(lt))
check('same party across order + punctuation', sameParty('PACE,JAMES W & SANDRA H', 'JAMES W PACE and SANDRA H PACE') && !sameParty('SMITH,JOHN Q', 'JAMES W PACE and SANDRA H PACE'))
const lt2 = lastTransfer('Grant Deed\nMarket\t55555\n10/10/23\tSMITH,JOHN Q\nPACE,JAMES W & SANDRA H\t$1,685,000', 'JAMES W PACE and SANDRA H PACE')
check('grantee (current owner, assessor-style) is not the prior owner', lt2.priorOwner === 'SMITH,JOHN Q', JSON.stringify(lt2))

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
  check('owners joined — header names win over the assessor line', d.ownerOfRecord === 'JAMES W PACE and SANDRA H PACE', d.ownerOfRecord)
  check('taxpayer kept separately', d.taxpayer === 'PACE,JAMES W & SANDRA H', d.taxpayer)
  check('prior owner from the deed, not the current owner', d.priorOwner === 'SMITH,JOHN Q', d.priorOwner)
  check('homeowner exemption Yes', d.homeownerExemption === 'Yes')
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

  console.log('\n[Profile] LLC owner across four tabs (2323 Hyde St) — tabs must really switch')
  const page3 = await browser.newPage()
  await page3.goto(fx('propertyradar-profile-llc.html'), { waitUntil: 'domcontentloaded' })
  const msgs = []
  const tabs3 = await readProfileTabs(page3, (ev) => msgs.push(ev.message), signal, ['Contacts', 'Property', 'Value & Equity', 'Transactions'])
  check('every tab opened and was confirmed', !msgs.some((m) => /Could not confirm/.test(m)), msgs.join(' | '))
  const res3 = emptyResult('PropertyRadar'); res3.audit = []
  const out3 = await extractAndBuild(page3, selectors.propertyradar, res3, runDir, { address: '2323 Hyde Street, San Francisco, CA 94109' }, tabs3, { screenshot: false })
  const g = res3.data
  check('found', out3.ok === true)
  check('LLC is the owner of record, flagged entity', g.ownerOfRecord === 'GOLDEN PROPERTIES LLC' && g.isEntityOwner === true, g.ownerOfRecord)
  check('ownership type Company', g.ownershipType === 'Company', g.ownershipType)
  check('mailing address from the Taxpayer block', g.mailingAddress === '2170 SUTTER ST, SAN FRANCISCO, CA 94115', g.mailingAddress)
  check('APN from text, not the hidden menu\'s next item ("Radar ID")', g.apn === '0069-005', g.apn)
  check('county from the Property tab', g.county === 'SAN FRANCISCO', g.county)
  check('taxpayer = the LLC', g.taxpayer === 'GOLDEN PROPERTIES LLC', g.taxpayer)
  check('property type', g.propertyType === 'Multi-Family 2-4', g.propertyType)
  check('estimated value / equity / loans from Value & Equity', g.estValue === '$7,551,529' && g.equity === '$7,551,529' && g.loanBalance === '$0', `${g.estValue} ${g.equity} ${g.loanBalance}`)
  check('assessed / purchase / owned since / built / distress from header', g.assessedValue === '$6,502,500' && g.purchasePrice === '$6,375,000' && g.ownedSince === 'Oct 2023' && g.yearBuilt === '1900' && g.distressScore === '44', `${g.assessedValue} ${g.purchasePrice} ${g.ownedSince} ${g.yearBuilt} ${g.distressScore}`)
  check('purchase date / type', g.purchaseDate === '10/31/2023' && g.purchaseType === 'Market', `${g.purchaseDate} ${g.purchaseType}`)
  check('homeowner exemption No -> non-owner occupied (mailing elsewhere)', g.homeownerExemption === 'No' && g.occupancy === 'Non-Owner Occupied', `${g.homeownerExemption} / ${g.occupancy}`)
  check('likely to list for sale', g.likelyToList === '82 - Very High (as of 08/11/2026)', g.likelyToList)
  check('prior owner + last transfer', g.priorOwner === 'SPERLING JOHN 1994 TRUST' && g.lastTransfer === 'Grant Deed · 10/31/23 · $6,375,000', `${g.priorOwner} | ${g.lastTransfer}`)
} finally {
  await browser.close()
  fs.rmSync(runDir, { recursive: true, force: true })
}
console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
