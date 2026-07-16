# Lead Recovery and Identity Verification Project

A standardized process for investigating stalled, incomplete, or conflicting
lead records — confirming the correct property owner or seller, verifying the
connection between the person and the property, locating accurate contact
information, flagging conflicts, and documenting every finding in REI BlackBook
so the lead can be reassigned and followed up correctly.

> **Scope reminder:** The investigator **gathers, verifies, and documents**
> information. The investigator does **not** make pricing, negotiation, legal,
> fraud, or final business decisions. Those belong to a manager or authorized
> operator.

## The app

A React + Vite single-page app that turns the SOP into a guided tool with a
lead dashboard. It runs entirely in the browser — **all data is stored in
`localStorage`; there is no backend and no login.**

### Features

- **Dashboard** — every investigation as a card, with search and status filters
  (In Progress, Seller Contact Located, Seller Confirmed Interested, No Contact
  After Investigation, Management Review Required) and a QC progress count.
- **Guided workflow** — a stepper walks through Setup & Scope, Baseline Review,
  Ownership, People Search, Contact Verification, Conflicts & Relatives, Sources
  Checked, Outreach, Recommendation, and QC & Note, each annotated with the SOP
  rules for that step.
- **Guardrails built in** — Standard/Enhanced time limits with an over-limit
  warning, an outreach section that stays locked until outreach is authorized,
  single-select final status, and a reassignment hint for Management Review.
- **Findings capture** — add multiple people-search findings, phones (with
  Confirmed/Likely/Possible/Invalid classification), and emails, each with a
  source, date, and confidence level.
- **Note generator** — produces the complete REI BlackBook note (matching the
  template) to copy or download, plus a live Definition of Done checklist.

### Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
npm run preview    # preview the production build
```

The build output in `dist/` is a static site and can be hosted anywhere.

## Documentation

| File | Purpose |
| --- | --- |
| [`docs/SOP.md`](docs/SOP.md) | The full Standard Operating Procedure — roles, rules, sources, time limits, and the 15-step workflow. |
| [`docs/investigation-note-template.md`](docs/investigation-note-template.md) | The fillable Lead Recovery Investigation note used in REI BlackBook. |
| [`docs/quick-reference.md`](docs/quick-reference.md) | One-page cheat sheet: sources, time limits, confidence levels, statuses, reassignment. |
| [`docs/quality-control-checklist.md`](docs/quality-control-checklist.md) | The final QC checklist to confirm before closing an investigation. |

## How to run an investigation

1. Open the app and click **New investigation** (or read the
   **[SOP](docs/SOP.md)** for the full process).
2. Confirm the investigation objective and scope in **Setup & Scope** — Standard
   vs. Enhanced, and whether outreach is authorized.
3. Work through the stepper, recording a **source, date, and confidence level**
   for every finding.
4. Complete the **QC checklist** before presenting the note for approval.
5. Recommend one final status and the next task, then click **Generate note**.
   The authorized operator approves and executes: saving the note, setting the
   status, creating the next task, and reassigning the lead.

## Definition of Done

An investigation is **not complete** until all four actions are done by the
authorized operator:

1. The complete investigation note is saved in REI BlackBook.
2. The approved final status is selected.
3. The next task and due date are created.
4. The lead is reassigned to the correct person or department.

The investigator **prepares and recommends** these actions. The authorized
operator **approves and executes** them.
