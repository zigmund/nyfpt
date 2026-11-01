// Task 51: US prices on the regular session close (16:00 New York, like Yahoo); the after-hours /
// pre-market trade is shown apart. Synthetic tickers and prices only.
import { describe, expect, it } from 'vitest'
import { holdingsRows, livePriceRows, regularCloses, regularQuote, tradePhase } from '../src/calc/live.js'
import { axisAt } from '../src/calc/marketTime.js'
import { computeCore, parsePositions } from '../src/calc/portfolio.js'

const OFF = 10800 // broker server at UTC+3: axis + 3 h = exchange wall clock
// US market clock in exchange wall minutes: pre-open 07:10, open 09:30, regular close 16:00, extended 20:00.
const US = { offset: OFF, dt: 0, tz: null, pre: 430, open: 570, close: 1200, regular: 960 }
// KASE: no regular close (`post`) from the broker.
const KZ = { offset: OFF, dt: 0, tz: null, pre: 680, open: 690, close: 1320, regular: null }
const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
// One ticker's 15-min bars [{ts, date, close}] of `date` from `from` to `to` (bar start times), closes from `px(i)`.
function bars(date, from, to, px) {
  const out = []
  for (let m = hm(from), i = 0; m <= hm(to); m += 15, i++) out.push({ ts: axisAt(OFF, date, m), date, close: px(i, m) })
  return out
}

describe('tradePhase: where the quote\'s last trade falls against the regular session', () => {
  it('pre / regular / post by the ltt wall time; null without a regular close or a trade time', () => {
    expect(tradePhase({ ltp: 1, ltt: '2026-10-30T08:15:00' }, US)).toEqual({ day: '2026-10-30', phase: 'pre' })
    expect(tradePhase({ ltp: 1, ltt: '2026-10-30T09:30:00' }, US)).toEqual({ day: '2026-10-30', phase: 'regular' })
    expect(tradePhase({ ltp: 1, ltt: '2026-10-30T15:59:59' }, US)).toEqual({ day: '2026-10-30', phase: 'regular' })
    expect(tradePhase({ ltp: 1, ltt: '2026-10-30T16:00:00' }, US)).toEqual({ day: '2026-10-30', phase: 'post' })
    expect(tradePhase({ ltp: 1, ltt: '2026-10-30 19:58:25' }, US)).toEqual({ day: '2026-10-30', phase: 'post' })
    expect(tradePhase({ ltp: 1, ltt: '2026-10-30T19:58:25' }, KZ)).toBeNull()
    expect(tradePhase({ ltp: 1, ltt: '1970-01-01T00:00:00' }, US)).toBeNull()
    expect(tradePhase({ ltp: 1 }, US)).toBeNull()
    expect(tradePhase({ ltp: 1, ltt: '2026-10-30T19:58:25' }, null)).toBeNull()
    expect(tradePhase(null, US)).toBeNull()
  })
})

describe('regularCloses: the last bar that ends by the regular close', () => {
  it('15-min and 60-min bars; after-hours and pre-market-only days do not count', () => {
    const d1 = [...bars('2026-10-29', '04:00', '19:45', (i, m) => (m < 960 ? 100 + i / 100 : 90))]
    const d2 = [...bars('2026-10-30', '04:00', '19:45', (i, m) => (m === 945 ? 101.5 : m < 960 ? 101 : 95))]
    const pre = bars('2026-11-02', '04:00', '08:45', () => 103) // a pre-market only day
    const m = regularCloses([...d2, ...pre, ...d1], US)
    expect(m.get('2026-10-30')).toBe(101.5) // the 15:45 bar, not the after-hours 16:00+
    expect(m.get('2026-10-29')).toBeCloseTo(100 + (hm('15:45') - hm('04:00')) / 15 / 100, 9)
    expect(m.has('2026-11-02')).toBe(false)
    // hourly bars: 15:00 is the last bar ending by 16:00
    const h = [14, 15, 16, 17].map((x) => ({ ts: axisAt(OFF, '2026-10-30', x * 60), date: '2026-10-30', close: x }))
    expect(regularCloses(h, US).get('2026-10-30')).toBe(15)
  })

  it('a session still running (no bar reaching the close yet) or a lone bar gives nothing', () => {
    expect(regularCloses(bars('2026-10-30', '09:30', '11:00', () => 7), US).size).toBe(0)
    expect(regularCloses([{ ts: axisAt(OFF, '2026-10-30', 600), date: '2026-10-30', close: 1 }], US).size).toBe(0)
  })

  it('weekend bars and markets without a regular close give nothing', () => {
    expect(regularCloses(bars('2026-10-31', '10:00', '12:00', () => 5), US).size).toBe(0)
    expect(regularCloses(bars('2026-10-30', '10:00', '12:00', () => 5), KZ).size).toBe(0)
    expect(regularCloses(null, US).size).toBe(0)
  })
})

