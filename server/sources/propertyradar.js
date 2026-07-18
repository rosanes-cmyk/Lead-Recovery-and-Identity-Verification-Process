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

// Drive the "Full Address" toolbar search to the property profile. Captures a
// screenshot at each step (into Evidence) so the exact PropertyRadar screens are
// visible — PropertyRadar is behind the operator's login, so this is how we see
// and refine the flow.
async function autoSearch(page, address, cfg, emit, signal, res, runDir) {
  const streetNum = (address.match(/^\s*(\d+)/) || [])[1] || address.split(',')[0]
  const snap = async (name) => { try { res?.evidence.push(await capture(page, runDir, 'propertyradar-' + name)) } catch { /* ignore */ } }
  try {
    if (/\/detail\//i.test(page.url())) return true

    // Click the "Full Address" button in the top toolbar specifically.
    emit({ type: 'log', source: label, message: 'Opening Full Address search' })
    if (!(await clickFirst(page, [
      () => page.getByRole('button', { name: /^Full Address$/i }),
      () => page.getByRole('link', { name: /^Full Address$/i }),
      () => page.getByRole('menuitem', { name: /^Full Address$/i }),
      () => page.locator('button, a, [role="button"], span, div').filter({ hasText: /^\s*Full Address\s*$/i }),
    ]))) {
      return await genericSearch(page, address, streetNum, emit, signal)
    }
    await page.waitForTimeout(1500)
    await snap('fulladdress-panel')

    // Type into the address input that appears in the Full Address panel. Avoid
    // the "City, County or ZIP" box; take the first visible text input that's
    // NOT that one.
    emit({ type: 'log', source: label, message: `Typing address: ${address}` })
    const box = await firstVisible(page, [
      () => page.getByPlaceholder(/site address/i),
      () => page.getByPlaceholder(/enter.*address/i),
      () => page.getByPlaceholder(/full address/i),
      () => page.getByPlaceholder(/street|address|number/i),
      () => page.locator('input[type="text"], input:not([type])').filter({ hasNot: page.locator('[placeholder*="ZIP" i], [placeholder*="County" i]') }),
    ])
    if (!box) { await snap('no-address-box'); return false }
    await box.click({ timeout: 3000 }).catch(() => {})
    await box.fill(address, { timeout: 3000 }).catch(async () => { await box.type(address, { delay: 20 }).catch(() => {}) })
    await page.waitForTimeout(2000)
    await snap('address-typed')

    // Pick the autocomplete suggestion that matches the street number.
    const picked = await clickFirst(page, [
      () => page.getByRole('option').filter({ hasText: new RegExp(streetNum) }),
      () => page.locator('[role="option"], li, .pac-item, .autocomplete-item, .dropdown-item, .suggestion').filter({ hasText: new RegExp(streetNum) }),
      () => page.getByText(new RegExp(streetNum + '\\s+\\w+', 'i')),
    ])
    await page.waitForTimeout(1000)
    await snap('after-autocomplete')
    if (!picked) emit({ type: 'log', source: label, message: 'No autocomplete match — trying Add Criteria anyway' })

    // Apply the criterion (green "Add Criteria" button in the panel).
    await clickFirst(page, [
      () => page.getByRole('button', { name: /^Add Criteria$/i }),
      () => page.locator('button:has-text("Add Criteria")'),
    ])
    await page.waitForTimeout(3000)
    await snap('after-add-criteria')

    emit({ type: 'log', source: label, message: 'Waiting for results, then opening the property' })
    const opened = await openFirstResult(page, streetNum, signal)
    await snap(opened ? 'opened-detail' : 'results-not-opened')
    return opened
  } catch (err) {
    emit({ type: 'log', source: label, message: `Auto-search issue: ${String(err).slice(0, 120)}` })
    return false
  }
}

// After a search runs, wait for the results grid to render then OPEN the matching
// property (reach a /detail/ page). PropertyRadar's grid can spin like the main
// app, so poll, and try several ways to open the row: double-click, click, Enter.
async function openFirstResult(page, streetNum, signal) {
  const onDetail = () => /\/detail\//i.test(page.url())
  for (let i = 0; i < 12; i++) { // up to ~24s for the grid to appear
    if (signal?.aborted || onDetail()) break
    const row = await firstVisible(page, [
      () => page.getByRole('row').filter({ hasText: new RegExp(streetNum) }),
      () => page.locator('[role="row"], tr, [class*="row" i], [class*="grid" i] [class*="cell" i]').filter({ hasText: new RegExp(streetNum) }),
      () => page.getByText(new RegExp(streetNum + '\\s+\\w+', 'i')),
      () => page.locator('a, button, div, span').filter({ hasText: new RegExp('\\b' + streetNum + '\\b') }),
    ])
    if (row) {
      await row.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
      await row.dblclick({ timeout: 3500 }).catch(async () => { await row.click({ timeout: 2500 }).catch(() => {}) })
      await page.waitForTimeout(1500)
      if (!onDetail()) await page.keyboard.press('Enter').catch(() => {})
      await page.waitForTimeout(2500)
      await settle(page)
      if (onDetail()) return true
    }
    await page.waitForTimeout(2000)
  }
  return onDetail() || /property profile/i.test(await page.title().catch(() => ''))
}

// Fallback search when there's no "Full Address" button: type the address into
// whatever primary search box the current PropertyRadar UI shows, take the
// autocomplete match (or press Enter), then open the first result row.
async function genericSearch(page, address, streetNum, emit, signal) {
  try {
    const box = await firstVisible(page, [
      () => page.getByPlaceholder(/enter\s*(site\s*)?address/i),
      () => page.getByPlaceholder(/what are you searching for/i),
      () => page.getByPlaceholder(/find criteria/i),
      () => page.getByPlaceholder(/address/i),
      () => page.getByPlaceholder(/city.*zip|zip.*code/i),
      () => page.locator('input[type="search"]'),
      () => page.locator('textarea'),
    ])
    if (!box) return false
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
async function readProfileTabs(page, emit, signal) {
  let text = ''
  for (const tab of PROFILE_TABS) {
    if (signal?.aborted) return text
    try {
      const t = page.getByText(new RegExp(`^${tab.replace(/&/g, '&')}$`, 'i')).first()
      if ((await t.count()) > 0) {
        await t.click({ timeout: 2000 })
        await page.waitForTimeout(800)
        text += '\n\n' + (await page.innerText('body').catch(() => ''))
      }
    } catch {
      /* tab not present */
    }
  }
  // Return to Contacts so owner/contact fields are on screen for extraction.
  try {
    const c = page.getByText(/^Contacts$/i).first()
    if ((await c.count()) > 0) { await c.click({ timeout: 2000 }); await settle(page); text += '\n\n' + (await page.innerText('body').catch(() => '')) }
  } catch { /* ignore */ }
  return text
}

// PropertyRadar profile tab/section labels that must never be taken as an owner
// name (the label-based match can grab these by mistake).
const NOT_A_NAME = /^(value,?\s*equity\s*&?\s*tax|value\s*&?\s*equity|equity|transactions|neighborhood|listings|my info|contacts?|property|overview|summary|tax|owner phone number|owner email( address)?|phone number|email address|contact information|owner (info|information)|activities)$/i
// A real owner name never contains these label words.
const LABEL_WORDS = /\b(phone number|email address|equity|activities)\b/i

function looksLikeName(v) {
  const s = String(v || '').trim()
  if (!s || s === FIELD_NOT_FOUND) return false
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
  for (let i = 0; i < lines.length; i++) {
    // "Label: value" / "Label - value" on one line.
    const inline = lines[i].match(new RegExp('^' + escapeRe(label) + '\\s*[:\\-]\\s*(.+)$', 'i'))
    if (inline && inline[1] && inline[1].toLowerCase() !== L) return inline[1].trim()
    // "Label" on its own line, value on one of the next few non-empty lines.
    if (lines[i].toLowerCase().replace(/:$/, '') === L) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j]) return lines[j]
      }
    }
  }
  return ''
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

