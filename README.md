# Lead Recovery & Seller Identity Verification Automation

An app that **performs the investigation automatically**. You give it a property
address or an REI BlackBook lead, and it opens the sources in a real browser,
reads the lead, researches ownership and identity, cross-checks the results,
scores confidence, flags conflicts, and prepares a complete REI BlackBook note
and next-task recommendation — then **stops and waits for your approval** before
anything is saved or changed.

It is **not** a manual form. You start a lead and watch it work.

> **Guardrail:** In the first version the app runs in **dry-run** mode. It
> researches and prepares only. It never contacts anyone, saves a note, changes
> a status, creates a task, or reassigns a lead without your explicit approval —
> and even on approval it makes **no CRM changes** while dry-run is on.

---

## ⚠️ One important thing: this runs on your computer

This app opens a real browser and uses **your own logins** to REI BlackBook,
PropertyRadar, DealMachine, etc. Because of that, it has to run **on your PC** —
it cannot be a click-a-link website (a website can't touch your logged-in
sessions). The good news: after a one-time setup, starting it is a single
command, and it opens the screen for you automatically.

The app **never stores your passwords.** You log in yourself in the browser
window when it asks; only the resulting session lives in a local profile folder
on your machine.

---

## Setup (one time)

You need [Node.js](https://nodejs.org) (the "LTS" version) and, for real runs,
your browser logins.

```bash
npm install        # install the app's dependencies
npm run setup      # creates your .env file and installs the browser it drives
```

## Try it immediately (demo mode — no logins needed)

Want to see how it works before wiring up your accounts? Open `.env` and set:

```
DEMO_MODE=true
```

Then:

```bash
npm start
```

Your browser opens to the app. Enter any address and click **Start
investigation** — it runs the full flow with sample data so you can see the
progress, report, and approval screen. No logins, no real browser.

## Real investigations

1. In `.env`, set `DEMO_MODE=false`.
2. `npm start` — the app opens.
3. Enter a lead (address, REI BlackBook link, name, phone, or email) and click
   **Start investigation**.
4. A browser window opens and works through the sources. When a site needs a
   login, the app **pauses** and shows "Login required" — sign in in that
   window, then click **Resume**.
5. Review the report, evidence screenshots, and the generated note. Edit the
   note if needed.
6. Click **Approve** or **Reject**. In dry-run mode, Approve records your
   decision but makes no CRM change.

---

## What it does (the pipeline)

For each lead the app:

1. Opens and reviews the REI BlackBook lead and contact activity.
2. Researches ownership via **County records**, **PropertyRadar**, and
   **DealMachine**, and finds the recorded owner's full name.
3. Compares the recorded name with the CRM name (tolerating spelling variants
   and middle names — e.g. "Philip Barber" ↔ "Phillip Lyman Barber").
4. Runs **approved people search** by address, name, phone, and email — as
   research clues only.
5. Identifies the best phone, email, and mailing address, cross-checking sources.
6. Assigns **High / Medium / Low** confidence to each finding.
7. Flags conflicts: differing owner names, multiple mailing addresses, a phone
   tied to another person, or trust / estate / probate ownership.
8. Recommends **one** status: *Seller Contact Located*, *No Contact After
   Investigation*, or *Management Review Required*.
9. Generates the full REI BlackBook note plus the next task, due date, and
   reassignment recommendation.
10. **Stops at the approval screen.** No CRM changes in dry-run mode.

It enforces the SOP **time limits** (Standard 30 min / Enhanced 60 min): when the
limit is reached it stops, keeps everything found, and finalizes the report.

---

## Safety controls (`.env`)

Everything defaults to the safe posture — the app prepares, a human executes:

| Flag | Default | Meaning |
| --- | --- | --- |
| `LIVE_MODE` | `false` | `false` = never write to any CRM |
| `DRY_RUN` | `true` | `true` = prepare only, change nothing |
| `AUTO_OUTREACH` | `false` | never contact anyone automatically |
| `AUTO_SAVE_NOTE` | `false` | never save the note automatically |
| `AUTO_CHANGE_STATUS` | `false` | never change status automatically |
| `AUTO_CREATE_TASK` | `false` | never create the next task automatically |
| `AUTO_REASSIGN` | `false` | never reassign automatically |

The operator controls in the UI: **Start · Pause · Resume · Stop · Approve ·
Reject · Save edits · Export note · Export report.**

---

## Configuring the live sources (calibration)

The app is site-agnostic except for the **selectors** — the small specs that
tell it where each field sits on a page. They live in one file:

- **`server/sources/selectors.js`** — an ordered list of strategies per field.

The defaults lead with **label-based** strategies (find the visible field label,
read the value next to it) and semantic ones (`tel:` / `mailto:` links for
phones/emails). Those often work before any site-specific tuning. Strategy
priority, per the SOP:

1. Stable data attributes → 2. Accessible labels → 3. Text labels + nearby value
→ 4. Semantic HTML → 5. Stable URLs/tabs → 6. CSS (last resort).

If none match, the engine returns **`FIELD NOT FOUND`** — it never guesses or
substitutes another value.

### The calibration command

To tune selectors against a real page, run:

```bash
npm run calibrate -- reiblackbook https://members.reiblackbook.com/leads/<id>
```

It opens the page, waits for you to log in and press ENTER, then prints which
selectors matched, and saves to `runs/_calibration/<source>/`:

- `candidates.json` — every data attribute, aria-label, and field label on the page
- `extracted.json` — what the current selectors found
- `page.html` + a screenshot

Add the stable strategies you find (data attributes first) to the front of each
field's list in `selectors.js`. Nothing on the website is ever changed.

### The one-lead live test

Run a full investigation against one real lead in dry-run mode from the UI, then
confirm the report matches the sites by eye. The success bar: REI BlackBook lead
+ contact extracted, at least one ownership source extracted, names compared,
contacts classified, conflicts preserved, note generated, stops at approval, no
CRM change, and screenshots + `audit.jsonl` prove each step (saved under
`runs/<runId>/`).

A structural proof of the extract→compare→report pipeline (against local page
fixtures, not real accounts) runs with:

```bash
npm run test:fixture
```

## People search — disabled by default

`PEOPLE_SEARCH_ENABLED=false`. Do **not** use TruePeopleSearch, Spokeo,
FastPeopleSearch, or any aggregator unless **Cherry Hombre approves it in
writing.** When enabled, results are treated as clues only and cross-checked
against official / property-data sources; nobody is labeled a relative without a
lawful record.

---

## Project structure

```
server/
  index.js         HTTP server, live progress (SSE), approval endpoints
  config.js        reads .env (safety flags, limits, browser)
  browser.js       Playwright persistent profile + login detection + screenshots
  orchestrator.js  the pipeline: controls, time limits, checkpoints
  scoring.js       confidence, conflict detection, status recommendation
  note.js          REI BlackBook note + next-task builder
  demo.js          synthetic run for DEMO_MODE
  store.js         saves each run (report.json + evidence screenshots) under runs/
  sources/         one module per source (reiblackbook, propertyradar,
                   dealmachine, county, google, peoplesearch) + selectors.js
public/            the operator UI (input → progress → evidence → approval)
docs/              the underlying SOP, note template, quick reference, QC checklist
```

## Roadmap

- **Phase 1 (this version):** single lead at a time, dry-run, approval gate.
- **Phase 2:** bulk CSV/spreadsheet upload and export, once single-lead accuracy
  is confirmed.
- **Later:** calibrated per-county parsers and official APIs where available.

See [`docs/`](docs/) for the full standard operating procedure this automation
follows.
