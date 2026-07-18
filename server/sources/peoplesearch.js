// Approved People Search (TruePeopleSearch, Cherry-Hombre approved).
//
// Guardrails: results are CLUES only, cross-checked elsewhere; nobody is labeled
// a relative; read-only; disabled unless PEOPLE_SEARCH_ENABLED=true.
//
// Matching logic (per operator guidance): among the search results, pick the
// person whose address matches the lead's property address; if none match, use
// the first result. Then open that person's "View Details" page for the phone
// numbers. TruePeopleSearch blocks bots, so it pauses for the human-check.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto, settle } from './base.js'
import { selectors, fillUrl } from './selectors.js'
import { config } from '../config.js'

export const id = 'peoplesearch'
export const label = 'Approved People Search'
export const loginGated = true

export async function run(ctx) {
  const { page, input, data, emit, runDir, signal, pauseForAction } = ctx
  const res = emptyResult(label)
  const cfg = selectors.peoplesearch || {}

  if (!config.peopleSearchEnabled) {
    res.notes.push('People search is DISABLED (PEOPLE_SEARCH_ENABLED=false).')
    res.ok = true
    return res
  }
  if (!cfg.name || !hasAnyUrl(cfg)) {
    res.notes.push('People search enabled but no provider configured.')
    return res
  }

  // Search by NAME only (one search = one possible human-check), then pick the
  // result whose address matches the lead. Use the CRM seller name (reliable);
  // fall back to the recorded owner. Include city/state to narrow it.
  const { citystatezip } = splitAddress(input.address)
  const searchName = input.name || data?.ownership?.recordedOwner

  const steps = [
    cfg.searchUrlForName && searchName ? { kind: 'name', url: fillUrl(cfg.searchUrlForName, { name: searchName, citystatezip }) } : null,
  ].filter(Boolean)

  if (!steps.length) {
    res.notes.push('No seller name available to search.')
    res.ok = true
    return res
  }

  const results = []
  for (const step of steps) {
    if (signal?.aborted) break
    emit({ type: 'log', source: label, message: `TruePeopleSearch by ${step.kind}` })
    try {
      await goto(page, step.url, { signal })
    } catch (err) {
      res.notes.push(`People search (${step.kind}) failed to open: ${String(err)}`)
      continue
    }
    if (await handleBlock(page, res, runDir, emit, signal, pauseForAction, step.kind)) {
      if (signal?.aborted) break
    }
    if (await looksLikeLogin(page)) continue

    res.evidence.push(await capture(page, runDir, `peoplesearch-${step.kind}`))
    const row = await pickAndExtract(page, input, searchName, { res, runDir, emit, signal, pauseForAction })
    if (row && (row.name || row.phones.length || row.relatives?.length)) results.push({ kind: step.kind, rows: [row] })
  }

  res.data = { results }
  res.ok = true

  // Diagnostic summary so we can see exactly what was extracted.
  const rows = results.flatMap((r) => r.rows || [])
  const nPhones = rows.reduce((a, r) => a + (r.phones || []).length, 0)
  const nRels = rows.reduce((a, r) => a + (r.relatives || []).length, 0)
  const relPhone = rows.find((r) => r.bestRelative?.phones?.length)?.bestRelative
  emit({
    type: 'log',
    source: label,
    message: `Extracted: ${rows.length} match(es), ${nPhones} phone(s), ${nRels} relative(s)` +
      (relPhone ? `, best relative ${relPhone.name} ${relPhone.phones[0]}` : ''),
  })

  if (!results.length) res.notes.push('People search ran but nothing matched (blocked or no results). Clues only.')
  return res
}

// Gather all result cards, pick the one whose address matches the lead (else the
// first), open its detail page, and pull the phone numbers.
async function pickAndExtract(page, input, searchName, ctx) {
  const { res, runDir, emit, signal, pauseForAction } = ctx
  const cards = await readCards(page)

  // No result cards? We may already be on a person page — read it directly.
  if (!cards.length) {
    const phones = await phonesOnPage(page)
    const name = await headingName(page)
    if (!name && !phones.length) return null
    const row = { name, addresses: [], phones, matched: false }
    await attachRelatives(page, row, name || searchName, ctx)
    return row
  }

  const wanted = addressTokens(input)
  let best = cards.find((c) => tokensMatch(c.text, wanted))
  const matched = Boolean(best)
  if (!best) best = cards[0]

  const name = parseName(best.text)
  emit({ type: 'log', source: label, message: `${matched ? 'Address-matched' : 'Top'} result: ${name || '(unknown)'} — opening profile` })

  // Navigate straight to the person's profile (more reliable than clicking).
  try {
    if (best.href) {
      await goto(page, new URL(best.href, page.url()).href, { signal })
      await handleBlock(page, res, runDir, emit, signal, pauseForAction, 'detail')
      res.evidence.push(await capture(page, runDir, 'peoplesearch-detail'))
    }
  } catch {
    /* stay on results */
  }

  const phones = await phonesOnPage(page)
  const row = { name, addresses: parseAddresses(best.text), phones, matched }
  await attachRelatives(page, row, name || searchName, ctx)
  return row
}

