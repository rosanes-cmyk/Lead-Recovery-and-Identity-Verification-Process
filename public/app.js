// Operator UI logic. Talks to the server over fetch + SSE. No build step.

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

let currentRunId = null
let currentReport = null
let limits = { standard: 30, enhanced: 60 }
let timerHandle = null
let startedAt = null
let activeLimit = 30

// ---- boot -------------------------------------------------------------------
init()
async function init() {
  try {
    const cfg = await (await fetch('/api/config')).json()
    limits = cfg.limits
    renderSafety(cfg.safety)
  } catch {
    $('safety').textContent = 'server not reachable'
  }
  connectStream()
  loadRuns()

  $('btn-start').onclick = startInvestigation
  $('btn-pause').onclick = () => control('pause')
  $('btn-resume').onclick = () => control('resume')
  $('btn-stop').onclick = () => control('stop')
  $('btn-approve').onclick = approve
  $('btn-reject').onclick = reject
  $('btn-edit').onclick = saveEdits
  $('btn-export-note').onclick = () => exportReport('note')
  $('btn-export-report').onclick = () => exportReport('json')
}

function renderSafety(s) {
  const box = $('safety')
  box.innerHTML = ''
  const dry = !s.canWrite
  box.append(el('span', dry ? 'safety-pill dry' : 'safety-pill live', dry ? 'DRY-RUN · no CRM changes' : 'LIVE MODE'))
}

