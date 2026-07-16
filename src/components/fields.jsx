// Small reusable form controls. Each is uncontrolled-friendly: pass value +
// onChange(newValue).

export function Field({ label, value, onChange, placeholder, hint, type = 'text' }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function TextArea({ label, value, onChange, placeholder, hint, rows = 3 }) {
  return (
    <label className="field field-wide">
      <span className="field-label">{label}</span>
      <textarea
        rows={rows}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Select({ label, value, onChange, options, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt === '' ? '— select —' : opt}
          </option>
        ))}
      </select>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Confidence({ label = 'Confidence', value, onChange }) {
  const levels = ['High', 'Medium', 'Low']
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="chip-row">
        {levels.map((lvl) => (
          <button
            type="button"
            key={lvl}
            className={`chip chip-${lvl.toLowerCase()} ${value === lvl ? 'chip-on' : ''}`}
            onClick={() => onChange(value === lvl ? '' : lvl)}
          >
            {lvl}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Toggle({ label, value, onChange, hint }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}
