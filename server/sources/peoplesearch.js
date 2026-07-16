// Approved People Search — search by address, name, phone, or email.
//
// Guardrails baked in:
//  - Results are CLUES, never verified ownership. They are cross-checked
//    elsewhere against property/official records.
//  - "Possible relatives" are captured only as unverified clues. No one is
//    labeled a spouse/child/sibling/relative here; that requires a lawful
//    record, handled in the scoring/conflict stage.
//
// Only ONE approved provider is used, configured in selectors.js. When it is
// not configured the module explains what to set and captures nothing private.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto } from './base.js'
import { selectors, fillUrl } from './selectors.js'

export const id = 'peoplesearch'
export const label = 'Approved People Search'
export const loginGated = true

export async function run(ctx) {
  const { page, input, data, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  const cfg = selectors.peoplesearch

  if (!cfg.name || !hasAnyUrl(cfg)) {
    res.notes.push(
      'No approved people-search provider configured. Set selectors.js -> peoplesearch ' +
        '(provider name, search URLs, and result selectors) for your company-approved tool. ' +
        'People search is intentionally skipped until an approved tool is set.',
    )
    return res
  }

  // Search sequence per the SOP: address -> owner name -> phone -> email.
  const ownerName = data?.ownership?.recordedOwner || input.name
  const steps = [
    cfg.searchUrlForAddress && input.address
      ? { kind: 'address', url: fillUrl(cfg.searchUrlForAddress, { address: input.address }) }
      : null,
    cfg.searchUrlForName && ownerName
      ? {
          kind: 'name',
          url: fillUrl(cfg.searchUrlForName, {
            name: ownerName,
            city: input.city || '',
            state: input.state || '',
          }),
        }
      : null,
    cfg.searchUrlForPhone && input.phone
      ? { kind: 'phone', url: fillUrl(cfg.searchUrlForPhone, { phone: input.phone }) }
      : null,
    cfg.searchUrlForEmail && input.email
      ? { kind: 'email', url: fillUrl(cfg.searchUrlForEmail, { email: input.email }) }
      : null,
  ].filter(Boolean)

  const results = []
  for (const step of steps) {
    if (signal?.aborted) break
    emit({ type: 'log', source: label, message: `People search by ${step.kind}` })
    try {
      await goto(page, step.url, { signal })
    } catch (err) {
      res.notes.push(`People search (${step.kind}) failed to open: ${String(err)}`)
      continue
    }
    if (await looksLikeLogin(page)) {
      res.loginRequired = true
      res.evidence.push(await capture(page, runDir, `peoplesearch-login`))
      return res
    }
    res.evidence.push(await capture(page, runDir, `peoplesearch-${step.kind}`))
    const rows = await extractRows(page, cfg.result)
    results.push({ kind: step.kind, rows })
  }

  res.data = { results }
  res.ok = results.some((r) => r.rows.length > 0)
  if (!res.ok)
    res.notes.push('People search ran but no rows were parsed; review the captured screenshots.')
  return res
}

function hasAnyUrl(cfg) {
  return Boolean(
    cfg.searchUrlForAddress ||
      cfg.searchUrlForName ||
      cfg.searchUrlForPhone ||
      cfg.searchUrlForEmail,
  )
}

async function extractRows(page, r) {
  if (!r || !r.row) return []
  try {
    return await page.evaluate((sel) => {
      const rows = []
      document.querySelectorAll(sel.row).forEach((el) => {
        const pick = (s) => {
          if (!s) return ''
          const n = el.querySelector(s)
          return n ? n.textContent.trim() : ''
        }
        const pickAll = (s) => {
          if (!s) return []
          return Array.from(el.querySelectorAll(s)).map((n) => n.textContent.trim()).filter(Boolean)
        }
        rows.push({
          name: pick(sel.name),
          addresses: pickAll(sel.addresses),
          phones: pickAll(sel.phones),
          // labeled explicitly as UNVERIFIED clues
          possibleRelatives: pickAll(sel.possibleRelatives),
        })
      })
      return rows.slice(0, 15)
    }, r)
  } catch {
    return []
  }
}
