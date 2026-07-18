// Focused test for People Search (TruePeopleSearch) extraction, run against a
// local fixture that mirrors the real page layout from the operator's
// screenshots. Proves that:
//   1. Possible Relatives are extracted (the #toc-relatives anchor is a marker,
//      not a wrapper — the earlier bug returned 0 relatives).
//   2. Possible Associates are NOT counted as relatives.
//   3. Phones are extracted with the "Possible Primary Phone" moved to front.
//
// Live TruePeopleSearch blocks bots, so this fixture is how we verify the
// extraction logic deterministically in-container.

import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractRelatives, phonesOnPage, addressOnPage } from '../server/sources/peoplesearch.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'peoplesearch-person.html')).href

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const exe = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined
const browser = await chromium.launch({ executablePath: exe })
try {
  const page = await browser.newPage()
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })

  console.log('\n[People Search] Possible Relatives extraction')
  const rels = await extractRelatives(page)
  const names = rels.map((r) => r.name)
  check('relatives found', rels.length >= 8, `${rels.length} relatives`)
  check('includes Aireta Faga', names.includes('Aireta Faga'))
  check('includes Jake Faga', names.includes('Jake Faga'))
  check('relative href is a person link', /\/find\/person\//.test(rels[0]?.href || ''), rels[0]?.href)
  check('associates excluded (no Janelle Elisaia)', !names.includes('Janelle Elisaia'))
  check('associates excluded (no Kathryn Peleki)', !names.includes('Kathryn Peleki'))

  console.log('\n[People Search] Phone extraction')
  const phones = await phonesOnPage(page)
  check('phones found', phones.length >= 5, `${phones.length} phones`)
  check('possible-primary phone is first', phones[0] === '(713) 441-2672', phones[0])
  check('no phone-shaped junk from ages', !phones.some((p) => /Age|\b24\b$/.test(p)))

  console.log('\n[People Search] Current address extraction')
  const addr = await addressOnPage(page)
  check('address extracted', /Fairfield, CA 94533/.test(addr), addr || '(none)')
} finally {
  await browser.close()
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