// From the owner's detail page, collect Possible Relatives, pick the best
// same-surname one, open their page, and grab a valid phone. All UNVERIFIED
// clues — contacting a relative needs separate authorization (SOP).
async function attachRelatives(page, row, ownerName, ctx) {
  const { res, runDir, emit, signal, pauseForAction } = ctx
  try {
    const relatives = await extractRelatives(page)
    if (!relatives.length) return
    row.relatives = relatives.map((r) => r.name)

    const lastName = String(ownerName || '').trim().split(/\s+/).pop()?.toLowerCase() || ''
    let best = (lastName && relatives.find((r) => r.name.toLowerCase().split(/\s+/).includes(lastName))) || relatives[0]
    if (!best?.href) return

    emit({ type: 'log', source: label, message: `Checking possible relative for a phone: ${best.name}` })
    const url = new URL(best.href, page.url()).href
    await goto(page, url, { signal })
    await handleBlock(page, res, runDir, emit, signal, pauseForAction, 'relative')
    res.evidence.push(await capture(page, runDir, 'peoplesearch-relative'))
    const phones = await phonesOnPage(page)
    row.bestRelative = { name: best.name, phones, note: 'Possible relative (UNVERIFIED — aggregator label). Contacting requires separate authorization.' }
  } catch {
    /* relatives are a bonus; ignore failures */
  }
}

// Collect the possible relatives. TruePeopleSearch wraps them in
// #toc-relatives (associates are in #toc-associates), so scope to that exactly.
// Falls back to the "Possible Relatives"→"Possible Associates" heading range.
async function extractRelatives(page) {
  try {
    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const validName = (n) => n && /^[A-Za-z][A-Za-z .'-]{2,}$/.test(n)

      // Primary: the exact relatives container.
      const container = document.querySelector('#toc-relatives')
      if (container) {
        const out = []
        container.querySelectorAll('a[href*="/find/person/"]').forEach((a) => {
          const name = clean(a.textContent)
          if (validName(name) && !out.some((o) => o.name === name)) out.push({ name, href: a.getAttribute('href') })
        })
        return out.slice(0, 20)
      }

      // Fallback: between the two headings by document order.
      const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING
      let relHead = null
      let assocHead = null
      for (const n of Array.from(document.querySelectorAll('*'))) {
        const t = clean(n.textContent)
        if (t.length > 40) continue
        if (!relHead && /possible relatives/i.test(t)) relHead = n
        else if (!assocHead && /possible associates/i.test(t)) assocHead = n
      }
      const out = []
      for (const a of Array.from(document.querySelectorAll('a[href*="/find/person/"]'))) {
        const name = clean(a.textContent)
        if (!validName(name)) continue
        if (relHead) {
          const afterRel = relHead.compareDocumentPosition(a) & FOLLOWING
          const beforeAssoc = !assocHead || a.compareDocumentPosition(assocHead) & FOLLOWING
          if (!(afterRel && beforeAssoc)) continue
        }
        if (!out.some((o) => o.name === name)) out.push({ name, href: a.getAttribute('href') })
      }
      return out.slice(0, 20)
    })
  } catch {
    return []
  }
}

/* ---------- page helpers ---------- */

// Read each result card via its person-profile link (which always exists), with
// the surrounding card's text and the profile href to navigate to.
async function readCards(page) {
  try {
    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const seen = new Set()
      const out = []
      const distinctPeople = (node) =>
        new Set(Array.from(node.querySelectorAll('a[href*="/find/person/"]')).map((x) => x.getAttribute('href'))).size
      document.querySelectorAll('a[href*="/find/person/"]').forEach((a) => {
        const href = a.getAttribute('href')
        if (!href || seen.has(href)) return
        seen.add(href)
        // Climb to the card, but never into a parent that merges several people.
        let el = a
        for (let k = 0; k < 6 && el.parentElement; k++) {
          if (distinctPeople(el.parentElement) > 1) break
          el = el.parentElement
          if (clean(el.textContent).length >= 40) break
        }
        out.push({ href, text: clean(el.textContent).slice(0, 400) })
      })
      return out.slice(0, 25)
    })
  } catch {
    return []
  }
}

