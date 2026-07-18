// Approved People Search (TruePeopleSearch, Cherry-Hombre approved).
//
// Guardrails baked in:
//  - Results are CLUES, never verified ownership; cross-checked elsewhere.
//  - "Possible relatives" are captured only as unverified clues. No one is
//    labeled a relative here; that requires a lawful record.
//  - Read-only. Disabled unless PEOPLE_SEARCH_ENABLED=true.
//
// TruePeopleSearch blocks bots hard (Cloudflare / "verify you're human"). When
// that check appears, the app pauses so the operator can solve it, then reads
// the results.

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
    res.notes.push('People search is DISABLED (PEOPLE_SEARCH_ENABLED=false). Enable it only with Cherry Hombre approval.')
    res.ok = true // intentional skip
    return res
  }
  if (!cfg.name || !hasAnyUrl(cfg)) {
    res.notes.push('People search enabled but no provider configured in selectors.js.')
    return res
  }

  const { street, citystatezip } = splitAddress(input.address)
  const ownerName = data?.ownership?.recordedOwner || input.name

  // SOP search sequence: address -> owner name -> phone.
  const steps = [
    cfg.searchUrlForAddress && street ? { kind: 'address', url: fillUrl(cfg.searchUrlForAddress, { street, citystatezip }) } : null,
    cfg.searchUrlForName && ownerName ? { kind: 'name', url: fillUrl(cfg.searchUrlForName, { name: ownerName, citystatezip }) } : null,
    cfg.searchUrlForPhone && input.phone ? { kind: 'phone', url: fillUrl(cfg.searchUrlForPhone, { phone: onlyDigits(input.phone) }) } : null,
  ].filter(Boolean)

  if (!steps.length) {
    res.notes.push('Nothing to search (no address, name, or phone).')
    res.ok = true
    return res
  }

  const results = []
  for (const step of steps) {
    if (signal?.aborted) break
    emit({ type: 'log', source: `${label}`, message: `TruePeopleSearch by ${step.kind}` })
    try {
      await goto(page, step.url, { signal })
    } catch (err) {
      res.notes.push(`People search (${step.kind}) failed to open: ${String(err)}`)
      continue
    }

    // Human-verification / block? Pause so the operator can clear it.
    if (await isBlocked(page)) {
      res.evidence.push(await capture(page, runDir, `peoplesearch-${step.kind}-blocked`))
      if (typeof pauseForAction === 'function' && !signal?.aborted) {
        emit({ type: 'log', source: label, message: 'TruePeopleSearch is asking to verify you are human' })
        await pauseForAction('TruePeopleSearch is showing a "verify you\'re human" check. Solve it in the BROWSER window, then click Resume.')
      }
      if (signal?.aborted) break
    }
    if (await looksLikeLogin(page)) continue

    res.evidence.push(await capture(page, runDir, `peoplesearch-${step.kind}`))
    const rows = await extractRows(page, cfg.result)

    // Phone numbers live on the person's DETAIL page, not the results list.
    // For address/name searches, open the top match and pull its numbers.
    if (rows.length && step.kind !== 'phone' && !(rows[0].phones || []).length) {
      const phones = await getDetailPhones(page, { runDir, res, emit, signal, pauseForAction })
      if (phones.length) rows[0] = { ...rows[0], phones: [...new Set([...(rows[0].phones || []), ...phones])] }
    }
    if (rows.length) results.push({ kind: step.kind, rows })
  }

  res.data = { results }
  res.ok = true // running it (even with 0 rows) is a valid outcome
  if (!results.some((r) => r.rows.length)) res.notes.push('People search ran but no rows were parsed (blocked or no match) — review the screenshots. Clues only.')
  return res
}

// Open the top result's detail page and pull its phone numbers (which don't
// appear on the results list). Handles a human-verification prompt on the way.
async function getDetailPhones(page, { runDir, res, emit, signal, pauseForAction }) {
  try {
    const link = page.locator('a[href*="/find/person/"]').first()
    if ((await link.count()) === 0) return []
    emit({ type: 'log', source: label, message: 'Opening top result for phone numbers' })
    await link.click({ timeout: 4000 })
    await page.waitForTimeout(1500)
    await settle(page)
    if (await isBlocked(page)) {
      res.evidence.push(await capture(page, runDir, 'peoplesearch-detail-blocked'))
      if (typeof pauseForAction === 'function' && !signal?.aborted) {
        await pauseForAction('TruePeopleSearch is showing a "verify you\'re human" check. Solve it in the BROWSER window, then click Resume.')
      }
    }
    res.evidence.push(await capture(page, runDir, 'peoplesearch-detail'))
    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const tel = Array.from(document.querySelectorAll('a[href^="tel:"]')).map((a) => clean(a.textContent)).filter(Boolean)
      if (tel.length) return [...new Set(tel)]
      const m = (document.body.innerText || '').match(/\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}/g) || []
      return [...new Set(m.map(clean))]
    })
  } catch {
    return []
  }
}

function hasAnyUrl(cfg) {
  return Boolean(cfg.searchUrlForAddress || cfg.searchUrlForName || cfg.searchUrlForPhone || cfg.searchUrlForEmail)
}

// "97 Manchester Dr, Fairfield, CA 94533" -> { street, citystatezip }
function splitAddress(a) {
  const parts = String(a || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return { street: '', citystatezip: '' }
  return { street: parts[0], citystatezip: parts.slice(1).join(', ') }
}
const onlyDigits = (s) => String(s || '').replace(/\D/g, '')

// Detect a Cloudflare / CAPTCHA / bot block.
async function isBlocked(page) {
  try {
    const t = ((await page.title().catch(() => '')) + ' ' + (await page.locator('body').innerText().catch(() => ''))).toLowerCase().slice(0, 3000)
    return /captcha|verify (?:you|that you)(?:'re| are)? (?:a )?human|are you a human|unusual traffic|checking your browser|attention required|access denied|press ?& ?hold|please verify/i.test(t)
  } catch {
    return false
  }
}

async function extractRows(page, r) {
  if (!r || !r.row) return []
  try {
    return await page.evaluate((sel) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const rows = []
      document.querySelectorAll(sel.row).forEach((el) => {
        const pick = (s) => {
          if (!s) return ''
          const n = el.querySelector(s)
          return n ? clean(n.textContent) : ''
        }
        const pickAll = (s) => (s ? Array.from(el.querySelectorAll(s)).map((n) => clean(n.textContent)).filter(Boolean) : [])
        // Phones: prefer tel: links; else phone-shaped text in the card.
        let phones = Array.from(el.querySelectorAll('a[href^="tel:"]')).map((a) => clean(a.textContent))
        if (!phones.length) phones = (clean(el.textContent).match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [])
        rows.push({
          name: pick(sel.name),
          addresses: pickAll(sel.addresses),
          phones: [...new Set(phones)],
          possibleRelatives: pickAll(sel.possibleRelatives),
        })
      })
      return rows.filter((x) => x.name || x.phones.length).slice(0, 15)
    }, r)
  } catch {
    return []
  }
}
