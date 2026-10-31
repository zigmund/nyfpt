import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fx from './fixtures/synthetic-api.json'
import { openAccountDb } from '../src/store/db.js'
import { createRepo } from '../src/data/repo.js'
import { BrokerError, SessionExpiredError } from '../src/api/transport.js'
import {
  parseHloc, parsePositions, parseTrades, parseCashflows, parsePricesForPeriod, computeCore,
} from '../src/calc/portfolio.js'
import { livePriceRows } from '../src/calc/live.js'
import { createAppState } from '../src/composables/useApp.js'
import { CACHE_VERSION, TTL } from '../src/config.js'

// Synthetic market clock: broker server at UTC+3 (axis + 3 h = exchange wall clock, daily bar = server midnight).
const SRV3 = { offset: 10800, markets: {} }

const T0 = Date.parse('2026-10-12T15:00:00Z') // 11:00 in New York
const clone = (x) => JSON.parse(JSON.stringify(x))
const tsOf = (d) => Date.parse(`${d}T00:00:00Z`) / 1000
const PORTFOLIO = ['AAA.US', 'BBB.US', 'CCC_KZ.KZ', 'QQQ.US', 'SPY.US']
const STRIP = ['SP500.IDX', 'NASDAQ.IDX', 'USO.US', 'GLD.US', 'SLV.US']
const TTL_MARKETS = TTL.intraday

// Candle table {ticker: [[date, close]]} built from the synthetic fixture.
function fixtureSeries() {
  const s = {}
  for (const r of parseHloc({ answer: fx['getHloc.daily'] }, SRV3).rows) (s[r.ticker] ||= []).push([r.date, r.close])
  return s
}

// Fake broker over synthetic data with call counters. `gate` (a promise) stalls every call.
// Its server runs on UTC (axis = exchange wall clock, daily bar = UTC midnight); FIX = New York
// in summer time (dt 240), KASE = UTC+5 (dt -300). `b.now` = the repo's clock.
const mktOf = (t) => (String(t).endsWith('.KZ') ? 'KASE' : 'FIX')
// getHloc info.mrkt of the fake server (UTC): FIX = NY summer (dt 240), KASE = UTC+5 (dt -300).
const MRKT = {
  FIX: { p: '11:10:00', o: '13:30:00', post: '20:00:00', c: '00:00:00', dt: 240 },
  KASE: { p: '06:20:00', o: '06:30:00', c: '17:00:00', dt: -300 },
}
const srvTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
function fakeBroker() {
  const calls = { positions: 0, cashflows: 0, trades: [], hlocDaily: [], hlocIntraday: [], marketStatus: 0 }
  const b = {
    calls, fail: {}, series: fixtureSeries(), intraday: {}, gate: null, now: () => T0,
    unknown: new Set(), // tickers the broker does not know: a request naming one fails as a whole
    finder: [],
    async marketStatus() {
      calls.marketStatus++; await b.gate
      if (b.fail.marketStatus) throw b.fail.marketStatus
      return { result: { markets: { t: srvTime(b.now()), m: [
        { i: '1', n: 'FIX', n2: 'FIX', s: 'CLOSE', o: '13:30:00', c: '00:00:00', dt: '240' },
        { i: '2', n: 'KASE', n2: 'KASE', s: 'CLOSE', o: '06:30:00', c: '17:00:00', dt: '-300' },
      ] } } }
    },
    async positions() {
      calls.positions++; await b.gate
      if (b.fail.positions) throw b.fail.positions
      return clone(fx.getPositionJson)
    },
    async cashflows() {
      calls.cashflows++; await b.gate
      if (b.fail.cashflows) throw b.fail.cashflows
      return clone(fx.getUserCashFlows)
    },
    async trades(beginDate) {
      calls.trades.push(beginDate); await b.gate
      if (b.fail.trades) throw b.fail.trades
      const a = clone(fx.getTradesHistory)
      a.trades.trade = a.trades.trade.filter((t) => t.date.slice(0, 10) >= beginDate)
      return a
    },
    // count -N: N-1 candles before dateFrom, then everything after.
    async hlocDaily(tickers, dateFrom, count = -6) {
      calls.hlocDaily.push({ tickers: [...tickers], dateFrom, count }); await b.gate
      if (tickers.some((t) => b.unknown.has(t))) throw new BrokerError('Instruments not found')
      return answer(tickers, (rows) => {
        const i = rows.findIndex(([d]) => d >= dateFrom)
        return i < 0 ? [] : rows.slice(Math.max(0, i + count + 1))
      })
    },
    async tickerFinder(text) {
      calls.finder = [...(calls.finder || []), text]
      return { found: clone(b.finder) }
    },
    // b.intraday: {ticker: [[date, 'HH:MM', close]]}
    async hlocIntraday(tickers, dateFrom, dateTo, timeframe = 15) {
      calls.hlocIntraday.push({ tickers: [...tickers], dateFrom, dateTo, timeframe }); await b.gate
      if (b.fail.hlocIntraday) throw b.fail.hlocIntraday
      if (tickers.some((t) => b.unknown.has(t))) throw new BrokerError('Instruments not found')
      const a = { hloc: {}, xSeries: {}, info: {} }
      for (const t of tickers) {
        const rows = b.intraday[t] || []
        if (!rows.length) continue
        a.info[t] = { mkt_name: mktOf(t), mrkt: MRKT[mktOf(t)] }
        a.hloc[t] = rows.map(([, , c]) => [c, c, c, c])
        a.xSeries[t] = rows.map(([d, hm]) => tsOf(d) + Number(hm.slice(0, 2)) * 3600 + Number(hm.slice(3)) * 60)
      }
      return a
    },
  }
  function answer(tickers, pick) {
    const a = { hloc: {}, xSeries: {}, info: {} }
    for (const t of tickers) {
      const rows = pick(b.series[t] || [])
      if (!rows.length) continue
      a.info[t] = { mkt_name: mktOf(t), mrkt: MRKT[mktOf(t)] }
      a.hloc[t] = rows.map(([, c]) => [c, c, c, c])
      a.xSeries[t] = rows.map(([d]) => tsOf(d))
    }
    return a
  }
  return b
}

