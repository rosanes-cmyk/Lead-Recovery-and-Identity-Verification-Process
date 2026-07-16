// Selector engine.
//
// A field is described by an ORDERED list of strategies. They are tried in the
// priority the SOP requires, first match wins, and if none match the field
// resolves to the sentinel FIELD_NOT_FOUND — the engine never guesses or
// substitutes another value.
//
// Strategy shapes (each has a `type`):
//   { type:'data',    selector:'[data-testid="lead-id"]' }   stable data attribute
//   { type:'attr',    selector:'a.lead', attr:'href' }        read an attribute
//   { type:'aria',    label:'Seller name' }                   accessible label
//   { type:'labelValue', label:'Mailing Address' }            text label -> nearby value
//   { type:'semantic', selector:'address' }                   semantic HTML
//   { type:'css',     selector:'.owner .value' }              CSS (last resort)
//
// Multi-value fields (phones, emails) use resolveList with the same shapes plus
// the built-in semantic defaults tel:/mailto:.

export const FIELD_NOT_FOUND = 'FIELD NOT FOUND'

// Resolve a single field. Returns { value, ok, strategy } where strategy is the
// human-readable description of what matched (for the audit log).
export async function resolveField(page, strategies = []) {
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i]
    const value = await tryStrategy(page, s)
    if (value && value.trim() && !isPlaceholder(value)) {
      return { value: value.trim(), ok: true, strategy: describe(s), fallbackIndex: i }
    }
  }
  return { value: FIELD_NOT_FOUND, ok: false, strategy: 'none matched' }
}

// Treat empty placeholders (a dash, "N/A", etc.) as "not found" rather than a
// real value.
export function isPlaceholder(v) {
  return /^(-|—|–|n\/?a|none|null|--)$/i.test(String(v).trim())
}

// Resolve a multi-value field (e.g. all phone numbers). De-duplicates.
export async function resolveList(page, strategies = [], { semantic } = {}) {
  const out = []
  const seen = new Set()
  const push = (v) => {
    const t = (v || '').trim()
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase())
      out.push(t)
    }
  }
  // Built-in semantic defaults that work across most sites.
  if (semantic === 'phone') (await hrefList(page, 'tel:')).forEach(push)
  if (semantic === 'email') (await hrefList(page, 'mailto:')).forEach(push)

  for (const s of strategies) {
    const vals = await tryStrategyAll(page, s)
    vals.forEach(push)
  }
  return out
}

/* ---------- strategy runners ---------- */

async function tryStrategy(page, s) {
  try {
    switch (s.type) {
      case 'data':
      case 'css':
      case 'semantic':
        return await firstText(page, s.selector)
      case 'attr':
        return await firstAttr(page, s.selector, s.attr || 'href')
      case 'aria':
        return await ariaValue(page, s.label)
      case 'labelValue':
        return await labelValue(page, s.label)
      default:
        return ''
    }
  } catch {
    return ''
  }
}

async function tryStrategyAll(page, s) {
  try {
    if (s.type === 'attr') return await allAttr(page, s.selector, s.attr || 'href')
    if (s.selector) return await allText(page, s.selector)
    return []
  } catch {
    return []
  }
}

async function firstText(page, selector) {
  if (!selector) return ''
  const el = page.locator(selector).first()
  if ((await el.count()) === 0) return ''
  return ((await el.innerText({ timeout: 1500 })) || '').replace(/\s+/g, ' ').trim()
}

