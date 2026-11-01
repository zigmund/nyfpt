// Task 51 data layer: regular closes fetched only for the dates a period / card needs, cached for
// good; Performance, Holdings, search and the card on the same regular prices. Synthetic data only.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openAccountDb } from '../src/store/db.js'
import { createRepo } from '../src/data/repo.js'
import { holdingsRows, holdingsTotal } from '../src/calc/live.js'

// Fake server on UTC (axis = exchange wall clock, daily bar = UTC midnight); FIX = New York in
// summer time (dt 240): open 13:30 / regular close 20:00 server = 09:30 / 16:00 New York.
const MRKT = {
  FIX: { p: '11:10:00', o: '13:30:00', post: '20:00:00', c: '00:00:00', dt: 240 },
  KASE: { p: '06:20:00', o: '06:30:00', c: '17:00:00', dt: -300 },
}
const mktOf = (t) => (t.endsWith('.KZ') ? 'KASE' : 'FIX')
const tsOf = (d, min = 0) => Date.parse(`${d}T00:00:00Z`) / 1000 + min * 60
const SUNDAY = Date.parse('2026-11-01T17:00:00Z') // 12:00 in New York
const DATES = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']
// Per ticker and date: [regular close, last extended-hours trade (the daily candle's close)].
const PX = {
  'SPY.US': [[600, 601], [602, 603], [604, 604], [606, 607], [595, 590]],
  'QQQ.US': [[500, 500], [501, 502], [502, 503], [503, 505], [497, 495]],
  'AAA.US': [[90, 91], [92, 92], [95, 96], [100, 101], [104, 106]],
  'KZ.KZ': [[200, 200], [201, 201], [202, 202], [203, 203], [204, 204]],
  'SP500.IDX': [[5000, 5000], [5010, 5010], [5020, 5020], [5030, 5030], [5040, 5040]],
}
const POS = {
  acc: [{ curr: 'USD', currval: 1, s: 1000 }],
  pos: [
    { i: 'AAA.US', name: 'A', q: 10, mkt_price: 106, close_price: 104, market_value: 1060, curr: 'USD', currval: 1 },
    { i: 'KZ.KZ', name: 'K', q: 5, mkt_price: 204, close_price: 204, market_value: 1020, curr: 'USD', currval: 1 },
  ],
}
// Like the broker on a day off (verified 2026-11-01): ltp = Friday's last after-hours trade,
// ClosePrice = Friday's regular close, ltp - chg = pp = Thursday's regular close.
const QUOTES = {
  'AAA.US': { ltr: 'FIX', ltp: 106, chg: 6, pcp: 6, pp: 100, ClosePrice: 104, ltt: '2026-10-30T19:58:00' },
  'KZ.KZ': { ltr: 'KASE', ltp: 204, chg: 1, pcp: 0.49, pp: 203, ClosePrice: 204, ltt: '2026-10-30T17:00:00' },
}

function fakeBroker() {
  const calls = { hourly: [], quotes: 0 }
  const b = {
    calls,
    daily: Object.fromEntries(Object.entries(PX).map(([t, xs]) => [t, xs.map(([, ext], i) => [DATES[i], ext])])),
    async marketStatus() { return { result: { markets: { t: '2026-11-01 17:00:00', m: [] } } } },
    async positions() { return { result: { ps: JSON.parse(JSON.stringify(POS)) } } },
    async cashflows() { return { cashflow: [{ date: '2026-01-05', type_code: 'card', type_code_name: 'Deposit', currency: 'USD', sum: 1000 }] } },
    async trades() { return { trades: { trade: [] } } },
    async quotes(tickers) { calls.quotes++; return { result: { q: tickers.filter((t) => QUOTES[t]).map((t) => ({ c: t, ...QUOTES[t] })) } } },
    async securityInfo(t) { return { c: t, ...QUOTES[t] } },
    async hlocDaily(tickers, dateFrom) {
      const a = { hloc: {}, xSeries: {}, info: {} }
      for (const t of tickers) {
        const rows = (b.daily[t] || []).filter(([d]) => d >= dateFrom || dateFrom < DATES[0])
        a.info[t] = { mkt_name: mktOf(t), mrkt: MRKT[mktOf(t)] }
        a.hloc[t] = rows.map(([, c]) => [c, c, c, c])
        a.xSeries[t] = rows.map(([d]) => tsOf(d))
      }
      return a
    },
    // 15-min: the regular session only (09:30-15:45, closing on the regular close); 60-min: 04:00-19:00
    // with the after-hours trade from 16:00. The axis carries the exchange wall clock (docs §5.4).
    async hlocIntraday(tickers, dateFrom, dateTo, tf) {
      if (tf === 60) calls.hourly.push({ tickers: [...tickers], dateFrom, dateTo })
      const a = { hloc: {}, xSeries: {}, info: {} }
      for (const t of tickers) {
        const xs = []
        const hl = []
        DATES.forEach((d, i) => {
          if (d < dateFrom || d >= dateTo || (tf === 60 && b.noHourly?.has(t))) return
          const [reg, ext] = PX[t][i]
          const mins = tf === 60 ? Array.from({ length: 16 }, (_, k) => (4 + k) * 60) : Array.from({ length: 26 }, (_, k) => 570 + k * 15)
          for (const m of mins) {
            const c = m >= 960 ? ext : m + tf === 960 ? reg : reg - 1
            xs.push(tsOf(d, m)) // axis + server offset (0) = exchange wall clock, like the broker
            hl.push([c, c, c, c])
          }
        })
        a.info[t] = { mkt_name: mktOf(t), mrkt: MRKT[mktOf(t)] }
        a.hloc[t] = hl
        a.xSeries[t] = xs
      }
      return a
    },
  }
  return b
}

