// PropertyRadar — recorded owner, vesting, ownership type, owner mailing
// address, property address, occupancy, APN, phones, emails, trust/entity.
//
// Assisted mode: PropertyRadar is a logged-in app with no stable address-search
// URL, so the app opens it and asks the operator to bring up the property, then
// reads whatever property page is on screen. This is reliable without hardcoding
// site internals. If a searchUrlForAddress is later configured, it's used and
// the assisted pause is skipped.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto } from './base.js'
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
    return res
  }

  // Assisted: unless we navigated straight to a result, let the operator bring
  // up the property, then read the page they land on.
  if (!directUrl && typeof pauseForAction === 'function') {
    emit({ type: 'log', source: label, message: 'Waiting for operator to open the property in PropertyRadar' })
    await pauseForAction(
      `In the PropertyRadar BROWSER window (not the black command window), search for ${input.address || 'the property'} and open its property page, then click Resume.`,
    )
    if (signal?.aborted) return res
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
  if (!res.ok) res.notes.push('Recorded owner not found on the page shown. Make sure the property page was open before Resume, or run `npm run calibrate -- propertyradar <url>` to capture selectors.')
  return res
}
