// Source registry. Order here is the order the orchestrator runs them:
// CRM review -> ownership sources -> public records -> people search.

import * as reiblackbook from './reiblackbook.js'
import * as propertyradar from './propertyradar.js'
import * as google from './google.js'
import * as peoplesearch from './peoplesearch.js'
// Disabled for now (re-enable by uncommenting the import + adding to the array):
//  - DealMachine: no account.
//  - County: public county sites are unreliable (down / bot-blocked) and the
//    manual step was confusing. PropertyRadar covers recorded owner instead.
// import * as dealmachine from './dealmachine.js'
// import * as county from './county.js'

export const sources = [reiblackbook, propertyradar, google, peoplesearch]

export function sourceById(id) {
  return sources.find((s) => s.id === id) || null
}
