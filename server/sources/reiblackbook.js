// REI BlackBook — the CRM. Read-only. Opens the property/lead record AND the
// attached contact record (communication history usually lives on the contact),
// extracting every required field via the selector engine. Never writes.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto } from './base.js'
import { selectors } from './selectors.js'
import { extractFields, FIELD_NOT_FOUND } from './extract.js'
import { resolveField } from './resolve.js'

export const id = 'reiblackbook'
export const label = 'REI BlackBook'
export const loginGated = true

const LIST_FIELDS = ['phones', 'emails']
const SEMANTICS = { phones: 'phone', emails: 'email' }

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  res.audit = []
  const cfg = selectors.reiblackbook

  const target = input.reiLink || cfg.loginUrl
  if (!target) {
    res.notes.push('No REI BlackBook lead link provided; skipping CRM review.')
    return res
  }

  try {
    emit({ type: 'log', source: label, message: `Opening lead: ${target}` })
    await goto(page, target, { signal })
  } catch (err) {
    res.notes.push(`Could not open REI BlackBook: ${String(err)}`)
    res.evidence.push(await capture(page, runDir, 'reibb-error'))
    return res
  }

  if (await looksLikeLogin(page, { hostHint: 'reiblackbook' })) {
    res.loginRequired = true
    res.evidence.push(await capture(page, runDir, 'reibb-login'))
    return res
  }

  // --- Property / lead record ---
  res.evidence.push(await capture(page, runDir, 'reibb-lead'))
  const lead = await extractFields(page, cfg.fields, { listFields: LIST_FIELDS, semantics: SEMANTICS })
  lead.audit.forEach((a) => res.audit.push({ page: 'Property/Lead', ...a }))
  emit({ type: 'log', source: label, message: `Lead fields: ${summarize(lead.audit)}` })

  const data = { ...lead.values }

  // --- Attached contact record ---
  try {
    const contactHref = await resolveField(page, cfg.contactLink)
    if (contactHref.ok) {
      const url = new URL(contactHref.value, page.url()).href
      emit({ type: 'log', source: label, message: `Opening attached contact: ${url}` })
      await goto(page, url, { signal })
      if (await looksLikeLogin(page)) {
        res.loginRequired = true
        res.evidence.push(await capture(page, runDir, 'reibb-contact-login'))
        return res
      }
      res.evidence.push(await capture(page, runDir, 'reibb-contact'))
      const contact = await extractFields(page, cfg.fields, { listFields: LIST_FIELDS, semantics: SEMANTICS })
      contact.audit.forEach((a) => res.audit.push({ page: 'Contact', ...a }))
      mergeContact(data, contact.values)
    } else {
      res.notes.push('No attached contact record link found on the lead. Communication history may be missing — review the lead page manually.')
    }
  } catch (err) {
    res.notes.push(`Contact record step failed: ${String(err)}`)
  }

  res.data = data
  res.ok = Object.values(data).some((v) => v && v !== FIELD_NOT_FOUND && !(Array.isArray(v) && v.length === 0))
  if (!res.ok) {
    res.notes.push('No fields extracted. Run `npm run calibrate reiblackbook <lead-url>` to capture the page structure and add stable selectors.')
  }
  return res
}

// Prefer non-empty values; union phone/email lists across both records.
function mergeContact(base, contact) {
  for (const [k, v] of Object.entries(contact)) {
    if (Array.isArray(v)) {
      const merged = new Set([...(Array.isArray(base[k]) ? base[k] : []), ...v])
      base[k] = [...merged]
    } else if ((!base[k] || base[k] === FIELD_NOT_FOUND) && v && v !== FIELD_NOT_FOUND) {
      base[k] = v
    }
  }
}

function summarize(audit) {
  const found = audit.filter((a) => a.ok).length
  return `${found}/${audit.length} found`
}
