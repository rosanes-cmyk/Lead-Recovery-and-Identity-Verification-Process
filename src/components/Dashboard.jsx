import { useMemo, useState } from 'react'
import { FINAL_STATUSES, IN_PROGRESS_STATUS, QC_ITEMS } from '../model.js'

function displayStatus(inv) {
  return inv.recommendation.status || IN_PROGRESS_STATUS
}

function statusClass(status) {
  switch (status) {
    case 'Seller Contact Located':
      return 'st-located'
    case 'Seller Confirmed Interested':
      return 'st-interested'
    case 'No Contact After Investigation':
      return 'st-nocontact'
    case 'Management Review Required':
      return 'st-review'
    default:
      return 'st-progress'
  }
}

function qcProgress(inv) {
  const done = QC_ITEMS.filter((_, i) => inv.qc[i]).length
  return { done, total: QC_ITEMS.length }
}

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

const FILTERS = ['All', IN_PROGRESS_STATUS, ...FINAL_STATUSES]

export default function Dashboard({ investigations, onOpen, onCreate, onDelete }) {
  const [filter, setFilter] = useState('All')
  const [query, setQuery] = useState('')

  const counts = useMemo(() => {
    const c = { All: investigations.length }
    for (const f of FILTERS.slice(1)) c[f] = 0
    for (const inv of investigations) c[displayStatus(inv)] = (c[displayStatus(inv)] || 0) + 1
    return c
  }, [investigations])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return investigations
      .filter((inv) => filter === 'All' || displayStatus(inv) === filter)
      .filter((inv) => {
        if (!q) return true
        return [
          inv.verifiedName,
          inv.sellerName,
          inv.propertyAddress,
          inv.leadId,
          inv.investigator,
        ]
          .filter(Boolean)
          .some((v) => v.toLowerCase().includes(q))
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }, [investigations, filter, query])

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div>
          <h1>Investigations</h1>
          <p className="muted">
            {investigations.length} total · guided seller identity &amp; contact verification
          </p>
        </div>
        <button className="btn btn-primary" onClick={onCreate}>
          + New investigation
        </button>
      </div>

      <div className="dash-controls">
        <input
          className="search"
          placeholder="Search by name, address, lead ID, investigator…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="filter-row">
          {FILTERS.map((f) => (
            <button
              key={f}
              className={`filter-pill ${filter === f ? 'filter-on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
              <span className="pill-count">{counts[f] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          {investigations.length === 0 ? (
            <>
              <h2>No investigations yet</h2>
              <p className="muted">
                Start one to review a lead, verify ownership and identity, and prepare the
                REI BlackBook note.
              </p>
              <button className="btn btn-primary" onClick={onCreate}>
                + New investigation
              </button>
            </>
          ) : (
            <p className="muted">No investigations match this filter.</p>
          )}
        </div>
      ) : (
        <div className="card-grid">
          {visible.map((inv) => {
            const status = displayStatus(inv)
            const qc = qcProgress(inv)
            const title = inv.verifiedName || inv.sellerName || 'Unnamed seller'
            return (
              <div key={inv.id} className="card" onClick={() => onOpen(inv.id)}>
                <div className="card-top">
                  <span className={`badge ${statusClass(status)}`}>{status}</span>
                  <span className="type-tag">{inv.investigationType}</span>
                </div>
                <h3 className="card-title">{title}</h3>
                <p className="card-addr">{inv.propertyAddress || 'No property address'}</p>
                <div className="card-meta">
                  {inv.leadId && <span>Lead {inv.leadId}</span>}
                  {inv.investigator && <span>{inv.investigator}</span>}
                  <span>QC {qc.done}/{qc.total}</span>
                </div>
                <div className="card-foot">
                  <span className="muted">Updated {fmtDate(inv.updatedAt)}</span>
                  <button
                    className="btn-icon"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm(`Delete investigation for "${title}"? This cannot be undone.`)) {
                        onDelete(inv.id)
                      }
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
