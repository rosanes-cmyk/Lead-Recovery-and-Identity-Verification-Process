// Temporary sharing: put the operator UI behind a shared password so it can be
// reached from another machine (LAN, or a tunnel such as cloudflared / ngrok)
// without leaving it wide open.
//
// Why a password is not optional here: this app drives a REAL browser that is
// already signed in to PropertyRadar (and whatever else the operator logged
// into). Anyone who can reach the UI can start runs and download every CSV in
// runs/. So the guard sits in front of EVERYTHING, including the static files.
//
// There is deliberately NO localhost bypass. Tunnels (cloudflared, ngrok) reach
// the server from 127.0.0.1, so a loopback exemption would hand the whole app
// to the internet the moment a tunnel is opened.
import crypto from 'node:crypto'

export const SHARE_COOKIE = 'lrshare'
const MAX_FAILS = 8 // failed password tries per IP...
const FAIL_WINDOW_MS = 10 * 60 * 1000 // ...within this window, then locked out
const MAX_TOKENS = 500 // cap memory; oldest expire first

export function parseCookies(header = '') {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const k = part.slice(0, eq).trim()
    if (!k || k in out) continue
    let v = part.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

// Length-independent comparison: never leaks the password length by returning
// early, and never throws on a mismatched length the way timingSafeEqual does.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest()
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function clientIp(req) {
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return fwd || req.ip || req.socket?.remoteAddress || 'unknown'
}

function isHttps(req) {
  if (String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true
  return Boolean(req.secure)
}

function wantsJson(req) {
  const p = req.path || req.url || ''
  if (p.startsWith('/api/')) return true
  return String(req.headers?.accept || '').includes('application/json')
}

export function loginPage({ error = '', next = '/' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Lead Recovery</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0f172a; color:#e2e8f0; padding:16px; }
  form { background:#1e293b; padding:28px; border-radius:12px; width:min(360px,100%);
         box-shadow:0 10px 30px rgba(0,0,0,.35); box-sizing:border-box; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 18px; color:#94a3b8; font-size:13px; }
  label { display:block; font-size:13px; margin-bottom:6px; color:#cbd5e1; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #475569;
          background:#0f172a; color:#e2e8f0; font-size:15px; box-sizing:border-box; }
  button { width:100%; margin-top:14px; padding:10px 12px; border:0; border-radius:8px;
           background:#2563eb; color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#1d4ed8; }
  .err { margin:12px 0 0; padding:9px 11px; border-radius:8px; background:#7f1d1d;
         color:#fecaca; font-size:13px; }
</style></head>
<body>
  <form method="POST" action="/login">
    <h1>Lead Recovery &amp; Identity Verification</h1>
    <p class="sub">This link is shared temporarily. Enter the access password.</p>
    <input type="hidden" name="next" value="${escapeHtml(next)}" />
    <label for="password">Access password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <button type="submit">Sign in</button>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  </form>
</body></html>`
}

// Only allow same-origin redirects, so ?next= can never bounce a signed-in
// operator off to another site.
export function safeNext(value) {
  const v = String(value || '')
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '/'
  return v
}

export function createShare({ password = '', ttlHours = 12, now = () => Date.now() } = {}) {
  const secret = String(password || '').trim()
  const enabled = secret.length > 0
  const ttlMs = Math.max(1, Number(ttlHours) || 12) * 60 * 60 * 1000
  const tokens = new Map() // token -> expiresAt
  const fails = new Map() // ip -> { count, first }

  function prune() {
    const t = now()
    for (const [tok, exp] of tokens) if (exp <= t) tokens.delete(tok)
    if (tokens.size > MAX_TOKENS) {
      const oldest = [...tokens.entries()].sort((a, b) => a[1] - b[1]).slice(0, tokens.size - MAX_TOKENS)
      for (const [tok] of oldest) tokens.delete(tok)
    }
    for (const [ip, f] of fails) if (t - f.first > FAIL_WINDOW_MS) fails.delete(ip)
  }

  function issue() {
    prune()
    const tok = crypto.randomBytes(32).toString('hex')
    tokens.set(tok, now() + ttlMs)
    return tok
  }

  function valid(tok) {
    if (!tok) return false
    const exp = tokens.get(tok)
    if (!exp) return false
    if (exp <= now()) {
      tokens.delete(tok)
      return false
    }
    return true
  }

  function revoke(tok) {
    tokens.delete(tok)
  }

  function lockedFor(ip) {
    const f = fails.get(ip)
    if (!f) return 0
    if (now() - f.first > FAIL_WINDOW_MS) {
      fails.delete(ip)
      return 0
    }
    if (f.count < MAX_FAILS) return 0
    return FAIL_WINDOW_MS - (now() - f.first)
  }

  function noteFail(ip) {
    const f = fails.get(ip)
    if (!f || now() - f.first > FAIL_WINDOW_MS) fails.set(ip, { count: 1, first: now() })
    else f.count += 1
  }

  function attempt(candidate, ip = 'unknown') {
    const waitMs = lockedFor(ip)
    if (waitMs > 0) return { ok: false, lockedMs: waitMs }
    if (safeEqual(candidate, secret)) {
      fails.delete(ip)
      return { ok: true, token: issue() }
    }
    noteFail(ip)
    return { ok: false, lockedMs: 0 }
  }

  function cookieHeader(token, req) {
    const parts = [
      `${SHARE_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(ttlMs / 1000)}`,
    ]
    if (isHttps(req)) parts.push('Secure')
    return parts.join('; ')
  }

  // Express middleware. Mount it BEFORE express.static so the UI files are
  // covered too. Handles /login and /logout itself.
  function middleware(req, res, next) {
    if (!enabled) return next()
    const p = req.path || req.url || '/'
    const cookies = parseCookies(req.headers?.cookie)
    const signedIn = valid(cookies[SHARE_COOKIE])

    if (p === '/login') {
      if (req.method === 'GET') {
        if (signedIn) return res.redirect(safeNext(req.query?.next))
        res.set('Cache-Control', 'no-store')
        return res.status(200).type('html').send(loginPage({ next: safeNext(req.query?.next) }))
      }
      if (req.method === 'POST') {
        const body = req.body || {}
        const target = safeNext(body.next)
        const r = attempt(body.password, clientIp(req))
        res.set('Cache-Control', 'no-store')
        if (r.ok) {
          res.set('Set-Cookie', cookieHeader(r.token, req))
          return res.redirect(303, target)
        }
        if (r.lockedMs > 0) {
          const mins = Math.ceil(r.lockedMs / 60000)
          return res
            .status(429)
            .type('html')
            .send(loginPage({ error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, next: target }))
        }
        return res.status(401).type('html').send(loginPage({ error: 'Wrong password.', next: target }))
      }
      return res.status(405).end()
    }

    if (p === '/logout') {
      revoke(cookies[SHARE_COOKIE])
      res.set('Set-Cookie', `${SHARE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
      return res.redirect('/login')
    }

    if (signedIn) return next()

    res.set('Cache-Control', 'no-store')
    if (wantsJson(req)) return res.status(401).json({ error: 'Sign in required.', login: '/login' })
    const back = req.originalUrl && req.originalUrl !== '/' ? `?next=${encodeURIComponent(safeNext(req.originalUrl))}` : ''
    return res.redirect(`/login${back}`)
  }

  return { enabled, ttlMs, issue, valid, revoke, attempt, lockedFor, middleware, tokenCount: () => tokens.size }
}
