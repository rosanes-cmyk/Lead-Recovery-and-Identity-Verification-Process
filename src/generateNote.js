// Builds the plain-text Lead Recovery Investigation note for pasting into
// REI BlackBook. Mirrors docs/investigation-note-template.md.

import { IN_PROGRESS_STATUS } from './model.js'

const yn = (v) => (v ? 'Yes' : 'No')
const or = (v, fallback = '') => (v && String(v).trim() ? v : fallback)

export function generateNote(inv) {
  const L = []
  const push = (label, value) => L.push(`${label} ${or(value)}`.trimEnd())

  L.push('LEAD RECOVERY INVESTIGATION')
  L.push('')
  push('Task:', inv.task)
  push('Seller Name:', inv.sellerName)
  push('Verified Name:', inv.verifiedName)
  push('Property Address:', inv.propertyAddress)
  push('Lead ID:', inv.leadId)
  push('Investigator:', inv.investigator)
  push('Investigation Date:', inv.investigationDate)
  push('Investigation Type:', inv.investigationType)
  push('Time Used:', inv.timeUsed)
  push('Priority:', inv.priority)
  push('Investigation Objective:', inv.objective)
  push('Outreach Authorized:', yn(inv.outreachAuthorized))
  push('Relative Contact Authorized:', yn(inv.relativeContactAuthorized))

  const b = inv.baseline
  L.push('', 'BASELINE REVIEW')
  push('Name in REI BlackBook:', b.nameOnFile)
  push('Phone on File:', b.phoneOnFile)
  push('Email on File:', b.emailOnFile)
  push('Mailing Address on File:', b.mailingOnFile)
  push('Property Address:', b.propertyAddress)
  push('Last Activity:', b.lastActivity)
  push('Last Disposition:', b.lastDisposition)
  push('Current Lead Stage:', b.leadStage)
  push('Assigned Team Member:', b.assignedTeamMember)
  push('Conflicts or Red Flags:', b.redFlags)

  const o = inv.ownership
  L.push('', 'OWNERSHIP FINDINGS')
  push('Recorded Owner:', o.recordedOwner)
  push('Ownership Type:', o.ownershipType)
  push('Trust or Entity:', o.trustOrEntity)
  push('Owner Mailing Address:', o.mailingAddress)
  push('Source:', o.source)
  push('Date Checked:', o.dateChecked)
  push('Confidence:', o.confidence)
  push('Supporting Details:', o.supportingDetails)

  L.push('', 'PEOPLE-SEARCH FINDINGS')
  if (inv.findings.length === 0) {
    L.push('(none recorded)')
  } else {
    inv.findings.forEach((f, i) => {
      if (i > 0) L.push('---')
      push('Search Type:', f.searchType)
      push('Search Value:', f.searchValue)
      push('Name Found:', f.nameFound)
      push('Connection to Property:', f.connection)
      push('Source:', f.source)
      push('Date Checked:', f.dateChecked)
      push('Confidence:', f.confidence)
      push('Supporting Match:', f.supportingMatch)
      push('Conflicting Information:', f.conflicting)
    })
  }

  L.push('', 'CONTACT VERIFICATION')
  if (inv.phones.length === 0) {
    L.push('Best Phone: (none recorded)')
  } else {
    inv.phones.forEach((p, i) => {
      L.push(i === 0 ? 'Best Phone:' : `Additional Phone ${i}:`)
      push('  Number:', p.number)
      push('  Associated Name:', p.associatedName)
      push('  Phone Status:', p.status)
      push('  Phone Source:', p.source)
      push('  Date Checked:', p.dateChecked)
      push('  Matches Seller:', yn(p.matchesSeller))
      push('  Matches Property:', yn(p.matchesProperty))
      push('  Phone Confidence:', p.confidence)
    })
  }
  if (inv.emails.length === 0) {
    L.push('Email: (none recorded)')
  } else {
    inv.emails.forEach((e) => {
      push('Email:', e.address)
      push('  Associated Name:', e.associatedName)
      push('  Email Source:', e.source)
      push('  Date Checked:', e.dateChecked)
      push('  Email Confidence:', e.confidence)
    })
  }
  const m = inv.mailing
  push('Confirmed Mailing Address:', m.confirmedAddress)
  push('Mailing Address Classification:', m.classification)
  push('Mailing Address Source:', m.source)
  push('Mailing Address Confidence:', m.confidence)

  L.push('', 'SOURCES CHECKED')
  Object.entries(inv.sources).forEach(([k, v]) => push(`${k}:`, v))

  const out = inv.outreach
  L.push('', 'OUTREACH RESULT')
  push('Outreach Conducted:', yn(out.conducted))
  push('Authorized Method:', out.authorizedMethod)
  push('Result:', out.result)
  push('Seller Response:', out.sellerResponse)

  const c = inv.conflicts
  L.push('', 'CONFLICTS OR UNVERIFIED INFORMATION')
  push('Conflict 1:', c.conflict1)
  push('Conflict 2:', c.conflict2)
  push('Information Requiring Management Review:', c.managementReview)

  const r = inv.recommendation
  L.push('', 'FINAL RECOMMENDATION')
  push('Recommended Status:', r.status || IN_PROGRESS_STATUS)
  push('Reason:', r.reason)
  push('Next Task:', r.nextTask)
  push('Due Date:', r.dueDate)
  push('Reassign To:', r.reassignTo)

  L.push('', 'GUARDRAIL')
  L.push(
    'This investigation provides research and identity-verification information',
    'only. No pricing, negotiation, fraud determination, legal conclusion,',
    'outreach, task change, note saving, or reassignment was completed without',
    'authorization.',
  )

  return L.join('\n')
}