describe('repo', () => {
  let db, idb, clock
  beforeEach(async () => {
    idb = new IDBFactory()
    db = await openAccountDb('global:1', idb)
    clock = T0
  })
  // The same account written by a bundle with an older cache format.
  const oldDb = () => openAccountDb('global:1', idb, { version: CACHE_VERSION - 1 })
  const scale = (series, k, pick = () => true) => series.map(([d, c]) => [d, pick(d) ? c * k : c])
  const asCandles = (rows) => rows.map(([date, close]) => ({ date, close }))
  const mk = (broker) => { broker.now = () => clock; return createRepo({ broker, db, now: () => clock }) }
  const stripIntraday = (b) => b.calls.hlocIntraday.filter((c) => c.tickers[0] === STRIP[0])
  const sparkCalls = (b) => b.calls.hlocIntraday.filter((c) => c.tickers[0] !== STRIP[0])
  const counts = (b) => [b.calls.positions, b.calls.cashflows, stripIntraday(b).length]

  it('load emits cached state before network', async () => {
    const old = { ticker: 'OLD.US', name: 'Old', kind: 'position', qty: 1, price: 1, value: 1 }
    await db.putKv('positions', { rows: [old], rawPs: { pos: [] } }, T0 - 3600e3)
    const b = fakeBroker()
    let release
    b.gate = new Promise((r) => { release = r })
    const repo = mk(b)
    const seen = []
    repo.subscribe((s) => seen.push({ s, calls: b.calls.positions }))
    const done = repo.load()
    await vi.waitFor(() => expect(b.calls.positions).toBe(1))
    const cached = seen.find((x) => x.s.positions?.[0]?.ticker === 'OLD.US')
    expect(cached.calls).toBe(0)
    expect(cached.s.updatedAt).toBe(T0 - 3600e3)
    expect(seen.at(-1).s.loading).toContain('positions')
    release()
    await done
    const last = seen.at(-1).s
    expect(last.positions.map((p) => p.ticker)).toEqual(['AAA.US', 'BBB.US', 'CCC_KZ.KZ', 'USD'])
    expect(last.rawPs.pos).toHaveLength(3)
    expect(last.inception).toBe('2026-09-09')
    expect(last.updatedAt).toBe(T0)
    expect(last.loading).toEqual([])
  })

  it('respects TTL', async () => {
    const b = fakeBroker()
    await mk(b).load()
    expect(counts(b)).toEqual([1, 1, 1])
    clock += 30e3
    await mk(b).load() // fresh repo over the same cache: everything still fresh
    expect(counts(b)).toEqual([1, 1, 1])
    clock += 70e3 // 100 s: positions and markets stale, cashflows (10 min) fresh
    const repo = mk(b)
    await repo.load()
    expect(counts(b)).toEqual([2, 1, 2])
    await repo.refresh({ force: true, only: ['cashflows'] })
    expect(counts(b)).toEqual([2, 2, 2])
    expect(b.calls.trades).toEqual([]) // no period requested yet
  })

  it('coalesces concurrent refreshes', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await Promise.all([repo.refresh({ force: true }), repo.refresh({ force: true, only: ['positions'] })])
    expect(counts(b)).toEqual([1, 1, 1])
    await Promise.all([repo.ensurePrices('7d', '2026-10-13'), repo.ensurePrices('7d', '2026-10-13')])
    expect(b.calls.trades).toHaveLength(1)
    expect(b.calls.hlocDaily.filter((c) => c.count === -6)).toHaveLength(1)
  })

  it('fetches only new candles', async () => {
    const b = fakeBroker()
    const full = b.series
    // Broker as of 10-09: the 10-09 candle is still provisional.
    b.series = Object.fromEntries(Object.entries(full).map(([t, rows]) => [
      t, rows.filter(([d]) => d <= '2026-10-09').map(([d, c]) => [d, d === '2026-10-09' ? c - 1 : c]),
    ]))
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-09') // start 10-02
    expect(b.calls.hlocDaily).toEqual([{ tickers: PORTFOLIO, dateFrom: '2026-09-22', count: -6 }])
    b.series = full
    b.calls.hlocDaily.length = 0
    await repo.ensurePrices('7d', '2026-10-13') // start 10-06, already covered
    // From the earliest of the last 2 stored days (CCC_KZ has no 10-08: 10-07), one request.
    expect(b.calls.hlocDaily).toEqual([{ tickers: PORTFOLIO, dateFrom: '2026-10-07', count: -6 }])
    expect(await db.getCandles('AAA.US')).toEqual(full['AAA.US'].map(([date, close]) => ({ date, close })))
    expect(b.calls.trades).toEqual(['2026-10-02'])
  })

  it('fetches candles for new ticker', async () => {
    const b = fakeBroker()
    b.series['DDD.US'] = [['2026-10-01', 20], ['2026-10-12', 21], ['2026-10-13', 22]]
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-13')
    b.calls.hlocDaily.length = 0
    const ps = clone(fx.getPositionJson.result.ps)
    ps.pos.push({ i: 'DDD.US', name: 'Delta', q: 2, mkt_price: 22, market_value: 44 })
    await repo.applyPortfolio(ps)
    expect((await db.getKv('positions')).data.rawPs.pos).toHaveLength(4)
    await repo.ensurePrices('7d', '2026-10-13')
    expect(b.calls.hlocDaily).toEqual([
      { tickers: PORTFOLIO, dateFrom: '2026-10-12', count: -6 },
      { tickers: ['DDD.US'], dateFrom: '2026-09-26', count: -6 },
    ])
    expect((await db.getCandles('DDD.US')).map((c) => c.close)).toEqual([20, 21, 22])
    const core = repo.coreFor('7d', '2026-10-13')
    expect(core.summary.missing).toBe('')
    expect(core.positions.find((p) => p.ticker === 'DDD.US').value).toBe(44)
  })

  it('longer period refetches trades and backfills candles', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.ensurePrices('1d', '2026-10-13') // start 10-12, trades from 10-08
    await repo.ensurePrices('1m', '2026-10-13') // start 09-13
    expect(b.calls.trades).toEqual(['2026-10-08', '2026-09-13'])
    expect(b.calls.hlocDaily.map((c) => c.dateFrom)).toEqual(['2026-10-02', '2026-09-03'])
    await repo.ensurePrices('7d', '2026-10-13')
    expect(b.calls.trades).toHaveLength(2)
    expect(b.calls.hlocDaily.at(-1).dateFrom).toBe('2026-10-12')
  })

  // --- Task 31: release-safe cache, immutable history, split check
  it('kv rows of another cache version are refetched at once, TTL ignored', async () => {
    const b = fakeBroker()
    await createRepo({ broker: b, db: await oldDb(), now: () => clock }).load() // previous release
    expect([...counts(b), sparkCalls(b).length]).toEqual([1, 1, 1, 1])
    clock += 30e3 // every row still within its TTL
    await mk(b).load()
    expect([...counts(b), sparkCalls(b).length]).toEqual([2, 2, 2, 2])
    clock += 30e3
    await mk(b).load() // rows of this version: cached again
    expect([...counts(b), sparkCalls(b).length]).toEqual([2, 2, 2, 2])
  })

  it('candles of another cache version are downloaded again once, stale rows purged', async () => {
    const b = fakeBroker()
    const old = await oldDb()
    await createRepo({ broker: b, db: old, now: () => clock }).ensurePrices('7d', '2026-10-13')
    await old.putCandles('AAA.US', [{ date: '2026-01-02', close: 1 }])
    b.calls.hlocDaily.length = 0
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-13')
    expect(b.calls.hlocDaily).toEqual([{ tickers: PORTFOLIO, dateFrom: '2026-09-26', count: -6 }])
    expect(await db.getCandles('AAA.US')).toEqual(asCandles(b.series['AAA.US']))
    expect(await old.getCandles('AAA.US')).toEqual([]) // old-format rows deleted, not just hidden
    expect(repo.coreFor('7d', '2026-10-13')).not.toBeNull()
    b.calls.hlocDaily.length = 0
    await mk(b).ensurePrices('7d', '2026-10-13')
    expect(b.calls.hlocDaily).toEqual([{ tickers: PORTFOLIO, dateFrom: '2026-10-12', count: -6 }])
  })

  it('top-up re-requests the last 2 stored days and overwrites them (no full refetch)', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-13')
    // 10-12 revised slightly, 10-13 was partial: both differ from what is stored.
    b.series = Object.fromEntries(Object.entries(b.series).map(([t, rows]) => [t,
      scale(scale(rows, 1.002, (d) => d === '2026-10-12'), 1.1, (d) => d === '2026-10-13')]))
    b.calls.hlocDaily.length = 0
    await repo.ensurePrices('7d', '2026-10-13')
    expect(b.calls.hlocDaily).toEqual([{ tickers: PORTFOLIO, dateFrom: '2026-10-12', count: -6 }])
    for (const t of PORTFOLIO) expect(await db.getCandles(t)).toEqual(asCandles(b.series[t]))
  })

  it('split: an adjusted earliest overlapping close drops the ticker and downloads it again in one request', async () => {
    const b = fakeBroker()
    await mk(b).ensurePrices('7d', '2026-10-13') // covered from 09-26
    await db.putCandles('AAA.US', [{ date: '2026-09-28', close: 99 }]) // stored day the new answer lacks
    b.series['AAA.US'] = scale(b.series['AAA.US'], 0.5) // 2:1 split
    b.series['CCC_KZ.KZ'] = scale(b.series['CCC_KZ.KZ'], 3) // 1:3 reverse split, KZ calendar
    b.calls.hlocDaily.length = 0
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-13')
    expect(b.calls.hlocDaily).toEqual([
      { tickers: PORTFOLIO, dateFrom: '2026-10-12', count: -6 },
      { tickers: ['AAA.US', 'CCC_KZ.KZ'], dateFrom: '2026-09-26', count: -6 },
    ])
    expect(await db.getCandles('AAA.US')).toEqual(asCandles(b.series['AAA.US']))
    expect(await db.getCandles('CCC_KZ.KZ')).toEqual(asCandles(b.series['CCC_KZ.KZ']))
    expect((await db.getKv('candleCover')).data).toMatchObject({ 'AAA.US': '2026-09-26', 'CCC_KZ.KZ': '2026-09-26' })
    expect(repo.coreFor('7d', '2026-10-13')).not.toBeNull()
  })

  it('split check: within 0.5% keeps the history; a single stored day is never compared', async () => {
    const b = fakeBroker()
    b.series['SPY.US'] = [['2026-10-13', 520]] // one stored day only
    await mk(b).ensurePrices('7d', '2026-10-13')
    await db.putCandles('AAA.US', [{ date: '2026-09-28', close: 99 }])
    b.series['AAA.US'] = scale(b.series['AAA.US'], 1.004)
    b.series['SPY.US'] = [['2026-10-13', 260]]
    b.calls.hlocDaily.length = 0
    await mk(b).ensurePrices('7d', '2026-10-13')
    expect(b.calls.hlocDaily).toEqual([{ tickers: PORTFOLIO, dateFrom: '2026-10-12', count: -6 }])
    expect(await db.getCandles('AAA.US')).toEqual([{ date: '2026-09-28', close: 99 }, ...asCandles(b.series['AAA.US'])])
    expect(await db.getCandles('SPY.US')).toEqual([{ date: '2026-10-13', close: 260 }])
  })

  it('split on a longer-period backfill: the answer already reaches back, no extra request', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-13')
    await db.putCandles('AAA.US', [{ date: '2026-09-28', close: 99 }])
    b.series['AAA.US'] = scale(b.series['AAA.US'], 0.5)
    b.calls.hlocDaily.length = 0
    const r2 = mk(b)
    await r2.ensurePrices('1m', '2026-10-13') // start 09-13: everything from 09-03
    expect(b.calls.hlocDaily).toEqual([{ tickers: PORTFOLIO, dateFrom: '2026-09-03', count: -6 }])
    expect(await db.getCandles('AAA.US')).toEqual(asCandles(b.series['AAA.US']))
    expect((await db.getKv('candleCover')).data['AAA.US']).toBe('2026-09-03')
  })

  it('refresh failure keeps cached data and reports error', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.load()
    let st
    repo.subscribe((s) => { st = s })
    b.fail.positions = new BrokerError('Broker is down', { code: 1 })
    clock += 100e3
    await repo.refresh()
    expect(st.errors.positions).toBe('Broker is down')
    expect(st.positions).toHaveLength(4)
    expect(st.updatedAt).toBe(T0)
    expect((await db.getKv('positions')).data.rows).toHaveLength(4)
    expect(st.loading).toEqual([])
    delete b.fail.positions
    await repo.refresh({ force: true, only: ['positions'] })
    expect(st.errors.positions).toBeUndefined()
  })

  it('incomplete cash flows are kept and reported in errors.cashflows', async () => {
    const b = fakeBroker()
    const base = b.cashflows
    b.cashflows = async () => ({ ...(await base()), total: 900, complete: false })
    const repo = mk(b)
    let st
    repo.subscribe((s) => { st = s })
    await repo.load()
    expect(st.cashflows).toHaveLength(4)
    expect(st.inception).toBe('2026-09-09')
    expect(st.errors.cashflows).toMatch(/incomplete/i)
    b.cashflows = base
    await repo.refresh({ force: true, only: ['cashflows'] })
    expect(st.errors.cashflows).toBeUndefined()
  })

  it('keeps cache on session expiry', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-13')
    const expired = vi.fn()
    repo.onSessionExpired(expired)
    let st
    repo.subscribe((s) => { st = s })
    b.fail.positions = b.fail.cashflows = b.fail.trades = new SessionExpiredError()
    clock += 3600e3
    await repo.refresh()
    expect(expired).toHaveBeenCalledTimes(1)
    expect(st.positions).toHaveLength(4)
    expect(st.cashflows).toHaveLength(4)
    expect(st.trades).toHaveLength(1)
    expect((await db.getKv('positions')).data.rows).toHaveLength(4)
    // A longer period needs older trades; that fetch fails, so candles are not requested.
    b.calls.hlocDaily.length = 0
    await repo.ensurePrices('1m', '2026-10-13')
    expect(b.calls.trades.at(-1)).toBe('2026-09-13')
    expect(b.calls.hlocDaily).toEqual([])
    expect(await db.getCandles('SPY.US')).toHaveLength(7)
  })

  it('coreFor matches direct computeCore on synthetic data', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.ensurePrices('7d', '2026-10-12') // start 10-05 = fixture window
    const positions = parsePositions({ answer: fx.getPositionJson }).rows
    const trades = parseTrades({ answer: fx.getTradesHistory }).rows
    const cashflows = parseCashflows({ answer: fx.getUserCashFlows }).rows
    const prices = parsePricesForPeriod({ answer: fx['getHloc.daily'], args: { date_from: fx._meta.windowStart } }, SRV3).rows
    const direct = computeCore(positions, trades, cashflows, prices)
    expect(direct.summary.twr).toBe(7.58)
    expect(repo.coreFor('7d', '2026-10-12')).toEqual(direct)

    const quotes = new Map([['SPY.US', { ltp: 530 }], ['AAA.US', { ltp: 112 }]])
    expect(repo.coreFor('7d', '2026-10-12', quotes))
      .toEqual(computeCore(positions, trades, cashflows, livePriceRows(prices, quotes, '2026-10-12')))

    // A new repo over the same cache computes the same without network.
    const b2 = fakeBroker()
    const repo2 = mk(b2)
    await repo2.load()
    expect([b2.calls.positions, b2.calls.cashflows, b2.calls.trades.length]).toEqual([0, 0, 0])
    expect(repo2.coreFor('7d', '2026-10-12')).toEqual(direct)
  })

  it('coreFor returns null before the cache is loaded', async () => {
    const repo = mk(fakeBroker())
    await repo.ensurePrices('7d', '2026-10-12')
    expect(repo.coreFor('7d', '2026-10-12')).not.toBeNull() // (c) fully covered
    const repo2 = mk(fakeBroker())
    expect(repo2.coreFor('7d', '2026-10-12')).toBeNull()
    await repo2.load()
    expect(repo2.coreFor('7d', '2026-10-12').summary.twr).toBe(7.58)
  })

  it('coreFor returns null after an offline switch to a longer period', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.ensurePrices('1d', '2026-10-13') // trades from 10-08, candles from 10-02
    expect(repo.coreFor('1d', '2026-10-13')).not.toBeNull()
    expect(repo.coreFor('1m', '2026-10-13')).toBeNull() // needs trades and closes from 09-13
    expect(repo.coreFor('1d', '2026-10-11')).toBeNull() // closes cover 10-10, trades needed from 10-06
    // Trades cover the period but a new position has no candles yet.
    const ps = clone(fx.getPositionJson.result.ps)
    ps.pos.push({ i: 'DDD.US', name: 'Delta', q: 2, mkt_price: 22, market_value: 44 })
    await repo.applyPortfolio(ps)
    expect(repo.coreFor('1d', '2026-10-13')).toBeNull()
  })

  it('coreFor returns null after trades but before candles land', async () => {
    const b = fakeBroker()
    const hloc = b.hlocDaily
    let release
    const gate = new Promise((r) => { release = r })
    b.hlocDaily = async (...a) => { await gate; return hloc(...a) }
    const repo = mk(b)
    let st
    repo.subscribe((s) => { st = s })
    const done = repo.ensurePrices('7d', '2026-10-12')
    await vi.waitFor(() => expect(st.loading).toContain('candles'))
    expect(st.trades).toHaveLength(1)
    expect(repo.coreFor('7d', '2026-10-12')).toBeNull()
    release()
    await done
    expect(repo.coreFor('7d', '2026-10-12').summary.twr).toBe(7.58)
  })

  it('1d with no session after start shifts base using closes before start', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    await repo.ensurePrices('1d', '2026-10-14') // start 10-13, no candle after it yet
    const core = repo.coreFor('1d', '2026-10-14')
    expect(core.summary.base_close).toBe('2026-10-12')
    expect(core.summary.day_date).toBe('2026-10-13')
    const prices = parsePricesForPeriod({ answer: fx['getHloc.daily'], args: { date_from: '13.10.2026 00:00' } }, SRV3).rows
    expect(core).toEqual(computeCore(
      parsePositions({ answer: fx.getPositionJson }).rows,
      parseTrades({ answer: fx.getTradesHistory }).rows,
      parseCashflows({ answer: fx.getUserCashFlows }).rows,
      prices,
    ))
  })

  it('markets strip from daily and intraday candles', async () => {
    const b = fakeBroker()
    b.series['SP500.IDX'] = [['2026-10-09', 6000], ['2026-10-12', 6060]]
    const repo = mk(b)
    let st
    repo.subscribe((s) => { st = s })
    await repo.load()
    expect(b.calls.hlocDaily).toEqual([{ tickers: STRIP, dateFrom: '2026-10-02', count: -1 }])
    expect(stripIntraday(b)).toEqual([{ tickers: STRIP, dateFrom: '2026-10-06', dateTo: '2026-10-13', timeframe: 15 }])
    expect(repo.marketsStrip()[0]).toMatchObject({ ticker: 'SP500.IDX', last: 6060, prev: 6000, change_pct: 1 })
    expect(st.markets).toEqual(repo.marketsStrip())
  })

  describe('custom markets strip', () => {
    const mkStrip = (b, strip) => { b.now = () => clock; return createRepo({ broker: b, db, now: () => clock, strip }) }
    const stripDaily = (b) => b.calls.hlocDaily.filter((c) => c.count === -1)

    it('fetches the session index and the strip tickers; rows for each of them', async () => {
      const b = fakeBroker()
      b.series['SP500.IDX'] = [['2026-10-09', 6000], ['2026-10-12', 6060]]
      const repo = mkStrip(b, ['GLD.US', 'AAA.US'])
      let st
      repo.subscribe((s) => { st = s })
      await repo.load()
      expect(stripDaily(b).map((c) => c.tickers)).toEqual([['SP500.IDX', 'GLD.US', 'AAA.US']])
      expect(stripIntraday(b).map((c) => c.tickers)).toEqual([['SP500.IDX', 'GLD.US', 'AAA.US']])
      expect(repo.marketsStrip().map((r) => r.ticker)).toEqual(['SP500.IDX', 'GLD.US', 'AAA.US'])
      expect(repo.marketsStrip().find((r) => r.ticker === 'AAA.US').last).not.toBeNull()
      expect(st.strip).toEqual(['GLD.US', 'AAA.US'])
    })

    it('a new ticker is fetched at once, a removed one is not requested again; reordering fetches nothing', async () => {
      const b = fakeBroker()
      const repo = mkStrip(b, ['GLD.US', 'AAA.US'])
      let st
      repo.subscribe((s) => { st = s })
      await repo.load()
      expect(stripDaily(b)).toHaveLength(1)
      await repo.setStrip(['AAA.US', 'GLD.US'])
      await repo.setStrip(['GLD.US'])
      expect(stripDaily(b)).toHaveLength(1)
      expect(st.strip).toEqual(['GLD.US'])
      await repo.setStrip(['GLD.US', 'BBB.US'])
      expect(stripDaily(b).map((c) => c.tickers)).toEqual([['SP500.IDX', 'GLD.US', 'AAA.US'], ['SP500.IDX', 'GLD.US', 'BBB.US']])
      expect(stripIntraday(b).at(-1).tickers).toEqual(['SP500.IDX', 'GLD.US', 'BBB.US'])
      expect(repo.marketsStrip().map((r) => r.ticker)).toEqual(['SP500.IDX', 'GLD.US', 'BBB.US'])
      expect(st.strip).toEqual(['GLD.US', 'BBB.US'])
    })

    it('a ticker added while the strip is being fetched is fetched right after', async () => {
      const b = fakeBroker()
      const repo = mkStrip(b, ['GLD.US'])
      const loading = repo.load()
      await vi.waitFor(() => expect(stripDaily(b)).toHaveLength(1))
      const set = repo.setStrip(['GLD.US', 'BBB.US'])
      await Promise.all([loading, set])
      expect(stripDaily(b).at(-1).tickers).toEqual(['SP500.IDX', 'GLD.US', 'BBB.US'])
    })

    it('an empty strip still fetches the session index (the app\'s trading date)', async () => {
      const b = fakeBroker()
      await mkStrip(b, []).load()
      expect(stripDaily(b).map((c) => c.tickers)).toEqual([['SP500.IDX']])
    })

    it('a cached strip from before the setting counts as the default set', async () => {
      const b = fakeBroker()
      await mk(b).load()
      const { data } = await db.getKv('markets')
      delete data.tickers
      await db.putKv('markets', data, clock)
      const repo = mk(b)
      await repo.load()
      expect(stripDaily(b)).toHaveLength(1)
      expect(repo.marketsStrip().map((r) => r.ticker)).toEqual(STRIP)
    })

    it('an unknown ticker does not break the strip: its row is empty, no error, and it is skipped later', async () => {
      const b = fakeBroker()
      b.series['SP500.IDX'] = [['2026-10-09', 6000], ['2026-10-12', 6060]]
      b.unknown.add('BAD.US')
      const repo = mkStrip(b, ['SP500.IDX', 'BAD.US', 'AAA.US'])
      let st
      repo.subscribe((s) => { st = s })
      await repo.load()
      expect(st.errors.markets).toBeUndefined()
      const rows = repo.marketsStrip()
      expect(rows.map((r) => r.ticker)).toEqual(['SP500.IDX', 'BAD.US', 'AAA.US'])
      expect(rows[0]).toMatchObject({ last: 6060, prev: 6000 })
      expect(rows[1]).toMatchObject({ last: null, change_pct: null })
      expect(rows[2].last).not.toBeNull()
      const before = stripDaily(b).length
      clock += TTL_MARKETS
      await repo.refresh({ only: ['markets'] })
      const again = stripDaily(b).slice(before)
      expect(again.map((c) => c.tickers)).toEqual([['SP500.IDX', 'AAA.US']])
      expect(repo.marketsStrip().map((r) => r.ticker)).toEqual(['SP500.IDX', 'BAD.US', 'AAA.US'])
    })

    it('a strip request failing for every ticker is an error and keeps the cache', async () => {
      const b = fakeBroker()
      const repo = mkStrip(b, ['GLD.US'])
      await repo.load()
      b.unknown.add('SP500.IDX').add('GLD.US')
      clock += TTL_MARKETS
      let st
      repo.subscribe((s) => { st = s })
      await repo.refresh({ only: ['markets'] })
      expect(st.errors.markets).toBeTruthy()
      expect(repo.marketsStrip().map((r) => r.ticker)).toEqual(['SP500.IDX', 'GLD.US'])
    })
  })

  it('findTickers: tickerFinder results as {ticker, name, market}; currency pairs and rows without a ticker dropped', async () => {
    const b = fakeBroker()
    b.finder = [
      { t: 'GLD.US', nm: 'Gold Trust', mkt: 'FIX', type: 1, kind: 7 },
      { t: 'EUR/USD', nm: 'Euro', mkt: 'FX' },
      { nm: 'No ticker' },
      { t: 'KKK.KZ', n: 'Kappa', mkt: 'KASE' },
      { t: 'ZZZ.US' },
    ]
    const repo = mk(b)
    expect(await repo.findTickers('  gold ')).toEqual([
      { ticker: 'GLD.US', name: 'Gold Trust', market: 'FIX' },
      { ticker: 'KKK.KZ', name: 'Kappa', market: 'KASE' },
      { ticker: 'ZZZ.US', name: 'ZZZ.US', market: '' },
    ])
    expect(b.calls.finder).toEqual(['gold'])
    expect(await repo.findTickers('   ')).toEqual([])
    expect(b.calls.finder).toEqual(['gold'])
  })

  it('position sparks: one multi-ticker 15-min request for the positions, day sparks in state', async () => {
    const b = fakeBroker()
    b.intraday = {
      'SP500.IDX': [['2026-10-09', '09:30', 1], ['2026-10-09', '15:45', 1], ['2026-10-12', '09:30', 1], ['2026-10-12', '15:45', 1]],
      'AAA.US': [['2026-10-09', '10:00', 7], ['2026-10-12', '09:30', 8], ['2026-10-12', '15:45', 9], ['2026-10-12', '17:00', 10]],
      'CCC_KZ.KZ': [['2026-10-12', '11:30', 3], ['2026-10-13', '11:30', 4], ['2026-10-13', '11:45', 5]],
    }
    const repo = mk(b)
    let st
    repo.subscribe((s) => { st = s })
    await repo.load()
    // Positions only (cash rows skipped), sorted; the same window as the markets strip.
    expect(sparkCalls(b)).toEqual([{ tickers: ['AAA.US', 'BBB.US', 'CCC_KZ.KZ'], dateFrom: '2026-10-06', dateTo: '2026-10-13', timeframe: 15 }])
    expect(st.sparks['AAA.US']).toEqual({ date: '2026-10-12', spark: [8, 9] }) // US: S&P 500 session, regular hours
    expect(st.sparks['CCC_KZ.KZ']).toEqual({ date: '2026-10-13', spark: [4, 5] }) // KZ: its own last session
    expect(st.sparks['BBB.US']).toBeUndefined()
    expect((await db.getKv('sparks')).data.tickers).toEqual(['AAA.US', 'BBB.US', 'CCC_KZ.KZ'])
  })

  it('position sparks: cached with a 5-minute TTL, refetched when the positions change', async () => {
    const b = fakeBroker()
    await mk(b).load()
    expect(sparkCalls(b)).toHaveLength(1)
    clock += 100e3 // positions and markets stale, sparks fresh
    let repo = mk(b)
    await repo.load()
    expect(counts(b)).toEqual([2, 1, 2])
    expect(sparkCalls(b)).toHaveLength(1)
    clock += 200e3 // 5 min since the first fetch
    repo = mk(b)
    await repo.load()
    expect(sparkCalls(b)).toHaveLength(2)

    const ps = clone(fx.getPositionJson.result.ps)
    ps.pos.push({ i: 'DDD.US', name: 'Delta', q: 2, mkt_price: 22, market_value: 44 })
    await repo.applyPortfolio(ps)
    await repo.refresh()
    expect(sparkCalls(b)).toHaveLength(3)
    expect(sparkCalls(b).at(-1).tickers).toEqual(['AAA.US', 'BBB.US', 'CCC_KZ.KZ', 'DDD.US'])
  })

  it('position sparks: a failure is reported and keeps the cached sparks', async () => {
    const b = fakeBroker()
    b.intraday = { 'AAA.US': [['2026-10-12', '10:00', 1], ['2026-10-12', '10:15', 2]] }
    const repo = mk(b)
    let st
    repo.subscribe((s) => { st = s })
    await repo.load()
    b.fail.hlocIntraday = new Error('Bad request')
    await repo.refresh({ force: true, only: ['sparks'] })
    expect(st.errors.sparks).toBe('Bad request')
    expect(st.sparks['AAA.US'].spark).toEqual([1, 2])
  })

  it('state.closes: cached daily closes per ticker (period sparks)', async () => {
    const b = fakeBroker()
    const repo = mk(b)
    let st
    repo.subscribe((s) => { st = s })
    await repo.ensurePrices('7d', '2026-10-13')
    expect(st.closes.get('AAA.US')).toEqual(await db.getCandles('AAA.US'))
  })

  it('getMarketStatus down: closes, portfolio numbers, markets strip and sparks still work, no error banner', async () => {
    const b = fakeBroker()
    b.fail.marketStatus = new BrokerError('Something wrong, service unavailable', { code: 14 })
    b.series['SP500.IDX'] = [['2026-10-09', 6000], ['2026-10-12', 6060]]
    b.intraday['SP500.IDX'] = [['2026-10-12', '09:30', 1], ['2026-10-12', '10:00', 2]]
    b.intraday['AAA.US'] = [['2026-10-12', '09:30', 5], ['2026-10-12', '10:00', 6]]
    const repo = mk(b)
    let st
    repo.subscribe((s) => { st = s })
    await repo.ensurePrices('7d', '2026-10-12')
    const direct = computeCore(parsePositions({ answer: fx.getPositionJson }).rows, parseTrades({ answer: fx.getTradesHistory }).rows,
      parseCashflows({ answer: fx.getUserCashFlows }).rows,
      parsePricesForPeriod({ answer: fx['getHloc.daily'], args: { date_from: fx._meta.windowStart } }, SRV3).rows)
    expect(repo.coreFor('7d', '2026-10-12')).toEqual(direct)
    await repo.refresh()
    expect(st.markets[0].date).toBe('2026-10-12')
    expect(st.sparks['AAA.US'].spark).toEqual([5, 6])
    expect(st.errors).toEqual({})
  })

  it('a device clock 8 min fast does not move candle dates (offset from the daily bars)', async () => {
    const b = fakeBroker()
    b.now = () => clock // broker time is true time
    const repo = createRepo({ broker: b, db, now: () => clock + 8 * 60e3 })
    await repo.refresh({ only: ['clock'] }) // status read with the skewed clock
    await repo.ensurePrices('7d', '2026-10-12')
    const prices = parsePricesForPeriod({ answer: fx['getHloc.daily'], args: { date_from: fx._meta.windowStart } }, SRV3).rows
    expect(repo.coreFor('7d', '2026-10-12')).toEqual(computeCore(parsePositions({ answer: fx.getPositionJson }).rows,
      parseTrades({ answer: fx.getTradesHistory }).rows, parseCashflows({ answer: fx.getUserCashFlows }).rows, prices))
  })

  it('today = trading date of the session index market, from the broker status (no fixed zone)', async () => {
    clock = Date.parse('2026-10-31T02:30:00Z') // 22:30 on 10-30 in New York, already 10-31 on the server
    const b = fakeBroker()
    b.intraday['SP500.IDX'] = [['2026-10-30', '09:30', 1]]
    const repo = mk(b)
    await repo.refresh({ only: ['markets'] })
    expect(b.calls.marketStatus).toBe(1)
    expect(repo.today()).toBe('2026-10-30')
    expect(repo.today(Date.parse('2026-10-31T04:30:00Z'))).toBe('2026-10-31')
    await repo.ensurePrices('7d')
    expect(b.calls.trades).toEqual(['2026-10-23'])
    expect(b.calls.hlocDaily.filter((c) => c.tickers[0] !== STRIP[0])[0].dateFrom).toBe('2026-10-13')
    expect(b.calls.marketStatus).toBe(1) // the clock is cached
  })
})

