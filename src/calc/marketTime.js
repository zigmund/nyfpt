// Market time from the broker, with no zone or session constants.
//
// getMarketStatus: `t` = server wall clock; per market `o`/`c` (open / close, server time) and
// `dt` = server minus exchange local time, minutes. The server offset is `t` minus Date.now()
// when the answer arrived. getHloc axis (`xSeries`) + server offset = exchange wall clock
// written as UTC (daily bars: server midnight). So:
//   date of a bar          = UTC date of (ts + offset)
//   exchange wall time     = ts + offset
//   regular open / close   = o - dt / c - dt (exchange wall minutes; c is the extended close)
//   real UTC of a bar      = wall - exchange UTC offset; the broker's IANA zone (`mrkt.tz` in
//                            getHloc `info`) gives it for any day, else offset - dt*60 (today's)
// Display: the user's browser zone (Intl default), with the zone label.

export const DAY_S = 86400 // seconds per calendar day (unit, not a zone)
const ROUND_S = 15 * 60 // server offset step: zones are whole quarter hours

const ymd = (sec) => new Date(sec * 1000).toISOString().slice(0, 10)
const mod = (v, m) => ((v % m) + m) % m
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v)

/** 'HH:MM[:SS]' -> minutes since midnight; null if unparsable. */
export function hmsMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Server clock offset (seconds, quarter hours) from `t` ('YYYY-MM-DD HH:MM:SS') received at `at` (ms). */
export function serverOffset(t, at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(t ?? ''))
  if (!m || !Number.isFinite(at)) return null
  const srv = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  return Math.round((srv - at) / 1000 / ROUND_S) * ROUND_S || 0 // no -0
}

/** Market clock from a getMarketStatus snapshot {t, m, at}: {offset, markets: {NAME: {o, c, dt}}}. */
export function marketClock(status) {
  if (!status) return null
  const offset = serverOffset(status.t, status.at)
  if (offset === null) return null
  const markets = {}
  for (const x of status.m || []) {
    const e = { o: hmsMinutes(x.o), c: hmsMinutes(x.c), dt: num(x.dt) }
    for (const n of [x.n, x.n2]) if (n) markets[String(n).toUpperCase()] = e
  }
  return { offset, markets }
}

/**
 * One market's clock: {offset, dt, tz, open, close}; open/close in exchange wall minutes
 * (null when the market or its dt is unknown). `tz`: the broker's zone for the market, if known.
 */
export function marketClockFor(clock, name, { tz = null } = {}) {
  if (!clock || !Number.isFinite(clock.offset)) return null
  const m = (name && clock.markets && clock.markets[String(name).toUpperCase()]) || null
  const dt = m ? m.dt : null
  const wall = (v) => (v === null || v === undefined || dt === null ? null : mod(v - dt, 1440))
  return { offset: clock.offset, dt, tz: tz || null, open: wall(m && m.o), close: wall(m && m.c) }
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

/**
 * Regular-session bounds (axis seconds, inclusive) per date: (date) => [lo, hi] | null.
 * `sessions` (Map date -> [first, last] index bar, see sessionBounds) marks the session of an
 * index-anchored market (US: SP500.IDX trades only in the main session). `today`: the market's
 * current trading date (marketDay); index dates before it are complete sessions (without
 * `today`: all but the latest index date).
 *   - complete index dates: their own index bars;
 *   - the running session, later dates and older dates without index bars: from the market open
 *     (o - dt; unknown market: the earliest index open on complete dates) to the last index bar's
 *     time of day on complete dates (learned close), extended to the latest index bar of that
 *     date; open-ended while no complete session is known.
 * Without index bars: the market's own hours [o - dt, c - dt). null = no bounds known.
 */
export function sessionWindow(sessions, mc, today) {
  const off = mc && Number.isFinite(mc.offset) ? mc.offset : null
  const open = off !== null && mc.open !== null && mc.open !== undefined ? mc.open : null
  if (sessions && sessions.size) {
    const dates = [...sessions.keys()].sort()
    const done = new Set(today ? dates.filter((d) => d < today) : dates.slice(0, -1))
    const ends = off === null ? [] : [...done].map((d) => wallMinute(off, sessions.get(d)[1]))
    const close = ends.length ? Math.max(...ends) : null
    // Market unknown (no o/dt): the earliest index open on complete dates.
    const starts = off === null || open !== null ? [] : [...done].map((d) => wallMinute(off, sessions.get(d)[0]))
    const start = open !== null ? open : starts.length ? Math.min(...starts) : null
    return (date) => {
      const b = sessions.get(date)
      if (b && done.has(date)) return b
      const o = start !== null ? axisAt(off, date, start) : null
      const lo = b ? (o === null ? b[0] : Math.min(o, b[0])) : o
      if (lo === null) return null
      let hi = close !== null ? axisAt(off, date, close) : b && off === null ? b[1] : Infinity
      if (b) hi = Math.max(hi, b[1])
      return [lo, hi]
    }
  }
  if (open === null) return null
  const close = mc.close !== null && mc.close > open ? mc.close : null
  return (date) => [axisAt(off, date, open), close === null ? Infinity : axisAt(off, date, close) - 1]
}
