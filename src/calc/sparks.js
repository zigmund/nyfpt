// Holdings sparklines: pure functions over parseHloc rows and cached daily closes.

const US_ANCHOR = 'SP500.IDX'
const isUs = (ticker) => /\.US$/.test(String(ticker))

/**
 * Last-session 15-min closes per ticker: {ticker: {date, spark}}.
 * US tickers: the last S&P 500 intraday session, clipped to its first..last bar (regular hours,
 * as in the markets strip); without index candles, their own last date. Other markets (KZ):
 * their own last session date, unclipped (KASE trades in a different session than the US).
 * @param {{ticker, ts, date, close}[]} rows intraday rows of the positions
 * @param {{ticker, ts, date, close}[]} anchorRows intraday rows that may include SP500.IDX
 */
export function daySparks(rows, anchorRows) {
  const idx = (anchorRows || []).filter((r) => r.ticker === US_ANCHOR).sort((a, b) => a.ts - b.ts)
  const usDate = idx.length ? idx[idx.length - 1].date : null
  const sess = idx.filter((r) => r.date === usDate)
  const lo = sess.length ? sess[0].ts : -Infinity
  const hi = sess.length ? sess[sess.length - 1].ts : Infinity

  const by = new Map()
  for (const r of rows || []) {
    if (!Number.isFinite(r.close)) continue
    if (!by.has(r.ticker)) by.set(r.ticker, [])
    by.get(r.ticker).push(r)
  }
  const out = {}
  for (const [ticker, list] of by) {
    list.sort((a, b) => a.ts - b.ts)
    const us = isUs(ticker) && usDate
    const date = us ? usDate : list[list.length - 1].date
    out[ticker] = {
      date,
      spark: list.filter((r) => r.date === date && (!us || (r.ts >= lo && r.ts <= hi))).map((r) => r.close),
    }
  }
  return out
}

/**
 * Period sparkline: the start price, cached daily closes strictly inside (from, to), the end price.
 * Endpoints are computeCore's price_start / price_end, so the line agrees with Range %.
 * @param {{date, close}[]|undefined} closes ascending
 */
export function periodSpark(closes, from, to, first, last) {
  const mid = (closes || []).filter((c) => c.date > from && c.date < to).map((c) => c.close)
  return [first, ...mid, last].filter(Number.isFinite)
}
