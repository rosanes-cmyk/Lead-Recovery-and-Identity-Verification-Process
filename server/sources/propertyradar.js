// PropertyRadar — recorded owner, vesting, ownership type, owner mailing
// address, property address, occupancy, APN, phones, emails, trust/entity.
//
// Automated address lookup, following the verified live-app flow:
//   1. open app.propertyradar.com and WAIT OUT the radar loading spinner
//   2. click the "Full Address" toolbar button
//   3. type the address into "Enter Site Address"
//   4. pick the ALL-CAPS autocomplete match
//   5. click the green "Add Criteria" button
//   6. double-click the result row to open the property profile
//   7. read the Contacts / Property / Value / Transactions tabs
// Read-only: it never adds to lists, exports, or skip-traces. If it can't drive
// the search (not logged in, layout changed), it falls back to asking the
// operator so a run never dead-ends.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto, settle } from './base.js'
import { selectors, fillUrl } from './selectors.js'
import { extractFields, FIELD_NOT_FOUND } from './extract.js'

export const id = 'propertyradar'
export const label = 'PropertyRadar'
export const loginGated = true

const PROFILE_TABS = ['Contacts', 'Property', 'Value & Equity', 'Transactions']

export async function run(ctx) {
  const { page, input, emit, runDir, signal, pauseForAction } = ctx
  const res = emptyResult(label)
  res.audit = []
  const cfg = selectors.propertyradar

  const directUrl = fillUrl(cfg.searchUrlForAddress, { address: input.address })
  try {
    emit({ type: 'log', source: label, message: `Opening PropertyRadar${input.address ? ' for ' + input.address : ''}` })
    await goto(page, directUrl || cfg.loginUrl, { signal })
  } catch (err) {
    res.notes.push(`Could not open PropertyRadar: ${String(err)}`)
    res.evidence.push(await capture(page, runDir, 'propertyradar-error'))
    return res
  }

  // The app shows a radar spinner for 5–30s with no content. Wait it out.
  // (Skip when a direct URL was used — the page is already the target.)
  const ready = directUrl ? true : await waitForAppReady(page, emit, signal)
  if (!ready && (await looksLikeLogin(page))) {
    res.loginRequired = true
    res.evidence.push(await capture(page, runDir, 'propertyradar-login'))
    return res // orchestrator pauses for one-time login, then retries
  }

  let searched = false
  if (!directUrl && input.address && ready) {
    searched = await autoSearch(page, input.address, cfg, emit, signal)
    if (searched) await readProfileTabs(page, emit, signal)
  }

  let out = await extractAndBuild(page, cfg, res, runDir)

  // Fallback: if auto-search couldn't open the property, ask the operator once.
  if (!out.ok && typeof pauseForAction === 'function' && !signal?.aborted) {
    emit({ type: 'log', source: label, message: 'Auto-search did not open the property; asking operator' })
    await pauseForAction(
      `Couldn't open the property automatically. In the PropertyRadar BROWSER window, open the property for ${input.address || 'this lead'}, then click Resume.`,
    )
    if (!signal?.aborted) {
      await readProfileTabs(page, emit, signal)
      out = await extractAndBuild(page, cfg, res, runDir)
    }
  }

  if (!out.ok) res.notes.push('Recorded owner not found. If PropertyRadar changed its layout, re-share the search steps or run `npm run calibrate -- propertyradar <property-url>`.')
  return res
}

// Wait until the SPA has finished the radar spinner and shows real content.
// PropertyRadar can spin 5–30s (sometimes more); wait patiently and reload once
// if it's still blank, per the verified flow.
const READY_RE = /add criteria|discover|i'?m radar|full address|property profile/i
async function waitForAppReady(page, emit, signal) {
  emit({ type: 'log', source: label, message: 'Waiting for PropertyRadar to finish loading…' })
  for (let pass = 0; pass < 2; pass++) {
    // Up to ~40s per pass.
    for (let i = 0; i < 13; i++) {
      if (signal?.aborted) return false
      const txt = await page.innerText('body').catch(() => '')
      if (READY_RE.test(txt)) return true
      if (await looksLikeLogin(page)) return false
      await page.waitForTimeout(3000)
    }
    if (pass === 0 && !signal?.aborted) {
      emit({ type: 'log', source: label, message: 'Still loading — reloading PropertyRadar once…' })
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    }
  }
  emit({ type: 'log', source: label, message: 'PropertyRadar did not finish loading in time.' })
  return false
}

