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
  // never the bare word "land" — Zillow's tax table has a "Land" column on every home
  [/vacant land|vacant lot|\blot\s*\/\s*land\b|\bland for sale\b|\blots? for sale\b/i, 'Lot/Land'],
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
  // The property's own badges come before "nearby homes for sale" and similar
  // noise, so among the phrases present the EARLIEST one on the page wins.
  // Badges sit right under the address; keep the type scan tight so a
  // "nearby homes" section never supplies it.
  const head = t.slice(0, 2500)
  out.propertyType = earliest(head, PROP_TYPES)
  out.listingStatus = earliest(head.slice(0, 3000), STATUSES)
  return out
}

const STATUSES = [
  [/coming soon/i, 'Coming Soon'],
  [/\bpending\b/i, 'Pending'],
  [/\bfor sale\b/i, 'For Sale'],
  [/\boff[- ]market\b/i, 'Off Market'],
  [/\bsold\b/i, 'Sold'],
]

// Label of the pattern whose first match appears earliest in the text.
function earliest(text, pairs) {
  let best = ''
  let at = Infinity
  for (const [re, name] of pairs) {
    const m = re.exec(text)
    if (m && m.index < at) { at = m.index; best = name }
  }
  return best
}

// Load the Zillow page for an address in the given page/tab and read it.
export async function checkZillow(page, address, { signal = null, timeoutMs = 15000 } = {}) {
  const res = { ok: false, url: zillowSearchUrl(address), county: '', propertyType: '', listingStatus: '', blocked: false, error: '', listingAgent: null, buyerAgent: null, mlsNumber: '', mlsSource: '' }
  if (!address) { res.error = 'No address.'; return res }
  try {
    if (signal?.aborted) throw new Error('stopped')
    await page.goto(res.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForTimeout(2500) // let the page's JS render the badges
    res.url = page.url() // the real property URL (with zpid) after Zillow's redirect
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    Object.assign(res, parseZillowText(text))
    if (!res.blocked) Object.assign(res, parseZillowAgents(text))
    res.ok = !res.blocked && Boolean(res.propertyType || res.listingStatus || res.county || res.listingAgent || /_zpid/.test(res.url))
    if (res.blocked) res.error = 'Zillow showed a bot check for this page.'
  } catch (err) {
    res.error = String(err?.message || err).slice(0, 160)
  }
  return res
}

// ---------------------------------------------------------------------------------
// Agents, from the listing attribution block.
//
// Zillow prints the same facts Redfin does, in its own wording, near the bottom
// of the overview:
//
//   Listed by: Perry Kayasone DRE #01943235 415-290-0736, Sequoia Real Estate 888-499-7773
//   Bought with: Donna Chan, DRE #01774693
//                Exp Realty of California Inc.
//   Source: SFAR,  MLS#: 426097788
//
// Worth having as a second opinion: the two sites disagree often enough that a
// mismatch is a signal, and one answers when the other is blocked. Like Redfin,
// these are the agents of the MOST RECENT listing.
// ---------------------------------------------------------------------------------

const PHONE_RE = /\b(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g
const DRE_RE = /\bDRE\s*#?\s*(\d{5,10})\b/i

function tidyPhone(v) {
  const d = String(v || '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : ''
}

// One "Listed by" / "Bought with" block into a person.
//
// A block can name a co-listing agent as well:
//   "Peter Iskandar DRE #01481566 415-297-5185, Trident Real Estate ,
//    Yulia Iskandar DRE #02034288 , Trident Real Estate"
// Only the first agent is wanted. The brokerage therefore stops before the
// co-agent, at the last comma ahead of their licence — cutting at every comma
// instead would truncate honest names like "eXp Realty of California, Inc."
export function parseAgentBlock(block = '') {
  const raw = String(block || '').replace(/\s+/g, ' ').trim()
  if (!raw || raw.length > 400) return null
  const phones = (raw.match(PHONE_RE) || []).map(tidyPhone).filter(Boolean)
  const withoutPhones = raw.replace(PHONE_RE, ' ')
  const dre = withoutPhones.match(DRE_RE)
  let name = ''
  let brokerage = ''
  if (dre) {
    const at = withoutPhones.search(DRE_RE)
    name = withoutPhones.slice(0, at)
    brokerage = withoutPhones.slice(at + dre[0].length)
    // A second licence means a second agent: keep only what is before them.
    const next = brokerage.search(DRE_RE)
    if (next >= 0) {
      const comma = brokerage.lastIndexOf(',', next)
      brokerage = comma >= 0 ? brokerage.slice(0, comma) : brokerage.slice(0, next)
    }
  } else {
    // No licence shown: take the first comma as the split.
    const c = withoutPhones.indexOf(',')
    name = c > 0 ? withoutPhones.slice(0, c) : withoutPhones
    brokerage = c > 0 ? withoutPhones.slice(c + 1) : ''
  }
  const clean = (v) => String(v).replace(/\s+/g, ' ').replace(/^[\s,;:\u2013-]+|[\s,;:\u2013-]+$/g, '').trim()
  name = clean(name)
  brokerage = clean(brokerage)
  // A name with digits or a "no agent" placeholder is not a person.
  if (!name || /\d/.test(name) || name.length > 60 || /^(n\/?a|none|unknown)$/i.test(name)) return null
  return {
    name,
    brokerage: brokerage && brokerage.length <= 80 ? brokerage : '',
    license: dre ? `DRE #${dre[1]}` : '',
    phone: phones[0] || '',
    brokerPhone: phones[1] || '',
  }
}

export function parseZillowAgents(text = '') {
  const t = String(text || '')
  const grab = (label) => {
    const re = new RegExp(`${label}\\s*:?\\s*([\\s\\S]{0,240}?)(?=\\n\\s*(?:Listed by|Bought with|Co[- ]?listing|Source\\s*:|Originating MLS|Zillow last checked|Listing updated)|$)`, 'i')
    const m = t.match(re)
    return m ? parseAgentBlock(m[1]) : null
  }
  const mls = t.match(/\bMLS\s*#\s*:?\s*([A-Za-z0-9-]{4,20})\b/i)
  const source = t.match(/\bSource\s*:\s*([A-Za-z0-9 .&-]{2,40}?)\s*(?:,|\n|MLS)/i)
  return {
    listingAgent: grab('Listed by'),
    buyerAgent: grab('Bought with'),
    mlsNumber: mls ? mls[1] : '',
    mlsSource: source ? source[1].trim() : '',
  }
}
