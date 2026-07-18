// Field specifications per source.
//
// Each field is an ORDERED list of strategies (see resolve.js). They follow the
// SOP priority: stable data attributes first, then accessible labels, then
// text-labels-with-nearby-value, then semantic HTML, then CSS as a last resort.
// The engine tries them in order and returns FIELD NOT FOUND if none match.
//
// The defaults below lead with label-based strategies keyed on the visible field
// names, because those survive class-name churn and often work before any
// site-specific calibration. After you run `npm run calibrate` against a real
// page, add the stable data-attribute strategies you find to the FRONT of each
// list — they become the primary and the label strategies stay as fallbacks.
//
// DOCUMENTATION: for each field, `doc` records the calibration notes required by
// the SOP (page/tab, strategy, example value, fallback, missing behavior).

const semanticPhone = { type: 'semantic', selector: 'a[href^="tel:"]' }
const semanticEmail = { type: 'semantic', selector: 'a[href^="mailto:"]' }
// Fallbacks that scan the page text — many CRMs show phone/email as plain text,
// not tel:/mailto: links or labelled fields.
const patternPhone = { type: 'pattern', kind: 'phone' }
const patternEmail = { type: 'pattern', kind: 'email' }

export const selectors = {
  reiblackbook: {
    loginUrl: 'https://members.reiblackbook.com/',
    // How to reach the attached CONTACT record from the property/lead page.
    // Communication history often lives on the contact, so the module opens it.
    contactLink: [
      { type: 'attr', selector: 'a[href*="/contacts/"]', attr: 'href' },
      { type: 'attr', selector: 'a[href*="contact"]', attr: 'href' },
      { type: 'attr', selector: 'a:has-text("Contact")', attr: 'href' },
    ],
    fields: {
      leadId: [
        { type: 'data', selector: '[data-lead-id]' },
        { type: 'attr', selector: '[data-lead-id]', attr: 'data-lead-id' },
        { type: 'labelValue', label: 'Lead ID' },
      ],
      sellerName: [
        { type: 'data', selector: '[data-testid="lead-name"]' },
        { type: 'aria', label: 'Seller name' },
        { type: 'labelValue', label: 'Name' },
        { type: 'labelValue', label: 'Seller' },
      ],
      propertyAddress: [
        { type: 'labelValue', label: 'Property Address' },
        { type: 'labelValue', label: 'Address' },
        { type: 'semantic', selector: 'address' },
      ],
      mailingAddress: [
        { type: 'labelValue', label: 'Mailing Address' },
        { type: 'labelValue', label: 'Owner Mailing Address' },
      ],
      phones: [semanticPhone, { type: 'labelValue', label: 'Phone' }, { type: 'labelValue', label: 'Mobile' }, { type: 'labelValue', label: 'Cell' }, patternPhone],
      emails: [semanticEmail, { type: 'labelValue', label: 'Email' }, patternEmail],
      leadStage: [
        { type: 'labelValue', label: 'Stage' },
        { type: 'labelValue', label: 'Lead Stage' },
      ],
      disposition: [
        { type: 'labelValue', label: 'Disposition' },
        { type: 'labelValue', label: 'Last Disposition' },
      ],
      assignedTeamMember: [
        { type: 'labelValue', label: 'Assigned To' },
        { type: 'labelValue', label: 'Assigned' },
        { type: 'labelValue', label: 'Owner' },
      ],
      lastActivity: [
        { type: 'labelValue', label: 'Last Activity' },
        { type: 'labelValue', label: 'Last Contact' },
      ],
      notes: [
        { type: 'data', selector: '[data-testid="notes"]' },
        { type: 'labelValue', label: 'Notes' },
      ],
      callSummaries: [{ type: 'css', selector: '[data-activity-type="call"]' }],
      textActivity: [{ type: 'css', selector: '[data-activity-type="text"], [data-activity-type="sms"]' }],
      emailActivity: [{ type: 'css', selector: '[data-activity-type="email"]' }],
      openTasks: [{ type: 'css', selector: '[data-task-status="open"], .task.open' }],
      previousTasks: [{ type: 'css', selector: '[data-task-status="completed"], .task.completed' }],
    },
  },

  propertyradar: {
    loginUrl: 'https://app.propertyradar.com/',
    searchUrlForAddress: '', // e.g. 'https://app.propertyradar.com/search?address={address}'
    searchBox: '', // exact search-input selector (set after calibration for reliability)
    resultRow: '', // exact first-result selector to click after searching
    fields: {
      // Owner of record. "Taxpayer" (name + mailing addr) is the most reliable
      // label-anchored source on PropertyRadar; the extractor strips the address
      // and, for entity/REO owners, recovers the individual from the deed history.
      recordedOwner: [
        { type: 'labelValue', label: 'Taxpayer' },
        { type: 'labelValue', label: 'Owner Name' },
        { type: 'labelValue', label: 'Owner of Record' },
        { type: 'labelValue', label: 'Primary Owner' },
        { type: 'labelValue', label: 'Assessee' },
        { type: 'labelValue', label: 'Owner' },
      ],
      vesting: [{ type: 'labelValue', label: 'Vesting' }, { type: 'labelValue', label: 'Ownership Role' }],
      ownershipType: [
        { type: 'labelValue', label: 'Person Type' },
        { type: 'labelValue', label: 'Ownership Type' },
        { type: 'labelValue', label: 'Owner Type' },
      ],
      ownerMailingAddress: [
        { type: 'labelValue', label: 'Mailing Address' },
        { type: 'labelValue', label: 'Owner Address' },
      ],
      propertyAddress: [{ type: 'labelValue', label: 'Address' }, { type: 'labelValue', label: 'Property Address' }, { type: 'semantic', selector: 'address' }],
      occupancy: [
        { type: 'labelValue', label: 'Primary Residence' },
        { type: 'labelValue', label: 'Occupancy' },
        { type: 'labelValue', label: 'Owner Occupied' },
      ],
      apn: [{ type: 'labelValue', label: 'Assessor Parcel Number' }, { type: 'labelValue', label: 'APN' }, { type: 'labelValue', label: 'Parcel' }],
      phones: [semanticPhone, { type: 'labelValue', label: 'Phone' }, patternPhone],
      emails: [semanticEmail, { type: 'labelValue', label: 'Email' }, patternEmail],
      trustEntity: [{ type: 'labelValue', label: 'Trust' }, { type: 'labelValue', label: 'Entity' }],
    },
  },

  dealmachine: {
    loginUrl: 'https://app.dealmachine.com/',
    searchUrlForAddress: '',
    searchBox: '',
    fields: {
      ownerName: [{ type: 'labelValue', label: 'Owner' }, { type: 'labelValue', label: 'Owner Name' }],
      ownerMailingAddress: [{ type: 'labelValue', label: 'Mailing Address' }, { type: 'labelValue', label: 'Owner Address' }],
      propertyAddress: [{ type: 'labelValue', label: 'Property Address' }, { type: 'semantic', selector: 'address' }],
      phones: [semanticPhone, { type: 'labelValue', label: 'Phone' }, patternPhone],
      emails: [semanticEmail, { type: 'labelValue', label: 'Email' }, patternEmail],
      occupancy: [{ type: 'labelValue', label: 'Occupancy' }, { type: 'labelValue', label: 'Owner Occupied' }],
      propertyDetails: [{ type: 'labelValue', label: 'Property Details' }, { type: 'labelValue', label: 'Details' }],
    },
  },

  // Approved people-search provider (Cherry Hombre approved TruePeopleSearch).
  // Results are CLUES ONLY, cross-checked elsewhere. TruePeopleSearch blocks
  // bots aggressively, so expect a human "verify you're human" check the app
  // pauses for. {street}/{citystatezip} are filled from the parsed address.
  peoplesearch: {
    name: 'TruePeopleSearch',
    loginUrl: 'https://www.truepeoplesearch.com/',
    searchUrlForAddress: 'https://www.truepeoplesearch.com/resultaddress?streetaddress={street}&citystatezip={citystatezip}',
    searchUrlForName: 'https://www.truepeoplesearch.com/results?name={name}&citystatezip={citystatezip}',
    searchUrlForPhone: 'https://www.truepeoplesearch.com/resultphone?phoneno={phone}',
    searchUrlForEmail: '', // TPS has no reverse-email search
    result: {
      row: '.card-summary',
      name: 'a[href*="/find/person/"], .h4',
      addresses: '[itemprop="address"], .content-value',
      phones: 'a[href^="tel:"]',
      possibleRelatives: '', // captured as unverified clues only, never as facts
    },
  },

  county: {
    // County sites are located via Google (no login). When a specific county's
    // record page is known, add its field strategies here keyed by county.
    fields: {
      recordedOwner: [{ type: 'labelValue', label: 'Owner' }, { type: 'labelValue', label: 'Owner Name' }, { type: 'labelValue', label: 'Assessee' }],
      ownerMailingAddress: [{ type: 'labelValue', label: 'Mailing Address' }, { type: 'labelValue', label: 'Mail Address' }],
      apn: [{ type: 'labelValue', label: 'APN' }, { type: 'labelValue', label: 'Parcel Number' }, { type: 'labelValue', label: 'Parcel' }],
      vesting: [{ type: 'labelValue', label: 'Vesting' }],
      recordedDocInfo: [{ type: 'labelValue', label: 'Document' }, { type: 'labelValue', label: 'Recording' }],
      recordingDate: [{ type: 'labelValue', label: 'Recording Date' }, { type: 'labelValue', label: 'Recorded' }],
      documentNumber: [{ type: 'labelValue', label: 'Document Number' }, { type: 'labelValue', label: 'Doc Number' }],
      trustEntity: [{ type: 'labelValue', label: 'Trust' }, { type: 'labelValue', label: 'Entity' }],
    },
  },
}

// Known county parcel-search portals. When a lead's address matches, the app
// opens the search tool directly (instead of a Google-found info page) so the
// operator lands right on the search box. Add more counties as you work them.
export const countyPortals = [
  {
    name: 'Yavapai County, AZ',
    // Prescott / Prescott Valley / Chino Valley etc. — Yavapai zips are 863xx.
    match: /\b(yavapai|prescott|chino valley|cottonwood|camp verde|dewey|humboldt)\b|\bAZ\b.*\b863\d\d\b|\b863\d\d\b/i,
    searchUrl: 'https://gis.yavapaiaz.gov/v4/search.aspx',
  },
]

export function matchCountyPortal(address) {
  return countyPortals.find((p) => p.match.test(String(address || ''))) || null
}

// Fill a URL template like 'https://x/search?q={address}'.
export function fillUrl(template, vars) {
  if (!template) return ''
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] == null ? '' : String(vars[k])))
}
