// Live mode: WS quotes first, REST polling as a fallback, throttled 'update' events.
//
// Live = at least one market is OPEN and an instrument we track trades on it (instrument
// market = quote.ltr, matched against market n/n2; US instruments and indices report "FIX").
// Market status comes from the WS `markets` subscription; REST getMarketStatus fills in when
// the WS sends no markets within MARKETS_GRACE_MS of start or the socket is down.
// While live, the WS is trusted if it is open and has sent a quote within STALE_MS;
// otherwise quotes + positions are polled every POLL_MS.
// An auth error (demo/unauthenticated socket, expired session) makes the controller dead:
// no polling and no reconnects until the next start().
import { mergeQuote } from '../calc/live.js'
import { SessionExpiredError } from '../api/transport.js'
import { BENCHMARKS, MARKET_STRIP, POLL_MS, LIVE_RECALC_MS } from '../config.js'

const STALE_MS = 2 * 60e3
const MARKETS_GRACE_MS = 15e3

// Drop nullish fields so a delta never erases a known value.
const clean = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v != null))
const psOf = (a) => (a && a.result && a.result.ps) || (a && a.ps) || null
const ignore = () => {} // fire-and-forget: repo records its own errors
const upper = (v) => String(v).toUpperCase()
const marketNames = (m) => [m.n, m.n2].filter(Boolean).map(upper)
// WS entries carry `mkt_id`, REST ones `i`.
const marketKey = (m) => String(m.mkt_id ?? m.i ?? marketNames(m).join('|'))