describe('useApp + repo: closes after the session', () => {
  it('live -> not live on the same NY day re-requests the last stored closes', async () => {
    const db = await openAccountDb('global:1', new IDBFactory())
    const b = fakeBroker()
    const full = b.series
    // During the session the broker's 10-12 candle is partial.
    b.series = Object.fromEntries(Object.entries(full).map(([t, rows]) => [
      t, rows.filter(([d]) => d <= '2026-10-12').map(([d, c]) => [d, d === '2026-10-12' ? c - 1 : c]),
    ]))
    let live = false
    let onUpdate = null
    const app = createAppState({
      createBroker: () => b,
      openAccountDb: async () => db,
      createRepo: ({ broker, db: d }) => createRepo({ broker, db: d, now: () => T0 }),
      createLive: () => ({
        quotes: new Map(), isLive: () => live, marketsOpen: () => ({ us: live }),
        on: (e, fn) => { if (e === 'update') onUpdate = fn; return () => {} },
        start() {}, stop() {}, pause() {}, resume() {},
      }),
      socketFactory: () => () => ({}),
      sessionStore: { load: () => ({ cabinetId: 'global', sid: 's', userId: 1, loggedAt: 0 }), save() {}, clear() {} },
      prefsStore: { load: () => ({ period: '7d' }), save() {} },
      setTimer: () => 1, clearTimer: () => {},
    })
    app.start()
    await vi.waitFor(() => expect(app.state.value?.positions && app.state.value.loading).toEqual([]))
    await app.ensurePrices('7d') // the screen's fetch during the session
    expect((await db.getCandles('AAA.US')).at(-1)).toEqual({ date: '2026-10-12', close: full['AAA.US'].find(([d]) => d === '2026-10-12')[1] - 1 })

    live = true
    onUpdate()
    b.calls.hlocDaily.length = 0
    b.series = Object.fromEntries(Object.entries(full).map(([t, rows]) => [t, rows.filter(([d]) => d <= '2026-10-12')]))
    live = false
    onUpdate() // the session closed
    await vi.waitFor(() => expect(b.calls.hlocDaily.map((c) => c.dateFrom)).toContain('2026-10-09'))
    await vi.waitFor(async () => expect((await db.getCandles('AAA.US')).at(-1)).toEqual({
      date: '2026-10-12', close: full['AAA.US'].find(([d]) => d === '2026-10-12')[1],
    }))
    app.stop()
  })
})
