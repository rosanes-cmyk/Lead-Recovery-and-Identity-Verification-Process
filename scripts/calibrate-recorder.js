// Guided calibration of the San Francisco Assessor-Recorder document search.
//
//   npm run calibrate:recorder
//   npm run calibrate:recorder -- 4101 032 WINTERS MICHAEL
//
// Why this exists: recorder.sfgov.org is a single-page app. The page you see is
// drawn by JavaScript that calls a REST service behind it. Those calls are what
// we need in order to read liens and notices of default straight from the
// source, quickly, instead of driving a browser for every property. The call
// names are not published anywhere, so the only way to learn them is to watch
// the page make them.
//
// YOU do the searching, by hand, in the window this opens. It only watches and
// writes down what the page asked for and what came back. It never clicks,
// types, pays for anything, or changes anything on the site.
//
// Cookie and authorization values are redacted; only their shape is kept.
//
// Output: runs/_calibration/recorder/   (zip the folder and share it)

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from '../server/config.js'
import { getPage, capture, closeBrowser } from '../server/browser.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BLOCK = process.argv[2] || '4101'
const LOT = process.argv[3] || '032'
// A name search matters as much as a parcel one: California recorders index by
// the parties to a document, and the parcel number is only present when whoever
// filed it supplied one. This owner comes from the same property as the block
// and lot above.
const LAST = process.argv[4] || 'WINTERS'
const FIRST = process.argv[5] || 'MICHAEL'
const startUrl = process.env.CALIBRATE_URL || 'https://recorder.sfgov.org/'
const outDir = path.join(root, 'runs', '_calibration', 'recorder')
// Only the recorder's own traffic is recorded. Pointing CALIBRATE_URL somewhere
// else (a local test server) widens it to that host, which is how this script
// is exercised without hitting the city's servers.
const HOST_RE = process.env.CALIBRATE_URL ? new RegExp(new URL(startUrl).host.replace(/[.]/g, '\\.'), 'i') : /recorder\.sfgov\.org/i

const STEPS = [
  ['search-form', 'Accept the disclaimer if one appears. You want the "Public Index Search" form, the one with Document Type, Grantor/Grantee Name, Titles, Block and Lot. Press ENTER when it is on screen.'],
  ['titles-list', 'Open the "Titles" dropdown — the one showing --All Types-- — and leave it open. That is the list of document kinds (Deed, Lien, Notice of Default and so on). Press ENTER with it open.'],
  ['parcel-search', `Set Titles back to --All Types--. Leave Document Type on Officials and leave the date range alone.\n    Put ${BLOCK} in Block and ${LOT} in Lot, leave the name box empty, and click Search.\n    Press ENTER when the results appear, or when it says none were found.`],
  ['name-search', `Click "Clear All". Type   ${LAST} ${FIRST}   into the Grantor/Grantee Name box, leave the selector on "Grantor or Grantee", leave Block and Lot empty, and click Search.\n    If that finds nothing, try just   ${LAST}  . Press ENTER when the results appear.`],
  ['open-document', 'Open one document from the results — a deed of trust, a lien or a notice of default is ideal. When its detail or preview is on screen, press ENTER.'],
]

// One reader for the whole session: a line per ENTER on a keyboard, and all
// lines at once when input is piped. Resolves null when input ends.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const lines = []
const waiters = []
let stdinClosed = false
rl.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else lines.push(l) })
rl.on('close', () => { stdinClosed = true; while (waiters.length) waiters.shift()(null) })
const ask = (q) =>
  new Promise((res) => {
    process.stdout.write(q)
    if (lines.length) return res(lines.shift())
    if (stdinClosed) return res(null)
    waiters.push(res)
  })

// Request headers matter here: to repeat a call we need to know what the page
// sent. Secrets are reduced to a shape so nothing usable is written to disk.
const SECRET = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i
export function safeHeaders(h = {}) {
  const out = {}
  for (const [k, v] of Object.entries(h)) {
    out[k] = SECRET.test(k) ? `[redacted ${String(v).length} chars starting "${String(v).slice(0, 4)}"]` : v
  }
  return out
}

