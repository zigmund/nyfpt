// Holdings sparklines: pure functions over parseHloc rows and cached daily closes.
import { barSeconds, isSessionDay, marketClockFor, sessionBounds, sessionWindow } from './marketTime.js'

const US_ANCHOR = 'SP500.IDX'
const isUs = (ticker) => /\.US$/.test(String(ticker))
const mktOf = (list) => (list.find((r) => r.mkt) || {}).mkt || null

/**
 * Last-session 15-min closes per ticker: {ticker: {date, spark, prior?}}, inside the market's
 * session window (marketTime.sessionWindow: broker pre-open to regular close; S&P 500 index bars
 * cap complete days of its own market).
 * Tickers of the S&P 500's market (US): the last index session; a later date with bars in the
 * window (index cache behind) wins. With no such bars on the index date yet (the markets cache
 * refreshes faster than the sparks cache), the latest earlier session, flagged `prior: true`
 * (it is not the session that the day change and previous close refer to).
 * Other markets (KASE, EU): their own last date with bars inside the window; without known
 * hours, their own last date unclipped. In every market a weekend date is no session
 * (marketTime.isSessionDay): the broker's flat Saturday / Sunday .EU bars never take the spark.
 * @param {{ticker, mkt?, ts, date, close}[]} rows intraday rows of the positions
 * @param {{ticker, mkt?, ts, date, close}[]} anchorRows intraday rows that may include SP500.IDX
 * @param {{offset, markets}|null} clock marketClock
 * @param {string} [today] trading date of the index's market now (marketDay)
 */
export function daySparks(rows, anchorRows, clock, today) {
  const idx = (anchorRows || []).filter((r) => r.ticker === US_ANCHOR).sort((a, b) => a.ts - b.ts)
  const usDate = idx.length ? idx[idx.length - 1].date : null
  const idxMkt = mktOf(idx)

  const by = new Map()
  for (const r of rows || []) {
    if (!Number.isFinite(r.close)) continue
    if (!by.has(r.ticker)) by.set(r.ticker, [])
    by.get(r.ticker).push(r)
  }
  const out = {}
  for (const [ticker, list] of by) {
    list.sort((a, b) => a.ts - b.ts)
    const own = mktOf(list)
    const anchored = !!usDate && (own && idxMkt ? own === idxMkt : isUs(ticker))
    const mkt = own || (anchored ? idxMkt : null)
    const win = sessionWindow(anchored ? sessionBounds(idx) : null, marketClockFor(clock, mkt), anchored ? today : undefined, barSeconds(list))
    const inWin = (r) => {
      const b = win && win(r.date)
      return b ? r.ts >= b[0] && r.ts <= b[1] : isSessionDay(r.date)
    }
    const sess = list.filter(inWin)
    const closesOn = (date) => sess.filter((r) => r.date === date).map((r) => r.close)
    const dates = [...new Set(sess.map((r) => r.date))].sort()
    const last = dates[dates.length - 1]
    if (!anchored) {
      const date = last || list[list.length - 1].date
      out[ticker] = { date, spark: closesOn(date) }
      continue
    }
    if (last && last >= usDate) { out[ticker] = { date: last, spark: closesOn(last) }; continue }
    out[ticker] = last ? { date: last, spark: closesOn(last), prior: true } : { date: usDate, spark: [] }
  }
  return out
}

/**
 * Period sparkline: the start price, cached daily closes strictly inside (from, to), the end price.
 * Endpoints are computeCore's price_start / price_end, so the line agrees with Range %.
 * Session days only (isSessionDay, as computeCore): flat weekend .EU bars are no points.
 * @param {{date, close}[]|undefined} closes ascending
 */
export function periodSpark(closes, from, to, first, last) {
  const mid = (closes || []).filter((c) => c.date > from && c.date < to && isSessionDay(c.date)).map((c) => c.close)
  return [first, ...mid, last].filter(Number.isFinite)
}
