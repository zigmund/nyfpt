// Data repository: cache-first state, TTL refresh, incremental daily candles.
//
// kv keys (per account, via AccountDb):
//   positions    {rows, rawPs}        parsePositions rows + raw `ps` (holdings)
//   cashflows    rows                 parseCashflows rows (whole history)
//   trades       {from, rows}         parseTrades rows since `from` (beginDate watermark)
//   markets      {daily, intraday}    parseHloc rows for MARKET_STRIP
//   sparks       {tickers, intraday}  parseHloc 15-min rows of the positions (holdings sparklines)
//   candleCover  {ticker: date}       earliest date_from requested per ticker
// Daily closes live in the `candles` store and are mirrored in memory so coreFor stays sync.
import {
  parsePositions, parseTrades, parseCashflows, parseHloc, computeCore, computeMarkets,
} from '../calc/portfolio.js'
import { periodStart, tradesFrom, inceptionFromCashflows } from '../calc/periods.js'
import { livePriceRows } from '../calc/live.js'
import { daySparks } from '../calc/sparks.js'
import { TTL, BENCHMARKS, MARKET_STRIP } from '../config.js'
import { SessionExpiredError } from '../api/transport.js'

const DATASETS = ['positions', 'cashflows', 'trades', 'markets', 'sparks']
const TTL_OF = {
  positions: TTL.positions, cashflows: TTL.cashflows, trades: TTL.trades, markets: TTL.intraday, sparks: TTL.sparks,
}
const AUTHED = new Set(['positions', 'cashflows', 'trades'])
const CLOSES_BEFORE = 6 // closes kept at or before the period start (getHloc count:-6)
const PAD_DAYS = 10 // first fetch of a ticker starts this many days before the period

const nyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
/** Calendar date in New York ('YYYY-MM-DD'): candle dates are US trading dates. */
export const nyDate = (ms) => nyFormat.format(new Date(ms))

const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isExpired = (e) => e instanceof SessionExpiredError
const psOf = (a) => (a && a.result && a.result.ps) || (a && a.ps) || null

