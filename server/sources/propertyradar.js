// PropertyRadar — confirms ownership, vesting, mailing address, occupancy.
// Treated as a strong ownership source.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, textOf, goto } from './base.js'
import { selectors, fillUrl } from './selectors.js'

export const id = 'propertyradar'
export const label = 'PropertyRadar'
export const loginGated = true

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  const cfg = selectors.propertyradar

  if (!input.address) {
    res.notes.push('No property address available; PropertyRadar needs an address.')
    return res
  }

  const url = fillUrl(cfg.searchUrlForAddress, { address: input.address }) || cfg.loginUrl
  try {
    emit({ type: 'log', source: label, message: `Searching ownership for ${input.address}` })
    await goto(page, url, { signal })
  } catch (err) {
    res.notes.push(`Could not open PropertyRadar: ${String(err)}`)
    res.evidence.push(await capture(page, runDir, 'propertyradar-error'))
    return res
  }

  if (await looksLikeLogin(page)) {
    res.loginRequired = true
    res.evidence.push(await capture(page, runDir, 'propertyradar-login'))
    return res
  }

  // If there's no direct search URL, try the on-page search box.
  if (!cfg.searchUrlForAddress && cfg.searchBox) {
    try {
      await page.fill(cfg.searchBox, input.address, { timeout: 4000 })
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2500)
    } catch {
      /* leave a screenshot; operator can complete the search */
    }
  }

  res.evidence.push(await capture(page, runDir, 'propertyradar-result'))

  const r = cfg.result
  if (Object.values(r).some(Boolean)) {
    res.data = {
      ownerName: await textOf(page, r.ownerName),
      ownershipType: await textOf(page, r.ownershipType),
      vesting: await textOf(page, r.vesting),
      mailingAddress: await textOf(page, r.mailingAddress),
      occupancy: await textOf(page, r.occupancy),
    }
    res.ok = Boolean(res.data.ownerName)
    if (!res.ok) res.notes.push('PropertyRadar page loaded but owner name selector matched nothing.')
  } else {
    res.notes.push(
      'PropertyRadar selectors not configured. Ownership screenshot captured; configure ' +
        'selectors.js result fields to auto-extract owner, vesting, and mailing address.',
    )
    res.ok = true
  }
  return res
}
