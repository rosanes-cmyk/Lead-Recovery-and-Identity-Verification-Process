import { useEffect, useState, useCallback } from 'react'
import { loadAll, saveAll } from './storage.js'
import { blankInvestigation } from './model.js'
import Dashboard from './components/Dashboard.jsx'
import Investigation from './components/Investigation.jsx'

export default function App() {
  const [investigations, setInvestigations] = useState(() => loadAll())
  const [activeId, setActiveId] = useState(null)

  // Persist on every change.
  useEffect(() => {
    saveAll(investigations)
  }, [investigations])

  const createNew = useCallback(() => {
    const inv = blankInvestigation()
    setInvestigations((prev) => [inv, ...prev])
    setActiveId(inv.id)
  }, [])

  const updateActive = useCallback((updater) => {
    setInvestigations((prev) =>
      prev.map((inv) => {
        if (inv.id !== activeId) return inv
        const next = typeof updater === 'function' ? updater(inv) : updater
        return { ...next, updatedAt: new Date().toISOString() }
      }),
    )
  }, [activeId])

  const remove = useCallback((id) => {
    setInvestigations((prev) => prev.filter((inv) => inv.id !== id))
    setActiveId((cur) => (cur === id ? null : cur))
  }, [])

  const active = investigations.find((inv) => inv.id === activeId) || null

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setActiveId(null)}>
          <span className="brand-mark">LR</span>
          <span className="brand-text">
            Lead Recovery <span className="brand-sub">&amp; Identity Verification</span>
          </span>
        </button>
        {active && (
          <button className="btn btn-ghost" onClick={() => setActiveId(null)}>
            ← All investigations
          </button>
        )}
      </header>

      <main className="content">
        {active ? (
          <Investigation
            inv={active}
            onChange={updateActive}
            onBack={() => setActiveId(null)}
            onDelete={() => remove(active.id)}
          />
        ) : (
          <Dashboard
            investigations={investigations}
            onOpen={setActiveId}
            onCreate={createNew}
            onDelete={remove}
          />
        )}
      </main>

      <footer className="footer">
        Research &amp; identity-verification tool only. No pricing, negotiation, fraud
        determination, legal conclusion, outreach, or reassignment is executed without
        authorization. Data is stored only in this browser.
      </footer>
    </div>
  )
}
