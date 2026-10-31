// Position card: candles, chart windows, key statistics and My holdings. Pure functions over
// broker answers (getSecurityInfo, getHloc, getPositionJson `ps`); numbers may come as strings.
import { positionFactor } from './live.js'

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const x = +v
  return Number.isFinite(x) ? x : null
}
/** Prices and ranges: 0 means "no data" (closed market, empty fields). */
const posNum = (v) => {
  const x = num(v)
  return x !== null && x > 0 ? x : null
}

/** Card tabs in display order. `kinds` limits a tab to security kinds (getSecurityInfo `kind`).
 *  News (Task 21) is added here once its data source is confirmed. */
export const CARD_TABS = [{ id: 'summary' }]

/** Tabs shown for a security kind; unknown kind shows only unrestricted tabs. */
export const tabsFor = (kind, tabs = CARD_TABS) =>
  tabs.filter((t) => !t.kinds || (num(kind) !== null && t.kinds.includes(num(kind))))

export const CARD_PERIODS = ['1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'ALL']

/** Dataset a chart period is drawn from. */
export const chartSource = (period) =>
  period === '1D' || period === '5D' ? 'intraday' : period === '5Y' || period === 'ALL' ? 'max' : 'daily'

/** Security kind label key (getSecurityInfo `kind`: 1 stock, 2 preferred, 7 fund/ETF). */
export const KINDS = { 1: 'stock', 2: 'preferred', 7: 'fund' }

/** getHloc answer -> [{ts, date, open, high, low, close, vol}] ascending for one ticker.
 *  Candle order is [high, low, open, close]; `date` as parseHloc (NY trading date). */
export function parseCandles(answer, ticker) {
  const a = answer || {}
  const hl = a.hloc || {}
  const key = ticker in hl ? ticker : Object.keys(hl)[0]
  if (!key) return []
  const xs = (a.xSeries && a.xSeries[key]) || []
  const vl = (a.vl && a.vl[key]) || []
  const out = []
  hl[key].forEach((c, i) => {
    const close = num(c && c[3])
    const ts = num(xs[i])
    if (close === null || ts === null) return
    out.push({
      ts,
      date: new Date((ts + 14400) * 1000).toISOString().slice(0, 10),
      high: num(c[0]),
      low: num(c[1]),
      open: num(c[2]),
      close,
      vol: num(vl[i]),
    })
  })
  return out.sort((x, y) => x.ts - y.ts)
}

/** Regular-session bounds per date from index bars (an index trades only in the main session):
 *  Map date -> [firstTs, lastTs]. Broker intraday timestamps are not plain UTC, so the session
 *  is taken from the data, not from the clock. */
export function sessionBounds(indexRows) {
  const m = new Map()
  for (const r of indexRows || []) {
    const b = m.get(r.date)
    if (!b) m.set(r.date, [r.ts, r.ts])
    else { b[0] = Math.min(b[0], r.ts); b[1] = Math.max(b[1], r.ts) }
  }
  return m
}

const SESSION_OPEN_MIN = 9 * 60 + 30 // 09:30 New York

const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const addMonths = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

/** Start date (exclusive) of a daily chart period relative to `today`; null = all rows. */
export function chartStart(period, today) {
  if (period === '1M') return addMonths(today, -1)
  if (period === '6M') return addMonths(today, -6)
  if (period === 'YTD') return `${Number(today.slice(0, 4)) - 1}-12-31`
  if (period === '1Y') return addMonths(today, -12)
  if (period === '5Y') return addMonths(today, -60)
  return null
}

/**
 * Rows to draw for a chart period.
 * Intraday (1D: last session, 5D: last 5 sessions): only bars inside the regular session when
 * `sessions` (sessionBounds) knows the date; such bars get `min` = minutes since midnight NY.
 * Daily: rows after the period start plus the last close at or before it (the baseline).
 */
export function chartRows(period, { intraday, daily, max } = {}, { today, sessions } = {}) {
  const src = chartSource(period)
  if (src === 'intraday') {
    const rows = intraday || []
    const dates = [...new Set(rows.map((r) => r.date))].sort()
    const keep = new Set(dates.slice(period === '1D' ? -1 : -5))
    // Dates older than the index bars: the latest known session's time of day.
    const known = sessions && sessions.size ? [...sessions.keys()].sort().pop() : null
    const off = known ? sessions.get(known).map((v) => v % 86400) : null
    return rows.filter((r) => keep.has(r.date)).flatMap((r) => {
      const day = r.ts - (r.ts % 86400)
      const b = (sessions && sessions.get(r.date)) || (off && [day + off[0], day + off[1]])
      if (!b) return [{ ...r, min: null }]
      if (r.ts < b[0] || r.ts > b[1]) return []
      return [{ ...r, min: SESSION_OPEN_MIN + Math.round((r.ts - b[0]) / 60) }]
    })
  }
  const rows = (src === 'max' ? max : daily) || []
  const start = today ? chartStart(period, today) : null
  if (!start) return rows.slice()
  let cut = rows.findIndex((r) => r.date > start)
  if (cut < 0) return rows.slice(-1)
  return rows.slice(Math.max(0, cut - 1))
}

const YEAR_CANDLES = 252
const AVG_VOL_CANDLES = 63

/**
 * Key statistics (Task 22 set). Missing values are null and hidden by the UI.
 *   prevClose  `pp`: the broker's own day change (chg = ltp - pp) is measured from it
 *   open       open of the first regular-session bar of the last intraday session (as on the
 *              1D chart; daily candles start with the pre-market), else of the last daily
 *              candle (`op` is unreliable); `sessions`: sessionBounds, null for non-US
 *   dayLow/dayHigh  `mintp` / `maxtp`
 *   low52/high52    min low / max high over the last 252 daily candles
 *   volume     `vol`; avgVolume  mean `vl` of the last 63 daily candles
 *   kind       'stock' | 'preferred' | 'fund' | null
 */
export function keyStats({ info, daily, intraday, sessions } = {}) {
  const i = info || {}
  const d = daily || []
  const last = d.length ? d[d.length - 1] : null
  const session = intraday && intraday.length ? chartRows('1D', { intraday }, { sessions }) : []
  const first = session.find((r) => posNum(r.open) !== null)
  const year = d.slice(-YEAR_CANDLES)
  const lows = year.map((r) => posNum(r.low)).filter((v) => v !== null)
  const highs = year.map((r) => posNum(r.high)).filter((v) => v !== null)
  const vols = d.slice(-AVG_VOL_CANDLES).map((r) => num(r.vol)).filter((v) => v !== null && v >= 0)
  const vol = num(i.vol)
  return {
    prevClose: posNum(i.pp),
    open: first ? posNum(first.open) : posNum(last && last.open),
    dayLow: posNum(i.mintp),
    dayHigh: posNum(i.maxtp),
    low52: lows.length ? Math.min(...lows) : null,
    high52: highs.length ? Math.max(...highs) : null,
    volume: vol !== null && vol >= 0 ? vol : null,
    avgVolume: vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : null,
    kind: KINDS[num(i.kind)] || null,
  }
}

/** Position of `v` inside [lo, hi] as 0..1 (clamped); null when the range is unknown. */
export function rangePos(v, lo, hi) {
  const x = num(v)
  if (x === null || lo === null || hi === null || !(hi > lo)) return null
  return Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
}

/**
 * My holdings for `ticker` from a raw `ps` (null when there is no such position or qty is 0).
 * `price` and `prevClose` are the card's (live quote / security info / position fallbacks).
 * Amounts are in USD (position currency converted as in Holdings); avgCost in the position
 * currency: `bal_price_a`, else `price_a`, else open_bal / q.
 */
export function positionHolding(ps, ticker, { price = null, prevClose = null } = {}) {
  const p = ((ps && ps.pos) || []).find((x) => x.i === ticker)
  const qty = p ? num(p.q) || 0 : 0
  if (!p || !qty) return null
  const acc = ps.acc || []
  const usd = num((acc.find((c) => c.curr === 'USD') || {}).currval) || 1
  const { k, fx } = positionFactor(p, usd)
  const px = num(price) ?? num(p.mkt_price)
  const prev = posNum(prevClose) ?? posNum(p.close_price)
  const ob = num(p.open_bal)
  const avgCost = posNum(p.bal_price_a) ?? posNum(p.price_a) ?? (ob ? Math.abs(ob / qty) / k : null)
  const m = k * fx
  const dayGain = px === null || prev === null ? null : qty * (px - prev) * m
  const cost = avgCost === null ? null : Math.abs(qty) * avgCost * m
  const totalGain = px === null || avgCost === null ? null : qty * (px - avgCost) * m
  const mv = num(p.market_value)
  return {
    qty,
    currency: p.curr || null,
    avgCost,
    dayGain,
    dayGainPct: dayGain === null ? null : ((px - prev) / prev) * 100 * Math.sign(qty),
    totalGain,
    totalGainPct: totalGain === null || !cost ? null : (totalGain / cost) * 100,
    marketValue: px === null ? mv : qty * px * m,
  }
}
