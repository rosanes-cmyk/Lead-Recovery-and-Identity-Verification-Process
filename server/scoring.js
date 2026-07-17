// Turns the accumulated findings into a decision: verified name, best contact
// info with confidence levels, conflicts, and ONE recommended status.
//
// Rules follow the SOP:
//  - People-search results alone are never treated as verified.
//  - Nobody is labeled a relative without a lawful record (we never do that
//    automatically, so relatives only ever appear as unverified clues).
//  - "Seller Confirmed Interested" requires authorized outreach, which is not
//    automated, so this engine never recommends it.

import { normNameSet, normPhone } from './sources/base.js'

const TRUST_RE = /\b(trust|estate|probate|deceased|living trust|revocable|irrevocable|trustee|heirs?)\b/i

export function score(data) {
  const conflicts = []
  const possibleContacts = []

  // ---- Owner name ---------------------------------------------------------
  // A recorded-owner field can name several people ("A and B"). Split into the
  // primary owner (the verified name) and co-owners (verified connections).
  const recordedRaw = clean(data.ownership?.recordedOwner)
  const recordedNames = parseOwnerNames(recordedRaw)
  const recorded = recordedNames[0] || recordedRaw
  const coOwnerNames = recordedNames.slice(1)
  const crmName = clean(data.crm?.sellerName || data.input?.name)
  const dmName = clean(data.corroboration?.dealmachine?.ownerName)

  const ownerSources = []
  if (recorded) ownerSources.push({ name: recorded, source: data.ownership?.source || 'PropertyRadar' })
  if (dmName) ownerSources.push({ name: dmName, source: 'DealMachine' })

  let verifiedName = recorded || dmName || crmName || ''
  let verifiedNameSource = recorded
    ? data.ownership?.source || 'PropertyRadar'
    : dmName
      ? 'DealMachine'
      : crmName
        ? 'REI BlackBook'
        : ''
  let nameConfidence = 'Low'

  if (recorded && crmName) {
    if (nameMatch(recorded, crmName)) {
      nameConfidence = 'High'
    } else {
      nameConfidence = 'Medium'
      conflicts.push({
        type: 'Owner name mismatch',
        detail: `Recorded owner "${recorded}" differs from CRM name "${crmName}".`,
      })
    }
  } else if (recorded && dmName && nameMatch(recorded, dmName)) {
    nameConfidence = 'High'
  } else if (recorded) {
    nameConfidence = 'Medium'
  } else if (crmName || dmName) {
    nameConfidence = 'Low'
  }

  // Multiple distinct owner names across strong sources = conflict.
  const distinctOwners = uniqueNames(ownerSources.map((o) => o.name))
  if (distinctOwners.length > 1) {
    conflicts.push({
      type: 'Multiple possible owners',
      detail: `Sources disagree on owner: ${distinctOwners.join(' / ')}.`,
    })
  }

  // ---- Trust / estate / probate ------------------------------------------
  const vestingText = [data.ownership?.ownershipType, data.ownership?.vesting, verifiedName]
    .filter(Boolean)
    .join(' ')
  const trustFlag = TRUST_RE.test(vestingText)
  if (trustFlag) {
    conflicts.push({
      type: 'Trust / estate / probate ownership',
      detail: `Ownership text suggests a trust, estate, or probate matter: "${vestingText.trim()}".`,
    })
  }

  // ---- Mailing address ----------------------------------------------------
  const mailingWithSource = [
    { addr: clean(data.ownership?.mailingAddress), source: data.ownership?.source || 'PropertyRadar', strong: true },
    { addr: clean(data.corroboration?.dealmachine?.mailingAddress), source: 'DealMachine', strong: false },
    { addr: clean(data.crm?.mailingAddress), source: 'REI BlackBook', strong: false },
  ].filter((m) => m.addr)
  const mailingCandidates = uniq(mailingWithSource.map((m) => m.addr))
  const bestMailingRec = mailingWithSource[0] || null
  let bestMailing = bestMailingRec?.addr || ''
  let bestMailingSource = bestMailingRec?.source || ''
  let mailingConfidence = 'Low'
  if (bestMailingRec?.strong) mailingConfidence = 'High' // county/PR of record
  else if (bestMailing) mailingConfidence = 'Medium'
  if (mailingCandidates.length > 1) {
    conflicts.push({
      type: 'Multiple mailing addresses',
      detail: `Different mailing addresses found: ${mailingCandidates.join(' | ')}.`,
    })
  }

  // ---- Phones -------------------------------------------------------------
  const phoneMap = new Map() // normalized -> { number, sources:Set, names:Set }
  const formatted = (raw) => /[()\-\s]/.test(String(raw))
  const addPhone = (raw, source, name) => {
    const n = normPhone(raw)
    if (n.length < 10) return
    if (!phoneMap.has(n)) phoneMap.set(n, { number: raw, sources: new Set(), names: new Set() })
    const rec = phoneMap.get(n)
    // Prefer a human-formatted display over a bare tel: form for the same number.
    if (formatted(raw) && !formatted(rec.number)) rec.number = raw
    rec.sources.add(source)
    if (name) rec.names.add(clean(name))
  }
  ;(data.crm?.phones || []).forEach((p) => addPhone(p, 'REI BlackBook'))
  psRows(data).forEach((row) => (row.phones || []).forEach((p) => addPhone(p, 'People Search', row.name)))

  const phones = [...phoneMap.values()].map((rec) => {
    const sources = [...rec.sources]
    const names = [...rec.names]
    let status = 'Possible'
    let confidence = 'Low'
    const nameMatchesOwner = names.some((nm) => verifiedName && nameMatch(nm, verifiedName))
    if (sources.length >= 2 || (sources.includes('REI BlackBook') && nameMatchesOwner)) {
      status = 'Likely'
      confidence = 'Medium'
    }
    if (names.length > 1 && !nameMatchesOwner && verifiedName) {
      conflicts.push({
        type: 'Phone linked to another person',
        detail: `Phone ${rec.number} is associated with: ${names.join(', ')}.`,
      })
      status = 'Possible'
    }
    // Automation can never reach "Confirmed" — that needs direct seller contact.
    return { number: rec.number, status, confidence, sources, names, score: pct(confidence, sources.length) }
  })
  const bestPhone = phones.find((p) => p.confidence === 'Medium') || phones[0] || null

  // ---- Emails -------------------------------------------------------------
  const crmEmails = (data.crm?.emails || []).map(clean).filter(Boolean)
  const emailSet = uniq([...crmEmails, clean(data.input?.email)].filter(Boolean))
  const bestEmail = emailSet[0] || ''
  const bestEmailSource = crmEmails.length ? 'REI BlackBook' : bestEmail ? 'Provided input' : ''
  const emailConfidence = emailSet.length ? (crmEmails.length ? 'Medium' : 'Low') : ''

  // ---- Possible contacts (weak matches kept, never promoted) --------------
  psRows(data).forEach((row) => {
    if (row.name && (!verifiedName || !nameMatch(row.name, verifiedName))) {
      possibleContacts.push({
        name: row.name,
        addresses: row.addresses || [],
        phones: row.phones || [],
        note: 'People-search clue — unverified. Not a confirmed contact or relative.',
      })
    }
    ;(row.possibleRelatives || []).forEach((r) =>
      possibleContacts.push({
        name: r,
        note: 'Aggregator "possible relative" — NOT verified. A relationship needs a lawful record.',
      }),
    )
  })

  // ---- Match scores (numeric) --------------------------------------------
  // A calculated "match score", NOT a true statistical probability: it reflects
  // confidence level plus how many independent sources agree.
  const nameAgree =
    ownerSources.filter((o) => nameMatch(o.name, verifiedName)).length +
    (crmName && nameMatch(crmName, verifiedName) ? 1 : 0)
  const verifiedNameScore = verifiedName ? pct(nameConfidence, nameAgree) : 0
  const bestEmailScore = bestEmail ? pct(emailConfidence, 1) : 0
  const mailingAgree = mailingWithSource.filter((m) => m.addr === bestMailing).length
  const bestMailingScore = bestMailing ? pct(mailingConfidence, mailingAgree) : 0

  // ---- Top 5 possible contacts -------------------------------------------
  // Verified connections come only from recorded documents (co-owners). People-
  // search clues stay clearly unverified. Nobody is labeled a relative without
  // a lawful record.
  const src = data.ownership?.source || 'Recorded document'
  const verifiedConnections = coOwnerNames
    .filter((nm) => !verifiedName || !nameMatch(nm, verifiedName))
    .map((nm) => ({ name: nm, relationship: 'Co-owner named on recorded document', basis: src, verified: true, phones: [], score: 82 }))
  const clueContacts = possibleContacts.map((p) => ({
    name: p.name,
    relationship: 'Unverified clue',
    basis: 'People search',
    verified: false,
    phones: p.phones || [],
    score: 40,
    note: p.note,
  }))
  const ranked = [...verifiedConnections, ...clueContacts].sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      b.score - a.score ||
      (b.phones?.length || 0) - (a.phones?.length || 0),
  )
  // Dedupe by name (a verified co-owner outranks the same name as a clue).
  const topContacts = []
  for (const c of ranked) {
    if (!topContacts.some((k) => nameMatch(k.name, c.name))) topContacts.push(c)
    if (topContacts.length >= 5) break
  }

  // ---- Recommended status -------------------------------------------------
  const ownerKnown = Boolean(verifiedName) && nameConfidence !== 'Low'
  const hasUsableContact =
    (bestPhone && bestPhone.confidence !== 'Low') ||
    (bestMailing && mailingConfidence !== 'Low') ||
    (bestEmail && emailConfidence === 'Medium')

  let status, statusReason
  if (conflicts.length > 0 && (trustFlag || distinctOwners.length > 1 || hasMismatch(conflicts))) {
    status = 'Management Review Required'
    statusReason = 'Conflicts require a human decision: ' + conflicts.map((c) => c.type).join('; ') + '.'
  } else if (ownerKnown && hasUsableContact) {
    status = 'Seller Contact Located'
    statusReason =
      `Owner identified (${nameConfidence} confidence) with at least one usable contact method.`
  } else {
    status = 'No Contact After Investigation'
    statusReason = ownerKnown
      ? 'Owner identified, but no reliable contact method was confirmed.'
      : 'Owner could not be reliably identified and no reliable contact was confirmed.'
  }

  return {
    verifiedName,
    verifiedNameSource,
    verifiedNameScore,
    nameConfidence,
    nameComparison: { recorded, crm: crmName, dealmachine: dmName, match: recorded && crmName ? nameMatch(recorded, crmName) : null },
    bestPhone,
    phones,
    bestEmail,
    bestEmailSource,
    bestEmailScore,
    emailConfidence,
    bestMailing,
    bestMailingSource,
    bestMailingScore,
    mailingConfidence,
    trustFlag,
    conflicts,
    possibleContacts,
    topContacts,
    recommendedStatus: status,
    statusReason,
  }
}