describe('regular closes in the repo (Task 51)', () => {
  let idb, db
  beforeEach(async () => {
    idb = new IDBFactory()
    db = await openAccountDb('global:1', idb)
  })
  const mk = (b, now = SUNDAY) => createRepo({ broker: b, db, now: () => now, strip: ['SP500.IDX'] })

  it('weekend: Performance 1D = Holdings Day (Friday regular close vs Thursday), hourly bars only for the base / end', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.load()
    await repo.ensurePrices('1d')
    // one hourly request: the end pair (Thu, Fri), US tickers only (KZ.KZ known as KASE from its bars)
    expect(b.calls.hourly).toEqual([{ tickers: ['QQQ.US', 'SPY.US'], dateFrom: '2026-10-29', dateTo: '2026-10-31' }])
    const core = repo.coreFor('1d')
    expect(core.summary).toMatchObject({ base_close: '2026-10-29', end: '2026-10-30' })
    let s
    repo.subscribe((x) => { s = x })
    const rows = holdingsRows(s.rawPs, s.quotes, (t, q) => repo.regular(t, q))
    const aaa = rows.find((r) => r.ticker === 'AAA.US')
    expect(aaa).toMatchObject({ price: 104, prevClose: 100, dayChangeUsd: 40 })
    expect(core.summary.day_pnl).toBeCloseTo(holdingsTotal(rows).dayChangeUsd, 2) // 40 + KZ 5 x 1
    expect(core.positions.find((r) => r.ticker === 'AAA.US')).toMatchObject({ price_start: 100, price_end: 104 })
    expect(core.summary.spy).toBeCloseTo((595 / 606 - 1) * 100, 2) // regular, not 590 / 607
    // the closes are kept: a new repo on the same database asks nothing again
    const b2 = fakeBroker()
    const repo2 = mk(b2)
    await repo2.load()
    await repo2.ensurePrices('1d')
    expect(b2.calls.hourly).toEqual([])
    expect(repo2.coreFor('1d').summary.spy).toBeCloseTo((595 / 606 - 1) * 100, 2)
  })

  it('a longer period asks its base date once more; a date with no bars is remembered', async () => {
    const b = fakeBroker()
    b.noHourly = new Set(['QQQ.US'])
    const repo = mk(b)
    await repo.load()
    await repo.ensurePrices('1d')
    b.calls.hourly.length = 0
    // 7D seen on Monday: base 10-26; AAA.US is in the positions' 15-min bars already
    await repo.ensurePrices('7d', '2026-11-02')
    expect(b.calls.hourly).toEqual([{ tickers: ['QQQ.US', 'SPY.US'], dateFrom: '2026-10-26', dateTo: '2026-10-27' }])
    await repo.ensurePrices('7d', '2026-11-02')
    expect(b.calls.hourly).toHaveLength(1) // QQQ.US without bars that day: remembered (null)
    expect(repo.coreFor('7d', '2026-11-02').positions.find((r) => r.ticker === 'AAA.US').price_start).toBe(90)
  })

  it('the position quote snapshot keeps ClosePrice and ltt; a snapshot of the old shape is fetched again', async () => {
    await db.putKv('quotes', { tickers: ['AAA.US', 'KZ.KZ'], rows: [{ c: 'AAA.US', ltp: 106, chg: 6, pp: 100 }] }, SUNDAY - 1000)
    const rows = POS.pos.map((p) => ({ ticker: p.i, name: p.name, kind: 'position', qty: p.q, price: p.mkt_price, value: p.market_value }))
    await db.putKv('positions', { rows, rawPs: POS }, SUNDAY - 1000)
    const b = fakeBroker()
    const repo = mk(b)
    await repo.load()
    expect(b.calls.quotes).toBe(1)
    let s
    repo.subscribe((x) => { s = x })
    expect(s.quotes.get('AAA.US')).toMatchObject({ ClosePrice: 104, ltt: '2026-10-30T19:58:00' })
  })

  it('a daily candle after the last SP500.IDX session (US pre-market) is not the period end yet', async () => {
    const b = fakeBroker()
    b.daily['SPY.US'] = [...b.daily['SPY.US'], ['2026-11-02', 611]]
    b.daily['AAA.US'] = [...b.daily['AAA.US'], ['2026-11-02', 111]]
    const monday = Date.parse('2026-11-02T13:00:00Z') // 08:00 New York (fake summer clock: 09:00)
    const repo = mk(b, monday)
    await repo.load()
    await repo.ensurePrices('1d', '2026-11-02')
    expect(repo.coreFor('1d', '2026-11-02').summary.end).toBe('2026-10-30')
  })

  it('search: a US quote after the close shows the regular close and its day change', async () => {
    const repo = mk(fakeBroker())
    await repo.load()
    const got = await repo.searchQuotes(['AAA.US', 'KZ.KZ'])
    expect(got['AAA.US'].last).toBe(104)
    expect(got['AAA.US'].change).toBeCloseTo(4, 9)
    expect(got['KZ.KZ']).toEqual({ last: 204, change: 0.49 })
  })

  it('card: daily closes take the regular close of the dates the card asked for', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.load()
    await repo.loadSecurity('QQQ.US', ['info', 'daily'])
    expect(repo.security('QQQ.US').daily.find((r) => r.date === '2026-10-27').close).toBe(502)
    await repo.ensureRegular('QQQ.US', ['2026-10-27'])
    expect(b.calls.hourly.at(-1)).toEqual({ tickers: ['QQQ.US'], dateFrom: '2026-10-27', dateTo: '2026-10-28' })
    expect(repo.security('QQQ.US').daily.find((r) => r.date === '2026-10-27').close).toBe(501)
  })
})