// Drive the Full Address search all the way to the property profile.
async function autoSearch(page, address, cfg, emit, signal) {
  const streetNum = (address.match(/^\s*(\d+)/) || [])[1] || address.split(',')[0]
  try {
    // If we're already on a property profile, nothing to search.
    if (/\/detail\//i.test(page.url())) return true

    emit({ type: 'log', source: label, message: 'Opening Full Address search' })
    if (!(await clickFirst(page, [
      () => page.getByRole('button', { name: /^Full Address$/i }),
      () => page.getByRole('link', { name: /^Full Address$/i }),
      () => page.locator('button:has-text("Full Address"), a:has-text("Full Address")'),
      () => page.getByText(/^Full Address$/i),
    ]))) return false
    await page.waitForTimeout(1200)

    emit({ type: 'log', source: label, message: `Typing address: ${address}` })
    const box = await firstVisible(page, [
      () => page.getByPlaceholder(/Enter Site Address/i),
      () => page.getByPlaceholder(/site address/i),
      () => page.locator(cfg.searchBox || 'input[placeholder*="Address" i]'),
    ])
    if (!box) return false
    await box.click({ timeout: 3000 })
    await box.fill(address, { timeout: 3000 })
    await page.waitForTimeout(1800)

    // Pick the ALL-CAPS autocomplete row that matches the address.
    const picked = await clickFirst(page, [
      () => page.getByRole('option').filter({ hasText: new RegExp(streetNum) }),
      () => page.locator('[role="option"], li, .pac-item, .autocomplete-item, .dropdown-item').filter({ hasText: new RegExp(streetNum) }),
      () => page.getByText(new RegExp(streetNum + '\\s+\\w+', 'i')),
    ])
    if (!picked) {
      emit({ type: 'log', source: label, message: 'No autocomplete match — address may not be in PropertyRadar' })
      return false
    }
    await page.waitForTimeout(800)

    emit({ type: 'log', source: label, message: 'Running search (Add Criteria)' })
    await clickFirst(page, [
      () => page.getByRole('button', { name: /^Add Criteria$/i }),
      () => page.locator('button:has-text("Add Criteria")'),
    ])
    await page.waitForTimeout(3000)

    emit({ type: 'log', source: label, message: 'Opening property profile' })
    const row = await firstVisible(page, [
      () => page.locator('[role="row"], tr').filter({ hasText: new RegExp(streetNum) }),
      () => page.getByText(new RegExp(streetNum + '\\s+\\w+', 'i')),
    ])
    if (row) {
      await row.dblclick({ timeout: 4000 }).catch(async () => {
        await row.click({ timeout: 3000 }).catch(() => {})
      })
    }
    await page.waitForTimeout(3000)
    await settle(page)
    return /\/detail\//i.test(page.url()) || /property profile/i.test(await page.title().catch(() => ''))
  } catch (err) {
    emit({ type: 'log', source: label, message: `Auto-search issue: ${String(err).slice(0, 120)}` })
    return false
  }
}

// Click through the profile tabs so the whole record is loaded/visible.
async function readProfileTabs(page, emit, signal) {
  for (const tab of PROFILE_TABS) {
    if (signal?.aborted) return
    try {
      const t = page.getByText(new RegExp(`^${tab.replace(/&/g, '&')}$`, 'i')).first()
      if ((await t.count()) > 0) {
        await t.click({ timeout: 2000 })
        await page.waitForTimeout(800)
      }
    } catch {
      /* tab not present */
    }
  }
  // Return to Contacts so owner/contact fields are on screen for extraction.
  try {
    const c = page.getByText(/^Contacts$/i).first()
    if ((await c.count()) > 0) { await c.click({ timeout: 2000 }); await settle(page) }
  } catch { /* ignore */ }
}

// PropertyRadar profile tab/section labels that must never be taken as an owner
// name (the label-based match can grab these by mistake).
const NOT_A_NAME = /^(value,?\s*equity\s*&?\s*tax|value\s*&?\s*equity|equity|transactions|neighborhood|listings|my info|contacts|property|overview|summary|tax)$/i

async function extractAndBuild(page, cfg, res, runDir) {
  res.evidence.push(await capture(page, runDir, 'propertyradar-result'))
  const { values, audit } = await extractFields(page, cfg.fields, { listFields: ['phones', 'emails'], semantics: { phones: 'phone', emails: 'email' } })
  res.audit.push(...audit.map((a) => ({ page: 'Property', ...a })))
  // Reject section headers that slipped into the owner field.
  if (values.recordedOwner && NOT_A_NAME.test(String(values.recordedOwner).trim())) {
    values.recordedOwner = FIELD_NOT_FOUND
  }
  res.data = {
    ownerName: values.recordedOwner,
    ownershipType: values.ownershipType,
    vesting: values.vesting,
    mailingAddress: values.ownerMailingAddress,
    propertyAddress: values.propertyAddress,
    occupancy: values.occupancy,
    apn: values.apn,
    phones: values.phones,
    emails: values.emails,
    trustEntity: values.trustEntity,
  }
  res.ok = Boolean(values.recordedOwner && values.recordedOwner !== FIELD_NOT_FOUND)
  return res
}

/* ---------- click helpers ---------- */
// Try each locator factory; click the first that resolves to a visible element.
async function clickFirst(page, factories) {
  for (const make of factories) {
    try {
      const loc = make().first()
      if ((await loc.count()) === 0) continue
      await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
      await loc.click({ timeout: 2500 })
      return true
    } catch {
      /* try next */
    }
  }
  return false
}

async function firstVisible(page, factories) {
  for (const make of factories) {
    try {
      const loc = make().first()
      if ((await loc.count()) > 0) return loc
    } catch {
      /* try next */
    }
  }
  return null
}
