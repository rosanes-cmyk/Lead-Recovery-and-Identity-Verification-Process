// Guided, step-by-step calibration of PropertyRadar's address search.
//
//   npm run calibrate:propertyradar -- "547 Missouri Street, San Francisco, CA 94107"
//
// You drive PropertyRadar BY HAND while this watches. At each step it tells you
// what to do in the browser; you do it and press ENTER; it saves what the page
// looks like at that moment — the HTML, a screenshot, every visible clickable /
// input element with its text and attributes, and (for the whole session) every
// JSON response PropertyRadar's own page fetched. That is exactly the evidence
// needed to write selectors that hit the right elements, and to read
// PropertyRadar's data directly instead of the rendered screen.
//
// It never clicks, types, or changes anything on the website itself.
// Output: runs/_calibration/propertyradar-flow/   (zip the folder and share it)

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { config } from '../server/config.js'
import { getPage, capture, closeBrowser } from '../server/browser.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const address = process.argv[2] || '547 Missouri Street, San Francisco, CA 94107'
const startUrl = process.env.CALIBRATE_URL || 'https://app.propertyradar.com/'
const outDir = path.join(root, 'runs', '_calibration', 'propertyradar-flow')

const STEPS = [
  ['discover', 'Log in if PropertyRadar asks. When the Discover page (the map) is showing, press ENTER.'],
  ['full-address-panel', 'In the top toolbar click "Full Address". When the address box appears in the left panel, press ENTER — do NOT type yet.'],
  ['autocomplete', `Type this into the address box:   ${address}\n    Then WAIT for the suggestions to drop down under it — do not click one yet. Press ENTER.`],
  ['results', 'Click the matching suggestion, then click the green "Add Criteria" button. When the results (list or table) appear, press ENTER.'],
  ['detail', 'Open the property (double-click the result row, or however you normally open it). When the property profile (Taxpayer, APN, …) is on screen, press ENTER.'],
  ['second-search', 'Now start a NEW search for a different address exactly the way you normally would — including removing or clearing the previous address criteria. When the EMPTY address box is ready again, press ENTER.'],
]

// One readline for the whole session (a new one per question breaks when stdin
// is piped, and there is no reason for it on a keyboard either).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
let stdinClosed = false
rl.on('close', () => { stdinClosed = true })
const ask = (q) => new Promise((res) => { if (stdinClosed) return res(''); rl.question(q, res) })

// Everything visible that a person could click or type into, with the details a
// selector can be written from. Runs inside the page; must stay self-contained.
const DUMP = () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
  }
  const short = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 90)
  const SEL =
    'button, a, input, textarea, select, [role], [onclick], [tabindex], li, th, td, tr, ' +
    '[class*="criteria" i], [class*="toolbar" i], [class*="menu" i], [class*="suggest" i], [class*="option" i], ' +
    '[class*="autocomplete" i], [class*="dropdown" i], [class*="row" i], [class*="cell" i], [class*="grid" i], [class*="result" i], [class*="tab" i]'
  const out = []
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue
    const attrs = {}
    for (const a of el.attributes) {
      if (/^(id|class|role|name|type|placeholder|href|title|for|value|aria-.*|data-.*)$/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 140)
    }
    const r = el.getBoundingClientRect()
    out.push({
      tag: el.tagName.toLowerCase(),
      text: short(el.innerText != null ? el.innerText : el.textContent),
      value: el.value != null && el.value !== '' ? String(el.value).slice(0, 90) : undefined,
      attrs,
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    })
    if (out.length >= 900) break
  }
  return out
}

function summaryLine(e) {
  const a = e.attrs || {}
  const cls = a.class ? ' .' + String(a.class).trim().split(/\s+/).slice(0, 4).join('.') : ''
  return (
    `${e.tag}${a.role ? '[' + a.role + ']' : ''}${a.id ? ' #' + a.id : ''}${cls}` +
    `${a.placeholder ? ' placeholder="' + a.placeholder + '"' : ''}${a['aria-label'] ? ' aria="' + a['aria-label'] + '"' : ''}` +
    `${a.href ? ' href=' + String(a.href).slice(0, 60) : ''}${e.text ? '  "' + e.text + '"' : ''}${e.value ? '  value=' + e.value : ''}  @${e.box.join(',')}`
  )
}

async function snapshot(page, n, name) {
  const dir = path.join(outDir, `step-${n}-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  const url = page.url()
  let html = ''
  try { html = await page.content() } catch { /* page navigating */ }
  fs.writeFileSync(path.join(dir, 'page.html'), html)
  const shot = await capture(page, dir, name)
  let elements = []
  try { elements = await page.evaluate(DUMP) } catch (err) { console.log('  (element dump failed: ' + err.message + ')') }
  const title = await page.title().catch(() => '')
  fs.writeFileSync(path.join(dir, 'elements.json'), JSON.stringify({ url, title, elements }, null, 1))
  fs.writeFileSync(path.join(dir, 'summary.txt'), `URL: ${url}\nTITLE: ${title}\n\n${elements.map(summaryLine).join('\n')}\n`)
  console.log(`  saved step ${n} (${name}): ${elements.length} visible elements, HTML ${Math.round(html.length / 1024)} KB, screenshot ${shot.file ? 'ok' : 'failed'}`)
}

// ---- main ----------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

// This needs a window the operator can use.
if (process.env.CALIBRATE_HEADLESS === 'true') config.headless = true
else if (config.headless) { console.log('HEADLESS is on in .env — showing the browser for this calibration.'); config.headless = false }

const page = await getPage()
const network = []
let stepName = 'start'
const writeNetwork = () => fs.writeFileSync(path.join(outDir, 'network.jsonl'), network.map((n) => JSON.stringify(n)).join('\n') + (network.length ? '\n' : ''))
page.on('response', async (resp) => {
  try {
    const url = resp.url()
    if (!process.env.CALIBRATE_URL && !/propertyradar\.com/i.test(url)) return
    const ct = resp.headers()['content-type'] || ''
    if (!/json/i.test(ct)) return
    const req = resp.request()
    let preview = ''
    try { preview = (await resp.text()).slice(0, 1500) } catch { /* body gone */ }
    network.push({ step: stepName, method: req.method(), url, status: resp.status(), contentType: ct, requestBody: (req.postData() || '').slice(0, 1500), responsePreview: preview })
  } catch { /* ignore */ }
})
const finish = async (code) => { writeNetwork(); rl.close(); await closeBrowser().catch(() => {}); process.exit(code) }
process.on('SIGINT', () => finish(0))

console.log(`\nOpening ${startUrl} …`)
await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => console.log('  (page load issue: ' + err.message + ' — carry on in the browser anyway)'))
console.log('\nYou drive PropertyRadar by hand in the browser window; I only watch and save. Six short steps.')

for (let i = 0; i < STEPS.length; i++) {
  const [name, prompt] = STEPS[i]
  stepName = name
  await ask(`\n[${i + 1}/${STEPS.length}] ${prompt}\n> `)
  if (stdinClosed && i < STEPS.length - 1) { console.log('\nInput closed — saving what we have.'); await snapshot(page, i + 1, name); break }
  await snapshot(page, i + 1, name)
}

writeNetwork()
console.log(`\nSaved ${network.length} PropertyRadar JSON responses to network.jsonl`)
console.log('\n=== Done. Everything is in ===\n  ' + outDir)
console.log('\nZip that folder (right-click it → Send to → Compressed (zipped) folder) and share the .zip.')
console.log('Nothing on the website was changed.\n')
await finish(0)
