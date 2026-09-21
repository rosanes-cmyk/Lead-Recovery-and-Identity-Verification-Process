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

### Guided PropertyRadar calibration (search flow)

When PropertyRadar's address search stops opening properties, run

```bash
npm run calibrate:propertyradar -- "547 Missouri Street, San Francisco, CA 94107"
```

You do the search by hand in the browser while it watches; after each of six
prompted steps (toolbar → address box → suggestions → results → profile →
starting a second search) you press ENTER and it saves the page HTML, a
screenshot, every visible clickable element, and all JSON PropertyRadar's page
fetched, under `runs/_calibration/propertyradar-flow/`. Zip that folder and
share it to get exact selectors written. Nothing on the site is changed.

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

## Property Enrichment tab (batch)

The second tab takes a **CSV of property addresses** (Google Sheets → File →
Download → CSV; Excel works too) and looks every row up, one at a time:

- **PropertyRadar** — owner of record, entity/REO flag and title holder,
  ownership type, vesting, owner mailing address, occupancy, APN, trust/entity,
  and the address PropertyRadar actually matched, flagged `match` / `mismatch`
  so a wrong match is visible instead of silent.
- **The web** — DuckDuckGo (no login; a direct lookup, falling back to the
  browser if challenged) for the Zillow / Redfin / Realtor.com / county-records
  links, plus any sold price / date shown in the result snippets. Clues only.
- **Zillow** — the property page itself, for property type (mobile /
  manufactured, lot / land, condo…), listing status (for sale / pending / off
  market / sold) and county. Best-effort: a Zillow bot check is reported, not
  worked around.

The findings are appended as new columns; **Download CSV** gives you the
original sheet plus those columns, ready to import back. Every finished row is
saved under `runs/enrich_<id>/` as it completes, so **Pause / Stop / Resume**
never redo work, and "Resume" on a previous job picks up exactly where it
stopped. A row with no owner reads `FIELD NOT FOUND` — nothing is guessed.

If PropertyRadar returns nothing for three rows in a row, the job **pauses and
hands over**: every property you then open by hand in the PropertyRadar window
is read and saved into the row whose address it matches, the moment it is on
screen — open as many as you like, then click Resume to let it try
automatically again. Each stuck screen is kept as a screenshot under
`runs/enrich_<id>/evidence/`, and a failed row's notes list the search steps
that were attempted.

Per property, PropertyRadar contributes: owner(s) of record, entity/trust flag,
ownership (person / trust / company), mailing address (Contacts, or the
Property tab's Taxpayer block), owner-occupied or not (homeowner tax exemption,
then mailing/primary-residence address), APN, county, property type, estimated
value, equity, assessed value, loan balance, purchase price / date / type,
owned since, year built, distress score, homeowner exemption, "likely to list
for sale" score, prior owner (deed grantor) and the last transfer.

Log into PropertyRadar once in the visible browser when prompted. After that the
saved session lets a job run with the browser hidden (**Hide the browser
window**). PropertyRadar allows one active login: the job pauses and tells you
if another session kicks it, then continues once you are back in.

`.env` settings: `ENRICH_DELAY_MS` (pause between rows — slower is gentler on
PropertyRadar), `ENRICH_WEB_SEARCH`, `ENRICH_ZILLOW`, `ENRICH_SCREENSHOTS` (one
result screenshot per row as evidence). `DEMO_MODE=true` runs the tab on
synthetic data.

PropertyRadar is an ExtJS app with quirks the search flow is built around
(verified live): its loading masks swallow normal clicks (every click is
forced), the address box is `Enter Site Address`, suggestions are normalised
`.x-boundlist-item`s (the first is taken, never text-matched), there are two
"Add Criteria" texts and only the LAST runs the search, and the result is
opened from the list row or the map marker → "Property Info" modal → detail
link. `test/fixtures/propertyradar-search.html` reproduces the traps so the flow
is regression-tested offline (`npm run test:propertyradar-search`).

### Redfin: the agents PropertyRadar does not carry

PropertyRadar's Listings tab holds MLS status, date, days on market and price,
but no agent and no remarks; under the table it offers "Open Redfin". So the
enrichment run reads the Redfin page for each address, which serves all of it
in plain HTML:

- **Listing agent** with brokerage, DRE licence, phone and email.
- **Buyer's agent** with brokerage, DRE licence and broker phone.
- **MLS remarks**, and the deal signals matched from them: fixer, as-is,
  probate, trust sale, estate sale, court confirmation, needs work, contractor
  special, tear down, deferred maintenance, investor, vacant.
