// Data repository: cache-first state, TTL refresh, incremental daily candles.
//
// kv keys (per account, via AccountDb):
//   clock        {t, m, at}           getMarketStatus snapshot + local receive time (optional fallback)
//   marketInfo   {offset, markets}    server offset (daily bars) and market hours (getHloc info), marketTime.js
//   positions    {rows, rawPs}        parsePositions rows + raw `ps` (holdings)
//   cashflows    rows                 parseCashflows rows (whole history)
//   trades       {from, rows}         parseTrades rows since `from` (beginDate watermark)
//   markets      {tickers, daily, intraday}  parseHloc rows of the session index + strip tickers
//                                    (no `tickers`: rows cached before Task 38, LEGACY_STRIP)
//   sparks       {tickers, intraday}  parseHloc 15-min rows of the positions (holdings sparklines)
//   quotes       {tickers, rows, shape}  getStockQuotesJson snapshot of the positions ({c, ltp, chg, pcp,
//                                    pp, ltr, ClosePrice, ltt}): Holdings Day outside live mode
//                                    (calc/live regularQuote); another `shape` is refetched at once
//   candleCover  {ticker: date}       earliest date_from requested per ticker
//   regular      {closes: {ticker: {date: close | null}}, markets: {ticker: market}}  US regular
//                                    session closes (Task 51) from hourly bars, fetched only for the
//                                    dates a period or card chart needs (its base and end); past
//                                    sessions never change: no TTL. null = no bars that day.
// Daily closes live in the `candles` store and are mirrored in memory so coreFor stays sync.
// Rows of another CACHE_VERSION read as missing (store/db.js) and are purged on the first load.
// Candle history has no TTL: a top-up re-requests the last 2 stored days (the newest may have been
// saved before its session closed) and checks the oldest overlapping stored close for a split.
// Position card data (security info, full candles per ticker) is kept in memory only, TTL-gated.
import {
  parsePositions, parseTrades, parseCashflows, parseHloc, computeCore, computeMarkets,
} from '../calc/portfolio.js'
import { periodStart, tradesFrom, inceptionFromCashflows } from '../calc/periods.js'
import { livePriceRows, quotePrice, regularCloses, regularQuote, dayChangePct } from '../calc/live.js'
import { daySparks } from '../calc/sparks.js'
import {
  DAY_S, dailyOffset, dailyThroughSession, hlocMarkets, isSessionDay, marketClock, marketClockFor, marketDay,
} from '../calc/marketTime.js'
import { candleZone, parseCandles, sessionBounds } from '../calc/position.js'
import { TTL, BENCHMARKS, MARKET_STRIP } from '../config.js'
import { BrokerError, SessionExpiredError } from '../api/transport.js'

