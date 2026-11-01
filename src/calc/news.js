// News (getNewsList / getNewsDetail): times, paging, field normalisation. Pure functions.
//
// Times: the list `date` is 'YYYY-MM-DD HH:MM:SS' in the broker server's zone without a zone
// mark; the detail adds `timeZone` ('+0300'). The offset comes from the data (the item's own
// `timeZone`, else one learned from an article) or from the app's market clock (server offset,
// calc/marketTime.js); nothing is assumed. Display is in the user's zone (formatLocal).
import { formatLocal, localParts } from './marketTime.js'
import { safeHref } from './newsHtml.js'
import { t } from '../i18n.js'

/** '+0300' | '+03:00' | '+03' | 'Z' -> seconds east of UTC; null when not an offset. */
export function parseOffset(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === 'Z') return 0
  const m = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(s)
  if (!m) return null
  const h = Number(m[2])
  const min = Number(m[3] || 0)
  if (h > 14 || min > 59) return null
  return (m[1] === '-' ? -1 : 1) * (h * 3600 + min * 60)
}

/** Offset (s) for an item's time: its own timeZone, else `learned` (from an article), else `clock`
 *  (the market clock's server offset); null when none is known. */
export function newsOffset(item, { learned = null, clock = null } = {}) {
  const own = parseOffset(item && item.timeZone)
  if (own !== null) return own
  if (Number.isFinite(learned)) return learned
  return Number.isFinite(clock) ? clock : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Relative label: 'Just now', '5m ago', '3h ago', '2d ago', then 'Oct 19' / 'Jul 2, 2024'. */
export function agoLabel(sec, nowMs, timeZone) {
  const d = nowMs / 1000 - sec
  if (d < 60) return t('news.ago.now') // also a little in the future (clock skew)
  if (d < 3600) return t('news.ago.m', { n: Math.floor(d / 60) })
  if (d < 86400) return t('news.ago.h', { n: Math.floor(d / 3600) })
  if (d < 7 * 86400) return t('news.ago.d', { n: Math.floor(d / 86400) })
  const [y, m, day] = localParts(sec, timeZone).date.split('-')
  const label = `${MONTHS[Number(m) - 1]} ${Number(day)}`
  return y === localParts(Math.floor(nowMs / 1000), timeZone).date.slice(0, 4) ? label : `${label}, ${y}`
}

/**
 * Broker wall time + offset -> {sec (UTC), iso, ago, full ('Oct 31, 2026, 1:01 PM GMT+5')} in the
 * user's zone (or `timeZone`); null when the date is unparsable or the offset unknown.
 */
export function newsTime(date, offset, nowMs, timeZone) {
  if (!Number.isFinite(offset)) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(date ?? ''))
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000
  if (!Number.isFinite(wall)) return null
  const sec = wall - offset
  return { sec, iso: new Date(sec * 1000).toISOString(), ago: agoLabel(sec, nowMs, timeZone), full: formatLocal(sec, timeZone) }
}

const idOf = (x) => (x && typeof x === 'object' && x.id !== null && x.id !== undefined && x.id !== '' ? String(x.id) : null)

/** Appends `list` to `items` without duplicate ids (rows without an id are skipped). */
export function mergeItems(items, list) {
  const seen = new Set(items.map(idOf))
  const out = [...items]
  let added = 0
  for (const x of Array.isArray(list) ? list : []) {
    const id = idOf(x)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    out.push(x)
    added++
  }
  return { items: out, added }
}

/** Another page exists: below `total` (or a full page when total is unknown), and the last page
 *  was not empty and brought something new. */
export function hasMore({ total, skip, got, added, take = 20 }) {
  if (!got || !added) return false
  if (Number.isFinite(total)) return skip + got < total
  return got >= take
}

const SENTIMENTS = new Set(['positive', 'negative', 'neutral'])
/** Known sentiment ('positive' | 'negative' | 'neutral') or null; the broker's value set is unverified. */
export function sentimentOf(v) {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return SENTIMENTS.has(s) ? s : null
}

/** Absolute https URL (the article's original) or null. */
export const httpsUrl = safeHref

/** Up to `max` distinct tickers from `tickers[]` (strings or objects with ticker / c / code). */
export function relatedTickers(tickers, max = 3) {
  if (!Array.isArray(tickers)) return []
  const out = []
  for (const x of tickers) {
    const v = typeof x === 'string' ? x : x && typeof x === 'object' ? (x.ticker ?? x.c ?? x.code) : null
    const s = typeof v === 'string' ? v.trim() : ''
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}
