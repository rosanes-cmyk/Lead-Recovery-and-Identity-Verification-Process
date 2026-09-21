// PropertyRadar — recorded owner, vesting, ownership type, owner mailing
// address, property address, occupancy, APN, phones, emails, trust/entity.
//
// Automated address lookup, following the verified live-app flow:
//   1. open app.propertyradar.com and WAIT OUT the radar loading spinner
//   2. click the "Full Address" toolbar button
//   3. type the address into "Enter Site Address"
//   4. pick the ALL-CAPS autocomplete match
//   5. click the green "Add Criteria" button
//   6. open the property: the result row (list view) or the map marker →
//      "Property Info" modal → its address link (map view)
//   7. read the Contacts / Property / Value / Transactions tabs
// Read-only: it never adds to lists, exports, or skip-traces. If it can't drive
// the search (not logged in, layout changed), it falls back to asking the
// operator so a run never dead-ends.

import { looksLikeLogin, capture } from '../browser.js'
import { emptyResult, goto, settle } from './base.js'
import { selectors, fillUrl } from './selectors.js'
import { extractFields, FIELD_NOT_FOUND } from './extract.js'
import { addressMatch } from '../csv.js'

export const id = 'propertyradar'
export const label = 'PropertyRadar'
export const loginGated = true

const PROFILE_TABS = ['Contacts', 'Property', 'Value & Equity', 'Transactions']

