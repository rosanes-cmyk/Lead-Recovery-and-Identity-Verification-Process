// Focused test for PropertyRadar extraction on a foreclosure/REO property,
// modelled on the operator's real calibration of 97 Manchester Dr. Verifies:
//   1. Owner-of-record is read from the "Taxpayer" label and the mailing address
//      is stripped off (LAKEVIEW LN SERVICING LLC).
//   2. It's detected as an entity/REO owner.
//   3. The individual homeowner (Faga Paulo) is recovered from the deed history
//      so identity verification stays about the person, and the step goes green.

import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractAndBuild, personFromDeeds } from '../server/sources/propertyradar.js'
import { selectors } from '../server/sources/selectors.js'
import { emptyResult } from '../server/sources/base.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'propertyradar-reo.html')).href
const runDir = path.join(__dirname, '..', 'runs', '_pr_test')

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// Deed history the Transactions tab would yield (grantees in SURNAME FIRST form).
const tabsText = `
Grant Deed Market 29003 4/21/22 WHITEHEAD DAKHOTA C FAGA PAULO & HOSANNA U $370,000
Assignment 29463 6/30/25 FAGA PAULO & HOSANNA U LAKEVIEW LN SERVICING LLC $363,298
Trustees Deed REO 19828 4/29/26 ROBERTSON ANSCHUTZ SCHNEID LAKEVIEW LN SERVICING LLC $303,400
`

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH })
try {
  const page = await browser.newPage()
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })

  console.log('\n[PropertyRadar] Foreclosure / REO extraction')
  const res = emptyResult('PropertyRadar')
  res.audit = []
  await extractAndBuild(page, selectors.propertyradar, res, runDir, { name: 'Paulo Faga', address: '97 Manchester Dr, Fairfield, CA 94533' }, tabsText)

  check('owner of record read + address stripped', res.data.ownerOfRecord === 'LAKEVIEW LN SERVICING LLC', res.data.ownerOfRecord)
  check('detected as entity/REO owner', res.data.isEntityOwner === true)
  check('title holder recorded', res.data.titleHolder === 'LAKEVIEW LN SERVICING LLC', res.data.titleHolder)
  check('individual homeowner recovered from deeds', /faga\s+paulo/i.test(res.data.ownerName), res.data.ownerName)
  check('APN extracted', res.data.apn === '0174-340-380', res.data.apn)
  check('step is green (ok)', res.ok === true)

  console.log('\n[PropertyRadar] personFromDeeds direct')
  check('recovers surname-first grantee', personFromDeeds(tabsText, 'Paulo Faga').toLowerCase().startsWith('faga paulo'), personFromDeeds(tabsText, 'Paulo Faga'))
  check('returns empty when surname absent', personFromDeeds(tabsText, 'Nonexistent Zzyzx') === '')
} finally {
  await browser.close()
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