- **MLS number and originating MLS.**

No browser is involved. It is a plain fetch of the Redfin URL the web-search
step already found, so it adds about a second per row rather than a tab. Turn
it off with `ENRICH_REDFIN=false` or the checkbox in the tab.

The agent email comes only from inside Redfin's own listing-agent block. A
bare `agentEmail` elsewhere on the page belongs to a Redfin house agent
advertising on the listing, and is deliberately ignored.

If Redfin serves a bot check the row reads `blocked by Redfin` and the other
columns are untouched. Nothing is guessed.

For calibration, the first rows of each job also log the JSON that
PropertyRadar's own page fetches to `runs/enrich_<id>/network-sample.jsonl` —
the data needed to later read the app's responses directly instead of the
rendered page.

## Letting someone else in (temporary sharing)

By default the server listens on `127.0.0.1` only. Nothing on your network can
open it, which is the right default: the app drives a browser that is already
signed in to PropertyRadar, and anyone who reaches the UI can start runs and
download every CSV in `runs/`.

To share it, first set one password in `.env`:

```
SHARE_PASSWORD=pick-a-long-passphrase
SHARE_TTL_HOURS=12
```

Then `npm start`. Every page, API call, live progress stream and CSV download
now asks for that password once, and the sign-in lasts `SHARE_TTL_HOURS`. The
startup banner prints the links to hand out. "Sign out" appears in the header,
and restarting the server signs everyone out.

**Same office / same Wi-Fi.** Setting a password also binds the server to your
LAN, so the banner prints something like `http://192.168.1.42:4319`. Send that
plus the password. Windows will ask once to allow Node through the firewall —
choose Private networks. The password crosses the LAN unencrypted, so use a
tunnel instead if the network is not yours.

**Anywhere else, no account needed.** Install the tunnel once:

```
winget install --id Cloudflare.cloudflared
```

Then **close that terminal and open a new one** — a terminal keeps the PATH it
started with, so the window you installed from will keep saying `'cloudflared'
is not recognized`. Leave `npm start` running in one window and use a second:

```
npm run share
```

That prints a temporary `https://<random>.trycloudflare.com` address that works
from anywhere and dies when you press Ctrl+C. It finds `cloudflared` even if
PATH is stale, checks the app is actually up, and refuses to open the link
unless `SHARE_PASSWORD` is set. If it still cannot find the program, point it
at the file: `set CLOUDFLARED_PATH=C:\Program Files (x86)\cloudflared\cloudflared.exe`.

`cloudflared tunnel --url http://localhost:4319` by hand and `ngrok http 4319`
both work too. Every tunnel reaches the server over loopback, which is why
there is **no localhost exemption** in the password guard — otherwise opening
one would hand the whole app to the internet.

**When you are done:** stop the tunnel, then blank `SHARE_PASSWORD` in `.env`
and restart. The server goes back to this machine only.

A few things to know before you share:

- One browser, one operator. A guest starting a run uses the same signed-in
  browser you do, and PropertyRadar allows a single active session, so agree on
  who is driving. The app already refuses a second run while one is going.
- Guests see the whole app, including past runs and their CSVs. There are no
  per-person accounts, just the one shared password.
- Eight wrong passwords from the same address locks that address out for ten
  minutes.
- Nothing here makes the app safe to leave online permanently. It is for a demo
  or a hand-off, not hosting.

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
  enrich.js        Property Enrichment engine: CSV queue, checkpoint/resume, output
  csv.js           CSV parse/write, address-column detection, address matching
  share.js         one shared password in front of everything, for temporary sharing
  sources/         one module per source (reiblackbook, propertyradar,
                   dealmachine, county, google, peoplesearch, websearch,
                   zillow, redfin) + selectors.js
public/            the operator UI: Investigation tab (input → progress → evidence →
                   approval) and Property Enrichment tab (enrich.js)
scripts/share.js   `npm run share`: temporary public link via a Cloudflare tunnel
docs/              the underlying SOP, note template, quick reference, QC checklist
```

## Roadmap

- **Phase 1 (this version):** single lead at a time, dry-run, approval gate.
- **Phase 2:** bulk CSV/spreadsheet upload and export, once single-lead accuracy
  is confirmed.
- **Later:** calibrated per-county parsers and official APIs where available.

See [`docs/`](docs/) for the full standard operating procedure this automation
follows.
