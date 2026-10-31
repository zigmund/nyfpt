import { describe, it, expect } from 'vitest'
import { computeMarkets } from '../src/calc/portfolio.js'

// Row dates are ts + 4h (see parseHloc). Synthetic numbers shaped like the live response:
// NASDAQ.IDX carries an extra daily bar dated on the weekend after the last session.
const D1 = Date.UTC(2026, 9, 29, 21) / 1000 // labelled 2026-10-30
const D2 = D1 + 86400 // labelled 2026-10-31 (Saturday)
const daily = (ticker, date, ts, close) => ({ ticker, ts, date, close })
const candles = (ticker, date, start, closes) =>
  closes.map((close, i) => ({ ticker, date, ts: start + i * 900, close }))

describe('computeMarkets', () => {
  const sess = Date.UTC(2026, 9, 30, 6, 30) / 1000
  const intraday = [
    ...candles('SP500.IDX', '2026-10-30', sess, [100, 101, 102]),
    ...candles('NASDAQ.IDX', '2026-10-30', sess, [200, 202, 204]),
  ]

  it('weekend daily bar of one ticker does not empty its spark', () => {
    const dly = [
      daily('SP500.IDX', '2026-10-29', D1 - 86400, 99), daily('SP500.IDX', '2026-10-30', D1, 102),
      daily('NASDAQ.IDX', '2026-10-29', D1 - 86400, 198), daily('NASDAQ.IDX', '2026-10-30', D1, 204),
      daily('NASDAQ.IDX', '2026-10-31', D2, 203),
    ]
    const nq = computeMarkets(dly, intraday).find((r) => r.ticker === 'NASDAQ.IDX')
    expect(nq.spark).toEqual([200, 202, 204])
    expect(nq).toMatchObject({ date: '2026-10-30', last: 204, prev: 198 })
  })

  it('without intraday anchor keeps the latest daily bars', () => {
    const dly = [daily('SP500.IDX', '2026-10-29', D1 - 86400, 99), daily('SP500.IDX', '2026-10-30', D1, 102)]
    expect(computeMarkets(dly, [])[0]).toMatchObject({ date: '2026-10-30', last: 102, prev: 99, spark: [] })
  })

  it('rows follow the given tickers and their order; a ticker without bars gets an empty row', () => {
    const dly = [
      daily('SP500.IDX', '2026-10-29', D1 - 86400, 99), daily('SP500.IDX', '2026-10-30', D1, 102),
      daily('NASDAQ.IDX', '2026-10-29', D1 - 86400, 198), daily('NASDAQ.IDX', '2026-10-30', D1, 204),
    ]
    const rows = computeMarkets(dly, intraday, undefined, undefined, ['NASDAQ.IDX', 'NONE.US', 'SP500.IDX'])
    expect(rows.map((r) => r.ticker)).toEqual(['NASDAQ.IDX', 'NONE.US', 'SP500.IDX'])
    expect(rows[1]).toEqual({ ticker: 'NONE.US', date: null, last: null, prev: null, change_pct: null, spark: [] })
    expect(rows[2]).toMatchObject({ last: 102, prev: 99 })
  })
})