/** Dataset names: kv rows and state.errors / state.loading keys (one source for components). */
export const DATASET = Object.freeze({
  clock: 'clock', positions: 'positions', cashflows: 'cashflows', trades: 'trades', markets: 'markets', sparks: 'sparks',
  quotes: 'quotes', candles: 'candles',
})
const DATASETS = Object.values(DATASET).filter((n) => n !== DATASET.candles) // kv datasets
const TTL_OF = {
  clock: TTL.clock, positions: TTL.positions, cashflows: TTL.cashflows, trades: TTL.trades, markets: TTL.markets, sparks: TTL.sparks,
  quotes: TTL.positionQuotes,
}
const AUTHED = new Set(['positions', 'cashflows', 'trades', 'quotes'])
const QUOTE_FIELDS = ['c', 'ltp', 'chg', 'pcp', 'pp', 'ltr', 'ClosePrice', 'ltt'] // kept from a position quote
const QUOTES_SHAPE = 2 // quotes rows with ClosePrice / ltt (Task 51): older rows are refetched at once
// Regular closes (Task 51): hourly bars, the 15:00 bar ends at 16:00 New York (verified 2026-11-01:
// the same close as the 15:45 15-min bar, about 4x fewer bars per day). Today's close is taken once
// the regular session has been closed this long.
const REGULAR_TF = 60
const REGULAR_SETTLE_MIN = 30
const REGULAR_CLUSTER_DAYS = 7 // needed dates this close together share one request
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
const DEFAULT_STRIP = MARKET_STRIP.map((m) => m.ticker)
// Tickers of markets rows cached before the strip became customizable (no `tickers` field). Frozen:
// a later MARKET_STRIP change must not make those rows look complete.
const LEGACY_STRIP = Object.freeze(['SP500.IDX', 'NASDAQ.IDX', 'USO.US', 'GLD.US', 'SLV.US'])
// After a per-ticker fallback: a ticker rejected alone (without being named) is skipped this long;
// when every call of a fallback failed, no fallback for this long either (combined requests only).
const HLOC_RETRY_MS = 5 * 60e3
const NAME_ROUNDS = 3 // combined retries after dropping the tickers an error names
const FINDER_MAX = 30
const QUOTE_MISS_MS = 10e3 // search quotes: a miss (failed request, no price) is asked again after this
// tickerFinder type/kind -> instrument type (docs/tradernet-api.md; pairs seen in real answers
// 2026-11-01): 1/1 and 1/2 shares, 1/7 funds (ETF/ETP), 2 bonds, 3 futures, 5 indices, 6/8, 6/29,
// 6/31, 6/33 crypto. Anything else (6/1 money, repo, new kinds) has no type.
const CRYPTO_KINDS = new Set([8, 29, 31, 33])
function instrumentType(type, kind) {
  const ty = Number(type)
  const k = Number(kind)
  if (ty === 1) return k === 7 ? 'etf' : k === 1 || k === 2 ? 'equity' : ''
  if (ty === 2) return 'bond'
  if (ty === 3) return 'future'
  if (ty === 5) return 'index'
  if (ty === 6 && CRYPTO_KINDS.has(k)) return 'crypto'
  return ''
}
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v)
const HLOC_KEYS = ['hloc', 'xSeries', 'vl', 'info', 'maxSeries']

const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isExpired = (e) => e instanceof SessionExpiredError
const psOf = (a) => (a && a.result && a.result.ps) || (a && a.ps) || null
// Tickers of `tickers` named as whole tokens in a broker error text, e.g. "Failed to find instruments
// by tickers: ZZZQX.US" (no error code seen for it; matching our own tickers keeps it independent of the text's language).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const namedIn = (msg, tickers) => tickers.filter((t) => new RegExp(`(^|[^\\w.-])${esc(t)}(?![\\w-])`, 'i').test(String(msg || '')))
// getHloc answers of disjoint ticker sets as one answer.
const mergeHloc = (answers) => Object.fromEntries(HLOC_KEYS.map((k) => [k, Object.assign({}, ...answers.map((a) => (a && a[k]) || {}))]))

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

