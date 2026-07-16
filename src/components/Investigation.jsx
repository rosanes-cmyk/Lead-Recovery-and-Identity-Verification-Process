import { useMemo, useState } from 'react'
import {
  INVESTIGATION_TYPES,
  TIME_LIMITS,
  PEOPLE_SEARCH_TYPES,
  PHONE_STATUSES,
  FINAL_STATUSES,
  REASSIGN_DESTINATIONS,
  SOURCE_KEYS,
  QC_ITEMS,
  makeFinding,
  makePhone,
  makeEmail,
} from '../model.js'
import { generateNote } from '../generateNote.js'
import { Field, TextArea, Select, Confidence, Toggle } from './fields.jsx'
import NoteModal from './NoteModal.jsx'

const SECTIONS = [
  { key: 'setup', label: 'Setup & Scope', steps: 'Steps 1–2' },
  { key: 'baseline', label: 'Baseline Review', steps: 'Step 1' },
  { key: 'ownership', label: 'Ownership', steps: 'Step 3' },
  { key: 'people', label: 'People Search', steps: 'Steps 4–5' },
  { key: 'contact', label: 'Contact Verification', steps: 'Steps 6–8' },
  { key: 'conflicts', label: 'Conflicts & Relatives', steps: 'Step 9' },
  { key: 'sources', label: 'Sources Checked', steps: 'Section 4' },
  { key: 'outreach', label: 'Outreach', steps: 'Step 11' },
  { key: 'recommend', label: 'Recommendation', steps: 'Steps 13–15' },
  { key: 'qc', label: 'QC & Note', steps: 'Step 12 · Definition of Done' },
]