describe('regularQuote: ONE rule for the regular price and the previous regular close', () => {
  const closes = new Map([['2026-10-28', 98], ['2026-10-29', 100], ['2026-10-30', 104.1]])

  it('during the regular session: ltp against the previous close (unchanged rule)', () => {
    const q = { ltp: 103, chg: 3, pcp: 3, pp: 100, ClosePrice: 100, ltt: '2026-10-30T11:00:00' }
    expect(regularQuote(q, US, closes)).toEqual({ price: 103, prev: 100, pct: 3, day: '2026-10-30', ext: null })
  })

  it('after the close (weekend included): the regular close of that day, after hours apart', () => {
    // Like the broker on a day off: ClosePrice = Friday's official close, ltp - chg = Thursday's.
    const q = { ltp: 105, chg: 5, pcp: 5, pp: 100, ClosePrice: 104, ltt: '2026-10-30T19:58:25' }
    const r = regularQuote(q, US, closes)
    expect(r).toMatchObject({ price: 104, prev: 100, pct: null, day: '2026-10-30' })
    expect(r.ext).toMatchObject({ kind: 'post', price: 105, ltt: '2026-10-30T19:58:25' })
    expect(r.ext.change).toBeCloseTo(1, 9)
    expect(r.ext.pct).toBeCloseTo((105 / 104 - 1) * 100, 9)
    // without bars: the quote's own fields
    expect(regularQuote(q, US)).toMatchObject({ price: 104, prev: 100, day: '2026-10-30' })
  })

  it('a ClosePrice that is not that day\'s close (still the previous one) yields to the bars', () => {
    const q = { ltp: 105, chg: 5, pp: 100, ClosePrice: 100, ltt: '2026-10-30T17:00:00' }
    expect(regularQuote(q, US, closes)).toMatchObject({ price: 104.1, prev: 100, day: '2026-10-30' })
    // no ClosePrice at all: the bars; neither: the old rule (ltp against the previous close)
    expect(regularQuote({ ...q, ClosePrice: 0 }, US, closes)).toMatchObject({ price: 104.1, prev: 100 })
    expect(regularQuote({ ...q, ClosePrice: 0 }, US)).toMatchObject({ price: 105, prev: 100, ext: null })
  })

  it('pre-market: the last regular close against the one before it, the pre-market trade apart', () => {
    // Monday 08:15 trade; whatever the broker rolled (pp / ClosePrice), the bars name the sessions.
    const q = { ltp: 106, chg: 1.9, pcp: 1.8, pp: 104.1, ClosePrice: 104.1, ltt: '2026-11-02T08:15:00' }
    const r = regularQuote(q, US, closes)
    expect(r).toMatchObject({ price: 104.1, prev: 100, pct: null, day: '2026-10-30' })
    expect(r.ext).toMatchObject({ kind: 'pre', price: 106 })
    expect(r.ext.change).toBeCloseTo(1.9, 9)
    // without bars the sessions are unknown: the broker's own change (old rule)
    expect(regularQuote(q, US)).toEqual({ price: 106, prev: 104.1, pct: 1.8, day: null, ext: null })
  })

  it('official quote values win over the bars when they match the same session', () => {
    const q = { ltp: 105, chg: 5.05, pp: 99.95, ClosePrice: 104.05, ltt: '2026-10-30T18:00:00' }
    expect(regularQuote(q, US, closes)).toMatchObject({ price: 104.05, prev: 99.95 })
  })

  it('other markets and quotes without a price keep the old rule', () => {
    const kz = { ltp: 205.1, chg: 1.1, pcp: 0.54, pp: 204, ClosePrice: 205.1, ltt: '2026-10-30T17:00:00' }
    expect(regularQuote(kz, KZ, closes)).toEqual({ price: 205.1, prev: 204, pct: 0.54, day: null, ext: null })
    expect(regularQuote({ ltp: 0, pp: 0, ltt: '1970-01-01T00:00:00' }, US)).toEqual({ price: null, prev: null, pct: null, day: null, ext: null })
    expect(regularQuote(null, US)).toEqual({ price: null, prev: null, pct: null, day: null, ext: null })
  })
})

describe('Holdings Day on the regular close', () => {
  const ps = {
    acc: [{ curr: 'USD', currval: 1, s: 0 }],
    pos: [
      { i: 'AAA.US', q: 10, mkt_price: 105, close_price: 104, market_value: 1050, curr: 'USD', currval: 1 },
      { i: 'KZ.KZ', q: 1, mkt_price: 200, close_price: 200, market_value: 200, curr: 'USD', currval: 1 },
    ],
  }
  const quotes = new Map([
    ['AAA.US', { ltp: 105, chg: 5, pp: 100, ClosePrice: 104, ltt: '2026-10-30T19:58:25' }],
    ['KZ.KZ', { ltp: 200, chg: 2, pp: 198, ltt: '2026-10-30T17:00:00' }],
  ])
  const mcOf = (t) => (t.endsWith('.US') ? US : KZ)

  it('after-hours trades are not in the day; the regular close is the price', () => {
    const rows = holdingsRows(ps, quotes, (t, q) => regularQuote(q, mcOf(t)))
    const aaa = rows.find((r) => r.ticker === 'AAA.US')
    expect(aaa).toMatchObject({ price: 104, prevClose: 100, valueUsd: 1040, dayChangeUsd: 40 })
    expect(aaa.dayChangePct).toBeCloseTo(4, 9)
    expect(rows.find((r) => r.ticker === 'KZ.KZ')).toMatchObject({ price: 200, prevClose: 198, dayChangeUsd: 2 })
    // without a resolver: the old rule (ltp includes the after-hours trade)
    expect(holdingsRows(ps, quotes).find((r) => r.ticker === 'AAA.US')).toMatchObject({ price: 105, dayChangeUsd: 50 })
  })
})

