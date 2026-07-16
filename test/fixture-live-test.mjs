// Proves the LIVE extraction pipeline end-to-end against structural page
// fixtures (stand-ins, not real accounts): real source modules extract from
// real DOM via the selector engine; results flow through the real orchestrator
// consolidation + scoring + note builder; the run stops at the approval report
// with no CRM write. This validates the mechanics the one-lead live test needs.
//
// Run: npm run test:fixture
// Requires a Chromium binary; set PLAYWRIGHT_EXECUTABLE_PATH if needed.

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { selectors } from '../server/sources/selectors.js'
import * as reibb from '../server/sources/reiblackbook.js'
import * as propertyradar from '../server/sources/propertyradar.js'
import { Investigation } from '../server/orchestrator.js'
import { ensureRunDir } from '../server/store.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const fx = (f) => 'file://' + path.join(dir, 'fixtures', f)
const emit = (e) => { if (e.message) console.log(`   · ${e.source || ''} ${e.message}`) }

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

const launchOpts = { headless: true }
if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage()

// Point PropertyRadar at the fixture (no placeholder -> used as-is).
selectors.propertyradar.searchUrlForAddress = fx('propertyradar.html')

const input = { reiLink: fx('reiblackbook-lead.html'), address: '123 Main Street, Anytown, CA 94000', name: 'Philip Barber', dueDate: '2026-07-17' }
const runDir = path.join(process.cwd(), 'runs', '_fixture_test')
fs.rmSync(runDir, { recursive: true, force: true })
fs.mkdirSync(runDir, { recursive: true })
const baseCtx = { page, input, data: {}, emit, runDir, signal: { aborted: false } }

console.log('\n[1] REI BlackBook — contact/lead record')
const r1 = await reibb.run(baseCtx)
check('lead ID extracted', r1.data.leadId === 'LEAD-100294', r1.data.leadId)
check('seller name extracted', r1.data.sellerName === 'Philip Barber', r1.data.sellerName)
check('stage extracted', r1.data.leadStage === 'Stalled', r1.data.leadStage)
check('phone extracted', (r1.data.phones || []).some((p) => p.includes('555')), (r1.data.phones || []).join(','))
check('email extracted', (r1.data.emails || []).includes('pbarber@example.com'), (r1.data.emails || []).join(','))
check('mailing extracted', /Evergreen/.test(r1.data.mailingAddress || ''), r1.data.mailingAddress)
check('audit trail present', Array.isArray(r1.audit) && r1.audit.length > 0, `${r1.audit?.length} entries`)

console.log('\n[2] PropertyRadar — ownership')
const r2 = await propertyradar.run(baseCtx)
check('recorded owner extracted', r2.data.ownerName === 'Phillip Lyman Barber', r2.data.ownerName)
check('vesting extracted', /Joint Tenants/.test(r2.data.vesting || ''), r2.data.vesting)
check('APN extracted', r2.data.apn === '123-45-678', r2.data.apn)
check('mailing extracted', /PO Box 44/.test(r2.data.mailingAddress || ''), r2.data.mailingAddress)

console.log('\n[3] Consolidation + scoring + note (real orchestrator path)')
const inv = new Investigation(input)
ensureRunDir(inv.runId)
inv.startedAt = Date.now()
inv._absorb(reibb, r1)
inv._absorb(propertyradar, r2)
const report = inv.finalize('done')
const s = report.scored

check('CRM name vs recorded compared', s.nameComparison.crm === 'Philip Barber' && s.nameComparison.recorded === 'Phillip Lyman Barber')
check('fuzzy name match = true (Philip ~ Phillip Lyman)', s.nameComparison.match === true)
check('verified name chosen (most complete)', s.verifiedName === 'Phillip Lyman Barber', s.verifiedName)
check('name confidence High', s.nameConfidence === 'High', s.nameConfidence)
check('best phone classified', !!s.bestPhone && !!s.bestPhone.status, s.bestPhone && `${s.bestPhone.number} ${s.bestPhone.status}/${s.bestPhone.confidence}`)
check('best email classified', !!s.bestEmail && !!s.emailConfidence, `${s.bestEmail} ${s.emailConfidence}`)
check('best mailing classified w/ source', !!s.bestMailing && !!s.bestMailingSource, `${s.bestMailing} (${s.bestMailingSource}/${s.mailingConfidence})`)
check('mailing conflict preserved', s.conflicts.some((c) => /mailing/i.test(c.type)), s.conflicts.map((c) => c.type).join('; '))
check('status is a valid SOP status', ['Seller Contact Located', 'No Contact After Investigation', 'Management Review Required'].includes(s.recommendedStatus), s.recommendedStatus)
check('next task + reassignment present', !!report.nextTask.action && !!report.nextTask.reassignTo, report.nextTask.reassignTo)
check('note generated with sections', report.note.includes('OWNERSHIP FINDINGS') && report.note.includes('CONTACT VERIFICATION') && report.note.includes('GUARDRAIL'))
check('note carries source/date/confidence', report.note.includes('Source / Date / Confidence:'))
check('audit log written to disk', fs.existsSync(report.meta.auditLogPath), report.meta.auditLogPath)
check('run stops at approval (no approval recorded, no CRM write)', report.state === 'done' && !report.approval)
check('people search disabled', report.meta.peopleSearchEnabled === false)

// Save the produced note so it can be inspected.
fs.writeFileSync(path.join(runDir, 'sample-note.txt'), report.note)
console.log('\nSample note written to:', path.join(runDir, 'sample-note.txt'))

await browser.close()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
