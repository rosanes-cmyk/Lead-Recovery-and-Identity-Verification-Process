// County records — Assessor, Recorder, Tax Collector, GIS/parcel viewer, and
// probate/court records when relevant. Counties have no common API and every
// county site is different, so this module locates the official county pages
// for the property via Google and captures them as evidence + links. Deep
// parcel extraction is per-county and can be added as a sub-module later.

import { capture } from '../browser.js'
import { emptyResult, goto } from './base.js'
import { searchWeb } from './google.js'

export const id = 'county'
export const label = 'County Records'
export const loginGated = false

const RECORD_QUERIES = [
  '{address} county assessor property records',
  '{address} county recorder deed',
  '{address} property tax collector',
  '{address} parcel GIS map',
]

export async function run(ctx) {
  const { page, input, emit, runDir, signal } = ctx
  const res = emptyResult(label)
  if (!input.address) {
    res.notes.push('No property address available; county lookup needs an address.')
    return res
  }

  const found = []
  for (const q of RECORD_QUERIES) {
    if (signal?.aborted) break
    const query = q.replace('{address}', input.address)
    emit({ type: 'log', source: label, message: `Locating: ${query}` })
    const { links, evidence } = await searchWeb(page, query, runDir, signal)
    res.evidence.push(...evidence)
    // Prefer official-looking .gov / county domains.
    const official = links.filter((l) => /\.gov|county|assessor|recorder|parcel/i.test(l.url))
    const pick = (official[0] || links[0]) || null
    if (pick) found.push({ query, ...pick })
  }

  // Open the most promising official page and capture it for the operator.
  const top = found.find((f) => /\.gov|county|assessor/i.test(f.url)) || found[0]
  if (top) {
    try {
      emit({ type: 'log', source: label, message: `Opening ${top.url}` })
      await goto(page, top.url, { signal })
      res.evidence.push(await capture(page, runDir, 'county-official-page'))
    } catch (err) {
      res.notes.push(`Could not open county page: ${String(err)}`)
    }
  }

  res.data = { candidatePages: found }
  res.ok = found.length > 0
  if (!found.length)
    res.notes.push('No county record pages located (search may have been blocked).')
  else
    res.notes.push(
      'County official pages located and captured. Recorded-owner extraction is per-county; ' +
        'review the captured pages or add a county sub-module for automatic parsing.',
    )
  return res
}
