// Redfin — the only source we have found that names the agents.
//
// PropertyRadar's Listings tab carries MLS status, date, days on market and
// price, but no agent and no remarks; underneath it, PropertyRadar itself
// offers "Open Redfin". The Redfin property page serves the missing half in
// its HTML: listing agent and buyer agent with brokerage, DRE licence, phone
// and email, plus the MLS marketing remarks that say "fixer" or "as-is".
//
// No browser is needed. A plain fetch returns the whole thing, which is why
// this runs in the backend alongside the web search instead of costing a tab.
//
// Everything here is best effort. A blocked page or a changed layout returns
// empty fields and a status the operator can see. It never guesses.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Words that mark the kind of property we buy. Order matters only for display.
const SIGNALS = [
  ['fixer', /\bfixer(?:[- ]upper)?\b/i],
  ['as-is', /\bas[- ]is\b/i],
  ['probate', /\bprobate\b/i],
  ['trust sale', /\btrust sale\b|\bsold by (?:the )?trust\b/i],
  ['estate sale', /\bestate sale\b|\bestate of\b/i],
  ['conservatorship', /\bconservator(?:ship)?\b/i],
  ['court confirmation', /\bcourt confirmation\b/i],
  ['needs work', /\bneeds? (?:a lot of )?(?:work|tlc|updating|repair)\b|\bTLC\b/i],
  ['contractor special', /\bcontractor(?:'s)? special\b|\bhandyman\b/i],
  ['tear down', /\btear[- ]?down\b|\bscrape\b/i],
  ['deferred maintenance', /\bdeferred maintenance\b/i],
  ['investor', /\binvestor(?:s)? (?:special|opportunity|alert)\b/i],
  ['vacant', /\bvacant\b/i],
]

const BLOCKED_RE =
  /(px-captcha|are you a human|access to this page has been denied|unusual traffic|request blocked|captcha-delivery|<title>[^<]*403[^<]*<\/title>)/i

export function looksBlocked(html = '') {
  const s = String(html)
  if (!s.trim()) return true
  if (s.length < 5000 && BLOCKED_RE.test(s)) return true
  return BLOCKED_RE.test(s.slice(0, 4000))
}

// Redfin embeds its data as JSON inside a JS string literal, so every quote
// arrives as \" . Walk the text tracking whether we are inside one of those
// escaped strings, so a bracket in a description cannot end the slice early.
export function sliceEscapedJson(html, key) {
  const start = String(html).indexOf(`\\"${key}\\":`)
  if (start < 0) return ''
  const s = String(html)
  let i = s.indexOf(':', start + key.length) + 1
  while (i < s.length && /\s/.test(s[i])) i++
  const open = s[i]
  if (open !== '[' && open !== '{') return ''
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inStr = false
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '"') {
      inStr = !inStr
      j++
      continue
    }
    if (s[j] === '\\') {
      j++
      continue
    }
    if (inStr) continue
    if (s[j] === open) depth++
    else if (s[j] === close) {
      depth--
      if (depth === 0) return s.slice(i, j + 1)
    }
  }
  return ''
}

// The slice is the body of a JS string literal, so one JSON.parse unescapes it
// and a second turns the result into data.
export function parseEscapedJson(slice) {
  if (!slice) return null
  try {
    return JSON.parse(JSON.parse(`"${slice.replace(/\n/g, '\\n')}"`))
  } catch {
    return null
  }
}

function digitsOnly(v) {
  return String(v || '').replace(/[^\d]/g, '')
}

function tidyPhone(v) {
  const d = digitsOnly(v)
  if (d.length === 11 && d.startsWith('1')) return `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`
  if (d.length !== 10) return ''
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
}

function tidyLicense(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  // Redfin sometimes renders the label twice: "DRE #DRE #01339386".
  const m = s.match(/(\d{6,10})\s*$/)
  return m ? `DRE #${m[1]}` : ''
}

function oneAgent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.agentInfo?.agentName || '').trim()
  if (!name || raw.agentInfo?.isAgentNameBlank) return null
  return {
    name,
    brokerage: String(raw.brokerName || '').trim(),
    license: tidyLicense(raw.breNumber || raw.license),
    phone: tidyPhone(raw.agentPhoneNumber?.phoneNumber),
    brokerPhone: tidyPhone(raw.brokerPhoneNumber?.phoneNumber),
    // Only the address inside the agent block. A bare "agentEmail" elsewhere in
    // the page belongs to a Redfin house agent advertising on the listing.
    email: String(raw.agentEmailAddress || '').trim().toLowerCase(),
    isRedfinAgent: Boolean(raw.agentInfo?.isRedfinAgent),
  }
}

export function parseAgents(html, key) {
  const arr = parseEscapedJson(sliceEscapedJson(html, key))
  if (!Array.isArray(arr)) return []
  return arr.map(oneAgent).filter(Boolean)
}

export function parseRemarks(html = '') {
  const arr = parseEscapedJson(sliceEscapedJson(html, 'marketingRemarks'))
  if (Array.isArray(arr)) {
    const text = arr
      .map((r) => String(r?.marketingRemark || '').trim())
      .filter(Boolean)
      .join(' ')
    if (text) return text.replace(/\s+/g, ' ').trim()
  }
  return ''
}

export function dealSignals(remarks = '') {
  const text = String(remarks || '')
  if (!text) return []
  return SIGNALS.filter(([, re]) => re.test(text)).map(([label]) => label)
}

export function parseMls(html = '') {
  const s = String(html)
  const src = s.match(/\\"dataSourceDescription\\":\\"([^\\"]{3,80})\\"/)
  const num = s.match(/\\"mlsId\\":\{\\"label\\":\\"[^\\"]*\\",\\"value\\":\\"([\w-]{4,20})\\"/)
  return {
    mlsSource: src ? src[1].trim() : '',
    mlsNumber: num ? num[1].trim() : '',
  }
}

export function parseRedfinHtml(html = '') {
  if (looksBlocked(html)) return { ok: false, blocked: true, error: 'Redfin returned a bot check.' }
  const listing = parseAgents(html, 'listingAgents')
  const buying = parseAgents(html, 'buyingAgents')
  const remarks = parseRemarks(html)
  const { mlsSource, mlsNumber } = parseMls(html)
  const found = Boolean(listing.length || buying.length || remarks)
  return {
    ok: found,
    blocked: false,
    listingAgent: listing[0] || null,
    buyerAgent: buying[0] || null,
    otherAgents: [...listing.slice(1), ...buying.slice(1)],
    remarks,
    signals: dealSignals(remarks),
    mlsSource,
    mlsNumber,
  }
}

export async function fetchRedfin(url, { signal, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) return { html: '', status: res.status, error: `Redfin returned HTTP ${res.status}.` }
    return { html: await res.text(), status: res.status, error: '' }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

// One property. `url` comes from the web-search step, which already classifies
// a Redfin link for the address.
export async function lookupRedfin(url, opts = {}) {
  if (!url || !/redfin\.com/i.test(url)) return { ok: false, error: 'No Redfin page for this address.' }
  let got
  try {
    got = await fetchRedfin(url, opts)
  } catch (err) {
    const msg = String(err?.message || err)
    return { ok: false, error: /abort/i.test(msg) ? 'Redfin lookup timed out.' : `Redfin: ${msg}` }
  }
  if (got.error) return { ok: false, error: got.error, status: got.status }
  const parsed = parseRedfinHtml(got.html)
  return { ...parsed, url, error: parsed.ok ? '' : parsed.error || 'Redfin page had no agent or remarks.' }
}
