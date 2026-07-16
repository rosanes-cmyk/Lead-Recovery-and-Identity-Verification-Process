// Demo pipeline: emits realistic progress and synthetic findings without
// launching a browser or touching any real site. Lets the operator explore the
// full flow (progress -> report -> approval) before configuring live sources.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Returns consolidated demo data for the given input.
export function demoData(input) {
  const name = input.name || 'Philip Barber'
  const address = input.address || '123 Main Street, Anytown, CA 94000'
  return {
    input,
    crm: {
      sellerName: name,
      propertyAddress: address,
      phones: [input.phone || '(925) 555-1234'],
      emails: input.email ? [input.email] : [],
      lastDisposition: 'No answer',
      assignedTeamMember: 'Unassigned',
    },
    ownership: {
      recordedOwner: 'Phillip Lyman Barber',
      ownershipType: 'Joint Tenancy',
      vesting: 'Husband and Wife',
      mailingAddress: 'PO Box 44, Anytown, CA 94000',
      source: 'PropertyRadar',
    },
    corroboration: { dealmachine: { ownerName: 'Phillip L Barber', mailingAddress: 'PO Box 44, Anytown, CA 94000' } },
    county: { candidatePages: [{ query: 'assessor', title: 'County Assessor — Parcel 123-45-678', url: 'https://example.gov/assessor' }] },
    google: { links: [{ title: 'County records', url: 'https://example.gov' }] },
    peoplesearch: {
      results: [
        { kind: 'phone', rows: [{ name: 'Phillip Lyman Barber', phones: [input.phone || '(925) 555-1234'], addresses: [address], possibleRelatives: ['Jane Barber'] }] },
      ],
    },
  }
}

// Drives an Investigation instance through the demo, emitting the same events a
// real run would. `inv` is the Investigation (for emit + state + data).
export async function runDemo(inv) {
  const steps = [
    ['REI BlackBook', 'Opening lead and reviewing contact activity'],
    ['County Records', 'Locating assessor / recorder pages'],
    ['PropertyRadar', 'Confirming recorded owner and mailing address'],
    ['DealMachine', 'Cross-checking ownership and contacts'],
    ['Google', 'Searching public records'],
    ['Approved People Search', 'Reverse phone and address lookups'],
  ]
  inv.data = demoData(inv.input)
  for (const [source, msg] of steps) {
    if (inv.state === 'stopped') break
    await inv._waitIfPaused()
    inv.emit({ type: 'source-start', source })
    inv.emit({ type: 'log', source, message: msg })
    await sleep(650)
    inv.sourcesChecked.push({ source, summary: 'checked (demo)' })
    inv.emit({ type: 'source-done', source, ok: true, notes: [], evidenceCount: 0 })
  }
  return inv.finalize(inv.state === 'stopped' ? 'stopped' : 'done')
}
