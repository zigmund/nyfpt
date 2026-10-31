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

/** The ticker's short code: the broker's code_nm (DIA, NVDA_KZ), else the ticker without its
 *  market suffix (USO.US -> USO). */
export const tickerCode = (r) => (text(r.code) ? r.code.trim() : '') || r.ticker.replace(/\.[^.]+$/, '') || r.ticker

/** Strip card of a search row {ticker, name, code}: label = name, note = its code. */
export const stripCardOf = (r) => ({ ticker: r.ticker, label: text(r.name) ? r.name.trim() : r.ticker, note: tickerCode(r) })

// --- recent searches: securities opened from the search, newest first; descriptive fields only (no prices)
const RECENT_KEY = 'nyfpt.recent'
export const RECENT_MAX = 10
const RECENT_FIELDS = ['code', 'type', 'market', 'currency']

/** A clean recent entry, or null when `r` has no ticker. */
function recentEntry(r) {
  if (!r || typeof r !== 'object' || !text(r.ticker)) return null
  const ticker = r.ticker.trim()
  const e = { ticker, name: text(r.name) ? r.name.trim() : ticker }
  for (const k of RECENT_FIELDS) e[k] = typeof r[k] === 'string' ? r[k] : ''
  return e
}

const cleanRecent = (list) => {
  const out = []
  for (const r of Array.isArray(list) ? list : []) {
    const e = recentEntry(r)
    if (e && !out.some((x) => x.ticker === e.ticker)) out.push(e)
  }
  return out.slice(0, RECENT_MAX)
}

/** Recent list from localStorage; missing or broken = [], broken entries dropped. */
export const loadRecent = () => cleanRecent(read(RECENT_KEY))

export function saveRecent(list) {
  write(RECENT_KEY, cleanRecent(list))
}

/** `list` with `r` in front (once), at most RECENT_MAX entries. */
export const pushRecent = (list, r) => {
  const e = recentEntry(r)
  return e ? cleanRecent([e, ...(list || []).filter((x) => x && x.ticker !== e.ticker)]) : cleanRecent(list)
}
