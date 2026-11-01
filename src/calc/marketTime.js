// Market time from the broker, with no zone or session constants.
//
// getHloc axis (`xSeries`) + server offset = exchange wall clock written as UTC; daily bars sit
// at server midnight, so the server offset comes from the daily candles themselves
// (dailyOffset), independent of the device clock. getHloc `info[ticker].mrkt` gives the
// market's `o`/`c` (open / extended close), `post` (regular close, US only), server time, and
// `dt` = server minus exchange local time, minutes. getMarketStatus (`t` = server wall clock,
// same o/c/dt per market) is only a fallback for markets / offset not seen in candles yet. So:
//   date of a bar          = UTC date of (ts + offset)
//   exchange wall time     = ts + offset
//   session window         = [p - dt, post - dt) in exchange wall minutes (p: broker pre-open,
//                            else o; post: regular close, else c = extended close); owner rule:
//                            every trade from the pre-open on counts, post-market does not
//   real UTC of a bar      = wall - exchange UTC offset; the broker's IANA zone (`mrkt.tz` in
//                            getHloc `info`) gives it for any day, else offset - dt*60 (today's)
// Display: the user's browser zone (Intl default), with the zone label.

export const DAY_S = 86400 // seconds per calendar day (unit, not a zone)
const STATUS_ROUND_S = 30 * 60 // status offset step: tolerates a device clock off by < 15 min

const ymd = (sec) => new Date(sec * 1000).toISOString().slice(0, 10)
const mod = (v, m) => ((v % m) + m) % m
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v)

/** 'HH:MM[:SS]' -> minutes since midnight; null if unparsable. */
export function hmsMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Fallback server offset (seconds, half hours) from status `t` ('YYYY-MM-DD HH:MM:SS') received at `at` (ms). */
export function serverOffset(t, at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(t ?? ''))
  if (!m || !Number.isFinite(at)) return null
  const srv = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  return Math.round((srv - at) / 1000 / STATUS_ROUND_S) * STATUS_ROUND_S || 0 // no -0
}

/** Server offset (seconds) from a daily getHloc answer: bars sit at server midnight, so
 *  -ts mod 1 day, in (-12 h, 12 h]; the most frequent value over all bars; null without bars. */
export function dailyOffset(answer) {
  const n = new Map()
  for (const xs of Object.values((answer && answer.xSeries) || {})) {
    for (const ts of xs || []) {
      if (!Number.isFinite(+ts)) continue
      let o = mod(-ts, DAY_S)
      if (o > DAY_S / 2) o -= DAY_S
      n.set(o, (n.get(o) || 0) + 1)
    }
  }
  let best = null
  for (const [o, k] of n) if (best === null || k > n.get(best)) best = o
  return best === null ? null : best || 0
}

const entry = (x) => ({ p: hmsMinutes(x.p), o: hmsMinutes(x.o), c: hmsMinutes(x.c), dt: num(x.dt), post: hmsMinutes(x.post) })

/** Market hours per market name from a getHloc answer's `info[ticker]` ({mkt_name, mrkt}). */
export function hlocMarkets(answer) {
  const out = {}
  for (const i of Object.values((answer && answer.info) || {})) {
    if (i && i.mkt_name && i.mrkt) out[String(i.mkt_name).toUpperCase()] = entry(i.mrkt)
  }
  return out
}

/**
 * Market clock {offset, markets: {NAME: {o, c, dt, post}}} from what the candles taught
 * (`learned` {offset, markets}: dailyOffset / hlocMarkets) and, as a fallback, a
 * getMarketStatus snapshot {t, m, at}. null when no offset is known.
 */
export function marketClock(status, learned) {
  const markets = {}
  for (const x of (status && status.m) || []) {
    const e = { ...entry(x), p: null, post: null }
    for (const n of [x.n, x.n2]) if (n) markets[String(n).toUpperCase()] = e
  }
  for (const [n, e] of Object.entries((learned && learned.markets) || {})) {
    const known = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null && v !== undefined))
    markets[n] = { p: null, o: null, c: null, dt: null, post: null, ...markets[n], ...known }
  }
  const own = learned && Number.isFinite(learned.offset) ? learned.offset : null
  const offset = own !== null ? own : status ? serverOffset(status.t, status.at) : null
  return offset === null ? null : { offset, markets }
}

