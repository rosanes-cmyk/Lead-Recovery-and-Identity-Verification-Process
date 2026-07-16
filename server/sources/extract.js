// Runs a source's field specs through the selector engine and returns both the
// extracted values and a per-field audit trail (which strategy matched, the
// value, and whether it was found) for the run log.

import { resolveField, resolveList, FIELD_NOT_FOUND } from './resolve.js'

// listFields: field names that should collect multiple values.
// semantics: { fieldName: 'phone'|'email' } for built-in tel:/mailto: defaults.
export async function extractFields(page, fieldSpecs, { listFields = [], semantics = {} } = {}) {
  const values = {}
  const audit = []
  for (const [field, strategies] of Object.entries(fieldSpecs)) {
    if (listFields.includes(field)) {
      const list = await resolveList(page, strategies, { semantic: semantics[field] })
      values[field] = list
      audit.push({ field, ok: list.length > 0, count: list.length, value: list.slice(0, 5).join(' | ') || FIELD_NOT_FOUND, strategy: list.length ? 'list' : 'none matched' })
    } else {
      const r = await resolveField(page, strategies)
      values[field] = r.ok ? r.value : FIELD_NOT_FOUND
      audit.push({ field, ok: r.ok, value: r.value, strategy: r.strategy })
    }
  }
  return { values, audit }
}

export { FIELD_NOT_FOUND }