export async function run(ctx) {
  const { page, input, emit, runDir, signal, pauseForAction, pauseForActionUntil } = ctx
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
  let tabsText = ''
  if (!directUrl && input.address && ready) {
    searched = await autoSearch(page, input.address, cfg, emit, signal, res, runDir)
    if (searched) tabsText = await readProfileTabs(page, emit, signal)
  }

  let out = await extractAndBuild(page, cfg, res, runDir, input, tabsText)

  // PropertyRadar's single-session limit: a second login (another browser/run on
  // the same account) evicts this one. Detect it and say so plainly — no amount
  // of retrying helps until only one session is active.
  if (!out.ok && (await sessionKicked(page))) {
    res.evidence.push(await capture(page, runDir, 'propertyradar-session-kicked'))
    res.notes.push('PropertyRadar logged this session out: "Another user has logged in to this account." PropertyRadar allows only ONE active session — close other PropertyRadar logins (other browsers/tabs, or a second run) and try again.')
    emit({ type: 'log', source: label, message: 'PropertyRadar kicked this session (single-session limit — another login is active). Close other PropertyRadar sessions and retry.' })
    return res
  }

  // If auto-search couldn't open/read the property, pause for the operator to
  // open it — and AUTO-CONTINUE the moment the property profile is on screen,
  // exactly like People Search auto-continues when its captcha clears. We resume
  // as soon as EITHER the owner is already readable OR the property-detail page
  // is clearly open (the operator's part is done) — no manual Resume needed.
  if (!out.ok && !signal?.aborted) {
    // Snapshot whatever PropertyRadar screen we're stuck on so it shows in the
    // Evidence panel (helps pinpoint the exact 'open property' click to automate).
    res.evidence.push(await capture(page, runDir, 'propertyradar-search-screen'))
    emit({ type: 'log', source: label, message: 'Auto-search did not open the property; asking operator (will auto-continue when the property is open)' })
    const msg = `Open the property for ${input.address || 'this lead'} in the PropertyRadar BROWSER window — I'll continue automatically once the property profile is on screen (or click Resume).`
    // Resume only when a property is genuinely open: the /detail/ URL, or the
    // rendered text shows a real owner (Taxpayer line). Reading from text is what
    // survives PropertyRadar's React DOM — the positional engine can't see it.
    const profileReady = async () => {
      try {
        if (/\/detail\//i.test(page.url())) return true
        const txt = await page.innerText('body').catch(() => '')
        const taxpayer = textLabelValue(txt, 'Taxpayer')
        if (taxpayer) {
          const nm = taxpayer.split(/,\s*(?=\d)/)[0].trim()
          if (looksLikeName(nm) || ENTITY_RE.test(nm)) return true
        }
        return false
      } catch {
        return false
      }
    }
    if (typeof pauseForActionUntil === 'function') {
      await pauseForActionUntil(msg, profileReady, { timeoutMs: 4 * 60 * 1000 })
    } else if (typeof pauseForAction === 'function') {
      await pauseForAction(msg)
    }
    if (!signal?.aborted) {
      tabsText = await readProfileTabs(page, emit, signal)
      out = await extractAndBuild(page, cfg, res, runDir, input, tabsText)
    }
  }

  if (!out.ok) res.notes.push('Recorded owner not found. If PropertyRadar changed its layout, re-share the search steps or run `npm run calibrate -- propertyradar <property-url>`.')
  return res
}

// Wait until the SPA has finished the radar spinner and shows real content.
// PropertyRadar can spin 5–30s (sometimes more); wait patiently and reload once
// if it's still blank, per the verified flow.
const READY_RE = /add criteria|discover|i'?m radar|full address|property profile/i
export async function waitForAppReady(page, emit, signal) {
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

// Drive the "Full Address" search to the property profile.
//
// PropertyRadar is an ExtJS app. Verified live (in the dispute app, then here):
//  - its loading masks intercept pointer events, so a NORMAL click never becomes
//    "actionable" and times out — every click here uses force
//  - the address box is input[placeholder="Enter Site Address"]; fill() is
//    enough to trigger the autocomplete (real keystrokes as a fallback)
//  - suggestions are .x-boundlist-item and are normalised (ALL CAPS, unit added),
//    so they are never matched against the typed text — take the first
//  - there are TWO "Add Criteria" texts: a toolbar link (first in the DOM, a
//    silent no-op) and the green panel button (last) — click the LAST
//  - the result is a list-view grid row (double-click the address cell) or a
//    Leaflet map marker (.leaflet-marker-icon, 5–60s to render) whose
//    "Property Info" modal links to the detail page
// Captures a screenshot at each step when a result object is given.
export async function autoSearch(page, address, cfg, emit, signal, res, runDir) {
  const streetNum = (address.match(/^\s*(\d+)/) || [])[1] || address.split(',')[0]
  const snap = async (name) => { if (!res) return; try { res.evidence.push(await capture(page, runDir, 'propertyradar-' + name)) } catch { /* ignore */ } }
  try {
    if (/\/detail\//i.test(page.url())) return true

    // 1. Open the Full Address criterion.
    emit({ type: 'log', source: label, message: 'Opening Full Address search' })
    const siteBox = () => page.locator('input[placeholder="Enter Site Address"], input[placeholder*="Site Address" i]').first()
    // The toolbar renders after the app's spinner — give it time to exist.
    await page.locator('text="Full Address"').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {})
    let boxThere = false
    for (let i = 0; i < 3 && !boxThere; i++) {
      if (signal?.aborted) return false
      await clickFirst(page, [
        () => page.locator('text="Full Address" >> visible=true'),
        () => page.locator('text="Full Address"'),
        () => page.getByRole('button', { name: /^Full Address$/i }),
        () => page.getByRole('link', { name: /^Full Address$/i }),
        () => page.locator('button, a, [role="button"], span, div').filter({ hasText: /^\s*Full Address\s*$/i }),
      ], { force: true })
      boxThere = await siteBox().waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)
    }
    await snap('fulladdress-panel')
    if (!boxThere) {
      const atRoot = (await page.getByPlaceholder(/find criteria/i).count().catch(() => 0)) > 0
      emit({ type: 'log', source: label, message: `Full Address click did not open the address box${atRoot ? ' (criteria panel is at its root list)' : ''} — toolbar matches: ${await page.locator('text="Full Address"').count().catch(() => 0)}` })
      // "Full Address" flow unavailable on this layout — try the main search box.
      return await genericSearch(page, address, streetNum, emit, signal)
    }

    // 2. Type the address; wait for the suggestion list.
    emit({ type: 'log', source: label, message: `Typing address: ${address}` })
    const box = siteBox()
    await box.click({ timeout: 3000, force: true }).catch(() => {})
    await box.fill('').catch(() => {})
    await box.fill(address).catch(() => {})
    const items = () => page.locator('.x-boundlist-item')
    let suggestions = await items().first().waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false)
    if (!suggestions) {
      await box.fill('').catch(() => {})
      await box.pressSequentially(address, { delay: 60 }).catch(() => {})
      suggestions = await items().first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
    }
    await snap('address-typed')

    // 3. Pick the suggestion — prefer one starting with our street number.
    let matched = ''
    let picked = false
    if (suggestions) {
      const n = await items().count().catch(() => 0)
      let target = items().first()
      const numRe = new RegExp('^' + escapeRe(String(streetNum)) + '\\b')
      for (let k = 0; k < Math.min(n, 8); k++) {
        const t = (await items().nth(k).innerText().catch(() => '')).trim()
        if (numRe.test(t)) { target = items().nth(k); break }
      }
      matched = (await target.innerText().catch(() => '')).trim()
      picked = await target.click({ timeout: 3000, force: true }).then(() => true).catch(() => false)
    } else {
      // Other layouts: generic option lists.
      picked = await clickFirst(page, [
        () => page.getByRole('option').filter({ hasText: new RegExp(escapeRe(String(streetNum))) }),
        () => page.locator('[role="option"], li, .pac-item, .autocomplete-item, .dropdown-item, .suggestion').filter({ hasText: new RegExp(escapeRe(String(streetNum))) }),
      ], { force: true })
    }
    if (!picked) {
      emit({ type: 'log', source: label, message: 'No autocomplete match — PropertyRadar has no record for this address as typed.' })
      await snap('no-autocomplete')
      return false
    }
    emit({ type: 'log', source: label, message: `Address selected: ${matched || '(first suggestion)'}` })
    await page.waitForTimeout(600)
    await snap('after-autocomplete')

    // 4. Run the search with the LAST "Add Criteria" (the panel button).
    const addBtns = page.locator('text="Add Criteria"')
    const cnt = await addBtns.count().catch(() => 0)
    let ran = false
    if (cnt) ran = await addBtns.nth(cnt - 1).click({ timeout: 4000, force: true }).then(() => true).catch(() => false)
    if (!ran) {
      ran = await clickFirst(page, [
        () => page.getByRole('button', { name: /^Add Criteria$/i }),
        () => page.locator('button:has-text("Add Criteria")'),
      ], { force: true })
    }
    if (!ran) emit({ type: 'log', source: label, message: 'Could not click Add Criteria' })
    await page.waitForTimeout(2500) // map zoom + marker render begins
    await snap('after-add-criteria')

    // 5. Open the property.
    emit({ type: 'log', source: label, message: 'Waiting for the result, then opening the property' })
    const opened = await openProperty(page, streetNum, matched, signal, emit)
    await snap(opened ? 'opened-detail' : 'results-not-opened')
    return opened
  } catch (err) {
    emit({ type: 'log', source: label, message: `Auto-search issue: ${String(err).slice(0, 120)}` })
    return false
  }
}

