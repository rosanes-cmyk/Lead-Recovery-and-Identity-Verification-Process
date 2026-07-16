# Selector Calibration Guide

How the automation finds each field, the rules it follows, and how to record
what you calibrate. Selectors live in `server/sources/selectors.js`.

## Strategy priority (most to least stable)

1. **Stable data attributes** — `[data-testid="owner-name"]`
2. **Accessible labels** — `aria-label`, or a `<label for>` tied to a control
3. **Text label + nearby value** — find the visible label, read the value beside it
4. **Semantic HTML** — `<address>`, `a[href^="tel:"]`, `a[href^="mailto:"]`
5. **Stable URLs / tabs** — navigate to a known tab or record URL
6. **CSS class selectors** — last resort only (classes churn)

Each field is an ordered list; the engine tries them top to bottom and uses the
first match. If none match it returns **`FIELD NOT FOUND`** — it never guesses
or substitutes another value. If a layout changes, the field goes to
`FIELD NOT FOUND` rather than silently returning the wrong thing.

## How to calibrate

```bash
npm run calibrate -- <source> <url>
# source: reiblackbook | propertyradar | dealmachine | county
```

Log in when prompted, press ENTER, and review the files written to
`runs/_calibration/<source>/`. Add the stable strategies you find (data
attributes first) to the front of that field's list in `selectors.js`.

## Document each calibrated selector

For every field you calibrate, record these (keep the table with your team):

| Field | Source | Page / tab | Strategy used | Example value | Fallback | If missing |
| --- | --- | --- | --- | --- | --- | --- |
| e.g. Recorded owner | PropertyRadar | Owner panel | data `[data-field="owner"]` | Phillip Lyman Barber | label "Owner" | FIELD NOT FOUND |

## Fields to calibrate per source

**REI BlackBook** (open the property/lead record **and** the attached contact —
communication history usually lives on the contact): Lead ID, seller name,
property address, mailing address, phones, emails, lead stage, disposition,
assigned team member, last activity, notes, call/text/email activity, open and
previous tasks.

**PropertyRadar:** recorded owner, vesting, ownership type, owner mailing
address, property address, occupancy, APN, phones, emails, trust/entity.

**DealMachine:** owner name, owner mailing address, property address, phones,
emails, occupancy, property details.

**County records:** recorded owner, owner mailing address, APN, vesting,
recorded document info, recording date, document number, trust/entity. County
sites vary; many need a county-specific parser added to `selectors.js`.

## People search

Disabled (`PEOPLE_SEARCH_ENABLED=false`) until Cherry Hombre approves an
aggregator in writing. When enabled, results are clues only, cross-checked
against official/property sources; no one is labeled a relative without a lawful
record.
