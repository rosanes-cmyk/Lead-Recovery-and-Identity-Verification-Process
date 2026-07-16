// Domain constants and blank-record factory for the Lead Recovery process.
// Values here mirror the SOP (docs/SOP.md) exactly — do not invent new
// statuses, confidence levels, or reassignment destinations.

export const INVESTIGATION_TYPES = ['Standard', 'Enhanced']

// Maximum minutes per SOP section 5.
export const TIME_LIMITS = {
  Standard: 30,
  Enhanced: 60,
}

export const CONFIDENCE_LEVELS = ['', 'High', 'Medium', 'Low']

export const PHONE_STATUSES = ['', 'Confirmed', 'Likely', 'Possible', 'Invalid']

export const PEOPLE_SEARCH_TYPES = ['Address', 'Phone', 'Name', 'Email']

// The only approved final statuses (SOP Step 13). One per investigation.
export const FINAL_STATUSES = [
  'Seller Contact Located',
  'Seller Confirmed Interested',
  'No Contact After Investigation',
  'Management Review Required',
]

// Status shown before a final recommendation has been chosen.
export const IN_PROGRESS_STATUS = 'In Progress'

export const REASSIGN_DESTINATIONS = [
  'Acquisitions',
  'Cherry Hombre',
  'Transaction Coordination',
]

// Sources checked list (SOP section 4 / note template).
export const SOURCE_KEYS = [
  'REI BlackBook',
  'County Assessor',
  'County Recorder',
  'County Tax Collector',
  'County GIS',
  'PropertyRadar',
  'DealMachine',
  'Google',
  'People Search',
  'Other Public Records',
]

// The final quality-control checklist (docs/quality-control-checklist.md).
export const QC_ITEMS = [
  'The complete REI BlackBook record was reviewed.',
  'The investigation objective was clearly defined.',
  'The time limit was followed.',
  'Ownership was checked through reliable property records.',
  'People-search results were independently verified.',
  'The correct full name was documented.',
  'Name spelling differences were explained.',
  'The best phone number was classified.',
  'The email address was classified.',
  'The mailing address was verified.',
  'Every finding includes a source and date.',
  'Every finding includes a confidence level.',
  'Conflicting information was clearly flagged.',
  'No relative was classified based only on an aggregator.',
  'No unauthorized outreach occurred.',
  'One final status was recommended.',
  'A clear next task and due date were prepared.',
  'The correct reassignment destination was identified.',
  'The final note was presented for approval before saving.',
]

// Stable, deterministic id (avoids Math.random / Date.now edge cases when
// generating many at once).
let counter = 0
export function makeId() {
  counter += 1
  return `inv_${Date.now().toString(36)}_${counter.toString(36)}`
}

export function makeFinding() {
  return {
    searchType: 'Address',
    searchValue: '',
    nameFound: '',
    connection: '',
    source: '',
    dateChecked: '',
    confidence: '',
    supportingMatch: '',
    conflicting: '',
  }
}

export function makePhone() {
  return {
    number: '',
    associatedName: '',
    status: '',
    source: '',
    dateChecked: '',
    matchesSeller: false,
    matchesProperty: false,
    confidence: '',
  }
}

export function makeEmail() {
  return {
    address: '',
    associatedName: '',
    source: '',
    dateChecked: '',
    confidence: '',
  }
}

export function blankInvestigation() {
  return {
    id: makeId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    // Header
    task: 'Investigate and Verify Seller Identity and Contact Information',
    sellerName: '',
    verifiedName: '',
    propertyAddress: '',
    leadId: '',
    investigator: '',
    investigationDate: '',
    investigationType: 'Standard',
    timeUsed: '',
    priority: '',
    objective: '',
    outreachAuthorized: false,
    relativeContactAuthorized: false,

    // Step 1 — Baseline review
    baseline: {
      nameOnFile: '',
      phoneOnFile: '',
      emailOnFile: '',
      mailingOnFile: '',
      propertyAddress: '',
      lastActivity: '',
      lastDisposition: '',
      leadStage: '',
      assignedTeamMember: '',
      redFlags: '',
    },

    // Step 3 — Ownership findings
    ownership: {
      recordedOwner: '',
      ownershipType: '',
      trustOrEntity: '',
      mailingAddress: '',
      source: '',
      dateChecked: '',
      confidence: '',
      supportingDetails: '',
    },

    // Steps 4-5 — People-search findings (multiple)
    findings: [],

    // Steps 6-8 — Contact verification
    phones: [],
    emails: [],
    mailing: {
      confirmedAddress: '',
      source: '',
      confidence: '',
      classification: '', // property / separate / previous / forwarding / unconfirmed
    },

    // Step 9 + conflicts
    conflicts: {
      conflict1: '',
      conflict2: '',
      managementReview: '',
    },

    // Sources checked (notes per source)
    sources: SOURCE_KEYS.reduce((acc, k) => ({ ...acc, [k]: '' }), {}),

    // Step 11 — Outreach
    outreach: {
      conducted: false,
      authorizedMethod: '',
      result: '',
      sellerResponse: '',
    },

    // Steps 13-15 — Recommendation
    recommendation: {
      status: '',
      reason: '',
      nextTask: '',
      dueDate: '',
      reassignTo: '',
    },

    // QC checklist state (index -> boolean)
    qc: {},
  }
}
