// PropertyRadar SEARCH-FLOW test against a structural fixture that reproduces
// the two traps seen live: an ExtJS-style mask that intercepts pointer events
// (normal clicks time out) and a decoy toolbar "Add Criteria" (first in the
// DOM, a no-op). autoSearch must open the property through Full Address →
// suggestion → LAST Add Criteria → map marker → Property Info → detail link,
// and the profile must then extract.

import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { autoSearch, readProfileTabs, extractAndBuild } from '../server/sources/propertyradar.js'
import { selectors } from '../server/sources/selectors.js'
import { emptyResult } from '../server/sources/base.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'propertyradar-search.html')).href
const runDir = path.join(__dirname, '..', 'runs', '_pr_search_test')
fs.mkdirSync(runDir, { recursive: true })

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const logs = []
const emit = (ev) => { if (ev?.message) logs.push(ev.message) }
const signal = { aborted: false }

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH })
try {
  console.log('\n[PropertyRadar search] happy path through the mask + decoy button')
  const page = await browser.newPage()
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  const t0 = Date.now()
  const opened = await autoSearch(page, '324 5th Street, San Francisco, CA 94107', selectors.propertyradar, emit, signal, null, runDir)
  check('property opened', opened === true, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
  check('landed on the detail page', /\/detail\//.test(page.url()), page.url())
  check('picked the suggestion with our street number', logs.some((m) => /Address selected: 324 5TH ST/.test(m)), logs.find((m) => /Address selected/.test(m)))
  const res = emptyResult('PropertyRadar'); res.audit = []
  const tabsText = await readProfileTabs(page, emit, signal, ['Contacts', 'Property', 'Transactions'])
  const out = await extractAndBuild(page, selectors.propertyradar, res, runDir, { address: '324 5th Street, San Francisco, CA 94107' }, tabsText, { screenshot: false })
  check('owner extracted from the profile', out.ok && res.data.ownerOfRecord === 'JANE Q DOE', res.data.ownerOfRecord)
  check('APN extracted', res.data.apn === '3775-021', res.data.apn)

  console.log('\n[PropertyRadar search] address with no suggestion gives up quickly')
  const page2 = await browser.newPage()
  await page2.goto(fixture, { waitUntil: 'domcontentloaded' })
  logs.length = 0
  const t1 = Date.now()
  const opened2 = await autoSearch(page2, '999 Nowhere Rd, Fresno, CA 93701', selectors.propertyradar, emit, signal, null, runDir)
  const secs = (Date.now() - t1) / 1000
  check('not opened', opened2 === false)
  check('says PropertyRadar has no record', logs.some((m) => /No autocomplete match/.test(m)))
  check('gave up in well under a minute', secs < 40, `${secs.toFixed(1)}s`)
} finally {
  await browser.close()
  fs.rmSync(runDir, { recursive: true, force: true })
}
console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