// ---- start ------------------------------------------------------------------
async function startInvestigation() {
  const input = {
    reiLink: $('in-reiLink').value,
    address: $('in-address').value,
    city: $('in-city').value,
    state: $('in-state').value,
    name: $('in-name').value,
    phone: $('in-phone').value,
    email: $('in-email').value,
    leadId: $('in-leadId').value,
    enhanced: $('in-enhanced').checked,
  }
  $('input-error').hidden = true
  const r = await fetch('/api/investigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await r.json()
  if (!r.ok) {
    $('input-error').textContent = data.error || 'Could not start.'
    $('input-error').hidden = false
    return
  }
  currentRunId = data.runId
  currentReport = null
  activeLimit = input.enhanced ? limits.enhanced : limits.standard
  startedAt = Date.now()
  resetWorkspace()
  startTimer()
}

function resetWorkspace() {
  $('empty').hidden = true
  $('workspace').hidden = false
  $('report').hidden = true
  $('steps').innerHTML = ''
  $('log').innerHTML = ''
  $('evidence').innerHTML = '<p class="muted">Screenshots will appear as the app works.</p>'
  $('login-banner').hidden = true
  $('time-banner').hidden = true
  setState('running')
}

function showWorkspace() {
  if (!$('empty').hidden) $('empty').hidden = true
  if ($('workspace').hidden) $('workspace').hidden = false
}

// ---- SSE stream -------------------------------------------------------------
function connectStream() {
  const es = new EventSource('/api/stream')
  es.onmessage = (m) => {
    let ev
    try { ev = JSON.parse(m.data) } catch { return }
    handleEvent(ev)
  }
  es.onerror = () => { /* browser auto-reconnects */ }
}

const seenEvidence = new Set()
function handleEvent(ev) {
  if (ev.runId && ev.runId !== currentRunId && ev.type === 'hello') {
    // Adopt an in-progress (or just-finished) run if the page was reloaded.
    currentRunId = ev.runId
  }
  if (ev.runId && ev.runId !== currentRunId) return

  // Any event for the active run means we're past the empty state.
  if (ev.runId) showWorkspace()

  switch (ev.type) {
    case 'state': setState(ev.state); if (ev.message) addLog(ev.message, 'state'); break
    case 'safety': break
    case 'source-start': addStep(ev.source); $('current-source').textContent = '· ' + ev.source; break
    case 'source-done': completeStep(ev.source, ev.ok, ev.notes); break
    case 'log': addLog(`${ev.source ? ev.source + ': ' : ''}${ev.message}`); break
    case 'login-required':
      setState('login')
      $('login-banner').hidden = false
      $('login-banner').textContent = ev.message
      $('btn-resume').hidden = false
      $('btn-pause').hidden = true
      break
    case 'time-limit':
      $('time-banner').hidden = false
      $('time-banner').textContent = ev.message
      addLog(ev.message, 'state')
      break
    case 'error': addLog('ERROR: ' + ev.message, 'error'); setState('error'); break
    case 'report': onReport(ev.report, ev.state); break
  }
  // Pull any new evidence attached to the running report checkpoints.
  if (ev.report?.evidence) renderEvidence(ev.report.evidence)
}

// ---- steps / log ------------------------------------------------------------
const stepNodes = {}
function addStep(name) {
  if (stepNodes[name]) return
  const li = el('li', 'step running')
  li.append(el('span', 'step-dot'), el('span', 'step-name', name), el('span', 'step-note', '…'))
  $('steps').append(li)
  stepNodes[name] = li
}
function completeStep(name, ok, notes) {
  const li = stepNodes[name] || (addStep(name), stepNodes[name])
  li.className = 'step ' + (ok ? 'ok' : 'warn')
  li.querySelector('.step-note').textContent = ok ? 'done' : (notes && notes[0] ? notes[0].slice(0, 80) : 'needs attention')
  $('current-source').textContent = ''
}
function addLog(msg, kind) {
  const line = el('div', 'log-line ' + (kind || ''))
  line.textContent = msg
  $('log').append(line)
  $('log').scrollTop = $('log').scrollHeight
}

// ---- evidence ---------------------------------------------------------------
function renderEvidence(list) {
  const box = $('evidence')
  let added = false
  for (const e of list) {
    if (!e.file) continue
    const key = e.file
    if (seenEvidence.has(key)) continue
    seenEvidence.add(key)
    if (!added) { box.innerHTML = ''; added = true }
    const fig = el('figure', 'evi')
    const a = el('a')
    // Handle both / and \ separators (Windows stored paths).
    const fileName = e.file.split(/[\\/]/).pop()
    a.href = `/evidence/${e.runId || currentRunId}/${fileName}`
    a.target = '_blank'
    const img = el('img')
    img.src = a.href
    img.loading = 'lazy'
    a.append(img)
    fig.append(a, el('figcaption', null, `${e.source ? e.source + ' — ' : ''}${e.label || ''}`))
    box.append(fig)
  }
  $('evi-count').textContent = seenEvidence.size ? `(${seenEvidence.size})` : ''
}

// ---- state + timer ----------------------------------------------------------
function setState(s) {
  const chip = $('state-chip')
  chip.textContent = s
  chip.className = 'chip chip-' + s
  const running = s === 'running'
  const terminal = ['done', 'stopped', 'error'].includes(s)
  $('btn-pause').hidden = !running
  $('btn-resume').hidden = !(s === 'paused' || s === 'login')
  $('btn-stop').hidden = terminal
  if (terminal) stopTimer()
}
function startTimer() {
  stopTimer()
  timerHandle = setInterval(() => {
    const mins = (Date.now() - startedAt) / 60000
    $('timer').textContent = `${mins.toFixed(1)} / ${activeLimit} min`
    $('timer').classList.toggle('over', mins >= activeLimit)
  }, 500)
}
function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null } }

// ---- controls ---------------------------------------------------------------
async function control(action) {
  await fetch('/api/control/' + action, { method: 'POST' })
  if (action === 'resume') { $('login-banner').hidden = true }
}