describe('livePriceRows with the regular price', () => {
  const rows = [
    { ticker: 'AAA.US', date: '2026-10-29', close: 100, window_start: '2026-10-28' },
    { ticker: 'AAA.US', date: '2026-10-30', close: 105, window_start: '2026-10-28' },
  ]
  it('today\'s row takes the regular price; a pre-market quote adds no row for today', () => {
    const post = new Map([['AAA.US', { ltp: 105, chg: 5, pp: 100, ClosePrice: 104, ltt: '2026-10-30T19:00:00' }]])
    const res = (t, q) => regularQuote(q, US)
    expect(livePriceRows(rows, post, '2026-10-30', res).find((r) => r.date === '2026-10-30').close).toBe(104)
    const pre = new Map([['AAA.US', { ltp: 106, chg: 2, pp: 104, ClosePrice: 104, ltt: '2026-11-02T08:00:00' }]])
    const closes = new Map([['2026-10-29', 100], ['2026-10-30', 104]])
    const out = livePriceRows(rows, pre, '2026-11-02', (t, q) => regularQuote(q, US, closes))
    expect(out.some((r) => r.date === '2026-11-02')).toBe(false)
  })
})

describe('Performance on regular closes (computeCore `regular`)', () => {
  // Weekend after Friday 10-30: 1D = Friday's regular close against Thursday's, no trades, no flows.
  const ps = {
    acc: [{ curr: 'USD', currval: 1, s: 500 }],
    pos: [
      { i: 'AAA.US', name: 'A', q: 10, mkt_price: 105, close_price: 104, market_value: 1050, curr: 'USD', currval: 1 },
      { i: 'BBB.US', name: 'B', q: 4, mkt_price: 49, close_price: 50, market_value: 196, curr: 'USD', currval: 1 },
    ],
  }
  const ws = '2026-10-31'
  // Daily candles close on the last extended-hours trade.
  const daily = [
    ['SPY.US', '2026-10-29', 600], ['SPY.US', '2026-10-30', 590], ['QQQ.US', '2026-10-29', 500], ['QQQ.US', '2026-10-30', 495],
    ['AAA.US', '2026-10-29', 101], ['AAA.US', '2026-10-30', 105], ['BBB.US', '2026-10-29', 52], ['BBB.US', '2026-10-30', 49],
  ].map(([ticker, date, close]) => ({ ticker, date, close, window_start: ws }))
  const quotes = new Map([
    ['AAA.US', { ltp: 105, chg: 5, pp: 100, ClosePrice: 104, ltt: '2026-10-30T19:58:00' }],
    ['BBB.US', { ltp: 49, chg: -2, pp: 51, ClosePrice: 50, ltt: '2026-10-30T18:30:00' }],
  ])
  const regular = new Map([
    ['AAA.US', new Map([['2026-10-29', 100], ['2026-10-30', 104]])],
    ['BBB.US', new Map([['2026-10-29', 51], ['2026-10-30', 50]])],
    ['SPY.US', new Map([['2026-10-29', 601], ['2026-10-30', 595]])],
  ])

  it('1D P&L = the sum of the Holdings regular day changes; P&L identity holds', () => {
    const positions = parsePositions({ answer: { ps } }).rows
    const res = computeCore(positions, [], [], daily, regular)
    const day = holdingsRows(ps, quotes, (t, q) => regularQuote(q, US))
      .reduce((s, r) => s + r.dayChangeUsd, 0)
    expect(day).toBeCloseTo(10 * 4 + 4 * -1, 9) // 36
    expect(res.summary.day_pnl).toBeCloseTo(day, 2)
    expect(res.summary.pnl).toBeCloseTo(res.summary.value_end - res.summary.value_start - res.summary.deposits, 2)
    expect(res.positions.find((r) => r.ticker === 'AAA.US')).toMatchObject({ price_start: 100, price_end: 104 })
    expect(res.summary.spy).toBeCloseTo((595 / 601 - 1) * 100, 2) // benchmarks on regular closes too
    expect(res.summary.qqq).toBeCloseTo((495 / 500 - 1) * 100, 2) // no regular close: the daily one
    // without regular closes: the daily (extended-hours) closes as before
    expect(computeCore(positions, [], [], daily).summary.day_pnl).toBeCloseTo(10 * 4 + 4 * -3, 2)
  })
})
