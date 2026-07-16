// County records — Assessor, Recorder, Tax Collector, GIS/parcel viewer, and
// probate/court records when relevant. Counties have no common API and every
// county site is different, so this module locates the official county pages
// for the property via Google and captures them as evidence + links. Deep
// parcel extraction is per-county and can be added as a sub-module later.

import { capture } from '../browser.js'
import { emptyResult, goto } from './base.js'
import { searchWeb } from './google.js'
import { selectors } from './selectors.js'
import { extractFields, FIELD_NOT_FOUND } from './extract.js'

export const id = 'county'
export const label = 'County Records'
export const loginGated = false

// Two focused queries keep it fast; both surface the assessor/recorder pages.
const RECORD_QUERIES = [
  '{address} county assessor parcel property records',
  '{address} county recorder deed',
]

export async function run(ctx) {
  const { page, input, emit, runDir, signal, pauseForAction } = ctx
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

  // Open the most promising official page, capture it, and attempt extraction
  // using the generic label-based county field specs.
  res.audit = []
  const top = found.find((f) => /\.gov|county|assessor/i.test(f.url)) || found[0]
  if (top) {
    try {
      emit({ type: 'log', source: label, message: `Opening ${top.url}` })
      await goto(page, top.url, { signal })
      // Assisted: let the operator search the parcel by address on the county
      // site and open the record, then read the page they land on. County sites
      // are free but every one differs, so this is the reliable path.
      if (typeof pauseForAction === 'function') {
        await pauseForAction(
          `In the county window, search for ${input.address} and open the parcel/property record (owner + mailing address), then click Resume.`,
        )
        if (signal?.aborted) return res
      }
      res.evidence.push(await capture(page, runDir, 'county-official-page'))
      const { values, audit } = await extractFields(page, selectors.county.fields, {})
      audit.forEach((a) => res.audit.push({ page: 'County', ...a }))
      res.data = { candidatePages: found, ...values }
      const gotOwner = values.recordedOwner && values.recordedOwner !== FIELD_NOT_FOUND
      if (gotOwner) emit({ type: 'log', source: label, message: `Recorded owner: ${values.recordedOwner}` })
    } catch (err) {
      res.notes.push(`Could not open/parse county page: ${String(err)}`)
    }
  }

  if (!res.data) res.data = { candidatePages: found }
  res.ok = found.length > 0
  if (!found.length) res.notes.push('No county record pages located (search may have been blocked).')
  else
    res.notes.push(
      'County pages located and captured. Owner/APN extraction uses generic label matching; ' +
        'many county sites need a county-specific parser — add one to selectors.js when known.',
    )
  return res
}
