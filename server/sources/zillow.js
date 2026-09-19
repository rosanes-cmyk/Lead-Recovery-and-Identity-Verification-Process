// Zillow page check — county, property type and listing status for an address,
// read from the rendered property page (ported from the dispute app, where it
// was verified live). Zillow serves a bot challenge to some automation, so this
// is best-effort: a blocked or missing page is reported, never guessed around.
// Clues only — nothing here is treated as a record.

export const id = 'zillow'
export const label = 'Zillow'
export const loginGated = false

export function zillowSlug(address) {
  return String(address || '').replace(/[^\w\s]/g, '').trim().replace(/\s+/g, '-')
}
export function zillowSearchUrl(address) {
  return `https://www.zillow.com/homes/${zillowSlug(address)}/`
}

// Badge text → label, most specific first.
const PROP_TYPES = [
  [/mobile\s*\/?\s*manufactured|manufactured home|mobile home/i, 'MobileManufactured'],
  [/vacant land|\blot\s*\/\s*land\b|\bland\b(?!\s*(lord|scape))/i, 'Lot/Land'],
  [/\bcommercial\b/i, 'Commercial'],
  [/multi-?\s?family/i, 'Multi-Family'],
  [/\bcondo(minium)?\b/i, 'Condo'],
  [/\btownhouse\b|\btownhome\b/i, 'Townhouse'],
  [/single[-\s]family/i, 'Single Family'],
]
const BLOCKED_RE = /press\s*&\s*hold|access to this page has been denied|are you a human|verify you are a human|captcha|unusual traffic/i

// Parse the rendered page text. Badges and the breadcrumb live near the top, so
// only the first part of the page is scanned for type/status (less noise from
// "nearby homes" further down).
export function parseZillowText(text) {
  const t = String(text || '')
  const out = { county: '', propertyType: '', listingStatus: '', blocked: BLOCKED_RE.test(t.slice(0, 3000)) }
  if (out.blocked) return out
  // Breadcrumb: "California • Alameda County • Hayward • 94541"
  const cm = t.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){0,2}) County\b/)
  if (cm) out.county = cm[1]
  const head = t.slice(0, 4000)
  for (const [re, name] of PROP_TYPES) if (re.test(head)) { out.propertyType = name; break }
  const status = head.slice(0, 3000).toLowerCase()
  if (/coming soon/.test(status)) out.listingStatus = 'Coming Soon'
  else if (/\bpending\b/.test(status)) out.listingStatus = 'Pending'
  else if (/\bfor sale\b/.test(status)) out.listingStatus = 'For Sale'
  else if (/\boff market\b/.test(status)) out.listingStatus = 'Off Market'
  else if (/\bsold\b/.test(status)) out.listingStatus = 'Sold'
  return out
}

// Load the Zillow page for an address in the given page/tab and read it.
export async function checkZillow(page, address, { signal = null, timeoutMs = 15000 } = {}) {
  const res = { ok: false, url: zillowSearchUrl(address), county: '', propertyType: '', listingStatus: '', blocked: false, error: '' }
  if (!address) { res.error = 'No address.'; return res }
  try {
    if (signal?.aborted) throw new Error('stopped')
    await page.goto(res.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForTimeout(2500) // let the page's JS render the badges
    res.url = page.url() // the real property URL (with zpid) after Zillow's redirect
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    Object.assign(res, parseZillowText(text))
    res.ok = !res.blocked && Boolean(res.propertyType || res.listingStatus || res.county || /_zpid/.test(res.url))
    if (res.blocked) res.error = 'Zillow showed a bot check for this page.'
  } catch (err) {
    res.error = String(err?.message || err).slice(0, 160)
  }
  return res
}
