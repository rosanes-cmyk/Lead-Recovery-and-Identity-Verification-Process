// Source registry. Order here is the order the orchestrator runs them:
// CRM review -> ownership sources -> public records -> people search.

import * as reiblackbook from './reiblackbook.js'
import * as propertyradar from './propertyradar.js'
import * as dealmachine from './dealmachine.js'
import * as county from './county.js'
import * as google from './google.js'
import * as peoplesearch from './peoplesearch.js'

export const sources = [reiblackbook, county, propertyradar, dealmachine, google, peoplesearch]

export function sourceById(id) {
  return sources.find((s) => s.id === id) || null
}
