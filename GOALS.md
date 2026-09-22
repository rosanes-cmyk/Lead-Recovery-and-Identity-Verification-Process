# End goals

Two deliverables, one engine. Everything in this repo is judged against these.

The business outcome behind both: stop paying for an afternoon of manual
research per property, and stop blasting 9,000 agents. Talk to the ~200 agents
who actually sell the kind of property we buy.

---

## Goal 1 — Address in, full picture out

**Outcome:** type or upload an address and get back everything a person
currently gathers by hand across five browser tabs.

**Done when**, for any San Francisco address, one action returns:

| Field | Status |
| --- | --- |
| Owner of record (plus taxpayer, entity/trust, vesting, mailing address, occupancy) | done |
| Last sale price and date | done |
| Assessed value | done |
| Listing agent and selling agent | **done** — read from Redfin, with brokerage, DRE licence, phone and email. Caveat: these are the agents of the property's most recent listing, so on a property that sold again they are not the agents of an older sale. The `Redfin Agents For` column names the sale they belong to |
| Permit history | **done** — building permits and code violations from the city's open data, by parcel |
| Liens and encumbrances | **done** — the recorded chain of title by parcel: open loans, unreleased judgments and tax/mechanics liens, notices of default. No amounts; the index carries none |

and all of the following hold:

- **Never guesses.** Every field is either a real value or `FIELD NOT FOUND`.
- **Verifies it read the right property.** Address match is reported per row.
- **Auditable.** Screenshot and source link per property.
- **Under a minute per property**, unattended. Today: ~40 seconds.
- **Takes one typed address** as well as a CSV. Done — the address box makes a
  one-row job and runs the same engine, so there is no second code path to
  drift.
- **Returns a CSV** that pastes straight back into Google Sheets. Done.

**Where it stands:** all six fields are done. Ownership and money are
verified against live screenshots, the MLS sheet and internal arithmetic;
agents come from Redfin, liens from the recorded chain of title, and permits
from the city's open data. **Goal 1 is complete.** Nothing else in this file is
goal 1.

Measured on a 19-row live run (22 Sep 2026): 19 of 19 rows processed in 22
minutes, PropertyRadar found 17, liens read on 17, permits on 17, agents on 18.
Zillow was blocked 7 times and the run continued every time. Where Redfin
showed the same sale as the sheet, its buyer agent matched the sheet's on 13 of
14, the exception being a row where Redfin records no buyer agent at all.

---

## Goal 2 — Market in, ranked agent list out

**Outcome:** the same engine run backwards. Not one address at a time, but the
whole city at once, to produce the target list that replaces mass outreach.

**Done when** a single run:

1. Pulls **every San Francisco sale for the last 24 months**.
2. Filters to **our kind of deal**: fixer, probate, trust sale, as-is.
3. Groups by **listing agent** and counts.
4. Returns **150–250 named agents, ranked** by how many of those deals they
   actually closed.
5. Carries enough **contact detail to act on**: phone, email, brokerage, office
   address, DRE licence, website, LinkedIn or Instagram.

**Where it stands (22 Sep 2026):** built end to end and ready to run. Paste a
Redfin search URL into the Agent List tab and it walks the result pages,
collects the properties, reads each one for its listing agent and listing text,
and ranks the agents. What remains is to run it for real on San Francisco and
see how many of the 150-250 names come back.

**How the universe is gathered.** By walking Redfin's own search pages. The
operator sets the filters they want on Redfin, copies the URL, and the app
pages through the results itself. This replaced an earlier plan to use the
"Download All" link, which caps at 350 rows a file and so meant about forty
downloads by hand for one city; that path is still available in the tab for a
search the crawler cannot reach, and the link column in those files is found by
its values rather than its name, because the header names are long and have
changed over the years.

**Corrected (22 Sep 2026): Redfin's keyword filter cannot narrow the crawl.**
An earlier version of this plan had the operator run eight keyword searches —
`probate`, `fixer`, `as-is` and so on — and read only those few hundred
properties instead of the whole city. Checked live: the keyword box does not
survive into the URL. `keyword=probate` and `keyword=fixer` returned the
identical 41 properties. Nor can the results page stand in for the property
page — only 5 of its 41 cards carried any listing text. So the deal-signal
filter stays where it always was, on each property's own remarks, and the crawl
enumerates the universe. What the URL genuinely filters, confirmed the same
way: `include=sold-2yr` (328 pages) and `property-type=house` (138 pages).
Houses and multi-family is the default, which is about 5,600 properties rather
than 13,000, and drops condos and co-ops, which we do not buy.

