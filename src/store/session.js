// Session and prefs in localStorage. Never stores passwords or codes.
const SESSION_KEY = 'nyfpt.session'
const PREFS_KEY = 'nyfpt.prefs'

function defaultPrefs() {
  return {
    hide: false, period: 'YTD', vmode: 'perf', sorts: {}, theme: 'light',
    holdingsMode: 'day', holdingsClosedOpen: false, contribOpen: false, flowsOpen: false,
  }
}

function read(key) {
  try {
    const raw = globalThis.localStorage.getItem(key)
    if (raw == null) return null
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable (e.g. Safari private mode)
  }
}

export function loadSession() {
  const s = read(SESSION_KEY)
  if (!s || !s.sid) return null
  return { cabinetId: s.cabinetId, sid: s.sid, userId: s.userId, loggedAt: s.loggedAt }
}

export function saveSession(s) {
  write(SESSION_KEY, { cabinetId: s.cabinetId, sid: s.sid, userId: s.userId, loggedAt: s.loggedAt })
}

export function clearSession() {
  try {
    globalThis.localStorage.removeItem(SESSION_KEY)
  } catch {
    // ignore
  }
}

export function loadPrefs() {
  return { ...defaultPrefs(), ...(read(PREFS_KEY) || {}) }
}

export function savePrefs(p) {
  write(PREFS_KEY, p)
}
