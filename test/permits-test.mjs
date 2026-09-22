// San Francisco permits and code violations. The fixture is the real JSON the
// city returned for block 4101 lot 032 (547 Missouri St) on 22 Sep 2026.
import fs from 'node:fs'
import { summarisePermits, summariseViolations, datasetUrl, lookupPermits, PERMITS_DATASET } from '../server/sources/permits.js'
import { splitApn } from '../server/sources/recorder.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/sf-permits.json', import.meta.url), 'utf8'))

console.log('\n[Permits] A real parcel')
const p = summarisePermits(real)
check('every permit counted', p.total === 11, String(p.total))
check('street-space permits set aside', p.substantive === 6 && p.substantive < p.total, `${p.substantive} of ${p.total}`)
check('most recent work dated', p.lastDate === 'Mar 27, 2019', p.lastDate)
check('most recent work described', /sprinkler/i.test(p.lastDescription), p.lastDescription.slice(0, 40))
check('declared value added up', p.totalValue === 774300, String(p.totalValue))
check('nothing open on this parcel', p.open === 0)

console.log('\n[Permits] Open work and violations')
const open = summarisePermits([
  { permit_number: '1', status: 'issued', description: 'full kitchen remodel', revised_cost: '60000', filed_date: '2025-01-05' },
  { permit_number: '2', status: 'complete', description: 'reroof', revised_cost: '20000', filed_date: '2020-01-05' },
  { permit_number: '3', status: 'issued', description: 'street space', revised_cost: '0', filed_date: '2026-01-05' },
  { permit_number: '4', status: 'withdrawn', description: 'add a bedroom', revised_cost: '5000', filed_date: '2019-01-05' },
])
check('open work counted', open.open === 1, String(open.open))
check('withdrawn is not open', open.open === 1)
check('a street-space permit does not become the latest work', /kitchen/i.test(open.lastDescription), open.lastDescription)
check('zero-cost rows do not skew the value', open.totalValue === 85000, String(open.totalValue))

const v = summariseViolations([
  { status: 'active', nov_category_description: 'building section', date_filed: '2024-03-01T00:00:00.000' },
  { status: 'not active', nov_category_description: 'fire section', date_filed: '2011-03-01T00:00:00.000' },
])
check('active violations counted', v.active === 1 && v.total === 2)
check('the kind of violation is named', v.activeKinds === 'building section', v.activeKinds)
check('most recent violation dated', /2024/.test(v.lastDate), v.lastDate)
check('no violations is not an error', summariseViolations([]).active === 0)

console.log('\n[Permits] The request')
const url = datasetUrl(PERMITS_DATASET, { block: '4101', lot: '032' })
check('queried by parcel, not by street', /block%3D%224101%22\+AND\+lot%3D%22032%22/.test(url), url.slice(-70))
check('points at the city, current host', url.startsWith('https://data.sf.gov/resource/i98e-djp9.json'))
check('a quote cannot break out of the filter', !/"; DROP/i.test(datasetUrl(PERMITS_DATASET, { block: '1"; DROP', lot: '2' })))

console.log('\n[Permits] Bad input and failures')
const bad = await lookupPermits('not-a-parcel', { splitApn })
check('unusable parcel refused with a reason', bad.ok === false && /not usable/i.test(bad.error))
const failing = await lookupPermits('4101-032', { splitApn, fetchImpl: async () => ({ ok: false, status: 503 }) })
check('a server error is reported, not silently empty', failing.ok === false && /503/.test(failing.error), failing.error)
const okFetch = async (u) => ({ ok: true, json: async () => (String(u).includes('i98e') ? real : []) })
const good = await lookupPermits('4101-032', { splitApn, fetchImpl: okFetch })
check('a whole lookup works end to end', good.ok === true && good.permits.total === 11 && good.violations.active === 0)
const halfFetch = async (u) => (String(u).includes('nbtm') ? { ok: false, status: 500 } : { ok: true, json: async () => real })
const half = await lookupPermits('4101-032', { splitApn, fetchImpl: halfFetch })
check('permits still returned when violations fail', half.ok === true && half.permits.total === 11)

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