async function allText(page, selector) {
  const els = page.locator(selector)
  const n = Math.min(await els.count(), 30)
  const out = []
  for (let i = 0; i < n; i++) {
    const t = ((await els.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
  }
  return out
}

async function firstAttr(page, selector, attr) {
  const el = page.locator(selector).first()
  if ((await el.count()) === 0) return ''
  return (await el.getAttribute(attr)) || ''
}

async function allAttr(page, selector, attr) {
  const els = page.locator(selector)
  const n = Math.min(await els.count(), 30)
  const out = []
  for (let i = 0; i < n; i++) {
    const v = await els.nth(i).getAttribute(attr).catch(() => '')
    if (v) out.push(v)
  }
  return out
}

async function hrefList(page, scheme) {
  try {
    return await page.evaluate((sch) => {
      const clean = (h) => decodeURIComponent(h.replace(sch, '').split('?')[0]).trim()
      return Array.from(document.querySelectorAll(`a[href^="${sch}"]`)).map((a) => clean(a.getAttribute('href') || ''))
    }, scheme)
  } catch {
    return []
  }
}

// aria-label attribute, or a <label> whose text matches -> its control's value.
async function ariaValue(page, label) {
  return await page.evaluate((lbl) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const target = norm(lbl)
    // [aria-label]
    const byAria = Array.from(document.querySelectorAll('[aria-label]')).find(
      (e) => norm(e.getAttribute('aria-label')) === target,
    )
    if (byAria) {
      const v = byAria.value || byAria.textContent
      if (v && v.trim()) return v.replace(/\s+/g, ' ').trim()
    }
    // <label for=..> or wrapping <label>
    const label = Array.from(document.querySelectorAll('label')).find((l) => norm(l.textContent) === target)
    if (label) {
      let ctrl = null
      if (label.htmlFor) ctrl = document.getElementById(label.htmlFor)
      if (!ctrl) ctrl = label.querySelector('input,textarea,select,[data-value]')
      if (ctrl) {
        const v = ctrl.value || ctrl.getAttribute?.('data-value') || ctrl.textContent
        if (v && v.trim()) return v.replace(/\s+/g, ' ').trim()
      }
    }
    return ''
  }, label)
}

// Find a visible text label and return the value sitting next to it. Handles
// dl/dt-dd, table th/td rows, label+sibling, and "Label: value" in one node.
async function labelValue(page, label) {
  return await page.evaluate((lbl) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const low = (s) => norm(s).toLowerCase().replace(/:$/, '')
    const target = low(lbl)
    const clean = (v) => norm(v)

    // Candidate label elements: leaf-ish elements whose own text matches.
    const all = Array.from(document.querySelectorAll('dt,th,td,label,span,div,p,strong,b,li'))
    for (const el of all) {
      const ownText = low(el.childNodes.length ? Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ') : el.textContent)
      const full = low(el.textContent)
      const isLabel = ownText === target || full === target || full === target + ':'
      if (!isLabel) continue

      // dt -> dd
      if (el.tagName === 'DT' && el.nextElementSibling?.tagName === 'DD') {
        const v = clean(el.nextElementSibling.textContent)
        if (v) return v
      }
      // th/td row -> the other cell
      if (el.tagName === 'TH' || el.tagName === 'TD') {
        const sib = el.nextElementSibling
        if (sib && clean(sib.textContent)) return clean(sib.textContent)
      }
      // generic: next sibling
      if (el.nextElementSibling) {
        const v = clean(el.nextElementSibling.textContent)
        if (v && low(v) !== target) return v
      }
      // parent's next sibling (label above value blocks)
      if (el.parentElement?.nextElementSibling) {
        const v = clean(el.parentElement.nextElementSibling.textContent)
        if (v && low(v) !== target) return v
      }
    }

    // "Label: value" inside a single element.
    for (const el of all) {
      const t = norm(el.textContent)
      const m = t.match(new RegExp('^' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-]\\s*(.+)$', 'i'))
      if (m && m[1] && low(m[1]) !== target) return clean(m[1])
    }
    return ''
  }, label)
}

function describe(s) {
  switch (s.type) {
    case 'data': return `data attribute (${s.selector})`
    case 'attr': return `attribute ${s.attr} of ${s.selector}`
    case 'aria': return `accessible label "${s.label}"`
    case 'labelValue': return `text label "${s.label}" -> nearby value`
    case 'semantic': return `semantic ${s.selector}`
    case 'css': return `CSS ${s.selector}`
    default: return s.type
  }
}