// Confidence level -> numeric match score, nudged up by corroborating sources.
// Deliberately capped per level so the number never implies more certainty than
// the level itself allows.
function pct(level, agree = 1) {
  const base = { High: 88, Medium: 64, Low: 40 }
  const cap = { High: 99, Medium: 84, Low: 49 }
  if (!level || !base[level]) return 0
  return Math.min(cap[level], base[level] + (Math.max(1, agree) - 1) * 4)
}

// Extract person names from a recorded-owner string that may list several
// owners ("A and B", "A & B"). Conservative: a name needs 2+ non-boilerplate
// words, so "Smith Family Trust" or "Husband and Wife" yield no person names
// (the trust case is handled separately as an entity/conflict).
const OWNER_STOP = /^(husband|wife|and|as|joint|tenant|tenants|tenancy|trustee|trust|the|family|living|revocable|irrevocable|survivor|survivorship|community|property|et|al|etal|jt|ten|com|his|her|their|spouse|married|unmarried|single|a|an|of)$/i
function parseOwnerNames(str) {
  const out = []
  for (const rawPart of String(str || '').split(/\s+and\s+|\s*&\s*/i)) {
    const part = clean(rawPart).replace(/,.*$/, '')
    if (!part) continue
    const words = part.split(/\s+/).filter((w) => !OWNER_STOP.test(w.replace(/[^a-z]/gi, '')))
    if (words.length < 2) continue
    const nm = words.join(' ')
    if (!out.some((o) => nameMatch(o, nm))) out.push(nm)
  }
  return out
}

