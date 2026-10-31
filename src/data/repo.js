// Data repository: cache-first state, TTL refresh, incremental daily candles.
//
// kv keys (per account, via AccountDb):
//   clock        {t, m, at}           getMarketStatus snapshot + local receive time (optional fallback)
//   marketInfo   {offset, markets}    server offset (daily bars) and market hours (getHloc info), marketTime.js
//   positions    {rows, rawPs}        parsePositions rows + raw `ps` (holdings)
//   cashflows    rows                 parseCashflows rows (whole history)
//   trades       {from, rows}         parseTrades rows since `from` (beginDate watermark)
//   markets      {daily, intraday}    parseHloc rows for MARKET_STRIP
//   sparks       {tickers, intraday}  parseHloc 15-min rows of the positions (holdings sparklines)
//   candleCover  {ticker: date}       earliest date_from requested per ticker
// Daily closes live in the `candles` store and are mirrored in memory so coreFor stays sync.
// Rows of another CACHE_VERSION read as missing (store/db.js) and are purged on the first load.
// Candle history has no TTL: a top-up re-requests the last 2 stored days (the newest may have been
// saved before its session closed) and checks the oldest overlapping stored close for a split.
// Position card data (security info, full candles per ticker) is kept in memory only, TTL-gated.
import {
  parsePositions, parseTrades, parseCashflows, parseHloc, computeCore, computeMarkets,
} from '../calc/portfolio.js'
import { periodStart, tradesFrom, inceptionFromCashflows } from '../calc/periods.js'
import { livePriceRows } from '../calc/live.js'
import { daySparks } from '../calc/sparks.js'
import { dailyOffset, hlocMarkets, marketClock, marketClockFor, marketDay } from '../calc/marketTime.js'
import { candleZone, parseCandles, sessionBounds } from '../calc/position.js'
import { TTL, BENCHMARKS, MARKET_STRIP } from '../config.js'
import { SessionExpiredError } from '../api/transport.js'

/** Dataset names: kv rows and state.errors / state.loading keys (one source for components). */
export const DATASET = Object.freeze({
  clock: 'clock', positions: 'positions', cashflows: 'cashflows', trades: 'trades', markets: 'markets', sparks: 'sparks',
  candles: 'candles',
})
const DATASETS = Object.values(DATASET).filter((n) => n !== DATASET.candles) // kv datasets
const TTL_OF = {
  clock: TTL.clock, positions: TTL.positions, cashflows: TTL.cashflows, trades: TTL.trades, markets: TTL.intraday, sparks: TTL.sparks,
}
const AUTHED = new Set(['positions', 'cashflows', 'trades'])
const CLOSES_BEFORE = 6 // closes kept at or before the period start (getHloc count:-6)
const PAD_DAYS = 10 // first fetch of a ticker starts this many days before the period
const REFETCH_DAYS = 2 // last stored days re-requested on every top-up
// Split / adjustment: a stored close off the broker's by more than this share (same day) means the
// broker rewrote the ticker's history; 0.5% is far above rounding and far below any split ratio.
const ADJUST_TOLERANCE = 0.005

// Position card datasets: TTL per part; daily reaches back far enough for 1Y, YTD and 52 weeks.
const SEC_TTL = { info: TTL.quotes, intraday: TTL.intraday, daily: 5 * 60e3, max: 60 * 60e3 }
const SEC_DAILY_DAYS = 400
const SEC_INTRADAY_DAYS = 8 // 5 sessions back, weekends and a holiday included
const SEC_MAX_FROM = '1990-01-01'
const SESSION_INDEX = 'SP500.IDX' // its intraday bars mark the regular US session

const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isExpired = (e) => e instanceof SessionExpiredError
const psOf = (a) => (a && a.result && a.result.ps) || (a && a.ps) || null

/** True when the broker's closes no longer match the stored history: the oldest stored day that
 *  the answer also has differs by more than ADJUST_TOLERANCE. The last REFETCH_DAYS stored days
 *  are never compared (possibly saved mid-session); with no older day there is nothing to check. */
