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
| Listing agent and selling agent | **not built** |
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

**The open question that sizes this work:** does our PropertyRadar plan carry
MLS listing data? The Listings tab on a profile currently reads "Check for
listings". If agent names are not in PropertyRadar, then goal 1's agent fields
and the whole of goal 2 need a different source, and "fixer" and "as-is" exist
only in MLS remarks, which no property-data source carries.

### How to answer it

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

### The fallback is already in reach

The 234-row file we started from contains days on market and buyer's agent
name, phone and email. Those are MLS fields; public records have none of them.
So someone we work with already has MLS access. The same person can export
every San Francisco sale for 24 months with listing agent and remarks
included, which would satisfy most of goal 2 with no scraping at all.

---

## Order of work

1. Finish goal 1 on the fields that do not depend on MLS: permits (free San
   Francisco parcel dataset), liens (source decision needed), single-address
   box.
2. Answer the MLS question.
3. Build goal 2.