export default function Investigation({ inv, onChange, onDelete }) {
  const [section, setSection] = useState('setup')
  const [showNote, setShowNote] = useState(false)

  // Top-level patch.
  const patch = (partial) => onChange((cur) => ({ ...cur, ...partial }))
  // Nested-object patch.
  const patchIn = (key, partial) =>
    onChange((cur) => ({ ...cur, [key]: { ...cur[key], ...partial } }))

  const limit = TIME_LIMITS[inv.investigationType]
  const timeUsedNum = parseInt(inv.timeUsed, 10)
  const overLimit = !Number.isNaN(timeUsedNum) && timeUsedNum > limit

  const title = inv.verifiedName || inv.sellerName || 'Unnamed seller'

  return (
    <div className="investigation">
      <div className="inv-head">
        <div className="inv-title">
          <h1>{title}</h1>
          <p className="muted">{inv.propertyAddress || 'No property address'}</p>
        </div>
        <div className="inv-actions">
          <button className="btn btn-primary" onClick={() => setShowNote(true)}>
            Generate note
          </button>
          <button
            className="btn btn-danger-ghost"
            onClick={() => {
              if (confirm(`Delete this investigation? This cannot be undone.`)) onDelete()
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {inv.investigationType === 'Enhanced' && (
        <div className="banner banner-info">
          Enhanced investigation ({limit} min). Requires manager authorization.
        </div>
      )}
      {overLimit && (
        <div className="banner banner-warn">
          Time used ({timeUsedNum} min) exceeds the {limit}-minute limit. Stop, document all
          findings, and recommend a status.
        </div>
      )}

      <div className="inv-body">
        <nav className="stepper">
          {SECTIONS.map((s, i) => (
            <button
              key={s.key}
              className={`step ${section === s.key ? 'step-on' : ''}`}
              onClick={() => setSection(s.key)}
            >
              <span className="step-num">{i + 1}</span>
              <span className="step-labels">
                <span className="step-label">{s.label}</span>
                <span className="step-sub">{s.steps}</span>
              </span>
            </button>
          ))}
        </nav>

        <section className="panel">
          {section === 'setup' && (
            <Setup inv={inv} patch={patch} limit={limit} />
          )}
          {section === 'baseline' && (
            <Baseline b={inv.baseline} patchIn={patchIn} />
          )}
          {section === 'ownership' && (
            <Ownership o={inv.ownership} patchIn={patchIn} />
          )}
          {section === 'people' && (
            <People inv={inv} onChange={onChange} patch={patch} />
          )}
          {section === 'contact' && (
            <Contact inv={inv} onChange={onChange} patchIn={patchIn} />
          )}
          {section === 'conflicts' && (
            <Conflicts c={inv.conflicts} patchIn={patchIn} />
          )}
          {section === 'sources' && (
            <Sources sources={inv.sources} onChange={onChange} />
          )}
          {section === 'outreach' && (
            <Outreach inv={inv} patchIn={patchIn} />
          )}
          {section === 'recommend' && (
            <Recommend inv={inv} patchIn={patchIn} />
          )}
          {section === 'qc' && (
            <QC inv={inv} onChange={onChange} onOpenNote={() => setShowNote(true)} />
          )}
        </section>
      </div>

      {showNote && (
        <NoteModal text={generateNote(inv)} onClose={() => setShowNote(false)} />
      )}
    </div>
  )
}

/* ---------- Section: Setup & Scope (Steps 1-2) ---------- */
function Setup({ inv, patch, limit }) {
  return (
    <div className="section">
      <SectionHead
        title="Setup & Scope"
        note="Confirm the objective and scope before any research. Outreach is never assumed — if authorization is unclear, stop before contacting anyone."
      />
      <div className="grid">
        <Field label="Task" value={inv.task} onChange={(v) => patch({ task: v })} />
        <Field label="Lead ID" value={inv.leadId} onChange={(v) => patch({ leadId: v })} />
        <Field label="Seller Name (as listed)" value={inv.sellerName} onChange={(v) => patch({ sellerName: v })} />
        <Field label="Verified Name" value={inv.verifiedName} onChange={(v) => patch({ verifiedName: v })} hint="Most complete name from the strongest source" />
        <Field label="Property Address" value={inv.propertyAddress} onChange={(v) => patch({ propertyAddress: v })} />
        <Field label="Investigator" value={inv.investigator} onChange={(v) => patch({ investigator: v })} />
        <Field label="Investigation Date" type="date" value={inv.investigationDate} onChange={(v) => patch({ investigationDate: v })} />
        <Field label="Priority" value={inv.priority} onChange={(v) => patch({ priority: v })} />
        <Select
          label="Investigation Type"
          value={inv.investigationType}
          onChange={(v) => patch({ investigationType: v })}
          options={INVESTIGATION_TYPES}
          hint={`Max ${limit} min${inv.investigationType === 'Enhanced' ? ' · manager authorization required' : ''}`}
        />
        <Field
          label="Time Used (minutes)"
          type="number"
          value={inv.timeUsed}
          onChange={(v) => patch({ timeUsed: v })}
          hint={`Limit ${limit} min`}
        />
      </div>
      <TextArea
        label="Investigation Objective"
        value={inv.objective}
        onChange={(v) => patch({ objective: v })}
        placeholder="e.g. Verify the correct owner name for 123 Main Street, confirm whether the phone ending 1234 belongs to the owner, and locate the owner's current mailing address."
      />
      <div className="toggle-row">
        <Toggle
          label="Outreach authorized"
          value={inv.outreachAuthorized}
          onChange={(v) => patch({ outreachAuthorized: v })}
          hint="Set only when a manager has authorized contact"
        />
        <Toggle
          label="Relative / connected-person contact authorized"
          value={inv.relativeContactAuthorized}
          onChange={(v) => patch({ relativeContactAuthorized: v })}
          hint="Requires separate authorization"
        />
      </div>
    </div>
  )
}

/* ---------- Section: Baseline Review (Step 1) ---------- */
function Baseline({ b, patchIn }) {
  const set = (k) => (v) => patchIn('baseline', { [k]: v })
  return (
    <div className="section">
      <SectionHead
        title="Baseline Review"
        note="Review the complete REI BlackBook record first. Do not begin outreach during this step."
      />
      <div className="grid">
        <Field label="Name in REI BlackBook" value={b.nameOnFile} onChange={set('nameOnFile')} />
        <Field label="Phone on File" value={b.phoneOnFile} onChange={set('phoneOnFile')} />
        <Field label="Email on File" value={b.emailOnFile} onChange={set('emailOnFile')} />
        <Field label="Mailing Address on File" value={b.mailingOnFile} onChange={set('mailingOnFile')} />
        <Field label="Property Address" value={b.propertyAddress} onChange={set('propertyAddress')} />
        <Field label="Last Activity" value={b.lastActivity} onChange={set('lastActivity')} />
        <Field label="Last Disposition" value={b.lastDisposition} onChange={set('lastDisposition')} />
        <Field label="Current Lead Stage" value={b.leadStage} onChange={set('leadStage')} />
        <Field label="Assigned Team Member" value={b.assignedTeamMember} onChange={set('assignedTeamMember')} />
      </div>
      <TextArea label="Conflicts or Red Flags" value={b.redFlags} onChange={set('redFlags')} />
    </div>
  )
}

/* ---------- Section: Ownership (Step 3) ---------- */
function Ownership({ o, patchIn }) {
  const set = (k) => (v) => patchIn('ownership', { [k]: v })
  return (
    <div className="section">
      <SectionHead
        title="Ownership Findings"
        note="Verify through county records / recorded documents first. A people-search website cannot confirm ownership."
      />
      <div className="grid">
        <Field label="Recorded Owner" value={o.recordedOwner} onChange={set('recordedOwner')} hint="Exactly as displayed" />
        <Field label="Ownership Type / Vesting" value={o.ownershipType} onChange={set('ownershipType')} />
        <Field label="Trust or Entity" value={o.trustOrEntity} onChange={set('trustOrEntity')} />
        <Field label="Owner Mailing Address of Record" value={o.mailingAddress} onChange={set('mailingAddress')} />
        <Field label="Source" value={o.source} onChange={set('source')} placeholder="County Assessor / Recorder / …" />
        <Field label="Date Checked" type="date" value={o.dateChecked} onChange={set('dateChecked')} />
      </div>
      <Confidence value={o.confidence} onChange={set('confidence')} />
      <TextArea label="Supporting Details (recording date, doc number, etc.)" value={o.supportingDetails} onChange={set('supportingDetails')} />
    </div>
  )
}

/* ---------- Section: People Search (Steps 4-5) ---------- */
function People({ inv, onChange, patch }) {
  const findings = inv.findings
  const add = () => onChange((cur) => ({ ...cur, findings: [...cur.findings, makeFinding()] }))
  const update = (i, partial) =>
    onChange((cur) => ({
      ...cur,
      findings: cur.findings.map((f, idx) => (idx === i ? { ...f, ...partial } : f)),
    }))
  const remove = (i) =>
    onChange((cur) => ({ ...cur, findings: cur.findings.filter((_, idx) => idx !== i) }))

  return (
    <div className="section">
      <SectionHead
        title="People-Search Findings"
        note="Use only after reviewing company + property info. Cross-check every result against a stronger source. People-search results alone are never proof of ownership."
      />
      {findings.length === 0 && <p className="muted">No people-search findings recorded yet.</p>}
      {findings.map((f, i) => (
        <div className="subcard" key={i}>
          <div className="subcard-head">
            <strong>Finding {i + 1}</strong>
            <button className="btn-icon" onClick={() => remove(i)} title="Remove">✕</button>
          </div>
          <div className="grid">
            <Select label="Search Type" value={f.searchType} onChange={(v) => update(i, { searchType: v })} options={PEOPLE_SEARCH_TYPES} />
            <Field label="Search Value" value={f.searchValue} onChange={(v) => update(i, { searchValue: v })} />
            <Field label="Name Found" value={f.nameFound} onChange={(v) => update(i, { nameFound: v })} />
            <Field label="Connection to Property" value={f.connection} onChange={(v) => update(i, { connection: v })} placeholder="Current / previous resident, etc." />
            <Field label="Source" value={f.source} onChange={(v) => update(i, { source: v })} />
            <Field label="Date Checked" type="date" value={f.dateChecked} onChange={(v) => update(i, { dateChecked: v })} />
          </div>
          <Confidence value={f.confidence} onChange={(v) => update(i, { confidence: v })} />
          <TextArea label="Supporting Match" value={f.supportingMatch} onChange={(v) => update(i, { supportingMatch: v })} rows={2} />
          <TextArea label="Conflicting Information" value={f.conflicting} onChange={(v) => update(i, { conflicting: v })} rows={2} />
        </div>
      ))}
      <button className="btn btn-secondary" onClick={add}>+ Add finding</button>

      <div className="divider" />
      <SectionHead title="Determined Name (Step 5)" note="Use the most complete name supported by the strongest source. Document spelling variations — do not silently replace the name." />
      <div className="grid">
        <Field label="Seller Name (as listed)" value={inv.sellerName} onChange={(v) => patch({ sellerName: v })} />
        <Field label="Verified Name" value={inv.verifiedName} onChange={(v) => patch({ verifiedName: v })} />
      </div>
    </div>
  )
}

/* ---------- Section: Contact Verification (Steps 6-8) ---------- */
function Contact({ inv, onChange, patchIn }) {
  const addPhone = () => onChange((cur) => ({ ...cur, phones: [...cur.phones, makePhone()] }))
  const updPhone = (i, partial) =>
    onChange((cur) => ({ ...cur, phones: cur.phones.map((p, idx) => (idx === i ? { ...p, ...partial } : p)) }))
  const rmPhone = (i) =>
    onChange((cur) => ({ ...cur, phones: cur.phones.filter((_, idx) => idx !== i) }))

  const addEmail = () => onChange((cur) => ({ ...cur, emails: [...cur.emails, makeEmail()] }))
  const updEmail = (i, partial) =>
    onChange((cur) => ({ ...cur, emails: cur.emails.map((e, idx) => (idx === i ? { ...e, ...partial } : e)) }))
  const rmEmail = (i) =>
    onChange((cur) => ({ ...cur, emails: cur.emails.filter((_, idx) => idx !== i) }))

  const m = inv.mailing
  const setM = (k) => (v) => patchIn('mailing', { [k]: v })

  return (
    <div className="section">
      <SectionHead title="Mailing Address (Step 6)" note="Start with the county owner mailing address; confirm before recommending any letter or package." />
      <div className="grid">
        <Field label="Confirmed Mailing Address" value={m.confirmedAddress} onChange={setM('confirmedAddress')} />
        <Select
          label="Classification"
          value={m.classification}
          onChange={setM('classification')}
          options={['', 'Property address', 'Separate owner mailing', 'Previous address', 'Possible forwarding', 'Unconfirmed']}
        />
        <Field label="Source" value={m.source} onChange={setM('source')} />
      </div>
      <Confidence value={m.confidence} onChange={setM('confidence')} />

      <div className="divider" />
      <SectionHead title="Phone Numbers (Step 7)" note="Classify each: Confirmed / Likely / Possible / Invalid. The first phone is treated as the best phone in the note." />
      {inv.phones.map((p, i) => (
        <div className="subcard" key={i}>
          <div className="subcard-head">
            <strong>{i === 0 ? 'Best phone' : `Phone ${i + 1}`}</strong>
            <button className="btn-icon" onClick={() => rmPhone(i)} title="Remove">✕</button>
          </div>
          <div className="grid">
            <Field label="Number" value={p.number} onChange={(v) => updPhone(i, { number: v })} />
            <Field label="Associated Name" value={p.associatedName} onChange={(v) => updPhone(i, { associatedName: v })} />
            <Select label="Status" value={p.status} onChange={(v) => updPhone(i, { status: v })} options={PHONE_STATUSES} />
            <Field label="Source" value={p.source} onChange={(v) => updPhone(i, { source: v })} />
            <Field label="Date Checked" type="date" value={p.dateChecked} onChange={(v) => updPhone(i, { dateChecked: v })} />
          </div>
          <div className="toggle-row">
            <Toggle label="Matches seller" value={p.matchesSeller} onChange={(v) => updPhone(i, { matchesSeller: v })} />
            <Toggle label="Matches property" value={p.matchesProperty} onChange={(v) => updPhone(i, { matchesProperty: v })} />
          </div>
          <Confidence value={p.confidence} onChange={(v) => updPhone(i, { confidence: v })} />
        </div>
      ))}
      <button className="btn btn-secondary" onClick={addPhone}>+ Add phone</button>

      <div className="divider" />
      <SectionHead title="Email Addresses (Step 8)" note="Do not assume an email belongs to the owner solely because it appears in a people-search result." />
      {inv.emails.map((e, i) => (
        <div className="subcard" key={i}>
          <div className="subcard-head">
            <strong>Email {i + 1}</strong>
            <button className="btn-icon" onClick={() => rmEmail(i)} title="Remove">✕</button>
          </div>
          <div className="grid">
            <Field label="Email Address" value={e.address} onChange={(v) => updEmail(i, { address: v })} />
            <Field label="Associated Name" value={e.associatedName} onChange={(v) => updEmail(i, { associatedName: v })} />
            <Field label="Source" value={e.source} onChange={(v) => updEmail(i, { source: v })} />
            <Field label="Date Checked" type="date" value={e.dateChecked} onChange={(v) => updEmail(i, { dateChecked: v })} />
          </div>
          <Confidence value={e.confidence} onChange={(v) => updEmail(i, { confidence: v })} />
        </div>
      ))}
      <button className="btn btn-secondary" onClick={addEmail}>+ Add email</button>
    </div>
  )
}

/* ---------- Section: Conflicts & Relatives (Step 9) ---------- */
function Conflicts({ c, patchIn }) {
  const set = (k) => (v) => patchIn('conflicts', { [k]: v })
  return (
    <div className="section">
      <SectionHead
        title="Conflicts & Relatives"
        note="A relationship is only 'verified' when a lawful, reliable record documents it. Same last name, same address, or an aggregator 'possible relative' listing is NOT enough. Do not contact relatives without separate authorization."
      />
      <TextArea label="Conflict 1" value={c.conflict1} onChange={set('conflict1')} />
      <TextArea label="Conflict 2" value={c.conflict2} onChange={set('conflict2')} />
      <TextArea
        label="Information Requiring Management Review"
        value={c.managementReview}
        onChange={set('managementReview')}
        hint="Trust / estate / probate / possible family or fraud concerns → recommend Management Review Required"
      />
    </div>
  )
}

/* ---------- Section: Sources Checked ---------- */
function Sources({ sources, onChange }) {
  const set = (k) => (v) => onChange((cur) => ({ ...cur, sources: { ...cur.sources, [k]: v } }))
  return (
    <div className="section">
      <SectionHead title="Sources Checked" note="Note what each source showed (or 'not checked')." />
      <div className="grid">
        {SOURCE_KEYS.map((k) => (
          <Field key={k} label={k} value={sources[k]} onChange={set(k)} />
        ))}
      </div>
    </div>
  )
}

/* ---------- Section: Outreach (Step 11) ---------- */
function Outreach({ inv, patchIn }) {
  const out = inv.outreach
  const set = (k) => (v) => patchIn('outreach', { [k]: v })
  const authorized = inv.outreachAuthorized
  return (
    <div className="section">
      <SectionHead
        title="Outreach"
        note="Only if authorization was confirmed in Setup. Order: Call → Voicemail → Text → Email → Alternate number → Letter → Relative (separately authorized only). Never negotiate, discuss price, make promises, give legal conclusions, or allege fraud."
      />
      {!authorized && (
        <div className="banner banner-warn">
          Outreach is not authorized for this investigation. Enable it in Setup &amp; Scope before
          recording any contact.
        </div>
      )}
      <div className={authorized ? '' : 'disabled-block'}>
        <Toggle label="Outreach conducted" value={out.conducted} onChange={set('conducted')} />
        <div className="grid">
          <Field label="Authorized Method" value={out.authorizedMethod} onChange={set('authorizedMethod')} placeholder="Call / Voicemail / Text / Email / Letter" />
        </div>
        <TextArea label="Result" value={out.result} onChange={set('result')} />
        <TextArea label="Seller Response" value={out.sellerResponse} onChange={set('sellerResponse')} />
      </div>
    </div>
  )
}

/* ---------- Section: Recommendation (Steps 13-15) ---------- */
function Recommend({ inv, patchIn }) {
  const r = inv.recommendation
  const set = (k) => (v) => patchIn('recommendation', { [k]: v })
  return (
    <div className="section">
      <SectionHead title="Final Recommendation" note="Recommend exactly one status. The authorized operator approves and executes saving, status, next task, and reassignment." />
      <div className="field">
        <span className="field-label">Recommended Status (choose one)</span>
        <div className="chip-row wrap">
          {FINAL_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip chip-status ${r.status === s ? 'chip-on' : ''}`}
              onClick={() => set('status')(r.status === s ? '' : s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <TextArea label="Reason" value={r.reason} onChange={set('reason')} />
      <div className="grid">
        <Field label="Next Task" value={r.nextTask} onChange={set('nextTask')} placeholder="e.g. Acquisitions to call verified seller at (925) 555-1234" />
        <Field label="Due Date" type="date" value={r.dueDate} onChange={set('dueDate')} />
        <Select label="Reassign To" value={r.reassignTo} onChange={set('reassignTo')} options={['', ...REASSIGN_DESTINATIONS]} />
      </div>
      {r.status === 'Management Review Required' && r.reassignTo && r.reassignTo !== 'Cherry Hombre' && (
        <div className="banner banner-warn">
          Management Review Required normally reassigns to <strong>Cherry Hombre</strong>.
        </div>
      )}
    </div>
  )
}

/* ---------- Section: QC & Note ---------- */
function QC({ inv, onChange, onOpenNote }) {
  const toggle = (i) =>
    onChange((cur) => ({ ...cur, qc: { ...cur.qc, [i]: !cur.qc[i] } }))
  const done = QC_ITEMS.filter((_, i) => inv.qc[i]).length

  const dod = useMemo(() => {
    const noteReady = done === QC_ITEMS.length
    return [
      { label: 'Complete investigation note prepared', ok: noteReady },
      { label: 'One final status recommended', ok: !!inv.recommendation.status },
      { label: 'Next task and due date prepared', ok: !!inv.recommendation.nextTask && !!inv.recommendation.dueDate },
      { label: 'Reassignment destination identified', ok: !!inv.recommendation.reassignTo },
    ]
  }, [inv.recommendation, done])

  return (
    <div className="section">
      <SectionHead
        title="Quality Control"
        note="Confirm every item before presenting the note for approval. These are checks the investigator completes; the operator executes the final actions."
      />
      <div className="qc-progress">
        <div className="qc-bar">
          <div className="qc-bar-fill" style={{ width: `${(done / QC_ITEMS.length) * 100}%` }} />
        </div>
        <span className="muted">{done}/{QC_ITEMS.length} confirmed</span>
      </div>
      <ul className="qc-list">
        {QC_ITEMS.map((item, i) => (
          <li key={i}>
            <label className="qc-item">
              <input type="checkbox" checked={!!inv.qc[i]} onChange={() => toggle(i)} />
              <span>{item}</span>
            </label>
          </li>
        ))}
      </ul>

      <div className="divider" />
      <SectionHead title="Definition of Done" note="The operator approves and executes these; the investigator prepares and recommends them." />
      <ul className="dod-list">
        {dod.map((d, i) => (
          <li key={i} className={d.ok ? 'dod-ok' : 'dod-pending'}>
            <span className="dod-mark">{d.ok ? '✓' : '○'}</span> {d.label}
          </li>
        ))}
      </ul>

      <button className="btn btn-primary" onClick={onOpenNote}>Generate REI BlackBook note</button>
    </div>
  )
}

/* ---------- shared ---------- */
function SectionHead({ title, note }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {note && <p className="section-note">{note}</p>}
    </div>
  )
}
