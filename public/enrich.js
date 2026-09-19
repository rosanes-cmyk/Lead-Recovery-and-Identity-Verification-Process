// Property Enrichment tab. Talks to /api/enrich/* over fetch; receives 'enrich'
// SSE events forwarded by app.js (window.enrichHandle). No build step.

;(() => {
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  const NF = 'FIELD NOT FOUND'

  let job = null // status of the job shown in the workspace
  let setup = null // status of the uploaded-but-not-started job in the setup card
  let opening = null // { id, promise } — dedupes openJob() while a fetch is in flight
  const rowNodes = new Map()

  init()
  async function init() {
    $('en-file').addEventListener('change', onFile)
    $('en-mode').addEventListener('change', () => { syncModeUi(); pushMapping() })
    ;['en-col-street', 'en-col-city', 'en-col-state', 'en-col-zip', 'en-col-full'].forEach((id) => $(id).addEventListener('change', pushMapping))
    $('en-start').onclick = start
    $('en-pause').onclick = () => control('pause')
    $('en-resume').onclick = () => control('resume')
    $('en-stop').onclick = () => control('stop')
    $('en-download').onclick = download
    window.enrichHandle = handleEvent
    await loadJobs()
  }

  // ---- upload + setup --------------------------------------------------------
  async function onFile(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    hide('en-upload-error')
    let text
    try { text = await file.text() } catch { return showErr('en-upload-error', 'Could not read that file.') }
    try {
      const r = await fetch('/api/enrich/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv', 'x-filename': encodeURIComponent(file.name) },
        body: text,
      })
      const data = await readJson(r)
      if (!r.ok) return showErr('en-upload-error', data.error || `Upload failed (HTTP ${r.status}).`)
      setup = data
      renderSetup(data)
      loadJobs()
    } catch (err) {
      showErr('en-upload-error', 'Could not reach the server. Is it still running? (' + (err?.message || err) + ')')
    } finally {
      e.target.value = ''
    }
  }

  function renderSetup(s) {
    show('en-setup-card')
    $('en-setup-title').textContent = s.filename
    $('en-setup-sub').textContent = `${s.total} rows · ${s.headers.length} columns`
    const fill = (id, selected, allowNone) => {
      const sel = $(id)
      sel.innerHTML = ''
      if (allowNone) sel.append(new Option('(none)', ''))
      s.headers.forEach((h) => sel.append(new Option(h, h)))
      sel.value = selected || ''
    }
    const m = s.addressMap || {}
    $('en-mode').value = m.mode === 'full' ? 'full' : 'parts'
    fill('en-col-street', m.street, false)
    fill('en-col-city', m.city, true)
    fill('en-col-state', m.state, true)
    fill('en-col-zip', m.zip, true)
    fill('en-col-full', m.full || m.street, false)
    syncModeUi()
    renderSample(s)
    $('en-web').checked = s.options?.webSearch !== false
    $('en-shots').checked = s.options?.screenshots !== false
    $('en-zillow').checked = s.options?.zillowCheck !== false
    $('en-headless').checked = s.options?.headless === true
    if (s.options?.delayMs != null) $('en-delay').value = (s.options.delayMs / 1000).toString()
    hide('en-start-error')
  }

  function syncModeUi() {
    const full = $('en-mode').value === 'full'
    $('en-parts').hidden = full
    $('en-full').hidden = !full
  }

  function currentMapping() {
    if ($('en-mode').value === 'full') return { mode: 'full', full: $('en-col-full').value }
    return { mode: 'parts', street: $('en-col-street').value, city: $('en-col-city').value, state: $('en-col-state').value, zip: $('en-col-zip').value }
  }

  function renderSample(s) {
    const box = $('en-sample')
    const sample = (s.sample || []).filter(Boolean)
    const bad = s.unresolved || 0
    box.textContent = ''
    box.append(el('div', null, sample.length ? `Address preview: ${sample.join('  ·  ')}` : 'No address could be built from these columns yet — check the mapping.'))
    if (bad) box.append(el('div', 'muted', `${bad} row${bad === 1 ? '' : 's'} have no address and will be skipped.`))
    if (s.demo) box.append(el('div', 'muted', 'DEMO MODE is on: results will be synthetic.'))
  }

  // Send the chosen columns to the server so the preview reflects them.
  async function pushMapping() {
    if (!setup) return
    hide('en-start-error')
    try {
      const r = await fetch(`/api/enrich/${setup.id}/options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addressMap: currentMapping() }) })
      const data = await readJson(r)
      if (!r.ok) return showErr('en-start-error', data.error || 'Could not apply that mapping.')
      setup = data.status
      renderSample(setup)
    } catch { /* preview only */ }
  }

  async function start() {
    if (!setup) return
    hide('en-start-error')
    const body = {
      addressMap: currentMapping(),
      webSearch: $('en-web').checked,
      screenshots: $('en-shots').checked,
      zillowCheck: $('en-zillow').checked,
      headless: $('en-headless').checked,
      delayMs: Math.round(parseFloat($('en-delay').value || '0') * 1000),
    }
    await startJob(setup.id, body, 'en-start-error')
  }

  async function startJob(id, body, errId) {
    const btn = $('en-start')
    btn.disabled = true
    try {
      const r = await fetch(`/api/enrich/${id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      const data = await readJson(r)
      if (!r.ok) { showErr(errId || 'en-start-error', data.error || `Could not start (HTTP ${r.status}).`); return }
      await openJob(id)
      window.showTab?.('enrich')
    } catch (err) {
      showErr(errId || 'en-start-error', 'Could not reach the server. (' + (err?.message || err) + ')')
    } finally {
      btn.disabled = false
    }
  }

  // ---- workspace ---------------------------------------------------------------
  function openJob(id) {
    // Several SSE events can arrive before the first fetch returns; open once.
    if (opening && opening.id === id) return opening.promise
    const promise = _openJob(id).finally(() => { if (opening?.id === id) opening = null })
    opening = { id, promise }
    return promise
  }
  async function _openJob(id) {
    const r = await fetch(`/api/enrich/${id}`)
    if (!r.ok) return
    const data = await r.json()
    job = data
    rowNodes.clear()
    $('en-rows').innerHTML = ''
    $('en-log').innerHTML = ''
    hide('en-login-banner')
    hide('en-done-banner')
    hide('en-empty')
    show('en-workspace')
    ;(data.rows || []).forEach(addRow)
    ;(data.log || []).forEach((ev) => { if (ev.sub === 'log' || ev.sub === 'state') addLog(ev.message, ev.level || (ev.sub === 'state' ? 'state' : '')) })
    setState(data.state)
    updateProgress(data)
    if (data.state === 'done' || data.state === 'error') {
      const b = $('en-done-banner')
      b.hidden = false
      b.className = 'banner ' + (data.state === 'error' ? 'banner-warn' : 'banner-ok')
      b.textContent = data.state === 'error' ? data.error || 'The job stopped with an error.' : `Done — ${data.found} of ${data.total} rows found an owner.`
    }
  }

  function handleEvent(ev) {
    if (ev.sub === 'hello') {
      if (!job || job.id !== ev.enrichId) openJob(ev.enrichId)
      return
    }
    if (!job || ev.enrichId !== job.id) {
      // A job started from another browser window: adopt it if nothing is open.
      if (!job && ev.enrichId) openJob(ev.enrichId)
      return
    }
    switch (ev.sub) {
      case 'state':
        setState(ev.state)
        if (ev.message) addLog(ev.message, 'state')
        if (ev.state === 'running') hide('en-login-banner')
        break
      case 'progress': updateProgress(ev); break
      case 'row': addRow(ev); break
      case 'log': addLog(ev.message, ev.level); break
      case 'login-required':
        setState('login')
        $('en-login-banner').hidden = false
        $('en-login-banner').textContent = ev.message
        addLog(ev.message, 'warn')
        break
      case 'done': {
        setState(ev.state)
        const b = $('en-done-banner')
        b.hidden = false
        b.className = 'banner ' + (ev.state === 'error' ? 'banner-warn' : 'banner-ok')
        b.textContent = ev.message
        // (the accompanying 'state' event already wrote this line to the log)
        updateProgress(ev)
        loadJobs()
        break
      }
    }
  }

  function setState(s) {
    const chip = $('en-chip')
    chip.textContent = s
    chip.className = 'chip chip-' + s
    const running = s === 'running'
    const active = ['running', 'paused', 'login'].includes(s)
    $('en-pause').hidden = !running
    $('en-resume').hidden = !(s === 'paused' || s === 'login')
    $('en-stop').hidden = !active
    $('en-spinner').hidden = !running
    const dot = $('tab-dot-enrich')
    if (dot) dot.hidden = !active
    if (job) job.state = s
  }

  function updateProgress(p) {
    const total = p.total ?? job?.total ?? 0
    const done = p.done ?? 0
    $('en-count').textContent = `${done} / ${total}`
    $('en-bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%'
    $('en-found').textContent = done ? `(${p.found ?? 0} found · ${p.notFound ?? 0} not found)` : ''
    $('en-eta').textContent = p.etaMs != null && done < total && ['running', 'paused', 'login'].includes(p.state || job?.state) ? `· ~${fmtEta(p.etaMs)} left` : ''
    $('en-current').textContent = p.currentAddress && (p.state || job?.state) === 'running' ? `· ${p.currentAddress}` : ''
  }

  function fmtEta(ms) {
    const m = Math.ceil(ms / 60000)
    if (m < 1) return '<1 min'
    if (m < 60) return `${m} min`
    return `${Math.floor(m / 60)}h ${m % 60}m`
  }

  function addRow(r) {
    const f = r.fields || {}
    let tr = rowNodes.get(r.i)
    if (!tr) {
      tr = el('tr')
      rowNodes.set(r.i, tr)
      // Keep the DOM light on very large sheets.
      if (rowNodes.size > 600) { const first = $('en-rows').firstChild; if (first) first.remove() }
      $('en-rows').append(tr)
    }
    tr.innerHTML = ''
    const owner = f['PR Owner of Record'] || ''
    const ownerTd = el('td', owner === NF ? 'nf' : '', owner || (f['PR Status'] === 'skipped' ? '—' : ''))
    if (f['PR Entity Owner'] === 'Yes') ownerTd.append(' ', el('span', 'pill pill-warn', 'entity'))
    const matchTd = el('td')
    if (f['PR Address Match']) matchTd.append(el('span', 'pill ' + (f['PR Address Match'] === 'match' ? 'pill-ok' : f['PR Address Match'] === 'mismatch' ? 'pill-bad' : 'pill-muted'), f['PR Address Match']))
    const webTd = el('td')
    const links = el('div', 'weblinks')
    const add = (label, url) => { if (!url) return; const a = el('a', null, label); a.href = url; a.target = '_blank'; a.rel = 'noopener'; links.append(a) }
    add('Zillow', f['Web Zillow']); add('Redfin', f['Web Redfin']); add('Realtor', f['Web Realtor.com']); add('County', f['Web County Records'])
    if (f['Web Sold Price'] || f['Web Sold Date']) links.append(el('span', 'muted', [f['Web Sold Price'], f['Web Sold Date']].filter(Boolean).join(' · ')))
    if (f['Web Property Type'] || f['Web Listing Status']) links.append(el('span', 'muted', [f['Web Property Type'], f['Web Listing Status']].filter(Boolean).join(' · ')))
    if (r.evidence && r.evidence[0]?.file && job) { const a = el('a', null, '📷'); a.href = `/evidence/${job.id}/${r.evidence[0].file.split(/[\\/]/).pop()}`; a.target = '_blank'; a.title = 'PropertyRadar screenshot'; links.append(a) }
    webTd.append(links)
    const st = f['PR Status'] || ''
    const stCls = st === 'found' ? 'pill-ok' : st === 'not found' || st === 'error' ? 'pill-bad' : st === 'skipped' ? 'pill-muted' : 'pill-warn'
    const stTd = el('td')
    stTd.append(el('span', 'pill ' + stCls, st))
    if (f['Enrichment Notes']) stTd.title = f['Enrichment Notes']
    tr.append(
      el('td', 'num', String(r.i + 1)),
      el('td', 'addr', r.address || f['Enriched Address'] || '(no address)'),
      ownerTd,
      el('td', null, f['PR APN'] || ''),
      el('td', null, f['PR Owner Mailing Address'] || ''),
      matchTd,
      webTd,
      stTd,
    )
    const wrap = tr.closest('.table-wrap')
    if (wrap && ['running', 'login', 'paused'].includes(job?.state)) wrap.scrollTop = wrap.scrollHeight
  }

  function addLog(msg, kind) {
    if (!msg) return
    const line = el('div', 'log-line ' + (kind || ''), msg)
    $('en-log').append(line)
    $('en-log').scrollTop = $('en-log').scrollHeight
  }

  // ---- controls ------------------------------------------------------------------
  async function control(action) {
    if (!job) return
    await fetch(`/api/enrich/${job.id}/control/${action}`, { method: 'POST' })
    if (action === 'resume') hide('en-login-banner')
  }

  function download() {
    if (!job) return
    window.open(`/api/enrich/${job.id}/download`, '_blank')
  }

  // ---- previous jobs ---------------------------------------------------------------
  async function loadJobs() {
    try {
      const jobs = await (await fetch('/api/enrich')).json()
      const box = $('en-jobs')
      box.innerHTML = ''
      if (!jobs.length) { box.innerHTML = '<p class="muted">No jobs yet.</p>'; return }
      const anyActive = jobs.some((j) => ['running', 'paused', 'login'].includes(j.state))
      jobs.slice(0, 20).forEach((j) => {
        const block = el('div', 'run-block')
        const head = el('div', 'run-item-head')
        head.style.display = 'flex'; head.style.justifyContent = 'space-between'; head.style.gap = '10px'
        head.append(el('span', 'run-name', j.filename), el('span', 'pill ' + pillFor(j.state), j.state))
        block.append(head)
        block.append(el('div', 'run-meta', `${j.done} / ${j.total} rows · ${j.found} found · ${new Date(j.createdAt).toLocaleString()}`))
        const acts = el('div', 'run-actions')
        const open = el('button', 'btn', 'Open'); open.onclick = () => openJob(j.id); acts.append(open)
        if (!['running', 'paused', 'login'].includes(j.state) && j.done < j.total && !anyActive) {
          const res = el('button', 'btn', j.done ? 'Resume' : 'Start'); res.onclick = () => startJob(j.id, {}, 'en-upload-error'); acts.append(res)
        }
        if (j.done) { const dl = el('button', 'btn btn-secondary', 'Download'); dl.onclick = () => window.open(`/api/enrich/${j.id}/download`, '_blank'); acts.append(dl) }
        block.append(acts)
        box.append(block)
      })
      // Re-attach to a job that is running (page reload mid-batch).
      const active = jobs.find((j) => ['running', 'paused', 'login'].includes(j.state))
      if (active && (!job || job.id !== active.id)) openJob(active.id)
    } catch { /* ignore */ }
  }

  function pillFor(s) {
    if (s === 'done') return 'pill-ok'
    if (s === 'running' || s === 'paused' || s === 'login') return 'pill-warn'
    if (s === 'error') return 'pill-bad'
    return 'pill-muted'
  }

  // ---- helpers ----------------------------------------------------------------------
  async function readJson(r) {
    const raw = await r.text()
    try { return raw ? JSON.parse(raw) : {} } catch { return { error: raw.slice(0, 300) } }
  }
  function show(id) { $(id).hidden = false }
  function hide(id) { $(id).hidden = true }
  function showErr(id, msg) { $(id).textContent = msg; $(id).hidden = false }
})()
