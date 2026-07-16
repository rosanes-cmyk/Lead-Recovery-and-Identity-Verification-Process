// DealMachine — cross-checks ownership, property info, and available contact
// information. Used to corroborate PropertyRadar / county, not as sole proof.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, textOf, goto } from './base.js'
import { selectors, fillUrl } from './selectors.js'

export const id = 'dealmachine'
export const label = 'DealMachine'
export const loginGated = true

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  const cfg = selectors.dealmachine

  if (!input.address) {
    res.notes.push('No property address available; DealMachine needs an address.')
    return res
  }

  const url = fillUrl(cfg.searchUrlForAddress, { address: input.address }) || cfg.loginUrl
  try {
    emit({ type: 'log', source: label, message: `Cross-checking ${input.address}` })
    await goto(page, url, { signal })
  } catch (err) {
    res.notes.push(`Could not open DealMachine: ${String(err)}`)
    res.evidence.push(await capture(page, runDir, 'dealmachine-error'))
    return res
  }

  if (await looksLikeLogin(page)) {
    res.loginRequired = true
    res.evidence.push(await capture(page, runDir, 'dealmachine-login'))
    return res
  }

  if (!cfg.searchUrlForAddress && cfg.searchBox) {
    try {
      await page.fill(cfg.searchBox, input.address, { timeout: 4000 })
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2500)
    } catch {
      /* screenshot only */
    }
  }

  res.evidence.push(await capture(page, runDir, 'dealmachine-result'))

  const r = cfg.result
  if (Object.values(r).some(Boolean)) {
    res.data = {
      ownerName: await textOf(page, r.ownerName),
      mailingAddress: await textOf(page, r.mailingAddress),
      phones: await textOf(page, r.phones),
      emails: await textOf(page, r.emails),
    }
    res.ok = Boolean(res.data.ownerName || res.data.phones)
  } else {
    res.notes.push('DealMachine selectors not configured. Screenshot captured for review.')
    res.ok = true
  }
  return res
}
