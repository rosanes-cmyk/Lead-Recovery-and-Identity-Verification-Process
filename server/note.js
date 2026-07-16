// Builds the REI BlackBook investigation note and the next-task recommendation
// from the scored result. Mirrors the SOP note template.

export function buildNote(report) {
  const { input, data, scored, meta } = report
  const L = []
  const line = (label, value) => L.push(`${label} ${value == null || value === '' ? '' : value}`.trimEnd())

  L.push('LEAD RECOVERY INVESTIGATION', '')
  line('Task:', 'Investigate and Verify Seller Identity and Contact Information')
  line('Seller Name:', data.crm?.sellerName || input.name || '')
  line('Verified Name:', scored.verifiedName)
  line('Property Address:', input.address || data.crm?.propertyAddress || '')
  line('Lead ID:', input.leadId || '')
  line('Investigation Date:', meta.date)
  line('Investigation Type:', meta.type)
  line('Time Used:', `${meta.minutesUsed} min (limit ${meta.limitMin} min)`)
  line('Outreach Authorized:', 'No')
  line('Relative Contact Authorized:', 'No')

  L.push('', 'OWNERSHIP FINDINGS')
  line('Recorded Owner:', data.ownership?.recordedOwner || '')
  line('Ownership Type / Vesting:', [data.ownership?.ownershipType, data.ownership?.vesting].filter(Boolean).join(' '))
  line('Owner Mailing Address:', data.ownership?.mailingAddress || '')
  line('Source:', data.ownership?.source || '')
  line('Name Confidence:', scored.nameConfidence)

  L.push('', 'NAME COMPARISON')
  line('Recorded:', scored.nameComparison.recorded || '(none)')
  line('CRM:', scored.nameComparison.crm || '(none)')
  line('DealMachine:', scored.nameComparison.dealmachine || '(none)')
  line('Match:', scored.nameComparison.match === null ? 'not comparable' : scored.nameComparison.match ? 'Yes' : 'No')

  L.push('', 'CONTACT VERIFICATION')
  if (scored.bestPhone) {
    line('Best Phone:', scored.bestPhone.number)
    line('  Status:', scored.bestPhone.status)
    line('  Confidence:', scored.bestPhone.confidence)
    line('  Sources:', scored.bestPhone.sources.join(', '))
  } else {
    line('Best Phone:', '(none confirmed)')
  }
  line('Best Email:', scored.bestEmail || '(none)')
  line('  Email Confidence:', scored.emailConfidence || 'n/a')
  line('Confirmed Mailing Address:', scored.bestMailing || '(unconfirmed)')
  line('  Mailing Confidence:', scored.mailingConfidence)

  if (scored.possibleContacts.length) {
    L.push('', 'POSSIBLE CONTACTS (UNVERIFIED CLUES)')
    scored.possibleContacts.slice(0, 10).forEach((p, i) => {
      line(`${i + 1}.`, `${p.name}${p.phones?.length ? ' — ' + p.phones.join(', ') : ''}`)
      if (p.note) L.push(`   ${p.note}`)
    })
  }

  L.push('', 'CONFLICTS OR UNVERIFIED INFORMATION')
  if (scored.conflicts.length) {
    scored.conflicts.forEach((c, i) => line(`Conflict ${i + 1}:`, `${c.type} — ${c.detail}`))
  } else {
    L.push('None identified.')
  }

  L.push('', 'SOURCES CHECKED')
  meta.sourcesChecked.forEach((s) => line(`${s.source}:`, s.summary))

  L.push('', 'FINAL RECOMMENDATION')
  line('Recommended Status:', scored.recommendedStatus)
  line('Reason:', scored.statusReason)
  line('Next Task:', report.nextTask?.action || '')
  line('Due Date:', report.nextTask?.dueDate || '')
  line('Reassign To:', report.nextTask?.reassignTo || '')

  L.push(
    '',
    'GUARDRAIL',
    'This investigation provides research and identity-verification information only. No',
    'pricing, negotiation, fraud determination, legal conclusion, outreach, task change,',
    'note saving, or reassignment was completed without authorization. Prepared by automation',
    'in dry-run mode; a human must approve before any CRM change.',
  )

  return L.join('\n')
}

// Recommend the next task + reassignment from the status (SOP Steps 14-15).
export function buildNextTask(scored, meta) {
  const dueDate = meta.dueDate // caller supplies (no Date math here for determinism)
  switch (scored.recommendedStatus) {
    case 'Seller Contact Located':
      return {
        action: scored.bestPhone
          ? `Acquisitions to call the verified seller at ${scored.bestPhone.number}.`
          : 'Acquisitions to follow up with the verified seller using the confirmed contact info.',
        dueDate,
        reassignTo: 'Acquisitions',
      }
    case 'Management Review Required':
      return {
        action:
          'Cherry Hombre to review ownership/identity conflicts before further outreach: ' +
          scored.conflicts.map((c) => c.type).join('; ') + '.',
        dueDate,
        reassignTo: 'Cherry Hombre',
      }
    default:
      return {
        action:
          'Return to queue. No reliable contact confirmed within the time limit; re-attempt with additional sources if authorized.',
        dueDate,
        reassignTo: 'Cherry Hombre',
      }
  }
}