/**
 * One market's clock: {offset, dt, tz, pre, open, close, regular}; pre-open (`p`) / open /
 * extended close / regular close (`post`, US) in exchange wall minutes (null when unknown).
 * `tz`: the broker's zone.
 */
export function marketClockFor(clock, name, { tz = null } = {}) {
  if (!clock || !Number.isFinite(clock.offset)) return null
  const m = (name && clock.markets && clock.markets[String(name).toUpperCase()]) || null
  const dt = m ? m.dt : null
  const wall = (v) => (v === null || v === undefined || dt === null ? null : mod(v - dt, 1440))
  return {
    offset: clock.offset, dt, tz: tz || null,
    pre: wall(m && m.p), open: wall(m && m.o), close: wall(m && m.c), regular: wall(m && m.post),
  }
}

/** Calendar date of a candle (axis seconds). */
export function axisDate(clock, ts) {
  if (!clock || !Number.isFinite(clock.offset)) throw new Error('No market clock')
  return ymd(ts + clock.offset)
}

/** Axis seconds of an exchange wall time (`min` minutes after midnight of `date`). */
export const axisAt = (offset, date, min) => Date.parse(`${date}T00:00:00Z`) / 1000 + min * 60 - offset

/** Exchange wall minutes of an axis value. */
export const wallMinute = (offset, ts) => mod(ts + offset, DAY_S) / 60

// --- zones (Intl): formatter per zone, created on first use
const fmts = new Map()
function partsFormat(timeZone) {
  const key = timeZone || ''
  let f = fmts.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset',
    })
    fmts.set(key, f)
  }
  return f
}
function partsOf(sec, timeZone) {
  const p = {}
  for (const x of partsFormat(timeZone).formatToParts(new Date(sec * 1000))) p[x.type] = x.value
  return p
}
const wallOf = (p) => Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000

/** UTC offset (seconds) of an IANA zone at a UTC instant. */
function zoneOffset(tz, sec) {
  return wallOf(partsOf(sec, tz)) - sec
}

/** Exchange wall time (as UTC seconds) -> real UTC seconds; null when nothing is known. */
export function wallToUtc(wall, mc) {
  if (!mc || !Number.isFinite(wall)) return null
  if (mc.tz) {
    try {
      const guess = wall - zoneOffset(mc.tz, wall)
      return wall - zoneOffset(mc.tz, guess)
    } catch {
      // zone unknown to this runtime: dt below
    }
  }
  if (mc.dt === null || mc.dt === undefined || !Number.isFinite(mc.offset)) return null
  return wall - (mc.offset - mc.dt * 60)
}

/** Candle axis -> real UTC seconds. */
export const axisToUtc = (ts, mc) => (mc ? wallToUtc(ts + mc.offset, mc) : null)