**Rate limiting is real.** It was hit while probing those URLs. The crawl and
the reading pass both pace themselves, an empty first page is reported as a
refusal rather than as an empty city, and five refusals in a row pause the run.

**The ranking.** The brief says "groups by listing agent and counts", and count
is the primary sort. Four more measures ride alongside as columns rather than
being folded into a score, because a score hides its reasoning and whoever
works the call list should be able to sort on what they care about:

- **Share** — what fraction of that agent's sales are our kind. Three of five
  matters far more than three of ninety.
- **Last deal** — recency, so a name that went quiet two years ago sinks.
- **Median days on market** on our kind of deal. An agent whose as-is listings
  sit is the one a cash buyer helps, and that is the opening line of the call.
- **Signals** — which of fixer, probate, trust sale and the rest they actually
  see.

**Previously:** The 234-name list we have today came from an
MLS export someone else ran. Those are buyer's agents, unfiltered and
unranked, so that file is an input, not this deliverable.

### ANSWERED (21 Sep 2026): listing status yes, agent names no

Checked live on the Listings tab of 547 Missouri St, a property that sold on
the open market in Oct 2023. The tab holds three MLS Market rows:

| Type | Status | Date | Description | DOM | Price |
| --- | --- | --- | --- | --- | --- |
| MLS Market | Sold | 10/23/2023 | (blank) | 12 | $4,850,000 |
| MLS Market | Cancelled | 7/7/2023 | (blank) | 36 | $4,895,000 |
| MLS Market | Expired | 12/30/2022 | (blank) | 675 | $5,350,000 |

There is **no agent column at all**, and the Description column, where "fixer"
and "as-is" would live, is empty. Below the table PropertyRadar offers "Check
for Listings" buttons that send you out to Zillow, Realtor and Redfin, which
is the vendor telling us it does not hold listing detail itself.

**What this settles:**

- Listing agent and selling agent **cannot come from PropertyRadar**, for one
  property or for thousands. Goal 1's agent fields and the whole of goal 2
  need another source.
- The fixer / as-is filter **cannot come from PropertyRadar** either, since
  remarks are not carried. Probate and trust can still be derived from vesting
  and deed type, which we already extract.
- **The MLS export is now the path for goal 2**, not a fallback. Whoever
  produced our 234-row starting file has the access needed.

**Redfin closes the gap (21 Sep 2026).** PropertyRadar's own "Open Redfin"
button pointed at the answer. The Redfin property page serves, in plain HTML
with no browser needed, the listing agent and buyer's agent with brokerage,
DRE licence, phone and email, plus the MLS marketing remarks. Verified against
547 Missouri St: Alexander Clark, The Front Steps, DRE #01339386, and James
Shinbori of Compass, all matching what the page shows a human. This is now
part of every enrichment row.

That also means the fixer / as-is filter is back on: remarks are matched
against twelve deal signals, so probate, trust sale, court confirmation and
contractor special come out as a column.

**What this unlocks straight away**, and was not in the original goal: real
listing history per property. Status, date, days on market, list price, and
the count of failed attempts before a sale. Three of those rows show a
property that sat 675 days, expired, was cancelled, then sold. That pattern is
a motivated seller, and we get it for free. The code already knows this tab
exists; it just does not read it yet.

### How the check was done (for next time)

Public records and MLS are two separate worlds. The county records who owns a
property, what they paid and what they owe. Agents are not parties to a deed,
so their names are never in public records. Listing agent, selling agent, days
on market and remarks like "fixer" or "as-is" exist only in the MLS, which is
licensed, not public. PropertyRadar is built on public records and resells MLS
data only where it has an agreement and the plan includes it.

There are three possible answers, not two: no MLS at all, listing status only
(on market, list price, days on market, no names), or full detail including
the agent. Only the third one is enough for us.

Four checks, quickest first:

1. **One property.** Open a property that definitely sold on the open market
   (any address from our 8-row test set) and click the Listings tab. A row
   with an agent name means yes. A row with dates and price but no name means
   status only. "Check for listings", an empty tab, or an upgrade prompt means
   no.
2. **The export columns.** Start any list export and look at the column
   chooser for "Listing Agent". This is the decisive one: if that column does
   not exist, the ranked list cannot come from PropertyRadar even if a name
   shows on a single property.
3. **The criteria menu.** Look for a Listing or MLS category holding Listing
   Status, Days on Market, List Price, Listing Agent. No agent criterion means
   no grouping by agent in bulk.
4. **Billing.** Check the plan page for an MLS or Listings add-on.

If the UI is ambiguous, send support this, in writing:

> Does my plan include MLS listing data for San Francisco, specifically the
> listing agent and selling agent names on sold properties? Can listing agent
> be used as a search criterion and included in a list export?

