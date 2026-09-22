// Goal 2 — the ranked listing-agent list.
//
// Goal 1 run backwards. Instead of one address in, the whole city: every San
// Francisco sale for 24 months, filtered to the kind of property we buy,
// grouped by the agent who listed it.
//
// The brief says "groups by listing agent and counts", and count is the primary
// ranking here. The other measures ride alongside as columns rather than being
// folded into a score, because a score hides its own reasoning and an operator
// ranking a call list should be able to sort on what they care about.

import { AGENT_DEAL_SIGNALS } from './sources/redfin.js'

// Two spellings of one person. Middle initials and suffixes vary between
// listings, so compare first and last name, and keep the brokerage out of it —
// agents move firms and are still the same person.
export function personKey(name = '') {
  const words = String(name)
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^(jr|sr|ii|iii|iv|md|esq|dr|mr|mrs|ms)$/.test(w))
    .filter((w) => w.length > 1)
  if (!words.length) return ''
  return `${words[0]} ${words[words.length - 1]}`
}

// The surname on its own, used only to reunite an abbreviated name with a full
// one. "K. Kohlmyer" loses its initial to the length filter above and would
// otherwise become a second, phantom agent.
export function surnameOf(name = '') {
  const key = personKey(name)
  return key ? key.split(' ').pop() : ''
}

/**
 * Fold abbreviated names into full ones, but only when it is unambiguous.
 *
 * "K. Kohlmyer" joins "Kenneth Kohlmyer" when Kohlmyer is the only full name
 * with that surname. If two Kohlmyers are listing in the city, the abbreviated
 * one stays on its own — splitting one agent into two rows is an annoyance,
 * while merging two people into one is a wrong phone number on a call list.
 */
export function mergeAbbreviatedKeys(keys = []) {
  const map = new Map(keys.map((k) => [k, k]))
  const bySurname = new Map()
  for (const k of keys) {
    const [first, last] = k.split(' ')
    if (first === last) continue // surname-only, nothing to be the target of
    if (!bySurname.has(last)) bySurname.set(last, [])
    bySurname.get(last).push(k)
  }
  for (const k of keys) {
    const [first, last] = k.split(' ')
    if (first !== last) continue
    const candidates = bySurname.get(last) || []
    if (candidates.length === 1) map.set(k, candidates[0])
  }
  return map
}

const median = (ns) => {
  const v = ns.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2)
}

// The best-filled version of a value across a person's listings: agents appear
// with a phone on one listing and an email on another.
const firstFilled = (rows, pick) => rows.map(pick).map((v) => String(v || '').trim()).find(Boolean) || ''

/**
 * Property rows into ranked agents.
 *
 * Each row is what one Redfin property page gave us:
 *   { url, address, soldDate, price, dom, listingAgent, signals, buyerBrokerage }
 *
 * A row counts as "our kind of deal" when its remarks carried at least one of
 * the deal signals goal 1 already matches.
 */
export function rollupAgents(rows = [], { minDeals = 1 } = {}) {
  const first = new Map()
  for (const r of rows) {
    const key = personKey(r?.listingAgent?.name)
    if (!key) continue
    if (!first.has(key)) first.set(key, [])
    first.get(key).push(r)
  }
  // Second pass: "K. Kohlmyer" is Kenneth, when there is only one Kohlmyer.
  const merge = mergeAbbreviatedKeys([...first.keys()])
  const byPerson = new Map()
  for (const [key, listings] of first) {
    const target = merge.get(key) || key
    if (!byPerson.has(target)) byPerson.set(target, [])
    byPerson.get(target).push(...listings)
  }

  const agents = []
  for (const [key, listings] of byPerson) {
    const ours = listings.filter((r) => (r.signals || []).length)
    if (ours.length < minDeals) continue
    const dates = ours.map((r) => (r.soldDate ? new Date(r.soldDate) : null)).filter((d) => d && !Number.isNaN(d.getTime()))
    dates.sort((a, b) => b - a)
    // Which signals this agent actually sees, most common first.
    const tally = {}
    for (const r of ours) for (const s of r.signals || []) tally[s] = (tally[s] || 0) + 1
    const kinds = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} (${n})`)
    agents.push({
      key,
      // Prefer the fullest spelling seen: "Kenneth Kohlmyer" over "K. Kohlmyer".
      name: listings
        .map((r) => String(r.listingAgent?.name || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] || '',
      brokerage: firstFilled(listings, (r) => r.listingAgent?.brokerage),
      license: firstFilled(listings, (r) => r.listingAgent?.license),
      phone: firstFilled(listings, (r) => r.listingAgent?.phone || r.listingAgent?.brokerPhone),
      email: firstFilled(listings, (r) => r.listingAgent?.email),
      ourDeals: ours.length,
      totalSales: listings.length,
      // How much of their business we are. An agent doing 3 of 5 cares far more
      // than one doing 3 of 90.
      share: listings.length ? Math.round((ours.length / listings.length) * 100) : 0,
      lastDeal: dates[0] ? dates[0].toISOString().slice(0, 10) : '',
      // Their as-is listings sitting on the market is the opening line of the
      // call: that is the problem a cash buyer solves.
      medianDom: median(ours.map((r) => r.dom)),
      medianPrice: median(ours.map((r) => r.price)),
      signals: kinds.join(', '),
      examples: ours.slice(0, 3).map((r) => r.address).filter(Boolean).join(' | '),
    })
  }

  // The brief's ranking: how many of our kind of deal they closed. Ties broken
  // by share, then by recency, so a specialist beats a generalist.
  agents.sort((a, b) => b.ourDeals - a.ourDeals || b.share - a.share || String(b.lastDeal).localeCompare(String(a.lastDeal)))
  return agents
}

export const AGENT_COLUMNS = [
  'Agent',
  'Brokerage',
  'DRE',
  'Phone',
  'Email',
  'Our Deals',
  'Total Sales',
  'Share %',
  'Last Deal',
  'Median DOM',
  'Median Price',
  'Signals',
  'Example Properties',
]

export function agentsToRows(agents = []) {
  return agents.map((a) => ({
    Agent: a.name,
    Brokerage: a.brokerage,
    DRE: a.license,
    Phone: a.phone,
    Email: a.email,
    'Our Deals': String(a.ourDeals),
    'Total Sales': String(a.totalSales),
    'Share %': String(a.share),
    'Last Deal': a.lastDeal,
    'Median DOM': a.medianDom == null ? '' : String(a.medianDom),
    'Median Price': a.medianPrice == null ? '' : `$${a.medianPrice.toLocaleString('en-US')}`,
    Signals: a.signals,
    'Example Properties': a.examples,
  }))
}

// What the whole run found, for the operator to sanity-check the shape of the
// answer before acting on it.
export function rollupSummary(rows = [], agents = []) {
  const withAgent = rows.filter((r) => r?.listingAgent?.name).length
  const ours = rows.filter((r) => (r.signals || []).length).length
  return {
    properties: rows.length,
    withAgent,
    ourKind: ours,
    ourKindPercent: rows.length ? Math.round((ours / rows.length) * 100) : 0,
    agents: agents.length,
    namedSignals: AGENT_DEAL_SIGNALS,
  }
}
