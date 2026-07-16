// Calibration / page-inspection tool.
//
//   npm run calibrate -- <source> <url>
//   e.g. npm run calibrate -- reiblackbook https://members.reiblackbook.com/leads/123
//
// It opens the page in the real browser, pauses for you to log in, then:
//   - tries the current selector strategies and prints what matched
//   - dumps candidate selectors (data attributes, aria labels, field labels)
//   - saves the page HTML and a screenshot
// Everything is written to runs/_calibration/<source>/ so you can review it or
// send it back to finalize the stable selectors. It NEVER changes anything.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { getPage, looksLikeLogin, capture, closeBrowser } from '../server/browser.js'
import { selectors } from '../server/sources/selectors.js'
import { extractFields } from '../server/sources/extract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [, , source, url] = process.argv

if (!source || !url) {
  console.log('Usage: npm run calibrate -- <source> <url>')
  console.log('  source: reiblackbook | propertyradar | dealmachine | county')
  process.exit(1)
}
const cfg = selectors[source]
if (!cfg || !cfg.fields) {
  console.log(`Unknown source "${source}". Known: ${Object.keys(selectors).join(', ')}`)
  process.exit(1)
}

const outDir = path.join(root, 'runs', '_calibration', source)
fs.mkdirSync(outDir, { recursive: true })

const ask = (q) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (a) => {
      rl.close()
      res(a)
    })
  })

const page = await getPage()
console.log(`\nOpening ${url} …`)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })

if (await looksLikeLogin(page)) {
  console.log('\n>>> Login required. Log in in the browser window that opened.')
}
await ask('\nWhen the correct page is fully loaded in the browser, press ENTER here to inspect it… ')

// 1) Try current strategies.
const listFields = ['phones', 'emails']
const semantics = { phones: 'phone', emails: 'email' }
const { values, audit } = await extractFields(page, cfg.fields, { listFields, semantics })
console.log('\n=== Current selectors — results ===')
for (const a of audit) {
  const mark = a.ok ? '✓' : '✗'
  console.log(`  ${mark} ${a.field.padEnd(20)} ${a.ok ? a.strategy : 'FIELD NOT FOUND'}`)
  if (a.ok) console.log(`      value: ${String(a.value).slice(0, 100)}`)
}

// 2) Dump candidate selectors from the page.
const candidates = await page.evaluate(() => {
  const short = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const dataAttrs = []
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-') && short(el.textContent)) {
        dataAttrs.push({ selector: `[${attr.name}="${attr.value}"]`, tag: el.tagName.toLowerCase(), text: short(el.textContent) })
      }
    }
  })
  const aria = Array.from(document.querySelectorAll('[aria-label]')).map((e) => ({ label: e.getAttribute('aria-label'), text: short(e.textContent || e.value) }))
  // Search boxes / text inputs — needed to automate a site's address search.
  const inputs = Array.from(document.querySelectorAll('input,textarea')).map((e) => ({
    tag: e.tagName.toLowerCase(),
    type: e.getAttribute('type') || '',
    id: e.id || '',
    name: e.getAttribute('name') || '',
    placeholder: e.getAttribute('placeholder') || '',
    ariaLabel: e.getAttribute('aria-label') || '',
  })).filter((i) => i.type !== 'hidden').slice(0, 60)
  const labels = []
  document.querySelectorAll('dt,th,label,strong,b').forEach((el) => {
    const t = short(el.textContent)
    if (t && t.length < 40) {
      const val = short(el.nextElementSibling?.textContent || '')
      labels.push({ label: t, nearbyValue: val })
    }
  })
  return { dataAttrs: dataAttrs.slice(0, 200), aria: aria.slice(0, 100), labels: labels.slice(0, 200), inputs }
})

// 3) Scan the page for anything that looks like a phone or email, with context.
const contacts = await page.evaluate(() => {
  const bodyText = document.body.innerText || ''
  const emails = [...new Set(bodyText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])].slice(0, 20)
  const phones = [...new Set(bodyText.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [])].slice(0, 20)
  const telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]')).map((a) => a.getAttribute('href'))
  const mailLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map((a) => a.getAttribute('href'))
  return { emails, phones, telLinks, mailLinks }
})

// Print the labels + values right here so you can copy-paste the output.
console.log('\n=== Field labels found on the page (label -> value beside it) ===')
candidates.labels
  .filter((l) => l.nearbyValue && l.nearbyValue.length < 100)
  .slice(0, 60)
  .forEach((l) => console.log(`  "${l.label}" -> ${l.nearbyValue}`))

console.log('\n=== Input / search boxes on the page (for automating search) ===')
if (!candidates.inputs.length) console.log('  (none found)')
candidates.inputs.forEach((i) =>
  console.log(`  ${i.tag}${i.type ? '[type=' + i.type + ']' : ''}` +
    `${i.id ? ' #' + i.id : ''}${i.name ? ' name=' + i.name : ''}` +
    `${i.placeholder ? ' placeholder="' + i.placeholder + '"' : ''}${i.ariaLabel ? ' aria-label="' + i.ariaLabel + '"' : ''}`),
)

console.log('\n=== Phones / emails detected anywhere on the page ===')
console.log('  phones:', contacts.phones.join(', ') || '(none found in page text)')
console.log('  emails:', contacts.emails.join(', ') || '(none found in page text)')
console.log('  tel: links:', contacts.telLinks.join(', ') || '(none)')
console.log('  mailto: links:', contacts.mailLinks.join(', ') || '(none)')

fs.writeFileSync(path.join(outDir, 'candidates.json'), JSON.stringify(candidates, null, 2))
fs.writeFileSync(path.join(outDir, 'extracted.json'), JSON.stringify({ values, audit }, null, 2))
fs.writeFileSync(path.join(outDir, 'contacts.json'), JSON.stringify(contacts, null, 2))
fs.writeFileSync(path.join(outDir, 'page.html'), await page.content())
const shot = await capture(page, outDir, `${source}-calibration`)

console.log('\n=== Saved for review / sharing ===')
console.log('  ' + path.join(outDir, 'candidates.json') + '   (data attrs, aria labels, field labels)')
console.log('  ' + path.join(outDir, 'extracted.json') + '    (what current selectors found)')
console.log('  ' + path.join(outDir, 'page.html'))
console.log('  ' + (shot.abs || path.join(outDir, 'screenshot')))
console.log('\nAdd the stable strategies you find to server/sources/selectors.js (data attributes first).')
console.log('Nothing was changed on the website. Done.\n')

await closeBrowser()
process.exit(0)