function historyAdjusted(stored, fresh) {
  if (stored.length <= REFETCH_DAYS || !fresh.length) return false
  const got = new Map(fresh.map((c) => [c.date, c.close]))
  for (const c of stored.slice(0, stored.length - REFETCH_DAYS)) {
    if (!got.has(c.date)) continue // holiday on one side, or before the answer starts
    const b = Number(got.get(c.date))
    const a = Number(c.close)
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return false
    return Math.abs(a - b) > ADJUST_TOLERANCE * Math.abs(b)
  }
  return false
}

export function createRepo({ broker, db, now = () => Date.now() }) {
  const cache = { clock: null, positions: null, cashflows: null, trades: null, markets: null, sparks: null }
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

  // Market clock: server offset from daily candles and market hours from getHloc `info`
  // (`learned`, kv marketInfo); the getMarketStatus snapshot only fills what is not learned yet.
  let learned = { offset: null, markets: {} }
  let clockMemo = { st: undefined, ln: undefined, value: null }
  function clock() {
    if (clockMemo.st !== cache.clock || clockMemo.ln !== learned) {
      clockMemo = { st: cache.clock, ln: learned, value: marketClock(cache.clock, learned) }
    }
    return clockMemo.value
  }
  /** Learn from a getHloc answer (daily: the server offset too); persisted when it changes. */
  async function learn(answer, daily) {
    const off = daily ? dailyOffset(answer) : null
    const next = { offset: off ?? learned.offset, markets: { ...learned.markets, ...hlocMarkets(answer) } }
    if (JSON.stringify(next) === JSON.stringify(learned)) return
    learned = next
    await db.putKv('marketInfo', learned, now())
  }
  /** Clock for parsing a daily answer: its own bars give the server offset (no status needed). */
  const dailyClock = (a) => {
    const off = dailyOffset(a)
    return off === null ? clock() : { offset: off, markets: {} }
  }
  // Market of the session index (US); its trading date is the app's "today".
  const indexMarket = () => ((cache.markets?.intraday || []).find((r) => r.ticker === SESSION_INDEX && r.mkt) || {}).mkt || null
  const today = (ms = now()) => marketDay(marketClockFor(clock(), indexMarket()), ms)
  /** Clock for parsing intraday bars: learned / cached; else after a running markets fetch
   *  (it brings daily bars), else from getMarketStatus. Throws when none is available. */
  async function intradayClock({ waitMarkets = true } = {}) {
    let c = clock()
    if (!c && waitMarkets && inflight.has('markets')) { await inflight.get('markets'); c = clock() }
    if (!c) { await refreshOne('clock'); c = clock() }
    if (!c) throw new Error('No market time')
    return c
  }

  function marketsStrip() {
    return cache.markets ? computeMarkets(cache.markets.daily, cache.markets.intraday, clock(), today()) : null
  }

  // Day sparks, recomputed only when their inputs change (state() runs on every emit).
  let sparksMemo = { src: undefined, mkts: undefined, clk: undefined, day: undefined, value: null }
  function sparksState() {
    if (!cache.sparks) return null
    const day = today()
    const clk = clock()
    if (sparksMemo.src !== cache.sparks || sparksMemo.mkts !== cache.markets || sparksMemo.clk !== clk || sparksMemo.day !== day) {
      sparksMemo = {
        src: cache.sparks, mkts: cache.markets, clk, day,
        value: daySparks(cache.sparks.intraday, cache.markets?.intraday, clk, day),
      }
    }
    return sparksMemo.value
  }

  // Tickers of the open positions (currency pairs skipped), sorted.
  const positionTickers = () => [...new Set((cache.positions?.rows || [])
    .filter((r) => r.kind === 'position').map((r) => r.ticker))].filter((t) => !String(t).includes('/')).sort()
  // Cached sparks were fetched for a different set of positions.
  const sparksOutdated = () => !!cache.positions && !!cache.sparks
    && cache.sparks.tickers.join(',') !== positionTickers().join(',')

  // --- position card: per ticker {info, intraday, daily, max} + fetch times, errors, in-flight
  const sec = new Map()
  function secEntry(ticker) {
    let e = sec.get(ticker)
    if (!e) sec.set(ticker, (e = { info: null, intraday: null, daily: null, max: null, zone: null, at: {}, errors: {}, inflight: new Map() }))
    return e
  }
  // Candles of a card ticker; remembers its market and the broker's zone for it (getHloc `info`).
  async function cardCandles(tk, answerP, daily) {
    const a = await answerP()
    await learn(a, daily)
    const z = candleZone(a, tk)
    if (z.mkt) secEntry(tk).zone = z
    return parseCandles(a, tk, daily ? dailyClock(a) : await intradayClock())
  }
  const secFetchers = {
    async info(tk) {
      const a = await broker.securityInfo(tk)
      if (!a || typeof a !== 'object') throw new Error('No security info')
      return a
    },
    intraday(tk) {
      return cardCandles(tk, () => {
        const t = today()
        return broker.hlocIntraday([tk], addDays(t, -SEC_INTRADAY_DAYS), addDays(t, 1), 15)
      }, false)
    },
    daily(tk) {
      return cardCandles(tk, () => broker.hlocDaily([tk], addDays(today(), -SEC_DAILY_DAYS), -1), true)
    },
    max(tk) {
      return cardCandles(tk, () => broker.hlocDaily([tk], SEC_MAX_FROM, -1), true)
    },
  }

  /** Fetch the parts ('info' | 'intraday' | 'daily' | 'max') of a ticker that are past their TTL.
   *  Never rejects: errors land in security(ticker).errors[part], the old data stays. */
  function loadSecurity(ticker, parts = ['info', 'daily'], { force = false } = {}) {
    const e = secEntry(ticker)
    return Promise.all(parts.filter((p) => p in secFetchers).map((part) => {
      if (e.inflight.has(part)) return e.inflight.get(part)
      if (!force && e.at[part] != null && now() - e.at[part] < SEC_TTL[part]) return null
      const pr = (async () => {
        try {
          e[part] = await secFetchers[part](ticker)
          e.at[part] = now()
          delete e.errors[part]
        } catch (err) {
          e.errors[part] = (err && err.message) || String(err)
        } finally {
          e.inflight.delete(part)
          emit()
        }
      })()
      e.inflight.set(part, pr)
      emit()
      return pr
    })).then(() => {})
  }

  /** Synchronous snapshot of a ticker's card data (null = not loaded). `sessions`: index bars by
   *  date (sessionBounds over SP500.IDX) for tickers of the index's market; `clock`: the ticker
   *  market's clock (marketClockFor); `today`: that market's trading date. */
  function security(ticker) {
    const e = sec.get(ticker)
    const im = indexMarket()
    const mkt = e?.zone?.mkt || e?.info?.ltr || null
    const anchored = mkt && im ? String(mkt).toUpperCase() === String(im).toUpperCase() : String(ticker).endsWith('.US')
    const idx = anchored ? (cache.markets?.intraday || []).filter((r) => r.ticker === SESSION_INDEX) : []
    const mc = marketClockFor(clock(), mkt || (anchored ? im : null), { tz: e?.zone?.tz })
    return {
      info: e?.info ?? null,
      intraday: e?.intraday ?? null,
      daily: e?.daily ?? null,
      max: e?.max ?? null,
      sessions: anchored ? sessionBounds(idx) : null,
      clock: mc,
      today: marketDay(mc, now()),
      errors: { ...(e?.errors || {}) },
      loading: e ? [...e.inflight.keys()] : [],
    }
  }

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
    // Optional fallback: a failure is not an error (the candles carry the clock); retried on
    // the next refresh because nothing is saved.
    async clock() {
      try {
        const a = await broker.marketStatus()
        const m = a && a.result && a.result.markets
        const status = { t: m && m.t, m: (m && m.m) || [], at: now() }
        if (marketClock(status)) await save('clock', status)
      } catch {
        // optional: nothing saved, the next refresh tries again
      }
    },
    async markets() {
      const t = today()
      const tickers = MARKET_STRIP.map((m) => m.ticker)
      const [d, i] = await Promise.all([
        broker.hlocDaily(tickers, addDays(t, -10), -1),
        broker.hlocIntraday(tickers, addDays(t, -6), addDays(t, 1), 15),
      ])
      await learn(d, true)
      await learn(i, false)
      const ic = await intradayClock({ waitMarkets: false })
      await save('markets', { daily: parseHloc({ answer: d }, dailyClock(d)).rows, intraday: parseHloc({ answer: i }, ic).rows })
    },
    // One multi-ticker request for all positions; needs the positions, so waits for their fetch.
    // Nothing is saved without positions: the next refresh tries again.
    async sparks() {
      if (inflight.has('positions')) await inflight.get('positions')
      const tickers = positionTickers()
      if (!tickers.length) return
      const t = today()
      const a = await broker.hlocIntraday(tickers, addDays(t, -6), addDays(t, 1), 15)
      await learn(a, false)
      await save('sparks', { tickers, intraday: parseHloc({ answer: a }, await intradayClock()).rows })
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
      try {
        await db.purgeStale([...DATASETS, 'candleCover', 'marketInfo'])
      } catch {
        // housekeeping only: rows of another version read as missing anyway
      }
      for (const name of DATASETS) {
        const kv = await db.getKv(name)
        if (kv) { cache[name] = kv.data; fetchedAt[name] = kv.fetchedAt }
      }
      cover = (await db.getKv('candleCover'))?.data || {}
      learned = (await db.getKv('marketInfo'))?.data || learned
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

  // Daily closes of `tickers` from `from` (plus CLOSES_BEFORE - 1 earlier bars), per ticker.
  async function dailyCloses(tickers, from) {
    const a = await broker.hlocDaily(tickers, from, -CLOSES_BEFORE)
    await learn(a, true)
    const rows = parseHloc({ answer: a }, dailyClock(a)).rows
    return new Map(tickers.map((t) => [t, rows.filter((r) => r.ticker === t).map(({ date, close }) => ({ date, close }))]))
  }
  async function storeCloses(t, own, from) {
    if (own.length) await db.putCandles(t, own)
    candles.set(t, await db.getCandles(t))
    if (!cover[t] || from < cover[t]) cover[t] = from
  }

  function fetchCandles(tickers, from) {
    return task(`candles:${from}:${tickers.join(',')}`, DATASET.candles, async () => {
      const got = await dailyCloses(tickers, from)
      const again = new Map() // old cover -> tickers whose adjusted history starts before `from`
      for (const t of tickers) {
        const own = got.get(t)
        if (historyAdjusted(candles.get(t) || [], own)) {
          // Split / adjustment: the stored history is stale as a whole.
          const back = cover[t]
          await db.deleteCandles(t)
          candles.delete(t)
          delete cover[t]
          if (back && back < from) {
            if (!again.has(back)) again.set(back, [])
            again.get(back).push(t)
            continue
          }
        }
        await storeCloses(t, own, from)
      }
      await db.putKv('candleCover', { ...cover }, now())
      // Dropped tickers: their whole covered range again, one request per old cover date.
      for (const [back, ts] of again) {
        const re = await dailyCloses(ts, back)
        for (const t of ts) await storeCloses(t, re.get(t), back)
        await db.putKv('candleCover', { ...cover }, now())
      }
    })
  }

  // Top-up start per covered ticker: the oldest of its last REFETCH_DAYS stored days. Tickers
  // whose starts lie within PAD_DAYS of the newest share the earliest one, so market calendars
  // (a US vs a KASE holiday) do not split the request.
  function topUpFroms(need) {
    if (!need.size) return need
    const newest = [...need.values()].sort().at(-1)
    const near = [...need.values()].filter((d) => d >= addDays(newest, -PAD_DAYS)).sort()[0]
    return new Map([...need].map(([t, d]) => [t, d >= near ? near : d]))
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
    // Covered tickers: top-up from the last REFETCH_DAYS stored days (re-fetched and overwritten);
    // tickers not covered back to `start` are fetched from start - PAD_DAYS.
    const tickers = tickersFor(tf)
    const need = new Map()
    for (const t of tickers) {
      const cs = candles.get(t) || []
      if (cs.length && cover[t] && cover[t] <= start) need.set(t, cs[Math.max(0, cs.length - REFETCH_DAYS)].date)
    }
    const topUp = topUpFroms(need)
    const groups = new Map()
    for (const t of tickers) {
      const from = topUp.get(t) || addDays(start, -PAD_DAYS)
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
    /** Trading date of the session index's market at `ms` (default now). */
    today,
    security,
    loadSecurity,

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
