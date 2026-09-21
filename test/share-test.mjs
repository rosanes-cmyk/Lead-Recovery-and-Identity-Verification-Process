// Temporary-sharing tests. No browser and no outside network: the guard's pure
// helpers are checked directly, then a real Express app on a random loopback
// port proves the whole surface (static UI, API, SSE, downloads) is covered and
// that the sign-in flow works.
import fs from 'node:fs'
import express from 'express'
import { createShare, parseCookies, safeEqual, safeNext, escapeHtml, SHARE_COOKIE } from '../server/share.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- helpers ---------------------------------------------------------------------
console.log('\n[Share] Helpers')
check('cookie parsed', parseCookies('a=1; lrshare=abc; b=2').lrshare === 'abc')
check('quoted + encoded cookie', parseCookies('lrshare="a%20b"').lrshare === 'a b')
check('junk cookie header is safe', JSON.stringify(parseCookies('; ;=x; =')) === '{}')
check('no cookie header', JSON.stringify(parseCookies(undefined)) === '{}')
check('first value wins (no clobber)', parseCookies('lrshare=first; lrshare=second').lrshare === 'first')
check('equal passwords match', safeEqual('hunter2', 'hunter2'))
check('different passwords do not', !safeEqual('hunter2', 'hunter3'))
check('different lengths do not throw', safeEqual('short', 'muchlongerpassword') === false)
check('empty vs empty is equal (guard is off in that case)', safeEqual('', ''))
check('next stays same-origin', safeNext('/api/enrich') === '/api/enrich')
check('protocol-relative next rejected', safeNext('//evil.example.com') === '/')
check('absolute next rejected', safeNext('https://evil.example.com') === '/')
check('backslash next rejected', safeNext('/\\evil.example.com') === '/')
check('html escaped in login page', escapeHtml('<script>"x"</script>') === '&lt;script&gt;&quot;x&quot;&lt;/script&gt;')

// ---- token lifecycle -------------------------------------------------------------
console.log('\n[Share] Tokens and lockout')
check('no password -> guard disabled', createShare({ password: '' }).enabled === false)
check('blank password -> guard disabled', createShare({ password: '   ' }).enabled === false)

let clock = 1_000_000
const s = createShare({ password: 'letmein', ttlHours: 1, now: () => clock })
check('password set -> guard enabled', s.enabled === true)
const tok = s.issue()
check('issued token is valid', s.valid(tok))
check('unknown token invalid', !s.valid('deadbeef'))
check('empty token invalid', !s.valid(''))
clock += 61 * 60 * 1000
check('token expires after its TTL', !s.valid(tok))
clock += 1
const ok = s.attempt('letmein', '1.2.3.4')
check('correct password issues a token', ok.ok === true && s.valid(ok.token))
check('wrong password refused', s.attempt('nope', '5.6.7.8').ok === false)
for (let i = 0; i < 8; i++) s.attempt('nope', '5.6.7.8')
const locked = s.attempt('letmein', '5.6.7.8')
check('too many wrong tries locks the IP out', locked.ok === false && locked.lockedMs > 0)
check('lockout is per IP, not global', s.attempt('letmein', '9.9.9.9').ok === true)
clock += 11 * 60 * 1000
check('lockout lifts after the window', s.attempt('letmein', '5.6.7.8').ok === true)

// ---- mounted in a real app -------------------------------------------------------
console.log('\n[Share] Live HTTP surface')
const guard = createShare({ password: 'letmein', ttlHours: 12 })
const app = express()
app.use(express.json())
app.use('/login', express.urlencoded({ extended: false }))
app.use(guard.middleware)
app.use(express.static('public'))
app.get('/api/config', (req, res) => res.json({ ok: true }))
app.get('/api/enrich/x/download', (req, res) => res.type('csv').send('a,b\n'))

const server = await new Promise((resolve) => {
  const srv = app.listen(0, '127.0.0.1', () => resolve(srv))
})
const base = `http://127.0.0.1:${server.address().port}`
const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' })

