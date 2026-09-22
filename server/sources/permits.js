// San Francisco building permits and code violations.
//
// The city publishes both as open data, free, no key, keyed by BLOCK and LOT —
// the parcel number PropertyRadar already gives us. Query by parcel, not by
// street: for 547 Missouri St the parcel query returns 11 permits where the
// address query returns 6, because permits get filed under spelling variants.
//
// No browser. Two plain fetches per property, about a second.
//
// Note the city moved off data.sfgov.org; the old host 301-redirects here.

const HOST = 'https://data.sf.gov'
export const PERMITS_DATASET = 'i98e-djp9' // Building Permits
export const VIOLATIONS_DATASET = 'nbtm-fbw5' // DBI Notices of Violation

// Work that says something about the property's condition, as opposed to a
// street-space or sign permit.
const TRIVIAL = /^(street space|sidewalk|banner|sign\b|awning|temporary occupancy)/i

export function datasetUrl(dataset, { block, lot, limit = 200 }) {
  const where = `block="${String(block).replace(/"/g, '')}" AND lot="${String(lot).replace(/"/g, '')}"`
  const q = new URLSearchParams({ $where: where, $limit: String(limit) })
  return `${HOST}/resource/${dataset}.json?${q}`
}

function asDate(v) {
  const d = new Date(String(v || ''))
  return Number.isNaN(d.getTime()) ? null : d
}

const fmt = (d) => (d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '')

export function summarisePermits(rows = []) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      number: String(r.permit_number || '').trim(),
      status: String(r.status || '').trim().toLowerCase(),
      description: String(r.description || '').replace(/\s+/g, ' ').trim(),
      cost: Number(r.revised_cost || r.estimated_cost || 0) || 0,
      filed: asDate(r.filed_date || r.permit_creation_date),
      type: String(r.permit_type_definition || '').trim(),
    }))
    .filter((p) => p.number)
  const real = list.filter((p) => !TRIVIAL.test(p.description))
  const sorted = [...real].sort((a, b) => (b.filed?.getTime() || 0) - (a.filed?.getTime() || 0))
  const open = real.filter((p) => /issued|approved|filed|reinstated|plancheck|appeal|revision/.test(p.status) && !/complete|withdrawn|cancel|expired|disapprove/.test(p.status))
  const last = sorted[0] || null
  return {
    total: list.length,
    substantive: real.length,
    open: open.length,
    lastDate: fmt(last?.filed || null),
    lastDescription: last ? last.description.slice(0, 180) : '',
    totalValue: real.reduce((n, p) => n + (p.cost > 1 ? p.cost : 0), 0),
  }
}

export function summariseViolations(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({
    status: String(r.status || '').trim().toLowerCase(),
    category: String(r.nov_category_description || '').trim(),
    filed: asDate(r.date_filed),
  }))
  const active = list.filter((v) => v.status === 'active')
  const sorted = [...list].sort((a, b) => (b.filed?.getTime() || 0) - (a.filed?.getTime() || 0))
  return {
    total: list.length,
    active: active.length,
    lastDate: fmt(sorted[0]?.filed || null),
    // An active building violation is a motivated owner; say which kind.
    activeKinds: [...new Set(active.map((v) => v.category).filter(Boolean))].join(', '),
  }
}

async function getJson(url, { signal, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

// Everything the city knows about one parcel. San Francisco only.
export async function lookupPermits(apn, { splitApn, ...opts } = {}) {
  const { block, lot } = splitApn(apn)
  if (!block) return { ok: false, error: `Parcel number not usable: "${apn}"` }
  try {
    const [permits, violations] = await Promise.all([
      getJson(datasetUrl(PERMITS_DATASET, { block, lot }), opts),
      getJson(datasetUrl(VIOLATIONS_DATASET, { block, lot }), opts).catch(() => []),
    ])
    return { ok: true, error: '', permits: summarisePermits(permits), violations: summariseViolations(violations) }
  } catch (err) {
    const msg = String(err?.message || err)
    return { ok: false, error: /abort/i.test(msg) ? 'Permit lookup timed out.' : `City open data: ${msg}` }
  }
}
