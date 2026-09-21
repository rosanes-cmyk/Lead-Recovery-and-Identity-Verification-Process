// The calibration capture writes what a website's page asked its server, so it
// must never write a credential to disk alongside it.
import { safeHeaders } from '../scripts/calibrate-recorder.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n[Calibrate] Header redaction')
const secret = 'SESSIONID=supersecretvalue12345'
const h = safeHeaders({
  'content-type': 'application/json',
  accept: 'application/json',
  Cookie: secret,
  Authorization: 'Bearer abcdefghijklmnop',
  'X-Api-Key': 'k-123456',
  'user-agent': 'Mozilla/5.0',
})
const dumped = JSON.stringify(h)
check('importing the script runs no capture', typeof safeHeaders === 'function')
check('cookie value never written', !dumped.includes(secret))
check('bearer token never written', !dumped.includes('abcdefghijklmnop'))
check('api key never written', !dumped.includes('k-123456'))
check('cookie header still listed, so the shape is visible', /redacted \d+ chars/.test(h.Cookie), h.Cookie)
check('content-type kept, it is needed to repeat the call', h['content-type'] === 'application/json')
check('accept kept', h.accept === 'application/json')
check('user agent kept', h['user-agent'] === 'Mozilla/5.0')
check('empty headers safe', JSON.stringify(safeHeaders()) === '{}')
check('redaction is case-insensitive', /redacted/.test(safeHeaders({ AUTHORIZATION: 'x' }).AUTHORIZATION))

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
