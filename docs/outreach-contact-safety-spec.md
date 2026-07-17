# Contact-Safety / Outreach-Suppression Spec

> **Handoff note:** This logic was removed from the Lead Recovery & Identity
> Verification app (that app only researches/verifies — it never contacts
> anyone). These rules belong in the **outreach automation** (the one that sends
> texts/emails/calls). This document is the complete spec to rebuild it there.

## Purpose

Before the outreach automation contacts a lead, it must check the lead and
**suppress / skip** contact when the lead should not be contacted, and **avoid
duplicate contact**. This protects against compliance issues (TCPA / opt-outs)
and annoying leads with repeat messages.

## Where to read the signals

Read all of these from the CRM lead (e.g. REI BlackBook contact record):

1. **Tags / labels** on the lead (chips like `Do Not Automate`, `Do Not Call`).
2. **Notes** field.
3. **Conversation / activity history** — the SMS thread, call summaries, and
   email activity (often on an **Activity / Communications tab**, not the main
   "About" tab — the automation must open that tab to see replies like "STOP").

Combine the text from all three and scan it.

## Signals to detect

### A. Do Not Automate
- Tag/phrase: **"Do Not Automate"**.
- Action: **Skip the lead entirely.** Do not run any outreach step on it. Mark
  it "Skipped — Do Not Automate".

### B. Do Not Contact / opt-out
Detect any of (case-insensitive):
- `unsubscribe`
- `do not call` / `do not text` / `do not email` / `do not contact`
- `do not market` / `do not mail` / `do not solicit`
- `opt out` / `opted out`
- `remove me`
- `DNC`
- `no more texts` / `no more calls` / `no more emails`
- `stop texting` / `stop calling` / `stop contacting`
- a standalone **`STOP`** reply (SMS opt-out convention — treat uppercase STOP as an opt-out)

Suggested regex (mirrors what was built):
```js
const OPTOUT = /\b(unsubscribe|do ?not ?(?:call|text|email|contact|automate|market|mail|solicit)|opt(?:ed)? ?out|remove me|\bdnc\b|no (?:more )?(?:texts?|calls?|emails?|contact)|stop (?:texting|calling|contacting))\b/i
// plus: /\bSTOP\b/ (uppercase) as a standalone opt-out reply
```
- Action: **Block all outreach** (no call/text/email). Flag **DO NOT CONTACT**.
- Honor an SMS **STOP** immediately and permanently (TCPA).

### C. Already contacted (don't double-contact)
- Detect prior outbound outreach in the history — e.g. your template markers:
```js
const OUTBOUND = /(are you still interested|reply yes or no|this is \w+ with|thinking about you|been thinking about you)/i
```
- Better: read the **date + direction** of each message/call, and compute the
  **last outbound contact date**.
- Rule: **do not send the same channel twice in the same calendar month** (or
  within N days — make it configurable). If already contacted this month, skip
  (or hold) that lead for this cycle.

## Behavior summary

| Signal | Outreach automation should… |
| --- | --- |
| Do Not Automate tag | Skip the lead; do nothing |
| Opt-out / STOP / Do Not Email/Call/Text / DNC | Never contact; mark Do Not Contact; suppress permanently |
| Already contacted this month | Skip this cycle; don't duplicate |
| None of the above | Proceed with the normal outreach sequence |

## Recommended data model

```
{
  leadId,
  tags: [ "Do Not Automate", ... ],
  doNotContact: true|false,        // from B
  doNotContactReason: "STOP" | "do not email" | ...,
  doNotAutomate: true|false,       // from A
  lastOutboundAt: "2026-07-16",    // from C (per channel ideally)
  lastOutboundChannel: "sms" | "call" | "email",
  suppressed: true|false,          // final decision: skip contact?
  suppressReason: "opt-out" | "already contacted this month" | "do not automate"
}
```

## Compliance notes
- Treat **STOP / opt-out as permanent** — record it and never message again.
- Keep an **audit trail**: what signal was found, where, and when, and the
  suppression decision — so you can prove compliance.
- When unsure, **suppress** (don't contact) rather than risk an unwanted message.
