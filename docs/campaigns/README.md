# Campaign copy, as sent

A snapshot of the live outreach sequence, pulled from Instantly on 5 Oct 2026.
It will go stale — Instantly is the source of truth — but it is kept here
because reading seven emails as a reader receives them is the only way to see
what three of them are actually doing wrong.

## Three defects found by pulling it

**Two pairs of step-1 variants are the same email.** Compared by hashing the
bodies rather than by eye:

| Subject | Body |
| --- | --- |
| A contractor's read before you negotiate credits | seller privacy, staging, open houses |
| A quiet option for the seller who wants privacy | *identical* |
| The second opinion (trusted advisor angle) | can the buyer perform, terms, speed |
| When you just need a buyer who performs | *identical* |

So an agent who opens "A contractor's read before you negotiate credits" — the
licensed-GC angle, the strongest thing in the campaign — is sent an email about
staging and open houses. Step 1 advertises five variants and sends three.

**A working note is in a live subject line.** "The second opinion (trusted
advisor angle)" — the parenthesis is copywriter shorthand that was never meant
to leave the brief. It has gone out from Realtors July 2026 (4,867 emails) and
Phase 1 – Peninsula Listing Agents (2,424).

**Step 2 has no unsubscribe link in its body**, where the other six do.
`insert_unsubscribe_header: true` means a header-level one still goes out, so
this is untidy rather than non-compliant.

## Why it matters to the reply rate

Across the four blast campaigns: 9,665 emails, 32 unique replies — 0.33%. Some
of that is the list, and goal 2 exists to fix the list. But step 1 is also
doing less work than the dashboard suggests, because two of its five variants
are duplicates and one carries a subject line that reads like an unfinished
template.