try {
  const home = await get('/')
  check('UI redirects to the login page', home.status === 302 && home.headers.get('location') === '/login')
  const api = await get('/api/config')
  check('API answers 401 JSON, not a redirect', api.status === 401)
  check('401 body names the login page', (await api.json()).login === '/login')
  const dl = await get('/api/enrich/x/download')
  check('CSV download is protected', dl.status === 401)
  const appjs = await get('/app.js')
  check('static UI file is protected', appjs.status === 302 || appjs.status === 401)
  check('protected responses are not cached', home.headers.get('cache-control') === 'no-store')
  const deep = await get('/api/enrich')
  check('deep link keeps no stale body', deep.status === 401)

  const loginGet = await get('/login')
  const loginHtml = await loginGet.text()
  check('login page renders', loginGet.status === 200 && /Access password/.test(loginHtml))
  check('login page asks for no other asset', !/<script|<link/i.test(loginHtml))

  const bad = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
    redirect: 'manual',
  })
  check('wrong password -> 401 and no cookie', bad.status === 401 && !bad.headers.get('set-cookie'))

  const good = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=letmein&next=%2Fapi%2Fconfig',
    redirect: 'manual',
  })
  const setCookie = good.headers.get('set-cookie') || ''
  check('right password -> 303 to the requested page', good.status === 303 && good.headers.get('location') === '/api/config')
  check('cookie is HttpOnly + SameSite', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie))
  check('cookie is not Secure over plain http (LAN would drop it)', !/Secure/i.test(setCookie))

  const cookie = setCookie.split(';')[0]
  check('cookie name', cookie.startsWith(SHARE_COOKIE + '='))
  const signedIn = await get('/api/config', { cookie })
  check('signed in -> API works', signedIn.status === 200 && (await signedIn.json()).ok === true)
  const forged = await get('/api/config', { cookie: `${SHARE_COOKIE}=forged` })
  check('forged cookie refused', forged.status === 401)

  const offsite = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=letmein&next=https%3A%2F%2Fevil.example.com',
    redirect: 'manual',
  })
  check('login cannot bounce to another site', offsite.headers.get('location') === '/')

  const out = await get('/logout', { cookie })
  check('logout clears the cookie', /Max-Age=0/i.test(out.headers.get('set-cookie') || ''))
  const after = await get('/api/config', { cookie })
  check('cookie is dead after logout', after.status === 401)
} finally {
  server.close()
}

// ---- off by default --------------------------------------------------------------
console.log('\n[Share] Off by default')
const openApp = express()
openApp.use(createShare({ password: '' }).middleware)
openApp.get('/api/config', (req, res) => res.json({ ok: true }))
const openSrv = await new Promise((resolve) => {
  const srv = openApp.listen(0, '127.0.0.1', () => resolve(srv))
})
try {
  const r = await fetch(`http://127.0.0.1:${openSrv.address().port}/api/config`)
  check('no password set -> app behaves exactly as before', r.status === 200)
} finally {
  openSrv.close()
}

// ---- npm run share ---------------------------------------------------------------
console.log('\n[Share] Tunnel helper')
const { findTunnelUrl, candidatePaths } = await import('../scripts/share.js')
check('importing the helper opens no tunnel', typeof findTunnelUrl === 'function')
check('banner line -> url', findTunnelUrl('|  https://tasty-blue-horse-99.trycloudflare.com   |') === 'https://tasty-blue-horse-99.trycloudflare.com')
check('url on a log line', findTunnelUrl('INF |  https://ab-cd-12.trycloudflare.com') === 'https://ab-cd-12.trycloudflare.com')
check('no url in ordinary output', findTunnelUrl('INF Requesting new quick Tunnel...') === '')
check('look-alike domain ignored', findTunnelUrl('https://trycloudflare.com.evil.example') === '')
check('empty input safe', findTunnelUrl() === '' && findTunnelUrl(null) === '')
const win = candidatePaths({ 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\LA', USERPROFILE: 'C:\\U' }, 'win32')
check('winget MSI location checked first', win[0] === 'C:\\PF86\\cloudflared\\cloudflared.exe', win[0])
check('winget Links shim checked', win.some((p) => p.includes('WinGet')), win.join(' | '))
check('override wins', candidatePaths({ CLOUDFLARED_PATH: 'X:\\cf.exe' }, 'win32')[0] === 'X:\\cf.exe')
check('posix locations', candidatePaths({}, 'linux').every((p) => p.endsWith('/cloudflared')))

// ---- wiring ----------------------------------------------------------------------
console.log('\n[Share] Server wiring')
const src = fs.readFileSync('server/index.js', 'utf8')
const guardAt = src.indexOf('app.use(share.middleware)')
const staticAt = src.indexOf('express.static(')
check('guard is mounted in server/index.js', guardAt > 0)
check('guard runs BEFORE express.static', guardAt > 0 && staticAt > 0 && guardAt < staticAt)
check('server binds the configured host', /app\.listen\(config\.port, config\.host/.test(src))
const cfg = fs.readFileSync('server/config.js', 'utf8')
check('loopback-only unless a password is set', /SHARE_PASSWORD[\s\S]*?'0\.0\.0\.0'\s*:\s*'127\.0\.0\.1'/.test(cfg))
const helper = fs.readFileSync('scripts/share.js', 'utf8')
check('helper refuses to tunnel an unprotected app', /if \(!config\.sharePassword\)[\s\S]{0,120}die\(/.test(helper))
check('npm run share is registered', JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts.share === 'node scripts/share.js')

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
