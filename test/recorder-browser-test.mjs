// The recorder browser flow, driven against a stand-in that has the same form
// shape and the same endpoint as recorder.sfgov.org. Proves the parts that the
// parser tests cannot: finding the boxes, clearing them between properties,
// reading the JSON the page fetches, and paging until every document is in.
//
// Requires Chromium; set PLAYWRIGHT_EXECUTABLE_PATH if it is not the default.
import { chromium } from 'playwright'
import { startStandIn } from './fixtures/recorder-standin.mjs'
import { readParcel, lookupLiens } from '../server/sources/recorder.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const srv = await startStandIn()
const base = `http://127.0.0.1:${srv.address().port}/`
const launchOpts = { headless: true }
if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage()

try {
  console.log('\n[Recorder] Driving the search page')
  await page.goto(base)
  const r = await readParcel(page, { block: '4101', lot: '032', url: base })
  check('search ran and returned rows', r.ok === true, r.error)
  check('service total read', r.total === 25, String(r.total))
  check('paged through every document', r.rows.length === 25, `${r.rows.length} of ${r.total}`)
  check('not flagged partial', r.partial === false)
  check('no duplicates across pages', new Set(r.rows.map((x) => x.docNumber)).size === 25)
  check('records are classified, not raw', r.rows.some((x) => x.kind === 'judgment') && r.rows.some((x) => x.kind === 'release'))

  console.log('\n[Recorder] A second property in the same tab')
  const empty = await readParcel(page, { block: '9999', lot: '001', url: base })
  check('a parcel with nothing returns nothing, cleanly', empty.rows.length === 0 && empty.total === 0)
  check('criteria were cleared, no rows carried over', !empty.rows.length)
  const again = await readParcel(page, { block: '4101', lot: '032', url: base })
  check('and the first parcel still works afterwards', again.rows.length === 25)

  console.log('\n[Recorder] Whole lookup, parcel number in')
  const liens = await lookupLiens(page, '4101-032', { url: base })
  check('APN accepted as one string', liens.ok === true, liens.error)
  check('summary produced', Boolean(liens.summary) && liens.summary?.total === 25)
  if (!liens.summary) { console.log('  (no summary — skipping the checks that need one)'); }
  check('last transfer identified', liens.summary?.lastTransfer?.parties?.[1]?.name === 'BUYER BETTY', liens.summary.lastTransfer?.parties?.[1]?.name)
  check('unreleased judgment surfaced', liens.summary?.unreleasedEncumbrances?.some((x) => x.kind === 'judgment'))
  const bad = await lookupLiens(page, 'not-a-parcel')
  check('unusable parcel number refused with a reason', bad.ok === false && /not usable/i.test(bad.error))

  console.log('\n[Recorder] When the page is not what we expect')
  const blank = await browser.newPage()
  await blank.goto('data:text/html,<html><body>nothing here</body></html>')
  const lost = await readParcel(blank, { block: '4101', lot: '032', timeoutMs: 4000, url: 'data:text/html,<html><body>nothing here</body></html>' })
  check('missing form reported, not silently empty', lost.ok === false && /Block box|Could not find|Timeout|net::/i.test(lost.error), lost.error)
  check('no invented rows', lost.rows.length === 0)
  await blank.close()
  const noParcel = await readParcel(page, { block: '', lot: '', url: base })
  check('no parcel number, no search attempted', noParcel.ok === false && /No parcel/i.test(noParcel.error))
} finally {
  await browser.close()
  srv.close()
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
