// DealMachine — cross-checks owner, mailing address, property, contacts,
// occupancy, and property details.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto } from './base.js'
import { selectors, fillUrl } from './selectors.js'
import { extractFields, FIELD_NOT_FOUND } from './extract.js'

export const id = 'dealmachine'
export const label = 'DealMachine'
export const loginGated = true

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  res.audit = []
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
  const { values, audit } = await extractFields(page, cfg.fields, { listFields: ['phones', 'emails'], semantics: { phones: 'phone', emails: 'email' } })
  audit.forEach((a) => res.audit.push({ page: 'Property', ...a }))
  emit({ type: 'log', source: label, message: `Fields: ${audit.filter((a) => a.ok).length}/${audit.length} found` })

  res.data = {
    ownerName: values.ownerName,
    mailingAddress: values.ownerMailingAddress,
    propertyAddress: values.propertyAddress,
    phones: values.phones,
    emails: values.emails,
    occupancy: values.occupancy,
    propertyDetails: values.propertyDetails,
  }
  res.ok = (values.ownerName && values.ownerName !== FIELD_NOT_FOUND) || (values.phones && values.phones.length > 0)
  if (!res.ok) res.notes.push('Owner/contacts not found. Run `npm run calibrate dealmachine <url>` to capture selectors.')
  return res
}
