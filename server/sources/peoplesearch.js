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
    const row = await pickAndExtract(page, input, { res, runDir, emit, signal, pauseForAction })
    if (row && (row.name || row.phones.length)) results.push({ kind: step.kind, rows: [row] })
  }

  res.data = { results }
  res.ok = true
  if (!results.length) res.notes.push('People search ran but nothing matched (blocked or no results). Clues only.')
  return res
}

// Gather all result cards, pick the one whose address matches the lead (else the
// first), open its detail page, and pull the phone numbers.
async function pickAndExtract(page, input, { res, runDir, emit, signal, pauseForAction }) {
  const cards = await readCards(page)

  // No result cards? Might be a direct person page (reverse phone). Read it.
  if (!cards.length) {
    const phones = await phonesOnPage(page)
    const name = await headingName(page)
    return name || phones.length ? { name, addresses: [], phones, matched: false } : null
  }

  const wanted = addressTokens(input)
  let best = cards.find((c) => tokensMatch(c.text, wanted))
  const matched = Boolean(best)
  if (!best) best = cards[0]

  const name = parseName(best.text)
  emit({ type: 'log', source: label, message: `${matched ? 'Address-matched' : 'Top'} result: ${name || '(unknown)'} — opening View Details` })

  // Click that specific card's "View Details".
  try {
    const link = page.locator('a:has-text("View Details"), a[href*="/find/person/"]').nth(best.index)
    if ((await link.count()) > 0) {
      await link.click({ timeout: 4000 })
      await page.waitForTimeout(1500)
      await settle(page)
      await handleBlock(page, res, runDir, emit, signal, pauseForAction, 'detail')
      res.evidence.push(await capture(page, runDir, 'peoplesearch-detail'))
    }
  } catch {
    /* stay on results; still return the card's summary */
  }

  const phones = await phonesOnPage(page)
  return { name, addresses: parseAddresses(best.text), phones, matched }
}

/* ---------- page helpers ---------- */

// Read each result card: its index (matching the "View Details" link order) and
// its visible text.
async function readCards(page) {
  try {
    return await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).filter((a) => /view details/i.test(a.textContent || ''))
      return links.map((a, index) => {
        let el = a
        for (let k = 0; k < 6 && el.parentElement; k++) {
          el = el.parentElement
          if ((el.textContent || '').replace(/\s+/g, ' ').trim().length > 60) break
        }
        return { index, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400) }
      })
    })
  } catch {
    return []
  }
}

async function phonesOnPage(page) {
  try {
    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const tel = Array.from(document.querySelectorAll('a[href^="tel:"]')).map((a) => clean(a.textContent)).filter(Boolean)
      if (tel.length) return [...new Set(tel)]
      const m = (document.body.innerText || '').match(/\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}/g) || []
      return [...new Set(m.map(clean))].slice(0, 10)
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
