// HTTP server: serves the operator UI, starts investigations, streams live
// progress over Server-Sent Events, and exposes the approval endpoints.
//
// Approval endpoints refuse to make CRM changes while the app is in dry-run
// mode — which, in the first version, it always is.

import './ensureEnv.js' // must run before config.js loads dotenv
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config, safetySummary, canWrite, ROOT } from './config.js'
import { Investigation } from './orchestrator.js'
import { loadReport, listRuns, runDir, saveReport } from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))
// Never cache the operator UI files, so pulling an update always shows the
// latest HTML/CSS/JS on a normal reload (no hard-refresh needed).
app.use(
  express.static(path.join(ROOT, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, max-age=0'),
  }),
)

// One active investigation at a time (Phase 1 is single-lead).
let current = null
const sseClients = new Set()

function sseWrite(res, ev) {
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
  } catch (err) {
    console.error('SSE write failed:', err.message)
  }
}
function broadcast(ev) {
  for (const res of sseClients) sseWrite(res, ev)
}

// --- config / safety ---------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    safety: safetySummary(),
    limits: { standard: config.standardLimitMin, enhanced: config.enhancedLimitMin },
    headless: config.headless,
  })
})

// --- start an investigation --------------------------------------------------
app.post('/api/investigate', async (req, res) => {
  if (current && ['running', 'paused', 'login'].includes(current.state)) {
    return res.status(409).json({ error: 'An investigation is already running. Stop it first.' })
  }
  const input = req.body || {}
  if (!input.address && !input.reiLink && !input.name && !input.phone && !input.email) {
    return res.status(400).json({ error: 'Provide at least an address, REI BlackBook link, name, phone, or email.' })
  }
  const inv = new Investigation(input)
  current = inv
  inv.on('event', (ev) => broadcast({ runId: inv.runId, ...ev }))
  res.json({ runId: inv.runId, state: inv.state })
  // Run asynchronously; progress flows over SSE.
  inv.run().catch((err) => broadcast({ runId: inv.runId, type: 'error', message: String(err) }))
})

// --- live progress stream ----------------------------------------------------
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders?.()
  sseClients.add(res)
  // Replay current run's log so a late-joining client catches up.
  if (current) {
    sseWrite(res, { runId: current.runId, type: 'hello', state: current.state })
    for (const ev of current.log) sseWrite(res, { runId: current.runId, ...ev })
    if (current.report) sseWrite(res, { runId: current.runId, type: 'report', state: current.state, report: current.report })
  }
  req.on('close', () => sseClients.delete(res))
})

// --- controls ----------------------------------------------------------------
app.post('/api/control/:action', (req, res) => {
  if (!current) return res.status(404).json({ error: 'No active investigation.' })
  const { action } = req.params
  switch (action) {
    case 'pause': current.pause(); break
    case 'resume': current.resume(); break
    case 'stop': current.stop(); break
    default: return res.status(400).json({ error: `Unknown action: ${action}` })
  }
  res.json({ state: current.state })
})

// --- report read / edit / export --------------------------------------------
app.get('/api/report/:runId', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  res.json(report)
})

app.get('/api/runs', (req, res) => {
  res.json(
    listRuns().map((r) => ({
      runId: r.runId,
      name: r.scored?.verifiedName || r.input?.name || r.input?.address || 'Lead',
      address: r.input?.address || '',
      status: r.scored?.recommendedStatus || 'In Progress',
      approval: r.approval?.decision || null,
      date: r.meta?.date,
    })),
  )
})

// Operator edits to the note or next task before approval.
app.post('/api/report/:runId/edit', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  const { note, nextTask, recommendedStatus } = req.body || {}
  if (typeof note === 'string') report.note = note
  if (nextTask && typeof nextTask === 'object') report.nextTask = { ...report.nextTask, ...nextTask }
  if (recommendedStatus) report.scored.recommendedStatus = recommendedStatus
  report.edited = true
  saveReport(report.runId, report)
  res.json({ ok: true, report })
})

// Approve / reject. Approval NEVER writes to the CRM in dry-run mode — it
// records the human decision and returns exactly what a live run WOULD do.
app.post('/api/approve/:runId', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  const wouldDo = [
    config.autoSaveNote ? 'save the note' : null,
    config.autoChangeStatus ? `set status to "${report.scored.recommendedStatus}"` : null,
    config.autoCreateTask ? 'create the next task' : null,
    config.autoReassign ? `reassign to ${report.nextTask.reassignTo}` : null,
  ].filter(Boolean)

  report.approval = {
    decision: 'approved',
    by: 'operator',
    at: new Date().toISOString(),
    executed: canWrite(),
  }

  if (!canWrite()) {
    report.approval.note =
      'DRY-RUN: approval recorded, but no CRM change was made. Enable LIVE_MODE=true and DRY_RUN=false (and the relevant AUTO_* flags) to let approval execute.'
    saveReport(report.runId, report)
    return res.json({
      ok: true,
      executed: false,
      message: 'Approved (dry-run). No CRM changes were made.',
      wouldExecute: wouldDo,
      approval: report.approval,
    })
  }

  // LIVE path is intentionally not implemented in the first version: writing to
  // REI BlackBook needs calibrated selectors and a deliberate go-live decision.
  report.approval.note = 'LIVE mode is enabled but CRM write-back is not implemented in this version.'
  saveReport(report.runId, report)
  res.json({ ok: true, executed: false, message: 'Approved. CRM write-back is not enabled in this version.', approval: report.approval })
})

app.post('/api/reject/:runId', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  report.approval = { decision: 'rejected', by: 'operator', at: new Date().toISOString(), reason: req.body?.reason || '' }
  saveReport(report.runId, report)
  res.json({ ok: true, approval: report.approval })
})

app.get('/api/report/:runId/export', (req, res) => {
  const report = loadReport(req.params.runId)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  if (req.query.format === 'note') {
    res.set('Content-Type', 'text/plain')
    res.set('Content-Disposition', `attachment; filename="${report.runId}-note.txt"`)
    return res.send(report.note || '')
  }
  res.set('Content-Disposition', `attachment; filename="${report.runId}-report.json"`)
  res.json(report)
})

// --- evidence screenshots ----------------------------------------------------
app.get('/evidence/:runId/:file', (req, res) => {
  const { runId, file } = req.params
  if (!/^[\w.-]+$/.test(file)) return res.status(400).end()
  const abs = path.join(runDir(runId), 'evidence', file)
  if (!abs.startsWith(runDir(runId))) return res.status(400).end()
  if (!fs.existsSync(abs)) return res.status(404).end()
  res.sendFile(abs)
})

app.listen(config.port, () => {
  const url = `http://localhost:${config.port}`
  console.log('\n  Lead Recovery & Seller Identity Verification Automation')
  console.log('  ' + '-'.repeat(54))
  console.log(`  Open:      ${url}`)
  console.log(`  Mode:      ${canWrite() ? 'LIVE (writes enabled)' : 'DRY-RUN (research only, no CRM changes)'}`)
  console.log(`  Browser:   ${config.headless ? 'headless' : 'visible (log in when prompted)'}`)
  console.log(`  Time:      Standard ${config.standardLimitMin}m / Enhanced ${config.enhancedLimitMin}m`)
  if (config.demoMode) console.log('  Demo:      ON (synthetic data, no real browser)')
  console.log('  ' + '-'.repeat(54) + '\n')
  openInBrowser(url)
})

// Best-effort: open the operator UI in the default browser on start.
function openInBrowser(url) {
  if (process.env.NO_OPEN === 'true') return
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* operator can open the URL manually */
  }
}
