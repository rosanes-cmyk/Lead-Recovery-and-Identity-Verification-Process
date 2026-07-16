// Source registry. Order here is the order the orchestrator runs them:
// CRM review -> ownership sources -> public records -> people search.

import * as reiblackbook from './reiblackbook.js'
import * as propertyradar from './propertyradar.js'
import * as county from './county.js'
import * as google from './google.js'
import * as peoplesearch from './peoplesearch.js'
// DealMachine disabled for now (no account). To re-enable: uncomment the import
// and add `dealmachine` back to the sources array below.
// import * as dealmachine from './dealmachine.js'

export const sources = [reiblackbook, county, propertyradar, google, peoplesearch]

export function sourceById(id) {
  return sources.find((s) => s.id === id) || null
}