// Imported for its helpers (the tests) rather than run: stop here.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (runDirectly) await main()

async function main() {
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

if (process.env.CALIBRATE_HEADLESS === 'true') config.headless = true
else if (config.headless) { console.log('HEADLESS is on in .env — showing the browser for this calibration.'); config.headless = false }

const page = await getPage()
const calls = []
let stepName = 'start'

const writeAll = () => {
  fs.writeFileSync(path.join(outDir, 'network.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + (calls.length ? '\n' : ''))
  // A short, readable index so the interesting calls are obvious at a glance.
  const lines = calls.map(
    (c) => `[${c.step}] ${c.method} ${c.status} ${c.url}\n    sent: ${c.requestBody ? c.requestBody.slice(0, 300) : '(no body)'}\n    got : ${(c.responsePreview || '').replace(/\s+/g, ' ').slice(0, 300)}${(c.responsePreview || '').length > 300 ? ` … (${c.responsePreview.length} chars, full text in network.jsonl)` : ''}\n`,
  )
  fs.writeFileSync(path.join(outDir, 'api-calls.txt'), `${calls.length} calls to the recorder service\n\n${lines.join('\n')}`)
}

page.on('response', async (resp) => {
  try {
    const url = resp.url()
    if (!HOST_RE.test(url)) return
    // Skip the page's own static files; we want the data calls.
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(url)) return
    const req = resp.request()
    const ct = resp.headers()['content-type'] || ''
    let preview = ''
    // Reference lists (the Titles dropdown is hundreds of entries) arrive in one
    // response, so keep enough of it to be useful rather than a teaser.
    if (/json|text|xml/i.test(ct)) { try { preview = (await resp.text()).slice(0, 200000) } catch { /* body gone */ } }
    calls.push({
      step: stepName,
      method: req.method(),
      url,
      status: resp.status(),
      contentType: ct,
      requestHeaders: safeHeaders(req.headers()),
      requestBody: (req.postData() || '').slice(0, 4000),
      responsePreview: preview,
    })
  } catch { /* ignore */ }
})

async function snapshot(page, n, name) {
  const dir = path.join(outDir, `step-${n}-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  let html = ''
  try { html = await page.content() } catch { /* navigating */ }
  fs.writeFileSync(path.join(dir, 'page.html'), html)
  const shot = await capture(page, dir, name)
  fs.writeFileSync(path.join(dir, 'url.txt'), `${page.url()}\n${await page.title().catch(() => '')}\n`)
  console.log(`  saved step ${n} (${name}): HTML ${Math.round(html.length / 1024)} KB, screenshot ${shot.file ? 'ok' : 'failed'}, ${calls.length} service calls so far`)
}

const finish = async (code) => { writeAll(); rl.close(); await closeBrowser().catch(() => {}); process.exit(code) }
process.on('SIGINT', () => finish(0))

console.log(`\nOpening ${startUrl} …`)
await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => console.log('  (page load issue: ' + err.message + ' — carry on in the browser anyway)'))
console.log(`\nYou drive the site by hand; I only watch. Five short steps.`)
console.log(`  Parcel to search: block ${BLOCK}, lot ${LOT}`)
console.log(`  Name to search:   ${LAST}, ${FIRST}`)
console.log('Viewing the index is free. Do NOT buy a copy of anything — we only need the search.')

for (let i = 0; i < STEPS.length; i++) {
  const [name, prompt] = STEPS[i]
  stepName = name
  const answer = await ask(`\n[${i + 1}/${STEPS.length}] ${prompt}\n> `)
  await snapshot(page, i + 1, name)
  if (answer === null && i < STEPS.length - 1) { console.log('\nInput closed — saved what we have.'); break }
}

writeAll()
console.log(`\nSaved ${calls.length} calls to the recorder service.`)
console.log('\n=== Done. Everything is in ===\n  ' + outDir)
console.log('\nOpen api-calls.txt first — that is the readable summary.')
console.log('Zip the folder (right-click → Send to → Compressed (zipped) folder) and share the .zip.')
console.log('Nothing on the website was changed and nothing was purchased.\n')
await finish(0)
}