export async function extractAndBuild(page, cfg, res, runDir, input = {}, tabsText = '') {
  res.evidence.push(await capture(page, runDir, 'propertyradar-result'))
  const { values, audit } = await extractFields(page, cfg.fields, { listFields: ['phones', 'emails'], semantics: { phones: 'phone', emails: 'email' } })
  res.audit.push(...audit.map((a) => ({ page: 'Property', ...a })))

  // Robust fallback: read key fields straight from the rendered tab TEXT when the
  // positional selector engine couldn't (PropertyRadar's React DOM). Only fills
  // fields the engine left empty.
  const T = (lbl) => textLabelValue(tabsText, lbl)
  const missing = (v) => !v || v === FIELD_NOT_FOUND
  if (missing(values.recordedOwner)) values.recordedOwner = T('Taxpayer') || T('Owner Name') || values.recordedOwner
  if (missing(values.apn)) values.apn = T('Assessor Parcel Number') || T('APN') || values.apn
  if (missing(values.ownerMailingAddress)) values.ownerMailingAddress = T('Mailing Address') || values.ownerMailingAddress
  if (missing(values.propertyAddress)) values.propertyAddress = T('Address') || values.propertyAddress
  if (missing(values.occupancy)) values.occupancy = T('Primary Residence') || T('Occupancy') || values.occupancy

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
  }
  // Green when we have EITHER a usable owner identity or a clear owner of record.
  res.ok = Boolean((verifiedOwner && verifiedOwner !== FIELD_NOT_FOUND) || ownerOfRecord)
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