export function createRepo({ broker, db, now = () => Date.now() }) {
  const cache = { positions: null, cashflows: null, trades: null, markets: null, sparks: null }
  const fetchedAt = {}
  const candles = new Map() // ticker -> [{date, close}] asc
  let cover = {}
  const errors = {}
  const inflight = new Map() // key -> promise (one per dataset / candle request)
  const pending = new Map() // ensurePrices calls by period+day
  const listeners = new Set()
  const expiredFns = new Set()
  let expiredNotified = false
  let cacheLoaded = null
  let loaded = false

  const today = () => nyDate(now())

  function marketsStrip() {
    return cache.markets ? computeMarkets(cache.markets.daily, cache.markets.intraday) : null
  }

  // Day sparks, recomputed only when their inputs change (state() runs on every emit).
  let sparksMemo = { src: undefined, mkts: undefined, value: null }
  function sparksState() {
    if (!cache.sparks) return null
    if (sparksMemo.src !== cache.sparks || sparksMemo.mkts !== cache.markets) {
      sparksMemo = { src: cache.sparks, mkts: cache.markets, value: daySparks(cache.sparks.intraday, cache.markets?.intraday) }
    }
    return sparksMemo.value
  }

  // Tickers of the open positions (currency pairs skipped), sorted.
  const positionTickers = () => [...new Set((cache.positions?.rows || [])
    .filter((r) => r.kind === 'position').map((r) => r.ticker))].filter((t) => !String(t).includes('/')).sort()
  // Cached sparks were fetched for a different set of positions.
  const sparksOutdated = () => !!cache.positions && !!cache.sparks
    && cache.sparks.tickers.join(',') !== positionTickers().join(',')

  // null = never loaded.
  function state() {
    return {
      positions: cache.positions ? cache.positions.rows : null,
      rawPs: cache.positions ? cache.positions.rawPs : null,
      trades: cache.trades ? cache.trades.rows : null,
      cashflows: cache.cashflows,
      markets: marketsStrip(),
      sparks: sparksState(), // {ticker: {date, spark}}: last-session 15-min closes
      closes: candles, // ticker -> [{date, close}] daily closes (period sparks)
      inception: inceptionFromCashflows(cache.cashflows),
      updatedAt: fetchedAt.positions ?? null,
      errors: { ...errors },
      loading: [...new Set([...inflight.keys()].map((k) => k.split(':')[0]))],
    }
  }
  const emit = () => {
    const s = state()
    for (const fn of listeners) fn(s)
  }

  function sessionExpired() {
    if (expiredNotified) return
    expiredNotified = true
    for (const fn of expiredFns) fn()
  }

  // One in-flight run per key. Resolves to null on success or the error (never rejects);
  // errors land in state.errors[name], the cache stays untouched.
  function task(key, name, fn) {
    if (inflight.has(key)) return inflight.get(key)
    const p = (async () => {
      try {
        await fn()
        delete errors[name]
        if (AUTHED.has(name)) expiredNotified = false
        return null
      } catch (e) {
        errors[name] = (e && e.message) || String(e)
        if (isExpired(e)) sessionExpired()
        return e
      } finally {
        inflight.delete(key)
        emit()
      }
    })()
    inflight.set(key, p)
    emit()
    return p
  }

  async function save(name, data) {
    const at = now()
    await db.putKv(name, data, at)
    cache[name] = data
    fetchedAt[name] = at
  }

  const fetchTrades = (from) => task('trades', 'trades', async () => {
    const rows = parseTrades({ answer: await broker.trades(from) }).rows
    await save('trades', { from, rows })
  })

  const fetchers = {
    async positions() {
      const a = await broker.positions()
      await save('positions', { rows: parsePositions({ answer: a }).rows, rawPs: psOf(a) })
    },
    async cashflows() {
      const a = await broker.cashflows()
      const rows = parseCashflows({ answer: a }).rows
      await save('cashflows', rows)
      // Keep what arrived but say so: inception and older periods may be off.
      if (a && a.complete === false) {
        throw new Error(`Cash flows incomplete: ${rows.length}${a.total != null ? ` of ${a.total}` : ''} rows`)
      }
    },
    async markets() {
      const t = today()
      const tickers = MARKET_STRIP.map((m) => m.ticker)
      const [d, i] = await Promise.all([
        broker.hlocDaily(tickers, addDays(t, -10), -1),
        broker.hlocIntraday(tickers, addDays(t, -6), addDays(t, 1), 15),
      ])
      await save('markets', { daily: parseHloc({ answer: d }).rows, intraday: parseHloc({ answer: i }).rows })
    },
    // One multi-ticker request for all positions; needs the positions, so waits for their fetch.
    // Nothing is saved without positions: the next refresh tries again.
    async sparks() {
      if (inflight.has('positions')) await inflight.get('positions')
      const tickers = positionTickers()
      if (!tickers.length) return
      const t = today()
      const a = await broker.hlocIntraday(tickers, addDays(t, -6), addDays(t, 1), 15)
      await save('sparks', { tickers, intraday: parseHloc({ answer: a }).rows })
    },
  }

  function refreshOne(name) {
    // Trades are refreshed only once a period has set the watermark (ensurePrices).
    if (name === 'trades') return cache.trades ? fetchTrades(cache.trades.from) : Promise.resolve(null)
    return task(name, name, fetchers[name])
  }

  // Make sure cached trades start at or before `tf`; a longer period refetches from earlier.
  async function ensureTrades(tf) {
    while (!cache.trades || tf < cache.trades.from) {
      if (!inflight.has('trades')) return fetchTrades(tf)
      const e = await inflight.get('trades')
      if (e) return e
    }
    return null
  }

  function loadCache() {
    cacheLoaded ||= (async () => {
      for (const name of DATASETS) {
        const kv = await db.getKv(name)
        if (kv) { cache[name] = kv.data; fetchedAt[name] = kv.fetchedAt }
      }
      cover = (await db.getKv('candleCover'))?.data || {}
      for (const t of Object.keys(cover)) candles.set(t, await db.getCandles(t))
      loaded = true
    })()
    return cacheLoaded
  }

  const startOf = (period, day) => periodStart(period, day, inceptionFromCashflows(cache.cashflows))

  // Positions ∪ tickers traded since `tf` ∪ benchmarks; currency pairs skipped.
  const tickersFor = (tf) => [...new Set([
    ...(cache.positions?.rows || []).filter((r) => r.kind === 'position').map((r) => r.ticker),
    ...(cache.trades?.rows || []).filter((t) => t.date >= tf).map((t) => t.ticker),
    ...BENCHMARKS,
  ])].filter((t) => !String(t).includes('/')).sort()

  function fetchCandles(tickers, from) {
    return task(`candles:${from}:${tickers.join(',')}`, 'candles', async () => {
      const rows = parseHloc({ answer: await broker.hlocDaily(tickers, from, -CLOSES_BEFORE) }).rows
      for (const t of tickers) {
        const own = rows.filter((r) => r.ticker === t).map(({ date, close }) => ({ date, close }))
        if (own.length) await db.putCandles(t, own)
        candles.set(t, await db.getCandles(t))
        if (!cover[t] || from < cover[t]) cover[t] = from
      }
      await db.putKv('candleCover', { ...cover }, now())
    })
  }

  async function doEnsurePrices(period, day) {
    await loadCache()
    for (const name of ['cashflows', 'positions']) {
      if (!cache[name] && isExpired(await refreshOne(name))) return
    }
    const start = startOf(period, day)
    if (!start) return // 'All' without any cashflows: nothing to price
    const tf = tradesFrom(period, start)
    if (isExpired(await ensureTrades(tf))) return
    // Incremental from the last cached date (it is re-fetched: the current day may be partial);
    // tickers not covered back to `start` are fetched from start - PAD_DAYS.
    const groups = new Map()
    for (const t of tickersFor(tf)) {
      const last = await db.lastCandleDate(t)
      const from = last && cover[t] && cover[t] <= start ? last : addDays(start, -PAD_DAYS)
      if (!groups.has(from)) groups.set(from, [])
      groups.get(from).push(t)
    }
    await Promise.all([...groups].map(([from, ts]) => fetchCandles(ts, from)))
  }

  /** Price rows for computeCore: per ticker the last 6 closes <= start and all after it.
   *  null when the cache does not cover the period: not loaded, no positions/cashflows,
   *  trades start after tradesFrom, or a required ticker's closes start after `start`. */
  function priceRows(period, day) {
    if (!loaded || !cache.positions || !cache.cashflows) return null
    const start = startOf(period, day)
    if (!start) return null // 'All' without any cashflows
    const tf = tradesFrom(period, start)
    if (!cache.trades || cache.trades.from > tf) return null
    const out = []
    for (const t of tickersFor(tf)) {
      if (!cover[t] || cover[t] > start) return null
      const cs = candles.get(t) || []
      let cut = cs.findIndex((c) => c.date > start)
      if (cut < 0) cut = cs.length
      for (const c of cs.slice(Math.max(0, cut - CLOSES_BEFORE))) {
        out.push({ ticker: t, date: c.date, close: c.close, window_start: start })
      }
    }
    return out
  }

  async function refresh({ force = false, only } = {}) {
    await loadCache()
    const names = (only || DATASETS).filter((n) => DATASETS.includes(n))
    const due = names.filter((n) => force || fetchedAt[n] == null || now() - fetchedAt[n] >= TTL_OF[n]
      || (n === 'sparks' && sparksOutdated()))
    await Promise.all(due.map(refreshOne))
  }

  return {
    subscribe(fn) {
      listeners.add(fn)
      fn(state())
      return () => listeners.delete(fn)
    },

    onSessionExpired(fn) {
      expiredFns.add(fn)
      return () => expiredFns.delete(fn)
    },

    /** Cached state first, then refresh whatever is past its TTL. */
    async load() {
      await loadCache()
      emit()
      await refresh()
    },

    refresh,

    ensurePrices(period, day = today()) {
      const key = `${period}|${day}`
      if (!pending.has(key)) {
        pending.set(key, doEnsurePrices(period, day).finally(() => pending.delete(key)))
      }
      return pending.get(key)
    },

    /**
     * computeCore over the cache, synchronous; with `quotes` the `day` close is replaced by
     * live prices. Returns null when the cache does not cover the period (not loaded yet,
     * trades or closes not fetched back far enough, e.g. an offline switch to a longer
     * period or ensurePrices still running): the UI shows a skeleton / "unavailable".
     */
    coreFor(period, day = today(), quotes) {
      let prices = priceRows(period, day)
      if (!prices) return null
      if (quotes) prices = livePriceRows(prices, quotes, day)
      return computeCore(cache.positions.rows, cache.trades.rows, cache.cashflows, prices)
    },

    marketsStrip,

    /** Positions pushed by the WS `portfolio` event (raw `ps`). */
    async applyPortfolio(ps) {
      await loadCache()
      try {
        await save('positions', { rows: parsePositions({ answer: { ps } }).rows, rawPs: ps })
        delete errors.positions
      } catch (e) {
        errors.positions = (e && e.message) || String(e)
      }
      emit()
    },
  }
}
