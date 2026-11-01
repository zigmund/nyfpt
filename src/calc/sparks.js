// Holdings sparklines: pure functions over parseHloc rows and cached daily closes.

const US_ANCHOR = 'SP500.IDX'
const isUs = (ticker) => /\.US$/.test(String(ticker))

/**
 * Last-session 15-min closes per ticker: {ticker: {date, spark, prior?}}.
 * US tickers: the last S&P 500 intraday session, clipped to its first..last bar (regular hours,
 * as in the markets strip). With no regular bars on that date yet (the markets cache refreshes
 * faster than the sparks cache, so right after the open only pre-market bars may be cached), the
 * latest earlier session with regular bars, flagged `prior: true` (it is not the session that the
 * day change and previous close refer to). Without index candles: their own last date.
 * Other markets (KZ): their own last session date, unclipped (KASE trades in a different session).
 * @param {{ticker, ts, date, close}[]} rows intraday rows of the positions
 * @param {{ticker, ts, date, close}[]} anchorRows intraday rows that may include SP500.IDX
 */
export function daySparks(rows, anchorRows) {
  const idx = (anchorRows || []).filter((r) => r.ticker === US_ANCHOR).sort((a, b) => a.ts - b.ts)
  const usDate = idx.length ? idx[idx.length - 1].date : null
  // Regular-hours window of an index session date; unbounded when the index has no bars that day.
  const windowOf = (date) => {
    const sess = idx.filter((r) => r.date === date)
    return sess.length ? [sess[0].ts, sess[sess.length - 1].ts] : [-Infinity, Infinity]
  }
  const closesOn = (list, date, clip) => {
    const [lo, hi] = clip ? windowOf(date) : [-Infinity, Infinity]
    return list.filter((r) => r.date === date && r.ts >= lo && r.ts <= hi).map((r) => r.close)
  }

  const by = new Map()
  for (const r of rows || []) {
    if (!Number.isFinite(r.close)) continue
    if (!by.has(r.ticker)) by.set(r.ticker, [])
    by.get(r.ticker).push(r)
  }
  const out = {}
  for (const [ticker, list] of by) {
    list.sort((a, b) => a.ts - b.ts)
    if (!(isUs(ticker) && usDate)) {
      const date = list[list.length - 1].date
      out[ticker] = { date, spark: closesOn(list, date, false) }
      continue
    }
    out[ticker] = { date: usDate, spark: closesOn(list, usDate, true) }
    if (out[ticker].spark.length) continue
    const earlier = [...new Set(list.map((r) => r.date))].filter((d) => d < usDate).sort().reverse()
    for (const date of earlier) {
      const spark = closesOn(list, date, true)
      if (spark.length) { out[ticker] = { date, spark, prior: true }; break }
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
