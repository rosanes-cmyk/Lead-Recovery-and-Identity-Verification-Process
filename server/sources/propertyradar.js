// PropertyRadar — recorded owner, vesting, ownership type, owner mailing
// address, property address, occupancy, APN, phones, emails, trust/entity.
//
// Fully automatic where possible: after the operator is logged in (a one-time
// sign-in, remembered in the browser profile), the app finds the search box,
// types the address, opens the first result, and extracts. It only falls back
// to asking the operator if it can't drive the search itself.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto, settle } from './base.js'
import { selectors, fillUrl } from './selectors.js'
import { extractFields, FIELD_NOT_FOUND } from './extract.js'

export const id = 'propertyradar'
export const label = 'PropertyRadar'
export const loginGated = true

export async function run(ctx) {
  const { page, input, emit, runDir, signal, pauseForAction } = ctx
  const res = emptyResult(label)
  res.audit = []
  const cfg = selectors.propertyradar

  const directUrl = fillUrl(cfg.searchUrlForAddress, { address: input.address })
  try {
    emit({ type: 'log', source: label, message: `Opening PropertyRadar${input.address ? ' for ' + input.address : ''}` })
    await goto(page, directUrl || cfg.loginUrl, { signal })
  } catch (err) {
    res.notes.push(`Could not open PropertyRadar: ${String(err)}`)
    res.evidence.push(await capture(page, runDir, 'propertyradar-error'))
    return res
  }

  if (await looksLikeLogin(page)) {
    res.loginRequired = true
    res.evidence.push(await capture(page, runDir, 'propertyradar-login'))
    return res // orchestrator pauses for one-time login, then retries this source
  }

  // Try to run the search automatically.
  let searched = false
  if (!directUrl && input.address) {
    searched = await autoSearch(page, input.address, cfg, emit, signal)
  }

  let out = await extractAndBuild(page, cfg, res, runDir)

  // If automatic search didn't land on a property (no owner found), ask the
  // operator once to open it, then read the page — so a run never dead-ends.
  if (!out.ok && typeof pauseForAction === 'function' && !signal?.aborted) {
    emit({ type: 'log', source: label, message: 'Auto-search did not find the property; asking operator to open it' })
    await pauseForAction(
      `Couldn't open the property automatically. In the PropertyRadar BROWSER window, open the property for ${input.address || 'this lead'}, then click Resume.`,
    )
    if (!signal?.aborted) out = await extractAndBuild(page, cfg, res, runDir)
  }

  if (!out.ok) res.notes.push('Recorded owner not found. Run `npm run calibrate -- propertyradar <property-url>` so I can pin the search box + fields for full automation.')
  return res
}

// Find PropertyRadar's search box, type the address, submit, open first result.
async function autoSearch(page, address, cfg, emit, signal) {
  const boxSelectors = [
    cfg.searchBox,
    'input[type="search"]',
    'input[placeholder*="address" i]',
    'input[placeholder*="search" i]',
    'input[aria-label*="search" i]',
    'input[name*="search" i]',
  ].filter(Boolean)

  for (const sel of boxSelectors) {
    if (signal?.aborted) return false
    try {
      const box = page.locator(sel).first()
      if ((await box.count()) === 0) continue
      emit({ type: 'log', source: label, message: `Searching PropertyRadar for ${address}` })
      await box.click({ timeout: 2500 })
      await box.fill(address, { timeout: 3000 })
      await page.keyboard.press('Enter')
      await settle(page)
      await openFirstResult(page, cfg, signal)
      return true
    } catch {
      /* try next selector */
    }
  }
  return false
}

async function openFirstResult(page, cfg, signal) {
  const resultSelectors = [
    cfg.resultRow,
    '[data-testid*="result"]',
    'a[href*="propertyKey"]',
    'a[href*="property"]',
    '[role="row"]',
    'table tbody tr',
    '.search-result, .result-row, .list-item',
  ].filter(Boolean)
  for (const sel of resultSelectors) {
    if (signal?.aborted) return
    try {
      const row = page.locator(sel).first()
      if ((await row.count()) === 0) continue
      await row.click({ timeout: 2500 })
      await settle(page)
      return
    } catch {
      /* try next */
    }
  }
}

async function extractAndBuild(page, cfg, res, runDir) {
  res.evidence.push(await capture(page, runDir, 'propertyradar-result'))
  const { values, audit } = await extractFields(page, cfg.fields, { listFields: ['phones', 'emails'], semantics: { phones: 'phone', emails: 'email' } })
  res.audit.push(...audit.map((a) => ({ page: 'Property', ...a })))
  res.data = {
    ownerName: values.recordedOwner,
    ownershipType: values.ownershipType,
    vesting: values.vesting,
    mailingAddress: values.ownerMailingAddress,
    propertyAddress: values.propertyAddress,
    occupancy: values.occupancy,
    apn: values.apn,
    phones: values.phones,
    emails: values.emails,
    trustEntity: values.trustEntity,
  }
  res.ok = Boolean(values.recordedOwner && values.recordedOwner !== FIELD_NOT_FOUND)
  return res
}