/* ---------- helpers ---------- */
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

// Two name tokens match if equal, one is an initial of the other, or they are
// within one edit (handles Philip/Phillip, Steven/Stephen, etc.).
function tokenMatch(a, b) {
  if (a === b) return true
  if (a.length === 1 || b.length === 1) return a[0] === b[0] // initial vs full
  const maxLen = Math.max(a.length, b.length)
  const tol = maxLen >= 6 ? 2 : 1
  return levenshtein(a, b) <= tol
}

// Fuzzy name match tolerant of word order, spelling variants, middle names,
// and initials. Matches when at least two tokens correspond (e.g. given +
// surname), or when a single-token name fuzzily matches any token.
function nameMatch(a, b) {
  const sa = normNameSet(a).split(' ').filter(Boolean)
  const sb = normNameSet(b).split(' ').filter(Boolean)
  if (!sa.length || !sb.length) return false
  const short = sa.length <= sb.length ? sa : sb
  const long = sa.length <= sb.length ? sb : sa
  const used = new Set()
  let matched = 0
  for (const t of short) {
    const idx = long.findIndex((u, i) => !used.has(i) && tokenMatch(t, u))
    if (idx >= 0) {
      used.add(idx)
      matched++
    }
  }
  if (short.length === 1) return matched >= 1
  return matched >= 2
}

// Cluster names by fuzzy equality; return one representative per cluster.
function uniqueNames(names) {
  const reps = []
  names.map(clean).filter(Boolean).forEach((n) => {
    if (!reps.some((r) => nameMatch(r, n))) reps.push(n)
  })
  return reps
}
function uniq(arr) {
  return [...new Set(arr)]
}
function psRows(data) {
  const out = []
  ;(data.peoplesearch?.results || []).forEach((r) => out.push(...(r.rows || [])))
  return out
}
// Only identity-level conflicts force Management Review. A property-vs-owner
// mailing difference is normal and is preserved as a flag, not a blocker.
function hasMismatch(conflicts) {
  return conflicts.some((c) => /owner name mismatch|another person|multiple possible owners/i.test(c.type))
}