// "Opened" = the /detail/ URL, or the profile's own labels in the rendered text
// (PropertyRadar may open the record without a clean URL change).
async function propertyOpen(page) {
  if (/\/detail\//i.test(page.url())) return true
  const txt = await page.innerText('body').catch(() => '')
  return /\btaxpayer\b/i.test(txt) && /(assessor parcel number|\btransactions\b|value,?\s*equity)/i.test(txt)
}

// After the search: open the matching property. Tries the list-view grid row
// (double-click the address cell) and the map marker → "Property Info" modal →
// address link → detail page, polling up to ~90s because the marker can take
// that long to render behind PropertyRadar's radar animation.
async function openProperty(page, streetNum, matched, signal, emit) {
  const numRe = new RegExp('\\b' + escapeRe(String(streetNum)) + '\\b')
  const deadline = Date.now() + 90000
  let modalTried = false
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    if (await propertyOpen(page)) return true
    if (await sessionKicked(page)) return false

    // a) list view: a grid row/cell carrying our street number
    const cell = await firstVisible(page, [
      () => page.getByRole('gridcell').filter({ hasText: numRe }),
      () => page.getByRole('cell').filter({ hasText: numRe }),
      () => page.getByRole('row').filter({ hasText: numRe }),
    ])
    if (cell) {
      await cell.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
      await cell.dblclick({ timeout: 3500, force: true }).catch(() => {})
      await page.waitForTimeout(1800)
      if (await propertyOpen(page)) return true
    }

    // b) map view: marker → Property Info modal → detail link
    const marker = page.locator('.leaflet-marker-icon').first()
    if (!modalTried && (await marker.count().catch(() => 0)) && (await marker.isVisible().catch(() => false))) {
      await marker.click({ timeout: 8000, force: true }).catch(() => {})
      // The modal's title renders first and its data loads after — wait for content.
      const loaded = await page.locator('.fr-modal-dialog-base:has-text("Property Type")').first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
      if (loaded) {
        modalTried = true
        const modal = page.locator('.fr-modal-dialog-base:has-text("Property Info")').first()
        const street = String(matched || '').split(',')[0].split('#')[0].trim()
        const candidates = [
          () => (street ? modal.locator(`text=/${escapeRe(street.slice(0, 25))}/i`) : modal.locator('a').filter({ hasText: numRe })),
          () => modal.locator('a').filter({ hasText: numRe }),
          () => modal.getByRole('link'),
        ]
        for (const make of candidates) {
          const link = make().first()
          if (!(await link.count().catch(() => 0))) continue
          await link.click({ timeout: 4000, force: true }).catch(() => {})
          await settle(page)
          if (await propertyOpen(page)) return true
        }
        emit({ type: 'log', source: label, message: 'Property Info opened but its detail link was not found' })
      }
    }
    await page.waitForTimeout(2500)
  }
  return await propertyOpen(page)
}

// PropertyRadar allows one session per account; a second login evicts this one
// with an "Another user has logged in" / "Invalid Session" modal.
export async function sessionKicked(page) {
  try {
    const t = ((await page.innerText('body').catch(() => '')) || '').toLowerCase()
    return /another user has logged in|invalid session|your session (has )?expired|been logged out/i.test(t)
  } catch {
    return false
  }
}

