// localStorage-backed persistence for investigations. No backend, no login —
// data lives in the user's browser only.

const KEY = 'lrivp.investigations.v1'

export function loadAll() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.error('Failed to load investigations from localStorage', err)
    return []
  }
}

export function saveAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch (err) {
    console.error('Failed to save investigations to localStorage', err)
  }
}
