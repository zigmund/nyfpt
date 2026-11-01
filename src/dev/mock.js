// Dev-only fake broker and socket, enabled by `?mock` in `npm run dev`.
// Positions, trades and cashflows come from tests/fixtures/synthetic-api.json; daily and
// intraday candles (with volumes) are generated deterministically so that each ticker's latest
// close equals its last close in the fixture; getSecurityInfo is synthesized from them. The socket reports market FIX as OPEN and streams quote deltas.
// main.js imports this module dynamically under `import.meta.env.DEV`: never in production builds.
import fixture from '../../tests/fixtures/synthetic-api.json'

const DAY = 86400e3
const MARKET = 'FIX'
const TICK_MS = 1500
const LATENCY_MS = 350
const SESSION_KEY = 'nyfpt.mock.session'

// Index levels and ETF prices not present in the fixture.
const anchors = { 'SP500.IDX': 5800, 'NASDAQ.IDX': 20500, 'USO.US': 74, 'GLD.US': 245, 'SLV.US': 29 }
for (const [tk, rows] of Object.entries(fixture['getHloc.daily'].hloc)) anchors[tk] = rows[rows.length - 1][3]
const names = Object.fromEntries(fixture.getPositionJson.result.ps.pos.map((p) => [p.i, p.name]))