// Fallback search when there's no "Full Address" button: type the address into
// whatever primary search box the current PropertyRadar UI shows, take the
// autocomplete match (or press Enter), then open the first result row.
async function genericSearch(page, address, streetNum, emit, signal) {
  try {
    // Never the criteria FILTER ("Find Criteria") or the mailing-address box:
    // typing an address into the filter opens whatever criterion it matches.
    const box = await firstVisible(page, [
      () => page.getByPlaceholder(/enter\s*(site\s*)?address/i),
      () => page.getByPlaceholder(/what are you searching for/i),
      () => page.getByPlaceholder(/^(?!.*(mailing|criteria)).*address/i),
    ])
    if (!box) {
      emit({ type: 'log', source: label, message: 'No address search box found on this PropertyRadar layout — run `npm run calibrate -- propertyradar` to capture it.' })
      return false
    }
    emit({ type: 'log', source: label, message: 'Searching PropertyRadar by address (main search box)' })
    await box.click({ timeout: 3000 })
    await box.fill(address, { timeout: 3000 })
    await page.waitForTimeout(2000)

    const picked = await clickFirst(page, [
      () => page.getByRole('option').filter({ hasText: new RegExp(streetNum) }),
      () => page.locator('[role="option"], li, .pac-item, .autocomplete-item, .dropdown-item').filter({ hasText: new RegExp(streetNum) }),
      () => page.getByText(new RegExp(streetNum + '\\s+\\w+', 'i')),
    ])
    if (!picked) await page.keyboard.press('Enter').catch(() => {})
    await page.waitForTimeout(3000)
    await settle(page)
    if (/\/detail\//i.test(page.url())) return true

    // Open the first result row/link for the property.
    const row = await firstVisible(page, [
      () => page.locator('[role="row"], tr, .result, .property-row').filter({ hasText: new RegExp(streetNum) }),
      () => page.getByText(new RegExp(streetNum + '\\s+\\w+', 'i')),
    ])
    if (row) {
      await row.dblclick({ timeout: 4000 }).catch(async () => { await row.click({ timeout: 3000 }).catch(() => {}) })
      await page.waitForTimeout(3000)
      await settle(page)
    }
    return /\/detail\//i.test(page.url())
  } catch {
    return false
  }
}

// Click through the profile tabs so the whole record is loaded, and RETURN the
// combined text of every tab. PropertyRadar is an SPA that swaps tab content, so
// we capture each tab's text as we visit it — the Transactions tab in particular
// holds the deed history we use to recover the individual homeowner on REO deals.
// Text that proves a tab's content is on screen (seen live, Sept 2026).
const TAB_MARKERS = {
  Contacts: /person type|ownership role|primary contact/i,
  Property: /assessor parcel number|legal description|property taxes/i,
  'Value & Equity': /estimated value|estimated equity/i,
  Transactions: /transaction history|grant deed|likely to list/i,
  Listings: /check for listings|\bMLS\b/i,
}
export async function readProfileTabs(page, emit, signal, tabs = PROFILE_TABS) {
  let text = ''
  for (const tab of tabs) {
    if (signal?.aborted) return text
    const re = new RegExp(`^${escapeRe(tab)}$`, 'i')
    const marker = TAB_MARKERS[tab]
    // Several elements can carry the tab's text (a hidden clone, a label such as
    // "Property Type" on a role match…): try role, then visible text, then any
    // text — and only accept a click that actually shows the tab's content.
    const factories = [
      () => page.getByRole('tab', { name: re }),
      () => page.locator(`text=/^${escapeRe(tab)}$/i >> visible=true`),
      () => page.getByText(re),
    ]
    let body = ''
    let verified = false
    for (const make of factories) {
      try {
        const t = make().first()
        if ((await t.count()) === 0) continue
        await t.click({ timeout: 2000, force: true })
        await page.waitForTimeout(800)
        body = await page.innerText('body').catch(() => '')
        if (!marker || marker.test(body)) { verified = true; break }
      } catch {
        /* try the next way */
      }
    }
    if (body) text += '\n\n' + body
    if (!verified && emit) emit({ type: 'log', source: label, message: `Could not confirm the ${tab} tab opened` })
  }
  // Return to Contacts so owner/contact fields are on screen for extraction.
  try {
    const c = page.getByText(/^Contacts$/i).first()
    if ((await c.count()) > 0) { await c.click({ timeout: 2000, force: true }); await settle(page); text += '\n\n' + (await page.innerText('body').catch(() => '')) }
  } catch { /* ignore */ }
  return text
}

// PropertyRadar profile tab/section labels that must never be taken as an owner
// name (the label-based match can grab these by mistake).
const NOT_A_NAME = /^(value,?\s*equity\s*&?\s*tax|value\s*&?\s*equity|equity|transactions|neighborhood|listings|my info|contacts?|property|overview|summary|tax|owner phone number|owner email( address)?|phone number|email address|contact information|owner (info|information)|activities|owner|person|trust|company|primary contact|no notes|add note|edit)$/i
// A real owner name never contains these label words.
const LABEL_WORDS = /\b(phone number|email address|equity|activities|primary contact|person type|ownership role|skip trace|mailing address|primary residence|other properties|gender|notes)\b/i

function looksLikeName(v) {
  const s = String(v || '').trim()
  if (!s || s === FIELD_NOT_FOUND) return false
  // Letters, spaces and name punctuation only — never digits, checkboxes (☑) or other symbols.
  if (/[^\p{L} .,'&\-]/u.test(s)) return false
  if (NOT_A_NAME.test(s) || LABEL_WORDS.test(s)) return false
  return true
}

// A company/entity/lender owner — common on foreclosure/REO properties, where
// the title has flipped to the lender and the person we want is a prior owner.
const ENTITY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CO|COMPANY|SERVICING|TRUST|BANK|N\.?A\.?|MORTGAGE|LOAN|LOANDEPOT|FUND(?:ING)?|HOLDINGS|PROPERTIES|SERVICES|LP|LLP|ASSOCIATION|PARTNERS|CAPITAL|REO|HOA|ESCROW|TITLE)\b/i

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, ' ').trim()
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// Read a label's value straight from the page's TEXT (innerText of the tabs),
// independent of DOM nesting. PropertyRadar is a React app whose values don't
// always sit in a sibling element a positional reader can grab, but in the
// rendered text the value reliably follows its label ("Taxpayer" then the next
// line, or "Label: value" inline). This is the robust path for PropertyRadar.
export function textLabelValue(text, label) {
  if (!text) return ''
  const lines = text.split('\n').map((s) => s.replace(/\s+/g, ' ').trim())
  const L = label.toLowerCase()
  // An address wraps after its comma ("212 TEXAS ST," / "SAN FRANCISCO, CA 94107").
  const joinWrapped = (j) => (lines[j].endsWith(',') && lines[j + 1] ? `${lines[j]} ${lines[j + 1]}` : lines[j])
  for (let i = 0; i < lines.length; i++) {
    // "Label: value" / "Label - value" on one line.
    const inline = lines[i].match(new RegExp('^' + escapeRe(label) + '\\s*[:\\-]\\s*(.+)$', 'i'))
    if (inline && inline[1] && inline[1].toLowerCase() !== L) return inline[1].trim()
    // "Label" on its own line, value on one of the next few non-empty lines.
    if (lines[i].toLowerCase().replace(/:$/, '') === L) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j]) return joinWrapped(j)
      }
      continue
    }
    // "Label value" on one line — table cells joined by whitespace. Skip the
    // page's own "Phone edit" / "Add Phone" style controls.
    const same = lines[i].match(new RegExp('^' + escapeRe(label) + '\\s+(.{2,})$', 'i'))
    if (same && !/^(edit|add)\b/i.test(same[1])) return same[1].trim()
  }
  return ''
}

