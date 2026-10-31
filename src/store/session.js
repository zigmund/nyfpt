// Session and prefs in localStorage. Never stores passwords or codes.
import { MARKET_STRIP, MARKET_STRIP_MAX } from '../config.js'

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

const text = (v) => typeof v === 'string' && v.trim() !== ''

/** A clean copy of a markets strip list ([{ticker, label, note?}]), or null when it is not one:
 *  not an array, more than MARKET_STRIP_MAX cards, a card without a ticker or label, a note that
 *  is not a string, or a ticker twice. */
export function validStrip(list) {
  if (!Array.isArray(list) || list.length > MARKET_STRIP_MAX) return null
  const out = []
  const seen = new Set()
  for (const m of list) {
    if (!m || typeof m !== 'object' || !text(m.ticker) || !text(m.label)) return null
    if (m.note != null && typeof m.note !== 'string') return null
    const ticker = m.ticker.trim()
    if (seen.has(ticker)) return null
    seen.add(ticker)
    out.push(m.note ? { ticker, label: m.label.trim(), note: m.note } : { ticker, label: m.label.trim() })
  }
  return out
}

/** Cards of the markets strip from prefs.marketStrip: absent, null or invalid = a copy of
 *  MARKET_STRIP, so a new default reaches everyone who never customised the strip. */
export const marketStripOf = (saved) => validStrip(saved) || MARKET_STRIP.map((m) => ({ ...m }))
