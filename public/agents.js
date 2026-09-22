// Agent List tab — goal 2. Give it a Redfin search, it walks the result pages,
// reads each property and groups them by listing agent.
//
// SSE events arrive via window.agentsHandle, forwarded by app.js. No build step.
;(function () {
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  const hide = (id) => { $(id).hidden = true }
  const showErr = (id, msg) => { const n = $(id); n.textContent = msg; n.hidden = false }

  let job = null

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('ag-files')) return
    window.agentsHandle = handleEvent
    $('ag-files').onchange = uploadFiles
    $('ag-search-go').onclick = useSearch
    $('ag-crawl').onclick = crawl
    $('ag-start').onclick = start
    $('ag-pause').onclick = () => control('pause')
    $('ag-resume').onclick = () => control('resume')
    $('ag-stop').onclick = () => control('stop')
    $('ag-download').onclick = () => download('')
    $('ag-download-props').onclick = () => download('properties')
    loadRuns()
  })

  async function readFile(file) {
    return { name: file.name, text: await file.text() }
  }

  async function uploadFiles(ev) {
    const files = [...(ev.target.files || [])]
    hide('ag-upload-error')
    if (!files.length) return
    try {
      const payload = { files: await Promise.all(files.map(readFile)) }
      const r = await fetch('/api/agents/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await r.json()
      if (!r.ok) return showErr('ag-upload-error', data.error || `Could not read those files (HTTP ${r.status}).`)
      job = data
      showSetup(data)
      render(data)
      loadRuns()
    } catch (err) {
      showErr('ag-upload-error', 'Could not read those files. (' + (err?.message || err) + ')')
    }
  }

  // A search URL instead of files: the app walks the pages itself.
  async function useSearch() {
    hide('ag-search-error')
    const btn = $('ag-search-go')
    btn.disabled = true
    try {
      const r = await fetch('/api/agents/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchUrl: $('ag-search-url').value.trim(), propertyTypes: ['house', 'multifamily'] }),
      })
      const data = await r.json()
      if (!r.ok) return showErr('ag-search-error', data.error || `Could not use that search (HTTP ${r.status}).`)
      job = data
      showSetup(data)
      render(data)
      loadRuns()
    } catch (err) {
      showErr('ag-search-error', 'Could not reach the server. (' + (err?.message || err) + ')')
    } finally {
      btn.disabled = false
    }
  }

  // Walk the search without starting the reading pass, so the size of the job
  // is visible before committing hours to it.
  async function crawl() {
    if (!job) return
    hide('ag-start-error')
    const btn = $('ag-crawl')
    btn.disabled = true
    try {
      const r = await fetch(`/api/agents/${job.id}/crawl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxPages: parseInt($('ag-pages').value || '400', 10) }),
      })
      const data = await r.json()
      if (!r.ok) return showErr('ag-start-error', data.error || `Could not walk that search (HTTP ${r.status}).`)
      render(data)
    } catch (err) {
      showErr('ag-start-error', 'Could not reach the server. (' + (err?.message || err) + ')')
    } finally {
      btn.disabled = false
    }
  }

  function showSetup(s) {
    $('ag-setup-card').hidden = false
    const fromSearch = s.source === 'search'
    $('ag-pages-row').hidden = !fromSearch
    // The button stays available while the search still has pages left, so a
    // crawl that stopped short can be topped up rather than restarted.
    const short = Boolean(s.crawl?.totalPages) && s.crawl.through < s.crawl.totalPages
    $('ag-crawl').hidden = !fromSearch || (s.total > 0 && !short)
    $('ag-crawl').textContent = s.total > 0 ? 'Walk the rest of the search' : 'Find the properties first'
    const saves = 'It saves after every property, so you can stop and pick up later.'

    if (fromSearch && !s.total) {
      // Nothing walked yet, so the count is not knowable — say what happens
      // next instead of guessing at a number.
      $('ag-setup-title').textContent = 'Ready to walk the search'
      $('ag-setup-sub').textContent =
        `Start walks the result pages, collects every property in that search, then reads them one by one. San Francisco sold in 24 months is around 13,000 properties, or about 5,600 with house and multi-family only — the page count shows up as soon as it starts. ${saves}`
    } else {
      $('ag-setup-title').textContent = `${s.total.toLocaleString()} properties to read`
      const already = s.read ? ` ${s.read.toLocaleString()} already read.` : ''
      const mins = Math.round((s.total - s.read) * 2.4 / 60)
      const hrs = mins >= 90 ? ` (about ${(mins / 60).toFixed(1)} hours)` : ''
      // "7 pages walked" reads like success whether the search had 7 pages or
      // 328. Always say how many there were, so a crawl that stopped short
      // cannot be mistaken for the whole city.
      const c = s.crawl || {}
      const from = fromSearch
        ? `From the search, ${c.through || 0} of ${c.totalPages ? c.totalPages.toLocaleString() : '?'} result pages walked.`
        : `From ${s.filenames.length} file${s.filenames.length === 1 ? '' : 's'}, duplicates removed.`
      $('ag-setup-sub').textContent =
        `${from}${already} At the default pace that is roughly ${mins} minute${mins === 1 ? '' : 's'}${hrs}. ${saves}`
    }
    // A short crawl is the failure that looks most like a success: a few hundred
    // properties read cleanly, and no sign that the other nine tenths of the
    // city were never fetched.
    const c = s.crawl || {}
    if (fromSearch && c.totalPages && c.through < c.totalPages) {
      const left = c.totalPages - c.through
      $('ag-banner').hidden = false
      $('ag-banner').textContent =
        `This is part of the search, not all of it: ${c.through} of ${c.totalPages} result pages, ${left} still to walk.` +
        (c.error ? ` It stopped because: ${c.error}.` : ' It stopped early.') +
        ' Press "Walk the rest of the search" to pick up where it stopped — nothing already collected is re-walked. Reading what you have now is fine, but it is a slice of the city, not the city.'
    }
    for (const w of s.warnings || []) addLog(w, 'warn')
  }

  async function start() {
    if (!job) return
    hide('ag-start-error')
    const body = {
      delayMs: Math.round(parseFloat($('ag-delay').value || '1.5') * 1000),
      minDeals: parseInt($('ag-min').value || '1', 10),
    }
    const btn = $('ag-start')
    btn.disabled = true
    try {
      const r = await fetch(`/api/agents/${job.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) return showErr('ag-start-error', data.error || `Could not start (HTTP ${r.status}).`)
      render(data)
    } catch (err) {
      showErr('ag-start-error', 'Could not reach the server. (' + (err?.message || err) + ')')
    } finally {
      btn.disabled = false
    }
  }

  async function control(action) {
    if (!job) return
    await fetch(`/api/agents/${job.id}/control/${action}`, { method: 'POST' })
    if (action === 'resume') hide('ag-banner')
  }

  function download(what) {
    if (!job) return
    window.location = `/api/agents/${job.id}/download${what ? `?what=${what}` : ''}`
  }

  function addLog(message, level) {
    const box = $('ag-log')
    box.append(el('div', 'log-line' + (level ? ' ' + level : ''), message))
    box.scrollTop = box.scrollHeight
  }

  function render(s) {
    if (!s) return
    job = { ...(job || {}), ...s }
    const active = s.state === 'running' || s.state === 'paused' || s.state === 'crawling'
    $('ag-chip').textContent = s.state === 'crawling' ? 'walking the search' : s.state
    $('ag-count-read').textContent = `${(s.read || 0).toLocaleString()} / ${(s.total || 0).toLocaleString()}`
    $('ag-eta').textContent = active && s.etaMinutes ? `about ${s.etaMinutes} min left` : ''
    $('ag-progress').textContent = s.read
      ? `${s.withAgent || 0} with an agent · ${s.ourKind || 0} of our kind${s.blocked ? ` · ${s.blocked} blocked` : ''}`
      : ''
    $('ag-spinner').hidden = s.state !== 'running' && s.state !== 'crawling'
    $('ag-pause').hidden = s.state !== 'running'
    $('ag-resume').hidden = s.state !== 'paused'
    $('ag-stop').hidden = !active
    $('ag-bar').style.width = s.total ? `${Math.round(((s.read || 0) / s.total) * 100)}%` : '0%'
    $('tab-dot-agents').hidden = !active
  }

  function renderAgents(agents, summary) {
    const box = $('ag-table')
    box.textContent = ''
    if (!agents?.length) {
      box.append(el('p', 'muted', 'No agents yet. They appear as properties are read.'))
      return
    }
    $('ag-count').textContent = summary ? `${summary.agents} agents from ${summary.ourKind} of our kind of deal` : ''
    const table = el('table')
    const head = el('tr')
    for (const h of ['#', 'Agent', 'Brokerage', 'Ours', 'Total', 'Share', 'Median DOM', 'Last deal', 'Phone']) head.append(el('th', null, h))
    table.append(head)
    agents.forEach((a, i) => {
      const tr = el('tr')
      const cells = [
        String(i + 1),
        a.name,
        a.brokerage || '',
        String(a.ourDeals),
        String(a.totalSales),
        `${a.share}%`,
        a.medianDom == null ? '' : String(a.medianDom),
        a.lastDeal || '',
        a.phone || '',
      ]
      for (const c of cells) tr.append(el('td', null, c))
      table.append(tr)
    })
    box.append(table)
  }

  async function refreshTop() {
    if (!job) return
    try {
      const r = await fetch(`/api/agents/${job.id}`)
      if (!r.ok) return
      const data = await r.json()
      render(data)
      renderAgents(data.top, data.summary)
    } catch { /* the stream will catch up */ }
  }

  let lastRefresh = 0
  function handleEvent(ev) {
    if (job && ev.id !== job.id) return
    switch (ev.sub) {
      case 'log':
        addLog(ev.message, ev.level)
        break
      case 'state':
        render({ ...(job || {}), state: ev.state })
        if (ev.state === 'paused' && ev.message) { $('ag-banner').hidden = false; $('ag-banner').textContent = ev.message }
        if (ev.state === 'running') hide('ag-banner')
        if (ev.message) addLog(ev.message, 'state')
        break
      case 'crawl':
        // The crawl has its own measure — pages, not properties — so it drives
        // the same bar off the page count while it runs.
        $('ag-count-read').textContent = `${ev.collected.toLocaleString()} properties`
        $('ag-progress').textContent = `page ${ev.page}${ev.totalPages ? ` of ${ev.totalPages}` : ''}`
        $('ag-bar').style.width = ev.totalPages ? `${Math.round((ev.page / ev.totalPages) * 100)}%` : '0%'
        break
      case 'crawled':
        render(ev)
        showSetup(ev)
        break
      case 'row': {
        render({ ...(job || {}), ...ev })
        // The table is a roll-up of everything so far, so refresh it on a timer
        // rather than on every property.
        const now = Date.now()
        if (now - lastRefresh > 10000) { lastRefresh = now; refreshTop() }
        break
      }
      case 'done':
        render({ ...(job || {}), state: ev.state, read: ev.read, total: ev.total })
        addLog(ev.message, 'state')
        // A run that finished with nothing needs its reason on screen, not
        // buried in the log where it scrolls away.
        if (ev.diagnosis) { $('ag-banner').hidden = false; $('ag-banner').textContent = ev.diagnosis }
        refreshTop()
        loadRuns()
        break
      default:
        break
    }
  }

  async function loadRuns() {
    try {
      const r = await fetch('/api/agents')
      if (!r.ok) return
      const runs = await r.json()
      const box = $('ag-runs')
      box.textContent = ''
      if (!runs.length) { box.append(el('p', 'muted', 'No runs yet.')); return }
      for (const run of runs.slice(0, 8)) {
        const row = el('div', 'run')
        row.append(el('div', null, `${run.read.toLocaleString()} / ${run.total.toLocaleString()} read · ${run.state}${run.source === 'search' ? ' · from a search' : ''}`))
        row.append(el('div', 'muted', new Date(run.createdAt).toLocaleString()))
        const open = el('button', 'btn', run.state === 'done' ? 'Open' : 'Resume')
        open.onclick = async () => {
          job = { id: run.id }
          await refreshTop()
          showSetup(job)
          if (run.state !== 'done' && run.read < run.total) start()
        }
        row.append(open)
        box.append(row)
      }
    } catch { /* list is a convenience */ }
  }
})()
