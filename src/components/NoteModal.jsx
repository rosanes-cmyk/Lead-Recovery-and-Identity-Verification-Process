import { useState } from 'react'

export default function NoteModal({ text, onClose }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Fallback: select the textarea contents.
      const ta = document.getElementById('note-text')
      if (ta) {
        ta.focus()
        ta.select()
      }
    }
  }

  const download = () => {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'lead-recovery-investigation-note.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>REI BlackBook Note</h2>
          <button className="btn-icon" onClick={onClose} title="Close">✕</button>
        </div>
        <p className="muted modal-sub">
          Review, then paste into the REI BlackBook note. Present for approval before saving —
          the note is not saved automatically anywhere but this browser.
        </p>
        <textarea id="note-text" className="note-text" readOnly value={text} />
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy to clipboard'}
          </button>
          <button className="btn btn-secondary" onClick={download}>Download .txt</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
