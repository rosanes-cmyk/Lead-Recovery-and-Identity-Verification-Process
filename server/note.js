// Builds the REI BlackBook investigation note and the next-task recommendation
// from the scored result. Mirrors the SOP note template.

// Dedupe a phone list by digits, preferring a human-formatted representation.
function dedupePhones(list = []) {
  const byDigits = new Map()
  for (const raw of list) {
    const d = String(raw).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
    if (d.length < 10) continue
    const formatted = /[()\-\s]/.test(String(raw))
    if (!byDigits.has(d) || (formatted && !/[()\-\s]/.test(byDigits.get(d)))) byDigits.set(d, raw)
  }
  return [...byDigits.values()]
}

export function buildNote(report) {
  const { input, data, scored, meta } = report
  const L = []
  const line = (label, value) => L.push(`${label} ${value == null || value === '' ? '' : value}`.trimEnd())
  const NF = 'FIELD NOT FOUND'
  const show = (v) => (v && v !== NF ? v : NF)
  const date = meta.dateChecked || (meta.date || '').slice(0, 10)

  L.push('LEAD RECOVERY INVESTIGATION', '')
  line('Task:', 'Investigate and Verify Seller Identity and Contact Information')
  line('Seller Name (CRM):', data.crm?.sellerName || input.name || '')
  line('Verified Name:', scored.verifiedName || NF)
  line('  Source / Date / Confidence:', `${scored.verifiedNameSource || NF} / ${date} / ${scored.nameConfidence} (${scored.verifiedNameScore}% match)`)
  line('Property Address:', input.address || data.crm?.propertyAddress || '')
  line('Lead ID:', data.crm?.leadId && data.crm.leadId !== NF ? data.crm.leadId : input.leadId || '')
  line('Investigation Date:', meta.date)
  line('Investigation Type:', meta.type)
  line('Time Used:', `${meta.minutesUsed} min (limit ${meta.limitMin} min)`)
  line('Outreach Authorized:', 'No')
  line('Relative Contact Authorized:', 'No')
  line('People Search:', meta.peopleSearchEnabled ? 'Enabled (approved)' : 'Disabled (no Cherry Hombre approval)')

  L.push('', 'CRM LEAD SNAPSHOT (REI BlackBook)')
  line('Lead Stage:', show(data.crm?.leadStage))
  line('Disposition:', show(data.crm?.disposition))
  line('Assigned Team Member:', show(data.crm?.assignedTeamMember))
  line('Last Activity:', show(data.crm?.lastActivity))
  line('Phones on File:', dedupePhones(data.crm?.phones || []).join(', ') || NF)
  line('Emails on File:', [...new Set(data.crm?.emails || [])].join(', ') || NF)
  line('Mailing on File:', show(data.crm?.mailingAddress))

  L.push('', 'OWNERSHIP FINDINGS')
  line('Recorded Owner:', show(data.ownership?.recordedOwner))
  line('Ownership Type / Vesting:', [data.ownership?.ownershipType, data.ownership?.vesting].filter((v) => v && v !== NF).join(' ') || NF)
  line('APN:', show(data.ownership?.apn))
  line('Owner Mailing Address:', show(data.ownership?.mailingAddress))
  line('Occupancy:', show(data.ownership?.occupancy))
  line('Trust / Entity:', show(data.ownership?.trustEntity))
  line('Recording Date:', show(data.ownership?.recordingDate))
  line('Document Number:', show(data.ownership?.documentNumber))
  line('Source / Date:', `${data.ownership?.source || NF} / ${date}`)

  L.push('', 'NAME COMPARISON')
  line('Recorded:', scored.nameComparison.recorded || '(none)')
  line('CRM:', scored.nameComparison.crm || '(none)')
  line('DealMachine:', scored.nameComparison.dealmachine || '(none)')
  line('Match:', scored.nameComparison.match === null ? 'not comparable' : scored.nameComparison.match ? 'Yes' : 'No')

  L.push('', 'CONTACT VERIFICATION')
  if (scored.bestPhone) {
    line('Best Phone:', scored.bestPhone.number)
    line('  Status / Confidence:', `${scored.bestPhone.status} / ${scored.bestPhone.confidence} (${scored.bestPhone.score}% match)`)
    line('  Source / Date:', `${scored.bestPhone.sources.join(', ')} / ${date}`)
  } else {
    line('Best Phone:', NF)
  }
  line('Best Email:', scored.bestEmail || NF)
  line('  Source / Date / Confidence:', `${scored.bestEmailSource || NF} / ${date} / ${scored.emailConfidence || 'n/a'}${scored.bestEmail ? ` (${scored.bestEmailScore}% match)` : ''}`)
  line('Confirmed Mailing Address:', scored.bestMailing || NF)
  line('  Source / Date / Confidence:', `${scored.bestMailingSource || NF} / ${date} / ${scored.mailingConfidence}${scored.bestMailing ? ` (${scored.bestMailingScore}% match)` : ''}`)

  if (scored.topContacts?.length) {
    L.push('', 'TOP POSSIBLE CONTACTS (ranked)')
    scored.topContacts.forEach((c, i) => {
      const tag = c.verified ? 'VERIFIED CONNECTION' : 'UNVERIFIED CLUE'
      line(`${i + 1}.`, `${c.name} — ${c.relationship} [${tag}, ${c.score}% match]`)
      line('   Basis:', c.basis || '')
      if (c.phones?.length) line('   Phones:', c.phones.join(', '))
    })
    L.push('   Note: nobody is labeled a relative without a lawful record; clues are unverified.')
  }

  L.push('', 'CONFLICTS OR UNVERIFIED INFORMATION')
  if (scored.conflicts.length) {
    scored.conflicts.forEach((c, i) => line(`Conflict ${i + 1}:`, `${c.type} — ${c.detail}`))
  } else {
    L.push('None identified.')
  }

  L.push('', 'SOURCES CHECKED')
  meta.sourcesChecked.forEach((s) => line(`${s.source}:`, s.summary))

  L.push('', 'EVIDENCE & AUDIT')
  line('Screenshots:', meta.screenshotsDir || '(none)')
  line('Audit log:', meta.auditLogPath || '(none)')
  line('Screenshots captured:', String((report.evidence || []).length))

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