// Header facts on the property profile ("Beds / Baths", "Est. Value", …). The
// header is a grid whose rendered text may come out either as label / value
// pairs or as a ROW of labels followed by a row of values, so consecutive known
// labels are mapped positionally onto the lines that follow them.
const HEADER_LABELS = [
  'Address', 'Property Type', 'Beds / Baths', 'Year Built', 'Square Feet', 'Est. Value', 'Estimated Value',
  'Equity', 'Lot Size', 'Assessed Value', 'Total Loan Bal', 'Purchase Price', 'Owned Since', 'Distress Score',
]
const LABELISH = new Set(
  [
    ...HEADER_LABELS,
    'Radar ID', 'County', 'Lat/Lon', 'Subdivision', 'Site Congressional District', 'School Tax District', 'Census Tract',
    'Census Block', 'Carrier Route', 'Tax Rate Area', 'Legal BookPage/Block/Lot', 'Legal Description', 'Parcel Map',
    'Driving Directions', 'Look Up Assessor', 'Advanced Type', 'Lot SqFt', 'Lot Acres', 'Site Vacant?', 'Zoning',
    'Mailing Address', 'Primary Residence', 'Other Properties', 'Notes', 'Person Type', 'Ownership Role', 'Gender', 'Age',
    'Primary Contact', 'Phone', 'Email', 'Social', 'Skip Trace', 'Taxpayer', 'Mail Vacant', 'Homeowner Tax Exemption',
    'Owner Name', 'Owner Phone Number', 'Owner Email Address', 'Full Address', 'Full Mailing Address', 'Assessor Parcel Number',
  ].map((l) => l.toLowerCase()),
)
export function headerFields(text) {
  const out = {}
  if (!text) return out
  const lines = text.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const isLabel = (l) => HEADER_LABELS.find((h) => h.toLowerCase() === l.toLowerCase().replace(/:$/, ''))
  for (let i = 0; i < lines.length; ) {
    if (!isLabel(lines[i])) { i++; continue }
    let n = 0
    while (i + n < lines.length && isLabel(lines[i + n])) n++
    for (let k = 0; k < n; k++) {
      const label = isLabel(lines[i + k])
      const value = lines[i + n + k]
      if (value && !isLabel(value) && !(label in out)) out[label] = value
    }
    i += n + Math.max(n, 1)
  }
  return out
}

