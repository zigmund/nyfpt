// Live mode: WS quotes first, REST polling as a fallback, throttled 'update' events.
//
// Live = at least one market from WS `markets` is OPEN and an instrument we track trades on it
// (instrument market = quote.ltr). While live, the WS is trusted if it is open and has sent a
// quote within STALE_MS; otherwise quotes + positions are polled every POLL_MS.
import { mergeQuote } from '../calc/live.js'
import { SessionExpiredError } from '../api/transport.js'
import { BENCHMARKS, MARKET_STRIP, POLL_MS, LIVE_RECALC_MS } from '../config.js'

const STALE_MS = 2 * 60e3
const US_MARKET = /^(NYSE|NASDAQ|AMEX|ARCA|BATS|CBOE|OTC)/i

// Drop nullish fields so a delta never erases a known value.
const clean = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v != null))
const psOf = (a) => (a && a.result && a.result.ps) || (a && a.ps) || null
const ignore = () => {} // fire-and-forget: repo records its own errors
const marketNames = (m) => [m.n, m.n2].filter(Boolean).map((s) => String(s).toUpperCase())

export function createLive({
  repo, broker, socketFactory, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  const quotes = new Map()
  const markets = new Map() // mkt_id|name -> market entry
  const listeners = new Map()
  let sock = null
  let unsubRepo = null
  let tickers = []
  let tickersKey = ''
  let started = false
  let paused = false
  let wsOpen = false
  let lastSignal = 0 // WS open (when not polling) or last WS quote
  let polling = false
  let pollTimer = null
  let pollBusy = false
  let staleTimer = null
  let seeding = false
  let wasLive = false
  let lastEmit = -Infinity
  let updateTimer = null

  const emit = (event, ...args) => { for (const fn of listeners.get(event) || []) fn(...args) }
  const clear = (id) => { if (id != null) clearTimer(id) }

  // --- 'update' throttle: leading call, then at most one trailing call per LIVE_RECALC_MS.
  function fireUpdate() {
    updateTimer = null
    lastEmit = now()
    emit('update', quotes)
  }
  function scheduleUpdate() {
    if (updateTimer != null) return
    const wait = lastEmit + LIVE_RECALC_MS - now()
    if (wait <= 0) fireUpdate()
    else updateTimer = setTimer(fireUpdate, wait)
  }

  // --- market state
  function openNames() {
    const s = new Set()
    for (const m of markets.values()) if (m.s === 'OPEN') for (const n of marketNames(m)) s.add(n)
    return s
  }
  const instrumentMarkets = () =>
    tickers.map((t) => quotes.get(t)?.ltr).filter(Boolean).map((s) => String(s).toUpperCase())

  function isLive() {
    const open = openNames()
    return instrumentMarkets().some((m) => open.has(m))
  }

  function marketsOpen() {
    const open = openNames()
    const usCodes = new Set(tickers.filter((t) => t.endsWith('.US')).map((t) => quotes.get(t)?.ltr)
      .filter(Boolean).map((s) => String(s).toUpperCase()))
    return { us: [...open].some((n) => US_MARKET.test(n) || usCodes.has(n)) }
  }

  // --- quotes
  function applyQuote(q) {
    if (!q || !q.c) return
    quotes.set(q.c, mergeQuote(quotes.get(q.c), clean(q)))
  }
  async function fetchQuotes() {
    const a = await broker.quotes(tickers)
    for (const q of (a && a.result && a.result.q) || []) applyQuote(q)
    scheduleUpdate()
  }

  // Markets known to be open but no instrument market code yet: one REST snapshot gives `ltr`.
  async function seed() {
    if (seeding || !tickers.length) return
    seeding = true
    try { await fetchQuotes() } catch (e) { authCheck(e) } finally { seeding = false }
    evaluate()
  }

  function authCheck(e) {
    if (e instanceof SessionExpiredError) repo.refresh({ force: true, only: ['positions'] }).catch(ignore)
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
  function evaluate() {
    clear(staleTimer)
    staleTimer = null
    if (!started || paused) { stopPolling(); return }
    const live = isLive()
    if (live !== wasLive) { wasLive = live; scheduleUpdate() }
    if (!live) {
      stopPolling()
      if (openNames().size && !instrumentMarkets().length) seed()
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
    if (wsOpen && !polling) lastSignal = now()
    evaluate()
  }

  function onSocketQuote(q) {
    applyQuote(q)
    lastSignal = now()
    scheduleUpdate()
    evaluate()
  }

  function onSocketMarkets(m) {
    for (const x of (m && m.m) || []) markets.set(x.mkt_id ?? marketNames(x).join('|'), x)
    evaluate()
  }

  function onSocketAuthError() {
    emit('auth-error')
    repo.refresh({ force: true, only: ['positions'] }).catch(ignore)
  }

  return {
    quotes,
    isLive,
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
      sock = socketFactory()
      sock.on('status', onSocketStatus)
      sock.on('quote', onSocketQuote)
      sock.on('portfolio', (ps) => { repo.applyPortfolio(ps).catch(ignore) })
      sock.on('markets', onSocketMarkets)
      sock.on('auth-error', onSocketAuthError)
      sock.subscribeMarkets()
      sock.subscribePortfolio()
      tickersKey = ''
      unsubRepo = repo.subscribe(onRepo)
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
      clear(updateTimer)
      updateTimer = null
      evaluate()
    },

    pause() {
      if (!started || paused) return
      paused = true
      sock.close()
      wsOpen = false
      evaluate()
    },

    resume() {
      if (!started || !paused) return
      paused = false
      sock.connect()
      repo.refresh().catch(ignore)
      evaluate()
    },
  }
}