/** Today's calendar date in the user's zone (or `timeZone`). */
export function localDay(ms, timeZone) {
  const p = partsOf(Math.floor(ms / 1000), timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

/** Exchange calendar date at `ms`; server date without dt; the user's date without a clock. */
export function marketDay(mc, ms, timeZone) {
  if (!mc || !Number.isFinite(mc.offset)) return localDay(ms, timeZone)
  const sec = Math.floor(ms / 1000) + mc.offset - (mc.dt === null || mc.dt === undefined ? 0 : mc.dt * 60)
  return ymd(sec)
}

/** UTC seconds -> {date, min, zone} in the user's zone (or `timeZone`); zone like 'GMT+5'. */
export function localParts(sec, timeZone) {
  const p = partsOf(sec, timeZone)
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, zone: p.timeZoneName }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** UTC seconds -> 'Oct 30, 2026, 7:58 PM GMT+5' in the user's zone (or `timeZone`). */
export function formatLocal(sec, timeZone) {
  if (!Number.isFinite(sec)) return null
  const p = partsOf(sec, timeZone)
  const h = +p.hour % 24
  return `${MONTHS[+p.month - 1]} ${+p.day}, ${p.year}, ${h % 12 || 12}:${p.minute} ${h < 12 ? 'AM' : 'PM'} ${p.timeZoneName}`
}

/** Index bars per date (an index trades only in the main session): Map date -> [firstTs, lastTs]. */
export function sessionBounds(indexRows) {
  const m = new Map()
  for (const r of indexRows || []) {
    const b = m.get(r.date)
    if (!b) m.set(r.date, [r.ts, r.ts])
    else { b[0] = Math.min(b[0], r.ts); b[1] = Math.max(b[1], r.ts) }
  }
  return m
}

/** Daily rows up to the last session of the index (the latest date of its intraday rows). Some
 *  tickers (NASDAQ.IDX) carry a daily bar dated after it, e.g. a Saturday single print with
 *  volume 1; it is not a session. Without index rows the rows are returned as they are.
 *  Trade-off: before the index's first bar of a new day (US pre-market) that day's bar waits too. */
export function dailyThroughSession(daily, indexRows) {
  let anchor = null
  for (const r of indexRows || []) if (r && r.date && (anchor === null || r.date > anchor)) anchor = r.date
  return anchor === null || !daily ? daily : daily.filter((r) => r.date <= anchor)
}

/** A calendar date ('YYYY-MM-DD', exchange date of a bar) can hold a session: Monday to Friday.
 *  Every market the app shows (US, KASE, EU, AIX) trades on weekdays only; the broker still sends
 *  .EU bars on Saturday and Sunday (flat price, non-zero volume) and a weekend daily bar of
 *  NASDAQ.IDX, which are not sessions. Weekday holidays are not known (no verified calendar). */
export function isSessionDay(date) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getUTCDay()
  return d >= 1 && d <= 5
}

/** Bar length (seconds) of intraday rows: the smallest step between bars; 0 if unknown. */
export function barSeconds(rows) {
  const ts = [...new Set((rows || []).map((r) => r.ts).filter(Number.isFinite))].sort((a, b) => a - b)
  let best = 0
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1]
    if (d > 0 && (!best || d < best)) best = d
  }
  return best
}

const NO_SESSION = Object.freeze([Infinity, -Infinity]) // empty window: lo > hi
const first = (...v) => {
  for (const x of v) if (x !== null && x !== undefined) return x
  return null
}

/**
 * Session bounds of bar start times (axis seconds, inclusive) per date: (date) => [lo, hi] | null.
 * One rule for every market (owner): [p - dt, post - dt) in exchange wall time; without `p` the
 * open (o - dt), without `post` the extended close (c - dt). A bar counts when its interval
 * [ts, ts + bar) overlaps the window (the 11:15 bar of an 11:20 pre-open stays).
 * `sessions` (sessionBounds of an index of the same market) and `today` (marketDay): index dates
 * before today are complete; their last index bar caps the day (half days). Last fallbacks when
 * the broker gives no hours: the earliest index bar / latest index bar time of day on complete
 * dates; without an offset the index bars themselves. null = no bounds known (keep all bars).
 * A weekend date (isSessionDay) has an empty window: no bar is in a session.
 */
export function sessionWindow(sessions, mc, today, bar = 0) {
  const off = mc && Number.isFinite(mc.offset) ? mc.offset : null
  const idx = sessions && sessions.size ? sessions : null
  const dates = idx ? [...idx.keys()].sort() : []
  const done = new Set(today ? dates.filter((d) => d < today) : dates.slice(0, -1))
  const start = off === null ? null : first(mc.pre, mc.open)
  let end = off === null ? null : first(mc.regular, mc.close)
  if (end !== null && start !== null && end <= start) end = null // crosses midnight: open-ended
  const learn = (pickTs, agg) => {
    if (off === null || !done.size) return null
    return agg(...[...done].map((d) => wallMinute(off, pickTs(idx.get(d)))))
  }
  const s0 = start !== null ? start : learn((b) => b[0], Math.min)
  const e0 = end === null ? learn((b) => b[1], Math.max) : null
  if (s0 === null && !idx) return null
  const back = bar > 0 ? bar - 1 : 0
  return (date) => {
    if (!isSessionDay(date)) return NO_SESSION
    const b = idx && idx.get(date)
    const lo = s0 !== null ? axisAt(off, date, s0) - back : b ? b[0] : null
    if (lo === null) return null
    let hi = end !== null ? axisAt(off, date, end) - 1 : e0 !== null ? axisAt(off, date, e0) : Infinity
    if (b && (done.has(date) || off === null)) hi = Math.min(hi, b[1])
    return [lo, hi]
  }
}
