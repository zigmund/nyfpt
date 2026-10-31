// Dev-only fake broker and socket, enabled by `?mock` in `npm run dev`.
// Positions, trades and cashflows come from tests/fixtures/synthetic-api.json; daily and
// intraday candles (with volumes) are generated deterministically so that each ticker's latest
// close equals its last close in the fixture; getSecurityInfo is synthesized from them. The socket reports market FIX as OPEN and streams quote deltas.
// News: synthetic per ticker (see newsList below).
// tickerFinder: a small synthetic universe (FINDER); UNKNOWN tickers make getHloc fail like the broker.
// main.js imports this module dynamically under `import.meta.env.DEV`: never in production builds.
import fixture from '../../tests/fixtures/synthetic-api.json'
import { BrokerError } from '../api/transport.js'

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

// The fake broker's server and markets run on UTC (getMarketStatus t = UTC, dt 0), so the
// candle axis is the market's wall clock and dates are UTC dates. Session hours: FAKE_HOURS.
const FAKE_HOURS = { o: '09:30:00', c: '16:00:00' }
const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

// Latest trading date (holidays ignored).
function lastSession(now = Date.now()) {
  let ms = midnight(iso(now))
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

const marketOf = (tk) => (tk.endsWith('.KZ') ? 'KASE' : MARKET)

function hlocAnswer(series, scale) {
  const hloc = {}
  const xSeries = {}
  const vl = {}
  const info = {}
  for (const [tk, rows] of Object.entries(series)) {
    hloc[tk] = rows.map((r) => r.c)
    xSeries[tk] = rows.map((r) => Math.round(r.ts / 1000))
    vl[tk] = rows.map((r) => volume(tk, r.ts, scale))
    info[tk] = { id: tk, mkt_name: marketOf(tk), mrkt: { ...FAKE_HOURS, dt: 0 } }
  }
  return { hloc, xSeries, vl, info }
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

// 15-minute bars over FAKE_HOURS, encoded like the broker (wall clock on the axis).
function hlocIntraday(tickers, dateFrom, dateTo, timeframe = 15) {
  const from = midnight(dateFrom)
  const to = midnight(dateTo)
  const open = hm(FAKE_HOURS.o)
  const bars = Math.floor((hm(FAKE_HOURS.c) - open) / timeframe)
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
        series[tk].push({ ts: ms + (open + b * timeframe) * 60e3, c: candle(last, c) })
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

// --- tickerFinder: synthetic instruments [ticker, name, market]; UNKNOWN: found, but no candles.
const UNKNOWN = new Set(['GONE.US'])
const FINDER = [
  ...Object.entries(names).map(([t, nm]) => [t, nm, marketOf(t)]),
  ['SP500.IDX', 'S&P 500 Index', 'FIX'], ['NASDAQ.IDX', 'Nasdaq 100 Index', 'FIX'], ['DJI.IDX', 'Dow Jones Industrial Average', 'FIX'],
  ['SPY.US', 'Mock S&P 500 ETF', 'FIX'], ['QQQ.US', 'Mock Nasdaq 100 ETF', 'FIX'], ['DIA.US', 'Mock Dow ETF', 'FIX'],
  ['IWM.US', 'Mock Small Cap ETF', 'FIX'], ['USO.US', 'Mock Oil Fund', 'FIX'], ['GLD.US', 'Mock Gold Trust', 'FIX'],
  ['SLV.US', 'Mock Silver Trust', 'FIX'], ['UNG.US', 'Mock Natural Gas Fund', 'FIX'], ['TLT.US', 'Mock Long Treasury Bond ETF', 'FIX'],
  ['EEE.US', 'Echo Mock Holdings With A Very Long Company Name Incorporated', 'FIX'], ['GONE.US', 'Gone Mock Corp (no data)', 'FIX'],
  ['KZM.KZ', 'Kazakh Mock Bank', 'KASE'], ['EUR/USD', 'Euro / US Dollar', 'FX'],
]
function tickerFinder(text) {
  const q = String(text || '').trim().toLowerCase()
  const found = FINDER.filter(([t, nm]) => t.toLowerCase().includes(q) || nm.toLowerCase().includes(q))
    .slice(0, 30).map(([t, nm, mkt], i) => ({ instr_id: 1000 + i, t, nm, n: nm, mkt, type: 1, kind: 1 }))
  return { found }
}
const known = (tickers) => {
  const bad = tickers.filter((t) => UNKNOWN.has(t))
  if (bad.length) throw new BrokerError(`Instruments not found: ${bad.join(', ')}`, { cmd: 'getHloc' })
}

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
    ltr: marketOf(tk),
    ltt: new Date(now).toISOString().slice(0, 19),
  }
}

// --- news (getNewsList / getNewsDetail): server wall clock = UTC here, like the candles.
// CCC_KZ.KZ / *.KZ: Russian only; BBB.US: no news at all; any other ticker: 45 English items
// (pages of 20, the third page repeats the last row of the second). The first article mixes
// allowed and disallowed HTML; Russian articles are plain text.
const NEWS_EN_TOTAL = 45
const NEWS_EMPTY = new Set(['BBB.US'])
const newsById = new Map()
const wall = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const MIXED_HTML = [
  '<h2>What the mock article shows</h2>',
  '<p>Allowed: <b>bold</b>, <i>italic</i>, <strong>strong</strong> and a <a href="https://example.com/safe" onclick="alert(1)" target="_self">safe https link</a>.</p>',
  '<script>alert("mock script")</script><style>p { color: red }</style>',
  '<p><img src="x" onerror="alert(1)">The image before this sentence was dropped.</p>',
  '<p><a href="javascript:alert(1)">A javascript: link shown as text</a>, <a href="/relative">a relative one</a>, <a href="http://example.com/">plain http</a>.</p>',
  '<div><span style="color:red" class="x">Text of an unwrapped div and span.</span></div>',
  '<svg onload="alert(1)"><a href="https://example.com/svg">svg link (dropped)</a></svg>',
  '<iframe src="https://example.com/frame"></iframe>',
  '<h1>An h1 becomes a paragraph</h1>',
  '<ul><li>First point</li><li>Second <em>point</em></li></ul>',
  '<blockquote>A quoted line.</blockquote>',
].join('')

function mockNews(tk, lang) {
  if (NEWS_EMPTY.has(tk)) return []
  const kz = tk.endsWith('.KZ')
  if (kz !== (lang === 'ru')) return []
  const base = Math.floor(rand(`news|${tk}`) * 1e6) * 100
  const n = kz ? 3 : NEWS_EN_TOTAL
  const now = Date.now()
  const sentiments = ['positive', 'negative', 'neutral', '']
  return Array.from({ length: n }, (_, i) => {
    const id = base + i
    const at = kz ? now - (400 + i * 40) * DAY : now - (i * 2 * 3600 + 17 * 60) * 1000
    const item = {
      id,
      title: kz ? `Новость по ${tk} номер ${i + 1}` : `${tk}: mock headline number ${i + 1} about the company and its market`,
      provider: i % 3 ? 'Oninvest' : 'OninvestCompanyNews',
      providerAlias: 'oninvest',
      lang,
      date: wall(at),
      url: i % 3 === 0 ? `https://example.com/news/${id}` : i % 3 === 1 ? `/news/${id}` : '',
      sentiment: sentiments[i % 4],
      tickers: [tk, 'SPY.US', 'QQQ.US', 'AAA.US'],
      images: [],
    }
    newsById.set(String(id), {
      ...item,
      dateTime: item.date,
      timeZone: '+0000',
      text: kz ? `Первый абзац новости ${i + 1}.\nВторая строка того же абзаца.\n\nВторой абзац.`
        : i === 0 ? MIXED_HTML : `<p>Mock article ${i + 1} for ${tk}.</p><p>Second <b>paragraph</b>.</p>`,
    })
    return item
  })
}

function newsList({ ticker, lang, take = 20, skip = 0 }) {
  const all = mockNews(ticker, lang)
  const from = skip >= 40 ? skip - 1 : skip // a repeated row: the app drops duplicates
  return { list: all.slice(from, skip + take), total: all.length, take, skip }
}

function newsDetail(id) {
  const d = newsById.get(String(id))
  if (d) return d
  return { id, title: 'Mock article', provider: 'Oninvest', lang: 'en', dateTime: wall(Date.now() - 3600e3), timeZone: '+0000', url: '', text: '<p>Opened by link before its list was loaded.</p>' }
}

const MARKETS = () => ({
  t: new Date().toISOString().slice(0, 19).replace('T', ' '),
  m: [
    { mkt_id: 1, n: MARKET, n2: MARKET, s: 'OPEN', ...FAKE_HOURS, dt: '0' },
    { mkt_id: 2, n: 'KASE', n2: 'KASE', s: 'CLOSE', ...FAKE_HOURS, dt: '0' },
  ],
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
    async quotes(tickers) { await wait(150); return { result: { q: tickers.filter((t) => !UNKNOWN.has(t)).map(quote) } } },
    async hlocDaily(tickers, dateFrom, count) { await wait(); known(tickers); return hlocDaily(tickers, dateFrom, count) },
    async hlocIntraday(tickers, dateFrom, dateTo, tf) { await wait(); known(tickers); return hlocIntraday(tickers, dateFrom, dateTo, tf) },
    async tickerFinder(text) { await wait(300); return tickerFinder(text) },
    async securityInfo(tk) { await wait(200); return securityInfo(tk) },
    async marketStatus() { await wait(150); return { result: { markets: MARKETS() } } },
    async checkSession() { return { SID: 'mock-sid', user_id: 'mock' } },
    async newsList(q) { await wait(600); return newsList(q) },
    async newsDetail(id) { await wait(250); return newsDetail(id) },
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
    this.tickers = tickers.filter((t) => !UNKNOWN.has(t))
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
