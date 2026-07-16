// Google — used to locate official county pages and lawful public records.
// Public, no login. Returns the top organic result links as research clues.

import { capture } from '../browser.js'
import { emptyResult, goto } from './base.js'

export const id = 'google'
export const label = 'Google'
export const loginGated = false

// Reusable: run a query and return { links: [{title,url}], evidence }.
export async function searchWeb(page, query, runDir, signal) {
  const links = []
  const evidence = []
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`
  try {
    await goto(page, url, { signal })
  } catch (err) {
    return { links, evidence, error: String(err) }
  }
  evidence.push(await capture(page, runDir, `google-${query.slice(0, 30)}`))

  try {
    // Google's markup shifts often; grab anchors that wrap an <h3> heading,
    // which is the stable shape of an organic result.
    const raw = await page.evaluate(() => {
      const out = []
      document.querySelectorAll('a h3').forEach((h3) => {
        const a = h3.closest('a')
        if (a && a.href && a.href.startsWith('http')) {
          out.push({ title: h3.textContent.trim(), url: a.href })
        }
      })
      return out.slice(0, 10)
    })
    links.push(...raw)
  } catch {
    /* leave links empty; screenshot still captured */
  }
  return { links, evidence }
}

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  const query = [input.name, input.address].filter(Boolean).join(' ')
  if (!query) {
    res.notes.push('Nothing to search on Google (no name or address).')
    return res
  }
  emit({ type: 'log', source: label, message: `Searching: ${query}` })
  const { links, evidence, error } = await searchWeb(page, query, runDir, signal)
  res.evidence = evidence
  res.data = { links }
  if (error) res.notes.push(`Google search issue: ${error}`)
  if (!links.length)
    res.notes.push('No organic results parsed (Google may have shown a consent or captcha page).')
  res.ok = links.length > 0
  return res
}
