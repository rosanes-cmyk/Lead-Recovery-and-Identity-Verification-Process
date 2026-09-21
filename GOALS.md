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
| Listing agent and selling agent | **not built** — not available in PropertyRadar, needs MLS (see below) |
| Permit history | **not built** |
| Liens and encumbrances | **partial** — open loan balance only; no tax, mechanics or involuntary liens, no notice of default |

and all of the following hold:

- **Never guesses.** Every field is either a real value or `FIELD NOT FOUND`.
- **Verifies it read the right property.** Address match is reported per row.
- **Auditable.** Screenshot and source link per property.
- **Under a minute per property**, unattended. Today: ~40 seconds.
- **Takes one typed address** as well as a CSV. Today: CSV only.
- **Returns a CSV** that pastes straight back into Google Sheets. Done.

**Where it stands:** about half. Ownership and money are solid and verified
against live screenshots, the MLS sheet and internal arithmetic. Agents,
permits and liens are missing.

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

**Where it stands:** not started. The 234-name list we have today came from an
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

1. **Add the Listings tab to the enrichment run.** Status, date, days on
   market, list price, failed-attempt count. Cheap, and the tab is already
   mapped.
2. **Permits**, from San Francisco's free parcel dataset. No browser needed.
3. **Single-address box**, so goal 1 matches how it was described.
4. **Liens.** Needs a source decision: foreclosure and default data sit in
   PropertyRadar, tax and mechanics liens sit with the county recorder.
5. **Get the MLS export** of every San Francisco sale for 24 months with
   listing agent and remarks. This is now a request to a person, not a build.
6. **Build goal 2** on top of that export: filter, group by listing agent,
   rank, then enrich the top names with contact detail.