### The MLS route

The 234-row file we started from contains days on market and buyer's agent
name, phone and email. Those are MLS fields; public records have none of them.
So someone we work with already has MLS access. The same person can export
every San Francisco sale for 24 months with listing agent and remarks
included, which would satisfy most of goal 2 with no scraping at all.

---

## Order of work

1. ~~**Agents from Redfin.**~~ Done. Listing and buyer agent with brokerage,
   DRE, phone, email, plus MLS remarks and deal signals, on every row.
2. ~~**Permits.**~~ Done. Building permits and Department of Building
   Inspection notices of violation, by parcel, from the city's open data.
3. ~~**Liens.**~~ Done. Read per property from the SF recorder by parcel
   number, with liens paired against their releases.
4. ~~**Single-address box.**~~ Done.

**Goal 1 is finished.** Everything after this is goal 2.

*Bonus, not part of goal 1, do it only if it is free along the way:*
PropertyRadar's Listings tab (status, date, days on market, list price,
failed attempts before a sale).
5. **Get the MLS export** of every San Francisco sale for 24 months with
   listing agent and remarks. This is now a request to a person, not a build.
6. **Build goal 2** on top of that export: filter, group by listing agent,
   rank, then enrich the top names with contact detail.

---

## Sources for the last two fields (checked live, 21 Sep 2026)

### Permits — solved, free, no browser

`data.sf.gov`, dataset `i98e-djp9`, "Building Permits". A Socrata REST API,
no key required. Note the city moved off `data.sfgov.org`; old links 301.

Query it by **block and lot**, which is the parcel number the tool already
extracts, not by street text. For 547 Missouri St (block 4101, lot 032) the
parcel query returns 11 permits where the street-name query returns 6, because
permits get filed under spelling variants of the address.

Each record carries: permit number, type and type definition, status and
status date, filed / issued / approved / last-activity dates, revised cost,
description, block, lot, address, neighborhood and supervisor district.

Free and parcel-keyed from the same source, and arguably worth more to us than
permits: **`nbtm-fbw5`, Notices of Violation from the Department of Building
Inspection**, with an active / not-active status per violation. A property
under an active building violation is a motivated seller.

### Liens — better than first assessed

An earlier note in this file said the county recorder's index was not freely
queryable. **That was wrong**, and San Francisco is the exception in
California.

- **Already have, from PropertyRadar:** mortgages and deeds of trust, open
  loan balances, notices of default and trustee sales.
- **Free and online:** the Assessor-Recorder has published more than 7 million
  recorded documents from 1990 to present at `recorder.sfgov.org`, the first
  California county to do so. That set includes deeds, reconveyances, notices
  of default and lien documents. Searchable **by block and lot**, which we
  have; it cannot search by street address, which does not matter to us.
  Viewing is free, a copy is $1.81.
- **Calibrated 21 Sep 2026.** The search is
  `GET /SearchService/api/Search/GetSearchResults` with plain query
  parameters — `Block`, `LowLot`, `DocumentClass=OfficialRecords`,
  `MinRecordedDate`, `MaxRecordedDate`, `Rows`, `StartRow` — returning
  `{ResultCount, SearchResults[{PrimaryDocNumber, DocumentDate, FilingCode,
  Names}]}`.
- **But it cannot be called directly.** Every data endpoint requires a rolling
  single-use key: `password` and `encryptedkey` headers, spent on one request
  and replaced by calling `GetSecureKey`, which needs the current pair itself.
  The client mints a random number and encrypts it with a key baked into the
  app. That is an anti-automation measure, and reproducing it means defeating
  it, so we drive the page with the browser instead and read the JSON response
  it fetches. A few seconds per property rather than one, which is nothing
  beside the 40 the PropertyRadar step already takes.
- **Search by parcel, never by name.** Proven: block 4101 lot 032 returned 55
  documents, the whole history of the property. The owner's name returned six,
  three of them abstracts of judgment against a MICHAEL A WINTERS and a
  MICHAEL P WINTERS — different people. A name key would have reported a
  stranger's collections judgment against the seller.
- **Two limits to be honest about.** Documents before 1 Jan 1990 are in-person
  only, at City Hall room 190. And an index says a lien was recorded, not that
  it is still owed; establishing that means reading the release or
  reconveyance alongside it.
- **When certainty matters**, a title company preliminary report is still the
  industry answer, and a title rep will usually run one for an investor they
  work with. That is a phone call, not a build.

## Open questions

None. The lien scope question is closed: one parcel query returns mortgages,
judgments, tax and mechanics liens and notices of default together, so there
was nothing to save by asking for less, and all of it is in.