export function createLive({
  repo, broker, socketFactory, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  const quotes = new Map()
  const markets = new Map() // marketKey -> merged market entry
  const listeners = new Map()
  let sock = null
  let unsubRepo = null
  let tickers = []
  let tickersKey = ''
  let started = false
  let paused = false
  let dead = false
  let wsOpen = false
  let wsMarkets = false // WS delivered markets since the socket last changed state
  let lastSignal = 0 // WS open (when not polling) or last WS quote
  let polling = false
  let pollTimer = null
  let pollBusy = false
  let staleTimer = null
  let seeding = false
  let wasLive = false
  let graceOver = false
  let graceTimer = null
  let restTimer = null
  let restBusy = false
  let pendingPs = null

  const emit = (event, ...args) => { for (const fn of listeners.get(event) || []) fn(...args) }
  const clear = (id) => { if (id != null) clearTimer(id) }

  // Leading call, then at most one trailing call per LIVE_RECALC_MS.
  function throttle(fn) {
    let last = -Infinity
    let timer = null
    const fire = () => { timer = null; last = now(); fn() }
    return {
      call() {
        if (timer != null) return
        const wait = last + LIVE_RECALC_MS - now()
        if (wait <= 0) fire()
        else timer = setTimer(fire, wait)
      },
      cancel() { clear(timer); timer = null },
    }
  }
  const update = throttle(() => emit('update', quotes))
  const portfolio = throttle(() => {
    const ps = pendingPs
    pendingPs = null
    if (ps && !dead) repo.applyPortfolio(ps).catch(ignore)
  })

  // --- market state
  function openNames() {
    const s = new Set()
    for (const m of markets.values()) if (m.s === 'OPEN') for (const n of marketNames(m)) s.add(n)
    return s
  }
  const ltrOf = (ts) => ts.map((t) => quotes.get(t)?.ltr).filter(Boolean).map(upper)
  const instrumentMarkets = () => ltrOf(tickers)

  function isLive() {
    if (dead) return false
    const open = openNames()
    return instrumentMarkets().some((m) => open.has(m))
  }

  /** The market of this instrument (its quote `ltr`) is open. */
  function isOpenFor(ticker) {
    if (dead) return false
    const l = quotes.get(ticker)?.ltr
    return !!l && openNames().has(upper(l))
  }

  function marketsOpen() {
    const open = openNames()
    return { us: !dead && ltrOf(tickers.filter((t) => t.endsWith('.US'))).some((m) => open.has(m)) }
  }

  function mergeMarkets(list) {
    for (const x of list || []) {
      const k = marketKey(x)
      markets.set(k, { ...markets.get(k), ...x })
    }
  }

  // --- quotes
  function applyQuote(q) {
    if (!q || !q.c) return
    quotes.set(q.c, mergeQuote(quotes.get(q.c), clean(q)))
  }
  async function fetchQuotes() {
    const a = await broker.quotes(tickers)
    for (const q of (a && a.result && a.result.q) || []) applyQuote(q)
    update.call()
  }

  // Markets known to be open but no instrument market code yet: one REST snapshot gives `ltr`.
  async function seed() {
    if (seeding || !tickers.length) return
    seeding = true
    try { await fetchQuotes() } catch (e) { authCheck(e) } finally { seeding = false }
    evaluate()
  }

  // Dead session: stop everything; the repo probes the session and notifies the UI.
  function kill() {
    if (dead) return
    dead = true
    markets.clear()
    pendingPs = null
    portfolio.cancel()
    if (sock) sock.close()
    wsOpen = false
    evaluate()
  }
  function authCheck(e) {
    if (!(e instanceof SessionExpiredError)) return
    repo.refresh({ force: true, only: ['positions'] }).catch(ignore)
    kill()
  }

  // --- REST market status (WS markets missing or socket down)
  const restWanted = () => started && !paused && !dead && graceOver && (!wsOpen || !wsMarkets)
  async function fetchMarketStatus() {
    if (restBusy) return
    restBusy = true
    try {
      const a = await broker.marketStatus()
      if (restWanted()) mergeMarkets(a && a.result && a.result.markets && a.result.markets.m)
    } catch {
      // next tick retries
    } finally {
      restBusy = false
    }
    evaluate()
  }
  function restTick() {
    restTimer = setTimer(restTick, POLL_MS)
    fetchMarketStatus()
  }
  function syncRest() {
    if (!restWanted()) { clear(restTimer); restTimer = null; return }
    if (restTimer == null) restTick()
  }
  function startGrace() {
    graceOver = false
    clear(graceTimer)
    graceTimer = setTimer(() => { graceTimer = null; graceOver = true; evaluate() }, MARKETS_GRACE_MS)
  }

  // --- polling
  async function poll() {
    if (pollBusy) return
    pollBusy = true
    try {
      const [q, p] = await Promise.allSettled([fetchQuotes(), broker.positions()])
      if (q.status === 'rejected') authCheck(q.reason)
      if (p.status === 'rejected') authCheck(p.reason)
      else if (polling) {
        const ps = psOf(p.value)
        if (ps) await repo.applyPortfolio(ps)
      }
    } catch {
      // next tick retries
    } finally {
      pollBusy = false
    }
  }
  function pollTick() {
    pollTimer = setTimer(pollTick, POLL_MS)
    poll()
  }
  function startPolling() {
    if (polling) return
    polling = true
    pollTick()
  }
  function stopPolling() {
    polling = false
    clear(pollTimer)
    pollTimer = null
  }

  // --- mode decision
  function setLive(live) {
    if (live === wasLive) return
    wasLive = live
    update.call()
  }
  function evaluate() {
    clear(staleTimer)
    staleTimer = null
    syncRest()
    if (!started || paused) { stopPolling(); return }
    const live = isLive()
    setLive(live)
    if (!live) {
      stopPolling()
      if (!dead && openNames().size && !instrumentMarkets().length) seed()
      return
    }
    const fresh = wsOpen && now() - lastSignal < STALE_MS
    if (!fresh) { startPolling(); return }
    stopPolling()
    staleTimer = setTimer(evaluate, lastSignal + STALE_MS - now())
  }

  // --- wiring
  function onRepo(state) {
    const pos = (state && state.positions) || []
    const next = [...new Set([
      ...pos.filter((r) => r.kind === 'position').map((r) => r.ticker),
      ...BENCHMARKS,
      ...MARKET_STRIP.map((m) => m.ticker),
    ])].filter((t) => t && !String(t).includes('/')).sort()
    const key = next.join(',')
    if (key === tickersKey) return
    tickers = next
    tickersKey = key
    if (sock) sock.setQuotes(tickers)
    if (started) evaluate()
  }

  function onSocketStatus(s) {
    wsOpen = s === 'open'
    wsMarkets = false
    if (wsOpen && !polling) lastSignal = now()
    evaluate()
  }

  function onSocketQuote(q) {
    applyQuote(q)
    lastSignal = now()
    update.call()
    evaluate()
  }

  function onSocketMarkets(m) {
    wsMarkets = true
    mergeMarkets(m && m.m)
    evaluate()
  }

  function onSocketPortfolio(ps) {
    pendingPs = ps
    portfolio.call()
  }

  function onSocketAuthError() {
    emit('auth-error')
    repo.refresh({ force: true, only: ['positions'] }).catch(ignore)
    kill()
  }

  return {
    quotes,
    isLive,
    isOpenFor,
    marketsOpen,

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event).delete(fn)
    },

    start() {
      if (started) return
      started = true
      paused = false
      dead = false
      sock = socketFactory()
      sock.on('status', onSocketStatus)
      sock.on('quote', onSocketQuote)
      sock.on('portfolio', onSocketPortfolio)
      sock.on('markets', onSocketMarkets)
      sock.on('auth-error', onSocketAuthError)
      sock.subscribeMarkets()
      sock.subscribePortfolio()
      tickersKey = ''
      unsubRepo = repo.subscribe(onRepo)
      startGrace()
      sock.connect()
    },

    stop() {
      if (!started) return
      started = false
      if (unsubRepo) unsubRepo()
      unsubRepo = null
      if (sock) sock.close()
      sock = null
      wsOpen = false
      clear(graceTimer)
      graceTimer = null
      update.cancel()
      portfolio.cancel()
      evaluate()
    },

    pause() {
      if (!started || paused) return
      paused = true
      sock.close()
      wsOpen = false
      clear(graceTimer)
      graceTimer = null
      evaluate()
    },

    resume() {
      if (!started || !paused) return
      paused = false
      repo.refresh().catch(ignore)
      if (!dead) {
        startGrace()
        sock.connect()
      }
      evaluate()
    },
  }
}
