// REI BlackBook — the CRM where the lead lives. Read-only in the first version:
// it reviews the lead + contact activity. Saving notes / changing status /
// reassigning are handled elsewhere and gated behind explicit approval.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, textOf, goto } from './base.js'
import { selectors } from './selectors.js'

export const id = 'reiblackbook'
export const label = 'REI BlackBook'
export const loginGated = true

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  const cfg = selectors.reiblackbook

  const target = input.reiLink || cfg.loginUrl
  if (!target) {
    res.notes.push('No REI BlackBook lead link provided; skipping CRM review.')
    return res
  }

  try {
    emit({ type: 'log', source: label, message: `Opening ${target}` })
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

  res.evidence.push(await capture(page, runDir, 'reibb-lead'))

  const s = cfg.lead
  const data = {}
  const configured = Object.values(s).some(Boolean)
  if (configured) {
    data.sellerName = await textOf(page, s.sellerName)
    data.propertyAddress = await textOf(page, s.propertyAddress)
    data.mailingAddress = await textOf(page, s.mailingAddress)
    data.lastActivity = await textOf(page, s.lastActivity)
    data.lastDisposition = await textOf(page, s.lastDisposition)
    data.assignedTeamMember = await textOf(page, s.assignedTeamMember)
    data.leadStage = await textOf(page, s.leadStage)
    data.notes = await textOf(page, s.notes)
    data.phones = await collectAll(page, s.phones)
    data.emails = await collectAll(page, s.emails)
    res.ok = true
  } else {
    res.notes.push(
      'REI BlackBook selectors are not configured yet, so lead fields were not ' +
        'auto-extracted. A screenshot of the lead was captured as evidence. ' +
        'Configure server/sources/selectors.js against your real lead page to enable extraction.',
    )
    res.ok = true
  }

  res.data = data
  return res
}

async function collectAll(page, selector) {
  if (!selector) return []
  try {
    const els = page.locator(selector)
    const n = await els.count()
    const out = []
    for (let i = 0; i < Math.min(n, 20); i++) {
      const t = ((await els.nth(i).innerText().catch(() => '')) || '').trim()
      if (t) out.push(t)
    }
    return out
  } catch {
    return []
  }
}