async function phonesOnPage(page) {
  try {
    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const RE = /\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}/
      const digits = (s) => String(s).replace(/\D/g, '')

      // All phone-shaped numbers on the page, in order.
      let all = [...new Set(((document.body.innerText || '').match(new RegExp(RE.source, 'g')) || []).map(clean))]

      // Find the number TruePeopleSearch marks as the primary / most recent.
      let primary = ''
      for (const n of Array.from(document.querySelectorAll('*'))) {
        if (/possible primary phone|primary phone/i.test(n.textContent || '')) {
          const around = clean((n.closest('div') || n.parentElement || n).textContent)
          const m = around.match(RE)
          if (m) { primary = clean(m[0]); break }
        }
      }
      if (primary) all = [primary, ...all.filter((p) => digits(p) !== digits(primary))]
      return all.slice(0, 10)
    })
  } catch {
    return []
  }
}

async function headingName(page) {
  try {
    const h = page.locator('h1, h2').first()
    return (await h.count()) ? ((await h.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  } catch {
    return ''
  }
}

// Detect + clear a Cloudflare / CAPTCHA block. Returns true if it paused.
async function handleBlock(page, res, runDir, emit, signal, pauseForAction, tag) {
  if (!(await isBlocked(page))) return false
  res.evidence.push(await capture(page, runDir, `peoplesearch-${tag}-blocked`))
  if (typeof pauseForAction === 'function' && !signal?.aborted) {
    emit({ type: 'log', source: label, message: 'TruePeopleSearch is asking to verify you are human' })
    await pauseForAction('TruePeopleSearch is showing a "verify you\'re human" check. Solve it in the BROWSER window, then click Resume.')
  }
  return true
}

async function isBlocked(page) {
  try {
    // Text cues (Cloudflare / hCaptcha / reCAPTCHA / "press & hold").
    const t = ((await page.title().catch(() => '')) + ' ' + (await page.locator('body').innerText().catch(() => ''))).toLowerCase().slice(0, 4000)
    if (/captcha|verify (?:you|that you)(?:'re| are)? (?:a )?human|are you a human|unusual traffic|checking your browser|just a moment|attention required|access denied|press ?& ?hold|please verify|review the security of your connection|verifying you are human/i.test(t)) {
      return true
    }
    // Structural cues: a challenge iframe or widget even without matching text.
    const widget = await page
      .locator('iframe[src*="captcha" i], iframe[src*="hcaptcha" i], iframe[src*="recaptcha" i], iframe[title*="captcha" i], #cf-challenge-running, .cf-challenge, [class*="captcha" i], [id*="challenge" i]')
      .count()
      .catch(() => 0)
    return widget > 0
  } catch {
    return false
  }
}

/* ---------- text parsing ---------- */

function hasAnyUrl(cfg) {
  return Boolean(cfg.searchUrlForAddress || cfg.searchUrlForName || cfg.searchUrlForPhone || cfg.searchUrlForEmail)
}
function splitAddress(a) {
  const parts = String(a || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return { street: '', citystatezip: '' }
  return { street: parts[0], citystatezip: parts.slice(1).join(', ') }
}
const onlyDigits = (s) => String(s || '').replace(/\D/g, '')

// Tokens that identify the lead's address: street name, city, ZIP.
function addressTokens(input) {
  const out = []
  const parts = String(input.address || '').split(',').map((s) => s.trim())
  const streetName = (parts[0] || '')
    .replace(/^\d+\s*/, '')
    .replace(/\b(dr|drive|st|street|ave|avenue|rd|road|ln|lane|ct|court|blvd|way|cir|circle|pl|place|ter|terrace)\b\.?/gi, '')
    .trim()
  const city = parts[1] || ''
  const zip = (String(input.address || '').match(/\b\d{5}\b/) || [])[0]
  if (streetName) out.push(streetName.toLowerCase())
  if (city) out.push(city.toLowerCase())
  if (zip) out.push(zip)
  return out.filter((t) => t && t.length > 2)
}
function tokensMatch(text, tokens) {
  const t = String(text || '').toLowerCase()
  return tokens.some((tok) => t.includes(tok))
}
function parseName(cardText) {
  // Name is the text before "Age", the bullet, or "Used to live".
  return String(cardText || '').split(/\s+age\b|•|used to live|related to/i)[0].replace(/\s+/g, ' ').trim().slice(0, 80)
}
function parseAddresses(cardText) {
  const m = String(cardText || '').match(/used to live in ([^]*?)(?:related to|view details|$)/i)
  if (!m) return []
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)
}
