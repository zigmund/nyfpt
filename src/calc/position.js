// Position card: candles, chart windows, key statistics and My holdings. Pure functions over
// broker answers (getSecurityInfo, getHloc, getPositionJson `ps`); numbers may come as strings.
import { positionFactor } from './live.js'
import { axisDate, axisToUtc, barSeconds, localParts, sessionWindow } from './marketTime.js'

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

/** Card tabs in display order. `kinds` limits a tab to security kinds (getSecurityInfo `kind`);
 *  `session`: needs a broker session (News: getNewsList answers only with a SID). */
export const CARD_TABS = [{ id: 'summary' }, { id: 'news', session: true }]

/** Tabs shown for a security kind (unknown kind: only unrestricted tabs) and session state
 *  (`session` omitted: session tabs are kept). */
export const tabsFor = (kind, tabs = CARD_TABS, { session = true } = {}) =>
  tabs.filter((t) => (!t.kinds || (num(kind) !== null && t.kinds.includes(num(kind)))) && (!t.session || session))

/** App period code -> chart period code ('7d' is drawn as the 5-session chart). */
export const CHART_PERIOD = { '1d': '1D', '7d': '5D', '1m': '1M', '6m': '6M', YTD: 'YTD', '1Y': '1Y', '5Y': '5Y', All: 'ALL' }

/** Dataset a chart period is drawn from. */
export const chartSource = (period) =>
  period === '1D' || period === '5D' ? 'intraday' : period === '5Y' || period === 'ALL' ? 'max' : 'daily'

/** Security kind label key (getSecurityInfo `kind`: 1 stock, 2 preferred, 7 fund/ETF). */
export const KINDS = { 1: 'stock', 2: 'preferred', 7: 'fund' }

/** getHloc answer -> [{ts, date, mkt, open, high, low, close, vol}] ascending for one ticker.
 *  Candle order is [high, low, open, close]; `date` via the server offset of `clock` (marketTime). */
export function parseCandles(answer, ticker, clock) {
  const a = answer || {}
  const hl = a.hloc || {}
  const key = ticker in hl ? ticker : Object.keys(hl)[0]
  if (!key) return []
  const xs = (a.xSeries && a.xSeries[key]) || []
  const vl = (a.vl && a.vl[key]) || []
  const mkt = candleZone(a, key).mkt || undefined
  const out = []
  hl[key].forEach((c, i) => {
    const close = num(c && c[3])
    const ts = num(xs[i])
    if (close === null || ts === null) return
    out.push({
      ts,
      date: axisDate(clock, ts),
      mkt,
      high: num(c[0]),
      low: num(c[1]),
      open: num(c[2]),
      close,
      vol: num(vl[i]),
    })
  })
  return out.sort((x, y) => x.ts - y.ts)
}

/** Market of a getHloc answer's ticker: {mkt: market name, tz: the broker's IANA zone} (nulls if absent). */
export function candleZone(answer, ticker) {
  const i = (answer && answer.info && answer.info[ticker]) || {}
  return { mkt: i.mkt_name || null, tz: (i.mrkt && i.mrkt.tz) || null }
}

export { sessionBounds } from './marketTime.js'

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
 * Intraday (1D: last session, 5D: last 5 sessions): only bars inside the session window, from
 * the broker's pre-open to the regular close (marketTime.sessionWindow over `sessions`, the
 * market `clock` and `today`), each with the user's local
 * `min` (minutes since midnight), `ldate` and `zone` label; the sessions are the last dates that
 * still have such bars (a day with only bars before the pre-open is skipped). Without any
 * bounds all bars stay.
 * Daily: rows after the period start plus the last close at or before it (the baseline).
 * @param {{today?: string, sessions?: Map|null, clock?: object|null, timeZone?: string}} opts
 *   clock: marketClockFor(...) of the security's market; timeZone: display zone (default: browser)
 */
export function chartRows(period, { intraday, daily, max } = {}, { today, sessions, clock, timeZone } = {}) {
  const src = chartSource(period)
  if (src === 'intraday') {
    const win = sessionWindow(sessions, clock, today, barSeconds(intraday))
    const local = (r) => {
      const at = axisToUtc(r.ts, clock)
      if (at === null) return { ...r, min: null }
      const p = localParts(at, timeZone)
      return { ...r, min: p.min, ldate: p.date, zone: p.zone }
    }
    const inSession = (intraday || []).flatMap((r) => {
      const b = win && win(r.date)
      if (b && (r.ts < b[0] || r.ts > b[1])) return []
      return [local(r)]
    })
    // The last sessions that have bars in the session: pre-market-only days do not count.
    const dates = [...new Set(inSession.map((r) => r.date))].sort()
    const keep = new Set(dates.slice(period === '1D' ? -1 : -5))
    return inSession.filter((r) => keep.has(r.date))
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
 *   open       open of the first bar of the last intraday session window (from the broker's
 *              pre-open, as on the 1D chart; owner's choice), else of the last daily
 *              candle (`op` is unreliable); `sessions`: sessionBounds (index-anchored market
 *              only), `clock`: the market clock (marketClockFor), `today`: its trading date
 *   dayLow/dayHigh  `mintp` / `maxtp`
 *   low52/high52    min low / max high over the last 252 daily candles
 *   volume     `vol` (an index's 0 = none: null); avgVolume  mean `vl` of the last 63 daily candles
 *              (none for an index: its `vl` is not a traded volume)
 *   kind       'index' | 'stock' | 'preferred' | 'fund' | null; index: `codesub_nm` INDEX, or without a
 *              codesub the .IDX suffix (`ticker`, else `c`): the broker sends kind 1 for indices
 */
export function keyStats({ info, daily, intraday, sessions, clock, today, ticker = null } = {}) {
  const i = info || {}
  const sub = i.codesub_nm ? String(i.codesub_nm).toUpperCase() : ''
  const index = sub ? sub === 'INDEX' : String(ticker || i.c || '').toUpperCase().endsWith('.IDX')
  const d = daily || []
  const last = d.length ? d[d.length - 1] : null
  const session = intraday && intraday.length ? chartRows('1D', { intraday }, { sessions, clock, today }) : []
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
    volume: vol !== null && vol >= 0 && !(index && vol === 0) ? vol : null,
    avgVolume: !index && vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : null,
    kind: index ? 'index' : KINDS[num(i.kind)] || null,
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