const clone = (v) => JSON.parse(JSON.stringify(v))
const wait = (ms = LATENCY_MS) => new Promise((r) => setTimeout(r, ms))
const r2 = (v) => Math.round(v * 100) / 100
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const midnight = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`)
const isWeekday = (ms) => { const d = new Date(ms).getUTCDay(); return d !== 0 && d !== 6 }

// FNV-1a -> [0, 1): the same ticker and date always give the same move.
function rand(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 2 ** 32
}
const dayMove = (tk, date) => (rand(`${tk}|${date}`) - 0.47) * 0.024

// Latest US trading date (New York is roughly UTC-4; holidays ignored).
function lastSession(now = Date.now()) {
  let ms = midnight(iso(now - 4 * 3600e3))
  while (!isWeekday(ms)) ms -= DAY
  return ms
}

/** [[ms, close]] for weekdays in [fromMs, endMs], ending at the ticker's anchor close. */
function dailyCloses(tk, fromMs, endMs = lastSession()) {
  const out = []
  let c = anchors[tk] ?? 100
  for (let ms = endMs; ms >= fromMs; ms -= DAY) {
    if (!isWeekday(ms)) continue
    out.push([ms, c])
    c /= 1 + dayMove(tk, iso(ms))
  }
  return out.reverse()
}

const candle = (open, close) => [r2(Math.max(open, close) * 1.004), r2(Math.min(open, close) * 0.996), r2(open), r2(close)]

const volume = (tk, ms, scale) => Math.round(scale * (0.5 + rand(`${tk}|v|${ms}`)))

function hlocAnswer(series, scale) {
  const hloc = {}
  const xSeries = {}
  const vl = {}
  for (const [tk, rows] of Object.entries(series)) {
    hloc[tk] = rows.map((r) => r.c)
    xSeries[tk] = rows.map((r) => Math.round(r.ts / 1000))
    vl[tk] = rows.map((r) => volume(tk, r.ts, scale))
  }
  return { hloc, xSeries, vl }
}

function hlocDaily(tickers, dateFrom, count = -6) {
  const back = Math.ceil((Math.abs(Math.min(count, 0)) * 7) / 5) + 3
  const from = midnight(dateFrom) - back * DAY
  const series = {}
  for (const tk of tickers) {
    const closes = dailyCloses(tk, from)
    series[tk] = closes.map(([ms, c], i) => ({ ts: ms, c: candle(i ? closes[i - 1][1] : c, c) }))
  }
  return hlocAnswer(series, 2e6)
}

// 15-minute bars 09:30-15:45 New York time, encoded like the broker (wall clock as UTC).
function hlocIntraday(tickers, dateFrom, dateTo, timeframe = 15) {
  const from = midnight(dateFrom)
  const to = midnight(dateTo)
  const bars = Math.floor((6.5 * 60) / timeframe)
  const series = {}
  for (const tk of tickers) {
    const all = dailyCloses(tk, from - 7 * DAY)
    series[tk] = []
    all.forEach(([ms, close], i) => {
      if (ms < from || ms >= to) return
      const prev = i > 0 ? all[i - 1][1] : close
      let last = prev
      for (let b = 0; b < bars; b++) {
        const k = (b + 1) / bars
        const noise = (rand(`${tk}|${ms}|${b}`) - 0.5) * 0.004 * Math.sin(Math.PI * k)
        const c = prev + (close - prev) * k + close * noise
        series[tk].push({ ts: ms + (9.5 * 60 + b * timeframe) * 60e3, c: candle(last, c) })
        last = c
      }
    })
  }
  return hlocAnswer(series, 8e4)
}

// --- live prices shared by the broker snapshot and the socket deltas
const prices = new Map() // ticker -> {ltp, pp}
function priceOf(tk) {
  if (!prices.has(tk)) {
    const closes = dailyCloses(tk, lastSession() - 7 * DAY)
    const last = closes[closes.length - 1][1]
    const prev = closes.length > 1 ? closes[closes.length - 2][1] : last
    prices.set(tk, { ltp: last, pp: prev })
  }
  return prices.get(tk)
}
function quote(tk) {
  const { ltp, pp } = priceOf(tk)
  return { c: tk, name: names[tk] || tk, ltr: MARKET, ltp: r2(ltp), pp: r2(pp), chg: r2(ltp - pp), pcp: r2(((ltp - pp) / pp) * 100) }
}
function step(tk) {
  const p = priceOf(tk)
  p.ltp *= 1 + (Math.random() - 0.5) * 0.003
  const { c, ltp, chg, pcp } = quote(tk)
  return { c, ltp, chg, pcp }
}

const FUNDS = new Set(['SPY.US', 'QQQ.US', 'USO.US', 'GLD.US', 'SLV.US'])

/** getSecurityInfo-like flat object (subset of fields the card reads). */
function securityInfo(tk) {
  const { ltp, pp } = priceOf(tk)
  const kz = tk.endsWith('.KZ')
  const now = Date.now()
  return {
    c: tk,
    name: names[tk] || tk,
    ltp: r2(ltp),
    pp: r2(pp),
    ClosePrice: r2(pp),
    chg: r2(ltp - pp),
    pcp: r2(((ltp - pp) / pp) * 100),
    mintp: r2(Math.min(ltp, pp) * 0.992),
    maxtp: r2(Math.max(ltp, pp) * 1.006),
    vol: volume(tk, lastSession(now), 2e6),
    kind: FUNDS.has(tk) ? 7 : 1,
    x_curr: kz ? 'KZT' : 'USD',
    codesub_nm: kz ? 'KASE' : FUNDS.has(tk) ? 'ARCA' : 'NASDAQ',
    ltr: kz ? 'KASE' : MARKET,
    ltt: new Date(now - 4 * 3600e3).toISOString().slice(0, 19),
  }
}

const MARKETS = () => ({
  t: new Date().toISOString().slice(0, 19).replace('T', ' '),
  m: [{ mkt_id: 1, n: MARKET, n2: MARKET, s: 'OPEN', o: '09:30:00', c: '16:00:00', dt: '0' }],
})

export function createMockBroker() {
  return {
    async positions() {
      await wait()
      const a = clone(fixture.getPositionJson)
      for (const p of a.result.ps.pos) {
        p.mkt_price = r2(priceOf(p.i).ltp)
        p.close_price = r2(priceOf(p.i).pp) // previous close: Day % / Day $ outside live mode
        p.market_value = r2(p.q * p.mkt_price)
        p.bal_price_a = r2(p.mkt_price * (0.85 + rand(`${p.i}|cost`) * 0.25)) // average cost
      }
      return a
    },
    async trades(beginDate) {
      await wait()
      const a = clone(fixture.getTradesHistory)
      a.trades.trade = a.trades.trade.filter((x) => String(x.date).slice(0, 10) >= String(beginDate).slice(0, 10))
      return a
    },
    async cashflows() { await wait(); return clone(fixture.getUserCashFlows) },
    async quotes(tickers) { await wait(150); return { result: { q: tickers.map(quote) } } },
    async hlocDaily(tickers, dateFrom, count) { await wait(); return hlocDaily(tickers, dateFrom, count) },
    async hlocIntraday(tickers, dateFrom, dateTo, tf) { await wait(); return hlocIntraday(tickers, dateFrom, dateTo, tf) },
    async securityInfo(tk) { await wait(200); return securityInfo(tk) },
    async marketStatus() { await wait(150); return { result: { markets: MARKETS() } } },
    async checkSession() { return { SID: 'mock-sid', user_id: 'mock' } },
  }
}

/** Same surface as api/ws.js LiveSocket, driven by timers. */
export class MockSocket {
  constructor() {
    this.handlers = new Map()
    this.tickers = []
    this.subs = new Set()
    this.isOpen = false
    this.openTimer = null
    this.tickTimer = null
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event).add(fn)
    return () => this.handlers.get(event).delete(fn)
  }

  emit(event, ...args) {
    for (const fn of this.handlers.get(event) || []) fn(...args)
  }

  connect() {
    if (this.isOpen || this.openTimer) return
    this.openTimer = setTimeout(() => {
      this.openTimer = null
      this.isOpen = true
      this.emit('status', 'open')
      if (this.subs.has('markets')) this.emit('markets', MARKETS())
      this.snapshot()
      this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    }, LATENCY_MS)
  }

  close() {
    clearTimeout(this.openTimer)
    clearInterval(this.tickTimer)
    this.openTimer = null
    this.tickTimer = null
    if (this.isOpen) {
      this.isOpen = false
      this.emit('status', 'closed')
    }
  }

  setQuotes(tickers) {
    this.tickers = [...tickers]
    if (this.isOpen) this.snapshot()
  }

  subscribePortfolio() { this.subs.add('portfolio') }

  subscribeMarkets() {
    this.subs.add('markets')
    if (this.isOpen) this.emit('markets', MARKETS())
  }

  snapshot() {
    for (const tk of this.tickers) this.emit('quote', quote(tk))
  }

  tick() {
    if (!this.tickers.length) return
    const n = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < n; i++) {
      this.emit('quote', step(this.tickers[Math.floor(Math.random() * this.tickers.length)]))
    }
  }
}

const SESSION = { sid: 'mock-sid', userId: 'mock' }

/** Dependency overrides for createAppState(): any credentials log in. */
export function mockDeps() {
  return {
    mock: true,
    auth: {
      async loginByPassword() { await wait(); return { ...SESSION } },
      async requestPhoneCode() { await wait(); return { authCodeId: 'mock-code', codeLength: 6 } },
      async loginByPhoneCode() { await wait(); return { ...SESSION } },
    },
    createBroker: () => createMockBroker(),
    socketFactory: () => () => new MockSocket(),
    // Separate per-tab storage so the mock never replaces a real session.
    sessionStore: {
      load() {
        try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) } catch { return null }
      },
      save(s) {
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) } catch { /* unavailable */ }
      },
      clear() {
        try { sessionStorage.removeItem(SESSION_KEY) } catch { /* unavailable */ }
      },
    },
  }
}