/** `strip`: tickers of the markets strip cards (setStrip changes them). */
export function createRepo({ broker, db, now = () => Date.now(), strip: initialStrip = DEFAULT_STRIP }) {
  const cache = { clock: null, positions: null, cashflows: null, trades: null, markets: null, sparks: null, quotes: null }
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
  let strip = [...new Set(initialStrip)]
  const badTickers = new Set() // strip tickers a broker error named as unknown: not requested again
  const skipUntil = new Map() // ticker -> ms: rejected alone without being named, skipped until then
  let fanOutPausedUntil = 0 // every call of the last per-ticker fallback failed: no fallback until then

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

  // Markets dataset tickers: the session index (the app's trading date) + the strip cards.
  const marketTickers = () => [...new Set([SESSION_INDEX, ...strip])]
  const cachedMarketTickers = () => cache.markets?.tickers || LEGACY_STRIP
  // A strip ticker is missing from the cached rows: fetch at once (removed ones need nothing).
  const marketsOutdated = () => !!cache.markets && marketTickers().some((t) => !cachedMarketTickers().includes(t))

  /** Rows of the cached strip tickers (computeMarkets), null before the first fetch. */
  function marketsStrip() {
    return cache.markets
      ? computeMarkets(cache.markets.daily, cache.markets.intraday, clock(), today(), cachedMarketTickers(), fetchedAt.markets)
      : null
  }

  // One getHloc for `tickers` that an unknown ticker does not break (the broker fails the whole request
  // for it). A rejected request: tickers the error names are remembered and dropped, and the rest is
  // asked again; with none named, one request per ticker, one at a time (no burst), merged. Only a
  // named ticker is dropped for good; one rejected alone without being named is skipped for
  // HLOC_RETRY_MS; network errors record nothing. SESSION_INDEX is never dropped or skipped (trading
  // date, status date, spark windows). Every fallback call failing is the dataset's error and pauses
  // the fallback for HLOC_RETRY_MS.
  async function hlocTolerant(call, tickers) {
    const usable = (t) => t === SESSION_INDEX || (!badTickers.has(t) && !(skipUntil.get(t) > now()))
    let ask = tickers.filter(usable)
    for (let round = 0; ask.length; round++) {
      let e
      try { return await call(ask) } catch (err) { e = err }
      if (!(e instanceof BrokerError)) throw e
      const named = namedIn(e.message, ask).filter((t) => t !== SESSION_INDEX)
      if (named.length && round < NAME_ROUNDS) {
        for (const t of named) badTickers.add(t)
        ask = ask.filter((t) => !named.includes(t))
        continue
      }
      if (ask.length < 2 || now() < fanOutPausedUntil) throw e
      return hlocEach(call, ask, e)
    }
    return { hloc: {} }
  }
  async function hlocEach(call, ask, first) {
    const ok = []
    for (const t of ask) {
      try {
        ok.push(await call([t]))
      } catch (err) {
        if (!(err instanceof BrokerError) || t === SESSION_INDEX) continue
        if (namedIn(err.message, [t]).length) badTickers.add(t)
        else skipUntil.set(t, now() + HLOC_RETRY_MS)
      }
    }
    if (!ok.length) {
      fanOutPausedUntil = now() + HLOC_RETRY_MS
      for (const t of ask) skipUntil.delete(t) // nothing worked: not the tickers' fault
      throw first
    }
    return mergeHloc(ok)
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
  // Cached sparks / quotes were fetched for a different set of positions.
  const outdated = (name) => !!cache.positions && !!cache[name]
    && (cache[name].tickers.join(',') !== positionTickers().join(',') || (name === 'quotes' && cache.quotes.shape !== QUOTES_SHAPE))

  // Position quote snapshot as a Map ticker -> quote, the same Map until the next fetch.
  let quotesMemo = { src: undefined, value: null }
  function quotesState() {
    if (quotesMemo.src !== cache.quotes) {
      quotesMemo = { src: cache.quotes, value: cache.quotes ? new Map(cache.quotes.rows.map((q) => [q.c, q])) : null }
    }
    return quotesMemo.value
  }

  // --- regular session closes (Task 51): US prices on the 16:00 close, like Yahoo.
  // Sources, later ones winning: the `regular` kv (hourly bars of the dates periods / cards need),
  // the 15-min bars already loaded (sparks: positions, markets: strip; contiguous last sessions),
  // the quotes (live, else the position snapshot) through calc/live regularQuote.
  let regularStore = { closes: {}, markets: {} }
  let barMemo = { sp: undefined, mk: undefined, clk: undefined, closes: new Map(), markets: new Map() }
  function barCloses() {
    const sp = cache.sparks
    const mk = cache.markets
    const clk = clock()
    if (barMemo.sp !== sp || barMemo.mk !== mk || barMemo.clk !== clk) {
      const closes = new Map()
      const markets = new Map()
      // Per source: a bar still forming when that source was fetched is no close (asOf).
      for (const [src, asOf] of [[mk, fetchedAt.markets], [sp, fetchedAt.sparks]]) {
        const by = new Map()
        for (const r of src?.intraday || []) {
          if (!by.has(r.ticker)) by.set(r.ticker, [])
          by.get(r.ticker).push(r)
        }
        for (const [t, rows] of by) {
          const mkt = (rows.find((r) => r.mkt) || {}).mkt
          if (mkt) markets.set(t, mkt)
          const m = regularCloses(rows, marketClockFor(clk, mkt), asOf)
          if (m.size) closes.set(t, new Map([...(closes.get(t) || []), ...m]))
        }
      }
      barMemo = { sp, mk, clk, closes, markets }
    }
    return barMemo
  }
  /** Market of a ticker as the broker named it (bars, card, regular kv); null when unknown. */
  const marketOfTicker = (t) => barCloses().markets.get(t) || sec.get(t)?.zone?.mkt || regularStore.markets[t] || null

  /** calc/live regularQuote of `q` for `ticker`: its market's clock and its bars' regular closes
   *  (`bars`: the caller's own intraday rows, e.g. the card's; default: sparks / markets rows). */
  function regularOf(ticker, q, bars = null) {
    const mc = marketClockFor(clock(), (q && q.ltr) || marketOfTicker(ticker))
    return regularQuote(q, mc, bars ? regularCloses(bars, mc) : barCloses().closes.get(ticker) || null)
  }

  /** Regular closes of `tickers` for computeCore: Map ticker -> Map date -> close (US only).
   *  A quote outside the regular session gives its day's close and, for the session before (the
   *  ticker's previous daily candle date), its previous close: Holdings Day and Performance 1D
   *  then share both prices. `quotes`: live quotes (else the position snapshot). */
  function regularMap(tickers, quotes) {
    const out = new Map()
    const bc = barCloses().closes
    const snap = quotesState()
    for (const t of tickers) {
      const m = new Map()
      for (const [d, c] of Object.entries(regularStore.closes[t] || {})) if (c != null) m.set(d, c)
      for (const [d, c] of bc.get(t) || []) m.set(d, c)
      const lq = quotes?.get?.(t)
      const q = quotePrice(lq) !== null ? lq : snap?.get(t)
      const r = q ? regularOf(t, q) : null
      if (r && r.day && r.price != null) {
        m.set(r.day, r.price)
        const before = (candles.get(t) || []).filter((c) => c.date < r.day).pop()
        if (before && r.prev != null) m.set(before.date, r.prev)
      }
      if (m.size) out.set(t, m)
    }
    return out
  }

  // Exchange wall minute of the US market now (null without its clock).
  function usWallMinute(ms = now()) {
    const mc = marketClockFor(clock(), indexMarket())
    if (!mc || mc.regular == null || mc.dt === null || mc.dt === undefined) return null
    const sec0 = Math.floor(ms / 1000) + mc.offset - mc.dt * 60
    return { day: marketDay(mc, ms), min: (((sec0 % DAY_S) + DAY_S) % DAY_S) / 60, regular: mc.regular }
  }
  /** A session date whose regular close is final: before today, or today once the regular
   *  session has been closed REGULAR_SETTLE_MIN. */
  function closedSession(d) {
    const w = usWallMinute()
    if (!w) return d < today()
    return d < w.day || (d === w.day && w.min >= w.regular + REGULAR_SETTLE_MIN)
  }
  // A ticker whose market is known to have no regular close (KASE, EU): never asked.
  const noRegular = (t) => {
    const mkt = marketOfTicker(t)
    if (!mkt) return false
    const mc = marketClockFor(clock(), mkt)
    return !!mc && mc.dt != null && mc.regular == null
  }

  /** Fetch the regular closes of `want` (Map ticker -> [dates]) that are final and not stored yet:
   *  one hourly getHloc per cluster of nearby dates, all tickers together (hlocTolerant). Never
   *  rejects: a failure only leaves the daily closes in place (retried on the next call). */
  async function fetchRegular(want) {
    const miss = new Map() // date -> Set(tickers)
    const bc = barCloses().closes
    for (const [t, dates] of want) {
      if (String(t).includes('/') || noRegular(t)) continue
      const have = regularStore.closes[t] || {}
      for (const d of dates) {
        // known already, or in the 15-min bars loaded anyway (positions, strip)
        if (!d || d in have || bc.get(t)?.has(d) || !isSessionDay(d) || !closedSession(d)) continue
        if (!miss.has(d)) miss.set(d, new Set())
        miss.get(d).add(t)
      }
    }
    if (!miss.size) return
    const dates = [...miss.keys()].sort()
    const clusters = []
    for (const d of dates) {
      const c = clusters[clusters.length - 1]
      if (c && d <= addDays(c[0], REGULAR_CLUSTER_DAYS)) c.push(d)
      else clusters.push([d])
    }
    for (const ds of clusters) {
      const tickers = [...new Set(ds.flatMap((d) => [...miss.get(d)]))].sort()
      const key = `regular:${ds.join(',')}:${tickers.join(',')}`
      if (inflight.has(key)) { await inflight.get(key); continue }
      const p = (async () => {
        try {
          const a = await hlocTolerant((ts) => broker.hlocIntraday(ts, ds[0], addDays(ds[ds.length - 1], 1), REGULAR_TF), tickers)
          await learn(a, false)
          const rows = parseHloc({ answer: a }, await intradayClock()).rows
          const at = now()
          const closes = { ...regularStore.closes }
          const markets = { ...regularStore.markets }
          const got = new Map() // ticker -> {mkt, mc, closes}
          const sessions = new Set() // dates some ticker of this answer has a regular close for
          for (const t of tickers) {
            const own = rows.filter((r) => r.ticker === t)
            const mkt = (own.find((r) => r.mkt) || {}).mkt
            if (mkt) markets[t] = mkt
            const mc = marketClockFor(clock(), mkt)
            const m = regularCloses(own, mc, at)
            for (const d of m.keys()) sessions.add(d)
            got.set(t, { mc, m })
          }
          for (const t of tickers) {
            const { mc, m } = got.get(t)
            // A market without a regular close (KASE, EU): nothing to wait for. Otherwise a date
            // without this ticker's close is remembered as null (not asked again: not listed yet,
            // halted) only when other tickers of the same answer had that session; else (the
            // ticker or the whole answer came back empty) it is asked again later.
            const none = !!mc && mc.dt != null && mc.regular == null
            const next = { ...(closes[t] || {}) }
            for (const d of ds) {
              if (!miss.get(d).has(t)) continue
              if (m.has(d)) next[d] = m.get(d)
              else if (none || sessions.has(d)) next[d] = null
            }
            closes[t] = next
          }
          regularStore = { closes, markets }
          await db.putKv('regular', regularStore, now())
        } catch (e) {
          if (isExpired(e)) sessionExpired()
        } finally {
          inflight.delete(key)
          emit()
        }
      })()
      inflight.set(key, p)
      await p
    }
  }

  /** Dates of a period whose regular closes it needs: base close, end and the session before
   *  the end (Performance "on <date>"), as computeCore picks them from the SPY.US candles. */
  function periodDates(start) {
    const spy = (candles.get('SPY.US') || []).map((c) => c.date).filter((d) => isSessionDay(d) && (!indexAnchor() || d <= indexAnchor()))
    if (!spy.length) return []
    const end = spy[spy.length - 1]
    const prevEnd = spy.length > 1 ? spy[spy.length - 2] : null
    let base = spy.filter((d) => d <= start).pop() || null
    if (base === end) base = prevEnd
    return [...new Set([base, prevEnd, end].filter(Boolean))]
  }

  // Last US session date: the latest SP500.IDX intraday date (an index trades only in the
  // regular session), null before the markets dataset is loaded.
  function indexAnchor() {
    let a = null
    for (const r of cache.markets?.intraday || []) if (r.ticker === SESSION_INDEX && r.date && (a === null || r.date > a)) a = r.date
    return a
  }

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

  // Daily / max candles of a card ticker: on the index's market up to the last index session
  // (dailyThroughSession), elsewhere session days only (isSessionDay: the broker's flat weekend
  // .EU bars dropped); memoized per source array and markets cache (no new array per read).
  // US closes are the regular session's where known (cardRegular; Task 51): the chart's base and
  // end are regular closes, like Performance.
  function sessionCandles(e, part, idx, reg) {
    const src = e?.[part] ?? null
    if (!src) return null
    const m = e.cut?.[part]
    if (m && m.src === src && m.mkts === cache.markets && m.idx === !!idx && m.reg === reg) return m.value
    const cut = idx ? dailyThroughSession(src, idx) : src.filter((r) => isSessionDay(r.date))
    const value = reg.size ? cut.map((r) => (reg.has(r.date) && reg.get(r.date) !== r.close ? { ...r, close: reg.get(r.date) } : r)) : cut
    e.cut = { ...e.cut, [part]: { src, mkts: cache.markets, idx: !!idx, reg, value } }
    return value
  }
  // Regular closes of a card ticker: the regular kv, the sparks / markets bars and the card's own
  // intraday bars (`mc`: its market clock); memoized per source.
  function cardRegular(ticker, e, mc) {
    const bc = barCloses().closes
    const k = e?.reg
    const clk = clock()
    if (k && k.store === regularStore && k.bc === bc && k.intra === e.intraday && k.clk === clk && k.mkt === e.zone?.mkt) return k.value
    const value = new Map(Object.entries(regularStore.closes[ticker] || {}).filter(([, c]) => c != null))
    for (const [d, c] of bc.get(ticker) || []) value.set(d, c)
    for (const [d, c] of regularCloses(e?.intraday, mc, e?.at?.intraday)) value.set(d, c)
    if (e) e.reg = { store: regularStore, bc, intra: e.intraday, clk, mkt: e.zone?.mkt, value }
    return value
  }

  /** Synchronous snapshot of a ticker's card data (null = not loaded). `sessions`: index bars by
   *  date (sessionBounds over SP500.IDX) for tickers of the index's market; `clock`: the ticker
   *  market's clock (marketClockFor); `today`: that market's trading date. `daily` / `max` of
   *  such tickers end at the last index session (no weekend single-print bar); of other tickers
   *  they keep session days only (no flat weekend .EU bars). US closes: the regular session's
   *  where known (Task 51). */
  function security(ticker) {
    const e = sec.get(ticker)
    const im = indexMarket()
    const mkt = e?.zone?.mkt || e?.info?.ltr || null
    const anchored = mkt && im ? String(mkt).toUpperCase() === String(im).toUpperCase() : String(ticker).endsWith('.US')
    const idx = anchored ? (cache.markets?.intraday || []).filter((r) => r.ticker === SESSION_INDEX) : []
    const mc = marketClockFor(clock(), mkt || (anchored ? im : null), { tz: e?.zone?.tz })
    const reg = cardRegular(ticker, e, mc)
    return {
      info: e?.info ?? null,
      intraday: e?.intraday ?? null,
      intradayAt: e?.at?.intraday ?? null, // fetch time of `intraday` (regularCloses asOf)
      daily: sessionCandles(e, 'daily', anchored ? idx : null, reg),
      max: sessionCandles(e, 'max', anchored ? idx : null, reg),
      sessions: anchored ? sessionBounds(idx) : null,
      clock: mc,
      today: marketDay(mc, now()),
      errors: { ...(e?.errors || {}) },
      loading: e ? [...e.inflight.keys()] : [],
    }
  }

  // --- search rows: last price and day change of any ticker (getStockQuotesJson), memory only
  const quoteMemo = new Map() // ticker -> {until, last, change}
  const quotePending = new Map() // ticker -> promise of the batch fetching it
  const fresh = (t, at) => quoteMemo.has(t) && at < quoteMemo.get(t).until
  /** {ticker: {last, change}} for `tickers` (null = no data). One batched request for the
   *  tickers neither fresh nor already being fetched; a price is kept TTL.quotes, a miss (failed
   *  request, no price in the answer) QUOTE_MISS_MS. Expired entries are pruned on every insert.
   *  Never rejects; an expired session is reported. */
  async function searchQuotes(tickers) {
    const list = [...new Set(tickers)]
    const t0 = now()
    const want = list.filter((t) => !quotePending.has(t) && !fresh(t, t0))
    if (want.length) {
      const batch = (async () => {
        const got = new Map()
        try {
          const a = await broker.quotes(want)
          for (const q of (a && a.result && Array.isArray(a.result.q)) ? a.result.q : []) {
            if (q && q.c) got.set(q.c, q)
          }
        } catch (e) {
          if (isExpired(e)) sessionExpired()
        }
        const at = now()
        for (const [t, m] of quoteMemo) if (at >= m.until) quoteMemo.delete(t)
        for (const t of want) {
          const q = got.get(t)
          // ltp 0 (an index on a day off) is no price, and then no change; US: the regular price
          // and its day change (calc/live regularQuote), the after-hours trade left out.
          const r = quotePrice(q) === null ? null : regularOf(t, q)
          const last = r ? r.price : null
          const until = at + (last === null ? QUOTE_MISS_MS : TTL.quotes)
          quoteMemo.set(t, { until, last, change: last === null ? null : r.pct ?? dayChangePct({ last, prev: r.prev }) })
          quotePending.delete(t)
        }
      })()
      for (const t of want) quotePending.set(t, batch)
    }
    await Promise.all([...new Set(list.map((t) => quotePending.get(t)).filter(Boolean))])
    return Object.fromEntries(list.map((t) => {
      const m = quoteMemo.get(t)
      return [t, { last: m ? m.last : null, change: m ? m.change : null }]
    }))
  }
  searchQuotes.memoSize = () => quoteMemo.size // tests: the memo does not only grow

  // null = never loaded.
  function state() {
    return {
      positions: cache.positions ? cache.positions.rows : null,
      rawPs: cache.positions ? cache.positions.rawPs : null,
      trades: cache.trades ? cache.trades.rows : null,
      cashflows: cache.cashflows,
      markets: marketsStrip(),
      strip: [...strip], // tickers of the strip cards (live subscribes them)
      sparks: sparksState(), // {ticker: {date, spark}}: last-session 15-min closes
      quotes: quotesState(), // Map ticker -> REST quote of the positions (Holdings Day outside live)
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
      const tickers = marketTickers()
      const [d, i] = await Promise.all([
        hlocTolerant((ts) => broker.hlocDaily(ts, addDays(t, -10), -1), tickers),
        hlocTolerant((ts) => broker.hlocIntraday(ts, addDays(t, -6), addDays(t, 1), 15), tickers),
      ])
      await learn(d, true)
      await learn(i, false)
      const ic = await intradayClock({ waitMarkets: false })
      await save('markets', {
        tickers, daily: parseHloc({ answer: d }, dailyClock(d)).rows, intraday: parseHloc({ answer: i }, ic).rows,
      })
    },
    // One multi-ticker request for all positions; needs the positions, so waits for their fetch.
    // Nothing is saved without positions: the next refresh tries again. An unknown ticker is
    // dropped (hlocTolerant) and simply has no spark.
    async sparks() {
      if (inflight.has('positions')) await inflight.get('positions')
      const tickers = positionTickers()
      if (!tickers.length) return
      const t = today()
      const a = await hlocTolerant((ts) => broker.hlocIntraday(ts, addDays(t, -6), addDays(t, 1), 15), tickers)
      await learn(a, false)
      await save('sparks', { tickers, intraday: parseHloc({ answer: a }, await intradayClock()).rows })
    },
    // Quote snapshot of the positions (one getStockQuotesJson); like sparks, waits for the positions.
    async quotes() {
      if (inflight.has('positions')) await inflight.get('positions')
      const tickers = positionTickers()
      if (!tickers.length) return
      const a = await broker.quotes(tickers)
      const rows = ((a && a.result && Array.isArray(a.result.q)) ? a.result.q : [])
        .filter((q) => q && q.c)
        .map((q) => Object.fromEntries(QUOTE_FIELDS.filter((f) => q[f] !== undefined).map((f) => [f, q[f]])))
      await save('quotes', { tickers, rows, shape: QUOTES_SHAPE })
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
        await db.purgeStale([...DATASETS, 'candleCover', 'marketInfo', 'regular'])
      } catch {
        // housekeeping only: rows of another version read as missing anyway
      }
      for (const name of DATASETS) {
        const kv = await db.getKv(name)
        if (kv) { cache[name] = kv.data; fetchedAt[name] = kv.fetchedAt }
      }
      cover = (await db.getKv('candleCover'))?.data || {}
      learned = (await db.getKv('marketInfo'))?.data || learned
      regularStore = (await db.getKv('regular'))?.data || regularStore
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
  // An unknown ticker is dropped (hlocTolerant): it gets no closes.
  async function dailyCloses(tickers, from) {
    const a = await hlocTolerant((ts) => broker.hlocDaily(ts, from, -CLOSES_BEFORE), tickers)
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
        // No closes for a ticker with a stored history: skipped for now (hlocTolerant), so its
        // history and cover stay (a backfill must not leave a hole); retried on a later call.
        // Unknown for good (named by the broker) or never stored: covered with no closes, so the
        // period is computed and computeCore reports the ticker missing.
        if (!own.length && (candles.get(t) || []).length && !badTickers.has(t)) continue
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
    // US regular closes of the period's base and end (Task 51); the daily closes stand meanwhile.
    const dates = periodDates(start)
    if (dates.length) await fetchRegular(new Map(tickers.map((t) => [t, dates])))
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
    // Up to the last US session (SP500.IDX bars): a daily candle of a day whose regular session has
    // not started (US pre-market) is not a session yet; Holdings Day shows the session before it.
    const anchor = indexAnchor()
    for (const t of tickersFor(tf)) {
      if (!cover[t] || cover[t] > start) return null
      const all = candles.get(t) || []
      const cs = anchor ? all.filter((c) => c.date <= anchor) : all
      let cut = cs.findIndex((c) => c.date > start)
      if (cut < 0) cut = cs.length
      for (const c of cs.slice(Math.max(0, cut - CLOSES_BEFORE))) {
        out.push({ ticker: t, date: c.date, close: c.close, window_start: start })
      }
    }
    return out
  }

  /** TTL-gated (or `force`d) refresh of `only` (default: all kv datasets) minus `except`. */
  async function refresh({ force = false, only, except = [] } = {}) {
    await loadCache()
    const names = (only || DATASETS).filter((n) => DATASETS.includes(n) && !except.includes(n))
    const due = names.filter((n) => force || fetchedAt[n] == null || now() - fetchedAt[n] >= TTL_OF[n]
      || ((n === 'sparks' || n === 'quotes') && outdated(n)) || (n === 'markets' && marketsOutdated()))
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
     * live prices. US closes are the regular session's where known (regularMap; Task 51). Returns null when the cache does not cover the period (not loaded yet,
     * trades or closes not fetched back far enough, e.g. an offline switch to a longer
     * period or ensurePrices still running): the UI shows a skeleton / "unavailable".
     */
    coreFor(period, day = today(), quotes) {
      let prices = priceRows(period, day)
      if (!prices) return null
      if (quotes) prices = livePriceRows(prices, quotes, day, regularOf)
      const tickers = [...new Set(prices.map((r) => r.ticker))]
      return computeCore(cache.positions.rows, cache.trades.rows, cache.cashflows, prices, regularMap(tickers, quotes))
    },

    marketsStrip,

    /** New strip card tickers: emitted at once (live resubscribes); added tickers are fetched
     *  (after a strip fetch already running), removed ones are simply no longer requested. */
    async setStrip(list) {
      const next = [...new Set(list)]
      if (next.join(',') === strip.join(',')) return
      strip = next
      emit()
      if (inflight.has('markets')) await inflight.get('markets')
      await refresh({ only: ['markets'] })
    },

    /** Broker search (tickerFinder, anonymous): [{ticker, name, market, code, currency, type}]
     *  (code: code_nm, the ticker without its suffix; currency: x_curr; type: 'equity' | 'etf' |
     *  'bond' | 'future' | 'index' | 'crypto'; '' when absent or unknown), at most 30;
     *  currency pairs skipped. Rejects on errors. */
    async findTickers(text) {
      const q = String(text || '').trim()
      if (!q) return []
      const a = await broker.tickerFinder(q)
      return ((a && Array.isArray(a.found)) ? a.found : [])
        .filter((x) => x && typeof x.t === 'string' && x.t.trim() && !x.t.includes('/'))
        .slice(0, FINDER_MAX)
        .map((x) => {
          const ticker = x.t.trim()
          const name = [x.nm, x.n, x.ln].map(str).find(Boolean) || ticker
          return {
            ticker, name, market: typeof x.mkt === 'string' ? x.mkt : '', code: str(x.code_nm),
            currency: str(x.x_curr), type: instrumentType(x.type, x.kind),
          }
        })
    },

    searchQuotes,

    /** calc/live regularQuote of a quote for `ticker` (Task 51: US on the regular close, the
     *  after-hours / pre-market trade in `ext`); `bars`: the caller's intraday rows of the ticker. */
    regular: regularOf,

    /** Fetch the regular closes of `ticker` on `dates` (a card chart's base), cached for good. */
    ensureRegular(ticker, dates) {
      return fetchRegular(new Map([[ticker, dates]]))
    },

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
