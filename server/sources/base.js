// Shared helpers and the common shape every source module returns.
//
// Each source module exports:
//   id           short machine id, e.g. "propertyradar"
//   label        display name, e.g. "PropertyRadar"
//   loginGated   true if the site requires the operator to be signed in
//   async run(ctx) -> SourceResult
//
// ctx = { page, input, data, runDir, emit, signal }
//   page   Playwright page (shared persistent context)
//   input  the lead input { address, name, phone, email, reiLink, ... }
//   data   accumulated findings so far (read-only view of other sources)
//   emit   (event) => void  — push a progress event to the UI
//   signal AbortSignal — throws/aborts navigation when the operator hits Stop
//
// SourceResult:
//   { source, ok, loginRequired, data, evidence: [], notes: [] }
//
// Modules must NEVER throw to the orchestrator — wrap risky work and return
// ok:false with a note instead, so one flaky site can't kill the run.

export function emptyResult(source) {
  return {
    source,
    ok: false,
    loginRequired: false,
    data: {},
    evidence: [],
    notes: [],
  }
}

// Best-effort text extraction for a selector; returns '' if not found.
export async function textOf(page, selector) {
  try {
    const el = page.locator(selector).first()
    if ((await el.count()) === 0) return ''
    return ((await el.innerText({ timeout: 2000 })) || '').trim()
  } catch {
    return ''
  }
}

// Navigate with a timeout, honoring the Stop signal. Returns true on success.
export async function goto(page, url, { signal } = {}) {
  if (signal?.aborted) throw new Error('stopped')
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await settle(page) // wait for the app's content to finish rendering
  return true
}

// Wait until the page has finished rendering. Uses the DOM node COUNT as the
// readiness signal (it grows while a single-page app renders, then plateaus) —
// unlike text length, it isn't disturbed by a ticking clock or activity feed,
// so it settles quickly instead of always hitting the timeout.
export async function settle(page, { timeout = 9000, minNodes = 60 } = {}) {
  // Let initial requests finish (ignored quickly if the site long-polls).
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
  const start = Date.now()
  let last = -1
  let stable = 0
  while (Date.now() - start < timeout) {
    const count = await page.evaluate(() => document.querySelectorAll('*').length).catch(() => 0)
    if (count >= minNodes && count === last) {
      if (++stable >= 2) return // ~0.8s of stability -> rendered
    } else {
      stable = 0
    }
    last = count
    await page.waitForTimeout(400)
  }
}

// Normalize a US phone to digits for comparison.
export function normPhone(s) {
  return String(s || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
}

// Normalize a name for loose comparison: lowercase, drop punctuation, sort the
// word set so "Barber Phillip Lyman" ~ "Phillip Lyman Barber".
export function normNameSet(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}