// Owners on the profile layout that has no "Taxpayer" line: each owner is an
// ALL-CAPS line in the header, optionally with an age ("JAMES W PACE, 60"), and
// repeated as the Contacts heading ("JAMES W PACE edit"). Entities read the same
// way ("CHAN FAMILY LIVING TRUST"). Page chrome in caps is excluded.
const UI_CAPS = /^(PROPERTY ?RADAR|MY LISTS|ADD CRITERIA|FULL ADDRESS|FULL MAILING ADDRESS|OWNER NAME|OWNER PHONE NUMBER|OWNER EMAIL ADDRESS|LEARN MORE|ADD NOTE|NO NOTES|ADD PHONE|ADD EMAIL|MY INFO|VALUE & EQUITY|SAN FRANCISCO|LOS ANGELES|NEW YORK|UNITED STATES)$/
export function ownersFromProfileText(text) {
  const seen = new Set()
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim().replace(/\s+edit$/i, '')
    const m = line.match(/^([A-Z][A-Z\s.'&-]{4,})(?:,\s*(\d{1,3}))?$/)
    if (!m) continue
    const name = m[1].trim().replace(/\s+/g, ' ')
    if (/\d/.test(name) || name.split(' ').length < 2 || UI_CAPS.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

// Recover the INDIVIDUAL homeowner (the lead) from the deed-history text when the
// owner of record is an entity/lender (post-foreclosure). We match the CRM
// seller's surname in the Transactions text — PropertyRadar renders grantees like
// "FAGA PAULO & HOSANNA U" — and return the fuller name if found.
const DEED_STOP = /^(RECORDED|GRANT|DEED|LOAN|ASSIGNMENT|ASSIGN|TRUSTEE|TRUST|MARKET|PURCHASE|MONEY|LIEN|NOD|NTS|HOA|REO|SALE|DATE|AMOUNT|DOC|LLC|INC|CORP|SERVICING|BANK|MORTGAGE|LP|LLP|LN|NA|TO|AND|OF|THE|DOWN|PAYMENT|POSITION|STAGE|NOTICE)$/
export function personFromDeeds(text, crmName) {
  const surname = String(crmName || '').trim().split(/\s+/).pop()
  if (!text || !surname || surname.length < 3) return ''
  const S = surname.toUpperCase().replace(/[^A-Z]/g, '')
  const up = text.toUpperCase()
  // Surname-first (PropertyRadar grantee format): "FAGA PAULO [& HOSANNA U]".
  // Skip a trailing word that's transaction boilerplate, not a first name.
  let re = new RegExp(`\\b${S}\\s+([A-Z]{2,})(?:\\s*&\\s*[A-Z]{2,}(?:\\s+[A-Z])?)?`, 'g')
  let m
  while ((m = re.exec(up))) {
    if (!DEED_STOP.test(m[1])) return titleCase(m[0])
  }
  // First-last: "PAULO FAGA".
  re = new RegExp(`\\b([A-Z]{2,})\\s+${S}\\b`, 'g')
  while ((m = re.exec(up))) {
    if (!DEED_STOP.test(m[1])) return titleCase(m[0])
  }
  return ''
}

// The Property tab's "Taxpayer" is a block: the name, then the mailing address
// on one or two more lines ("GOLDEN PROPERTIES LLC" / "2170 SUTTER ST" /
// "SAN FRANCISCO,CA 94115").
export function taxpayerBlock(text) {
  const lines = String(text || '').split(/[\n\t]+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const i = lines.findIndex((l) => /^taxpayer:?$/i.test(l))
  if (i < 0 || !lines[i + 1]) return { name: '', address: '' }
  const name = lines[i + 1]
  const addr = []
  for (let j = i + 2; j < Math.min(i + 4, lines.length); j++) {
    const l = lines[j]
    if (/^\d+\s+\S/.test(l) || /\b[A-Z]{2}\s*\d{5}\b/.test(l) || (addr.length && /^[A-Z][A-Z .'-]+,\s*[A-Z]{2}\b/.test(l))) addr.push(l)
    else break
  }
  return { name, address: addr.join(', ') }
}

// The current owner's deed on the Transactions tab: "Grant Deed / Market /
// <doc#> / <date> / GRANTOR / GRANTEE / $amount / LTV". Returns the prior owner
// (grantor) and a one-line summary of the transfer.
// Same party regardless of order or punctuation: "PACE,JAMES W & SANDRA H" is
// "JAMES W PACE and SANDRA H PACE".
export function sameParty(a, b) {
  const toks = (v) => new Set(String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ').filter((t) => t && t !== 'AND'))
  const A = toks(a), B = toks(b)
  if (!A.size || !B.size) return false
  let hit = 0
  for (const t of A) if (B.has(t)) hit++
  return hit / Math.min(A.size, B.size) >= 0.75
}
export function lastTransfer(text, ownerName) {
  const tokens = String(text || '').split(/[\n\t]+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const i = tokens.findIndex((t) => /^grant deed\b/i.test(t))
  if (i < 0) return { priorOwner: '', summary: '' }
  let date = '', amount = '', grantor = ''
  for (let j = i; j < Math.min(i + 10, tokens.length); j++) {
    const t = tokens[j]
    if (!date && /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) date = t
    else if (!amount && /^\$[\d,]+$/.test(t)) amount = t
    else if (!grantor && /^[A-Z][A-Z0-9 .,'&-]{4,}$/.test(t) && /[A-Z]{2,}[ ,]+[A-Z0-9]{2,}/.test(t) && !sameParty(t, ownerName) && !/^(GRANT DEED|MARKET|CURRENT OWNER)$/i.test(t)) grantor = t
    if (date && amount && grantor) break
  }
  const summary = ['Grant Deed', date, amount].filter(Boolean).join(' · ')
  return { priorOwner: grantor, summary }
}

// Occupancy from what the profile shows, strongest evidence first:
//   1. the assessor's Homeowner Tax Exemption (Yes = owner occupied, on record)
//   2. the owner's Primary Residence address vs. the property
//   3. with no exemption: the mailing address — elsewhere means not owner
//      occupied; at the property means owner occupied for a person, but for a
//      company/trust that only proves mail arrives there, so it stays Unknown.
export function deriveOccupancy({ raw = '', propertyAddress = '', mailingAddress = '', exemption = '', isEntity = false }) {
  const has = (v) => Boolean(v) && v !== FIELD_NOT_FOUND
  const ex = String(exemption || '').replace(/[^A-Za-z]/g, '').toLowerCase()
  if (ex === 'yes') return 'Owner Occupied'
  let occ = ''
  if (has(raw) && /\d/.test(raw) && has(propertyAddress)) occ = addressMatch(propertyAddress, raw) === 'match' ? 'Owner Occupied' : 'Non-Owner Occupied'
  else if (has(raw) && !/\d/.test(raw)) occ = String(raw).trim()
  if (!occ && ex === 'no' && has(mailingAddress) && has(propertyAddress)) {
    const atProperty = addressMatch(propertyAddress, mailingAddress) === 'match'
    occ = !atProperty ? 'Non-Owner Occupied' : isEntity ? 'Unknown (entity; mail at property)' : 'Owner Occupied'
  }
  return occ || FIELD_NOT_FOUND
}

export async function extractAndBuild(page, cfg, res, runDir, input = {}, tabsText = '', opts = {}) {
  if (opts.screenshot !== false) res.evidence.push(await capture(page, runDir, 'propertyradar-result'))
  const { values, audit } = await extractFields(page, cfg.fields, { listFields: ['phones', 'emails'], semantics: { phones: 'phone', emails: 'email' } })
  res.audit.push(...audit.map((a) => ({ page: 'Property', ...a })))

  // Robust fallback: read key fields straight from the rendered TEXT (the tabs
  // we visited, then the whole page) when the positional selector engine
  // couldn't — PropertyRadar's DOM rarely puts a value beside its label. Only
  // fills fields the engine left empty or filled with something implausible.
  const bodyText = await page.innerText('body').catch(() => '')
  const allText = [tabsText, bodyText].filter(Boolean).join('\n')
  const T = (lbl) => textLabelValue(tabsText, lbl) || textLabelValue(bodyText, lbl)
  const missing = (v) => !v || v === FIELD_NOT_FOUND
  // PropertyRadar's page keeps hidden menus whose items are field NAMES
  // ("Assessor Parcel Number", "Radar ID", …). The positional engine matches
  // those too and returns the next item — a label, not a value — so the rendered
  // TEXT is authoritative here and a DOM value is only a fallback, never when it
  // is itself a label name.
  const labelish = (v) => LABELISH.has(String(v || '').trim().toLowerCase().replace(/:$/, ''))
  const dom = (v) => (missing(v) || labelish(v) ? '' : String(v).trim())
  // A plausible owner has at least two words and is not a role/type word. A
  // Taxpayer-style value carries the mailing address after the name ("NAME, 97
  // MAIN ST…"), so judge the name part only.
  const nameOnly = (v) => String(v || '').split(/,\s*(?=\d)/)[0].trim()
  const plausibleOwner = (v) => !missing(v) && looksLikeName(nameOnly(v)) && /\s/.test(nameOnly(v))
  // Owner: the header's names first (natural order, "JAMES W PACE"), then the
  // assessor's Taxpayer line ("PACE,JAMES W & SANDRA H"), then the engine.
  const headerRegion = bodyText.split(/\n\s*Contacts\b/)[0]
  const headerOwners = ownersFromProfileText(headerRegion)
  const taxpayer = taxpayerBlock(allText)
  const domOwner = plausibleOwner(values.recordedOwner) ? values.recordedOwner : ''
  values.recordedOwner = headerOwners.length ? headerOwners.join(' and ') : ''
  if (!plausibleOwner(values.recordedOwner)) values.recordedOwner = [taxpayer.name, T('Owner Name'), domOwner].find((v) => plausibleOwner(v)) || FIELD_NOT_FOUND
  const validApn = (v) => /\d{3}/.test(v || '') && /^[\w -]{5,24}$/.test(v || '')
  values.apn = [T('Assessor Parcel Number'), T('APN'), dom(values.apn)].find(validApn) || FIELD_NOT_FOUND
  values.ownerMailingAddress = T('Mailing Address') || taxpayer.address || dom(values.ownerMailingAddress) || FIELD_NOT_FOUND
  values.propertyAddress = T('Address') || dom(values.propertyAddress) || FIELD_NOT_FOUND
  values.ownershipType = T('Person Type') || dom(values.ownershipType) || FIELD_NOT_FOUND
  values.vesting = T('Vesting') || dom(values.vesting) || FIELD_NOT_FOUND
  const rawOccupancy = T('Primary Residence') || T('Occupancy') || dom(values.occupancy) || ''
  // Addresses read from the DOM can lose the space after a wrapped comma.
  const tidyAddr = (v) => (missing(v) ? v : String(v).replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim())
  values.propertyAddress = tidyAddr(values.propertyAddress)
  values.ownerMailingAddress = tidyAddr(values.ownerMailingAddress)
  const exemption = (T('Homeowner Tax Exemption') || '').replace(/[^A-Za-z]/g, '')
  // Header facts (values, dates, scores) — validated so a neighbouring label
  // can never be mistaken for a value.
  const hdr = headerFields(allText)
  const money = (v) => (/^\$[\d,]+$/.test(v || '') ? v : '')
  const facts = {
    propertyType: T('Property Type') || '',
    estValue: money(hdr['Est. Value']) || money(hdr['Estimated Value']),
    equity: money(hdr['Equity']),
    assessedValue: money(hdr['Assessed Value']),
    loanBalance: money(hdr['Total Loan Bal']),
    purchasePrice: money(hdr['Purchase Price']),
    ownedSince: /^[A-Z][a-z]{2,8}\.? \d{4}$|^\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(hdr['Owned Since'] || '') ? hdr['Owned Since'] : '',
    yearBuilt: /^\d{4}$/.test(hdr['Year Built'] || '') ? hdr['Year Built'] : '',
    distressScore: /^\d{1,3}$/.test(hdr['Distress Score'] || '') ? hdr['Distress Score'] : '',
    // Property tab
    county: T('County') || '',
    homeownerExemption: /^(yes|no)$/i.test(exemption) ? exemption : '',
    // Value & Equity tab (fills what the header did not show)
    purchaseDate: /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(T('Purchase Date') || '') ? T('Purchase Date') : '',
    purchaseType: /^[A-Za-z -]{3,30}$/.test(T('Purchase Type') || '') ? T('Purchase Type') : '',
    // Transactions tab
    likelyToList: T('Likely to List for Sale') || '',
    // Assessor's taxpayer of record (surname-first), kept beside the owner names
    taxpayer: taxpayer.name || '',
  }
  facts.estValue = facts.estValue || money(T('Estimated Value'))
  facts.equity = facts.equity || money(T('Estimated Equity $')) || money(T('Estimated Equity'))
  facts.loanBalance = facts.loanBalance || money(T('Estimated Open Loans Balance'))
  facts.purchasePrice = facts.purchasePrice || money(T('Purchase Amount'))

  // The "Taxpayer" value is "NAME, <mailing address>" — keep just the name.
  let owner = values.recordedOwner
  if (owner && owner !== FIELD_NOT_FOUND) owner = owner.split(/,\s*(?=\d)/)[0].trim()
  // Reject section headers / labels that slipped in (entity names are allowed).
  if (owner && owner !== FIELD_NOT_FOUND && !looksLikeName(owner) && !ENTITY_RE.test(owner)) {
    owner = FIELD_NOT_FOUND
  }

  const ownerOfRecord = owner && owner !== FIELD_NOT_FOUND ? owner : ''
  const isEntity = Boolean(ownerOfRecord && ENTITY_RE.test(ownerOfRecord))
  let verifiedOwner = ownerOfRecord // what we treat as the seller identity
  let titleHolder = ''

  if (isEntity) {
    // Title is held by a company (often a lender/REO). Recover the individual
    // owner from the deed history so identity verification stays about the person.
    titleHolder = ownerOfRecord
    const person = personFromDeeds(tabsText, input.name)
    if (person) {
      verifiedOwner = person
      res.notes.push(`Title held by entity "${titleHolder}" — likely post-foreclosure/REO. Individual owner from the deed history: ${person}.`)
    } else {
      res.notes.push(`Owner of record is an entity "${titleHolder}" (often a lender/REO after foreclosure). The individual seller is a prior owner in the Transactions/deed history.`)
    }
  }

  // Occupancy is decided last: for a company or trust, mail at the property is
  // not proof anyone lives there.
  values.occupancy = deriveOccupancy({ raw: rawOccupancy, propertyAddress: values.propertyAddress, mailingAddress: values.ownerMailingAddress, exemption, isEntity })

  res.data = {
    ownerName: verifiedOwner || FIELD_NOT_FOUND,
    ownerOfRecord: ownerOfRecord || FIELD_NOT_FOUND,
    isEntityOwner: isEntity,
    titleHolder: titleHolder || '',
    ownershipType: isEntity ? (values.ownershipType && values.ownershipType !== FIELD_NOT_FOUND ? values.ownershipType : 'Entity / REO') : values.ownershipType,
    vesting: values.vesting,
    mailingAddress: values.ownerMailingAddress,
    propertyAddress: values.propertyAddress,
    occupancy: values.occupancy,
    apn: values.apn,
    phones: values.phones,
    emails: values.emails,
    trustEntity: isEntity ? titleHolder : values.trustEntity,
    ...facts,
    ...(() => { const t = lastTransfer(allText, ownerOfRecord); return { priorOwner: t.priorOwner, lastTransfer: t.summary } })(),
  }
  // Green when we have EITHER a usable owner identity or a clear owner of record.
  res.ok = Boolean((verifiedOwner && verifiedOwner !== FIELD_NOT_FOUND) || ownerOfRecord)
  return res
}

/* ---------- click helpers ---------- */
// Try each locator factory; click the first that resolves to a visible element.
async function clickFirst(page, factories, { force = false } = {}) {
  for (const make of factories) {
    try {
      const loc = make().first()
      if ((await loc.count()) === 0) continue
      // scrollIntoViewIfNeeded has its own stability wait, which ExtJS's
      // never-stable controls time out (1.5s wasted per click). A forced click
      // scrolls on its own, so only pre-scroll for normal clicks.
      if (!force) await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
      await loc.click({ timeout: 2500, force })
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
