// Per-site selectors and URL patterns.
//
// These are the ONLY parts that are site-specific and need calibration against
// the real, logged-in pages (which differ per account and change over time).
// Everything else in the app is site-agnostic. When you can see a real page,
// fill in the selectors below and the matching module starts extracting data —
// no other code changes needed.
//
// Until a selector is filled in, the module still navigates, detects login
// walls, and captures a screenshot as evidence; it just reports the field as
// "needs selector configuration" instead of guessing.

export const selectors = {
  reiblackbook: {
    // Where a lead lives. If your leads open at a stable URL pattern, note it.
    loginUrl: 'https://members.reiblackbook.com/',
    lead: {
      sellerName: '',
      propertyAddress: '',
      mailingAddress: '',
      phones: '', // selector matching all phone elements
      emails: '',
      lastActivity: '',
      lastDisposition: '',
      assignedTeamMember: '',
      leadStage: '',
      notes: '',
    },
  },

  propertyradar: {
    loginUrl: 'https://app.propertyradar.com/',
    // Build a search URL for an address if the site supports it; otherwise the
    // module will fall back to the UI search box (selector below).
    searchUrlForAddress: '', // e.g. 'https://app.propertyradar.com/search?q={address}'
    searchBox: '',
    result: {
      ownerName: '',
      ownershipType: '',
      vesting: '',
      mailingAddress: '',
      occupancy: '',
    },
  },

  dealmachine: {
    loginUrl: 'https://app.dealmachine.com/',
    searchUrlForAddress: '',
    searchBox: '',
    result: {
      ownerName: '',
      mailingAddress: '',
      phones: '',
      emails: '',
    },
  },

  // People-search: configure ONE approved provider here. Left blank on purpose —
  // set the base URLs and result selectors for the tool your company approved.
  peoplesearch: {
    name: '', // e.g. 'TruePeopleSearch'
    loginUrl: '',
    searchUrlForAddress: '', // '{address}' placeholder gets URL-encoded
    searchUrlForName: '', // '{name}' and optional '{city}' / '{state}'
    searchUrlForPhone: '', // '{phone}'
    searchUrlForEmail: '', // '{email}'
    result: {
      // selectors that match repeated result rows / cards
      row: '',
      name: '',
      addresses: '',
      phones: '',
      // relatives are captured ONLY as unverified clues, never as facts
      possibleRelatives: '',
    },
  },
}

// Fill a URL template like 'https://x/search?q={address}'.
export function fillUrl(template, vars) {
  if (!template) return ''
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    encodeURIComponent(vars[k] == null ? '' : String(vars[k])),
  )
}
