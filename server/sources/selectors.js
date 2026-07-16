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
      phones: [semanticPhone, { type: 'labelValue', label: 'Phone' }],
      emails: [semanticEmail, { type: 'labelValue', label: 'Email' }],
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
    searchBox: '',
    fields: {
      recordedOwner: [
        { type: 'labelValue', label: 'Owner' },
        { type: 'labelValue', label: 'Owner Name' },
        { type: 'labelValue', label: 'Primary Owner' },
      ],
      vesting: [{ type: 'labelValue', label: 'Vesting' }],
      ownershipType: [
        { type: 'labelValue', label: 'Ownership Type' },
        { type: 'labelValue', label: 'Owner Type' },
      ],
      ownerMailingAddress: [
        { type: 'labelValue', label: 'Mailing Address' },
        { type: 'labelValue', label: 'Owner Address' },
      ],
      propertyAddress: [{ type: 'labelValue', label: 'Property Address' }, { type: 'semantic', selector: 'address' }],
      occupancy: [
        { type: 'labelValue', label: 'Occupancy' },
        { type: 'labelValue', label: 'Owner Occupied' },
      ],
      apn: [{ type: 'labelValue', label: 'APN' }, { type: 'labelValue', label: 'Parcel' }],
      phones: [semanticPhone, { type: 'labelValue', label: 'Phone' }],
      emails: [semanticEmail, { type: 'labelValue', label: 'Email' }],
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
      phones: [semanticPhone, { type: 'labelValue', label: 'Phone' }],
      emails: [semanticEmail, { type: 'labelValue', label: 'Email' }],
      occupancy: [{ type: 'labelValue', label: 'Occupancy' }, { type: 'labelValue', label: 'Owner Occupied' }],
      propertyDetails: [{ type: 'labelValue', label: 'Property Details' }, { type: 'labelValue', label: 'Details' }],
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

// Fill a URL template like 'https://x/search?q={address}'.
export function fillUrl(template, vars) {
  if (!template) return ''
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] == null ? '' : String(vars[k])))
}