// ---- report -----------------------------------------------------------------
function onReport(report, state) {
  currentReport = report
  setState(state || report.state || 'done')
  renderEvidence(report.evidence || [])
  $('report').hidden = false
  const s = report.scored
  $('report-status').textContent = s.recommendedStatus
  $('report-status').className = 'badge ' + statusClass(s.recommendedStatus)

  const grid = $('report-grid')
  grid.innerHTML = ''
  grid.append(
    kv('Verified name', s.verifiedName || '—', s.nameConfidence),
    kv('Best phone', s.bestPhone ? s.bestPhone.number : '—', s.bestPhone?.confidence, s.bestPhone?.status),
    kv('Best email', s.bestEmail || '—', s.emailConfidence),
    kv('Mailing address', s.bestMailing || '—', s.mailingConfidence),
    kv('Time used', `${report.meta.minutesUsed} / ${report.meta.limitMin} min`),
    kv('Recorded owner', report.data.ownership?.recordedOwner || '—'),
  )

  const cbox = $('conflicts')
  cbox.innerHTML = ''
  if (s.conflicts.length) {
    cbox.append(el('h3', null, 'Conflicts flagged'))
    const ul = el('ul', 'conflict-list')
    s.conflicts.forEach((c) => {
      const li = el('li')
      li.append(el('strong', null, c.type + ': '), document.createTextNode(c.detail))
      ul.append(li)
    })
    cbox.append(ul)
  }
  if (s.possibleContacts.length) {
    cbox.append(el('h3', null, 'Possible contacts (unverified clues)'))
    const ul = el('ul', 'conflict-list')
    s.possibleContacts.slice(0, 8).forEach((p) => {
      const li = el('li')
      li.append(el('strong', null, (p.name || 'unknown') + ' '), el('span', 'muted', p.note || ''))
      ul.append(li)
    })
    cbox.append(ul)
  }

  $('note').value = report.note || ''
  const nt = report.nextTask || {}
  $('next-task').innerHTML = ''
  $('next-task').append(
    el('h3', null, 'Recommended next step'),
    kv('Next task', nt.action || '—'),
    kv('Reassign to', nt.reassignTo || '—'),
    kv('Reason', s.statusReason || '—'),
  )

  const approved = report.approval?.decision
  $('approval-note').textContent = approved
    ? `Already ${approved}${report.approval.note ? ' — ' + report.approval.note : ''}`
    : 'Review the findings and note above, then Approve or Reject. In dry-run mode, Approve records your decision but makes no CRM change.'
  loadRuns()
}

function kv(label, value, confidence, status) {
  const d = el('div', 'kv')
  d.append(el('div', 'kv-label', label))
  const v = el('div', 'kv-value', value)
  if (confidence) v.append(el('span', 'conf conf-' + String(confidence).toLowerCase(), confidence))
  if (status) v.append(el('span', 'conf conf-status', status))
  d.append(v)
  return d
}
function statusClass(s) {
  if (s === 'Seller Contact Located') return 'st-located'
  if (s === 'Management Review Required') return 'st-review'
  if (s === 'No Contact After Investigation') return 'st-nocontact'
  return 'st-progress'
}

async function approve() {
  if (!currentRunId) return
  const r = await fetch('/api/approve/' + currentRunId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const data = await r.json()
  let msg = data.message || 'Approved.'
  if (data.wouldExecute?.length) msg += ' In live mode it would: ' + data.wouldExecute.join(', ') + '.'
  $('approval-note').textContent = msg
  loadRuns()
}
async function reject() {
  if (!currentRunId) return
  const reason = prompt('Reason for rejection (optional):') || ''
  await fetch('/api/reject/' + currentRunId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })
  $('approval-note').textContent = 'Rejected. No CRM change made.'
  loadRuns()
}
async function saveEdits() {
  if (!currentRunId) return
  await fetch('/api/report/' + currentRunId + '/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: $('note').value }),
  })
  $('approval-note').textContent = 'Edits saved.'
}
function exportReport(format) {
  if (!currentRunId) return
  const q = format === 'note' ? '?format=note' : ''
  window.open('/api/report/' + currentRunId + '/export' + q, '_blank')
}

// ---- recent runs ------------------------------------------------------------
async function loadRuns() {
  try {
    const runs = await (await fetch('/api/runs')).json()
    const box = $('runs')
    box.innerHTML = ''
    if (!runs.length) { box.innerHTML = '<p class="muted">No past runs yet.</p>'; return }
    runs.slice(0, 20).forEach((r) => {
      const b = el('button', 'run-item')
      b.append(
        el('span', 'run-name', r.name),
        el('span', 'badge ' + statusClass(r.status), r.status),
      )
      if (r.approval) b.append(el('span', 'run-approval', r.approval))
      b.onclick = () => openRun(r.runId)
      box.append(b)
    })
  } catch { /* ignore */ }
}
async function openRun(runId) {
  const report = await (await fetch('/api/report/' + runId)).json()
  currentRunId = runId
  currentReport = report
  seenEvidence.clear()
  $('empty').hidden = true
  $('workspace').hidden = false
  $('steps').innerHTML = ''
  $('log').innerHTML = ''
  $('evidence').innerHTML = ''
  ;(report.meta?.sourcesChecked || []).forEach((s) => { addStep(s.source); completeStep(s.source, s.summary === 'checked', [s.summary]) })
  onReport(report, report.state)
  stopTimer()
  $('timer').textContent = `${report.meta.minutesUsed} / ${report.meta.limitMin} min`
}
