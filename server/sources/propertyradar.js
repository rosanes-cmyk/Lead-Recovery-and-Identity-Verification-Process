// PropertyRadar — recorded owner, vesting, ownership type, owner mailing
// address, property address, occupancy, APN, phones, emails, trust/entity.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto } from './base.js'
import { selectors, fillUrl } from './selectors.js'
import { extractFields, FIELD_NOT_FOUND } from './extract.js'

export const id = 'propertyradar'
export const label = 'PropertyRadar'
export const loginGated = true

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  res.audit = []
  const cfg = selectors.propertyradar

  if (!input.address) {
    res.notes.push('No property address available; PropertyRadar needs an address.')
    return res
  }

  const url = fillUrl(cfg.searchUrlForAddress, { address: input.address }) || cfg.loginUrl
  try {
    emit({ type: 'log', source: label, message: `Confirming ownership for ${input.address}` })
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

  if (!cfg.searchUrlForAddress && cfg.searchBox) {
    try {
      await page.fill(cfg.searchBox, input.address, { timeout: 4000 })
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2500)
    } catch {
      /* screenshot only */
    }
  }

  res.evidence.push(await capture(page, runDir, 'propertyradar-result'))
  const { values, audit } = await extractFields(page, cfg.fields, { listFields: ['phones', 'emails'], semantics: { phones: 'phone', emails: 'email' } })
  audit.forEach((a) => res.audit.push({ page: 'Property', ...a }))
  emit({ type: 'log', source: label, message: `Fields: ${audit.filter((a) => a.ok).length}/${audit.length} found` })

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
  res.ok = values.recordedOwner && values.recordedOwner !== FIELD_NOT_FOUND
  if (!res.ok) res.notes.push('Recorded owner not found. Run `npm run calibrate propertyradar <url>` to capture selectors.')
  return res
}
