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

---

## Order of work

1. Finish goal 1 on the fields that do not depend on MLS: permits (free San
   Francisco parcel dataset), liens (source decision needed), single-address
   box.
2. Answer the MLS question.
3. Build goal 2.
