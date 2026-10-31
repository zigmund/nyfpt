// @vitest-environment happy-dom
// Position card (Task 20): route, tabs, Summary (header, My holdings, Key statistics), data layer.
// Synthetic data only.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, ref, nextTick } from 'vue'
import App from '../src/App.vue'
import PositionScreen from '../src/components/PositionScreen.vue'
import { installApp, parseHash, positionRoute, positionPath, createAppState } from '../src/composables/useApp.js'
import {
  parseCandles, keyStats, positionHolding, chartRows, chartStart, sessionBounds, tabsFor, rangePos, CARD_TABS,
} from '../src/calc/position.js'
import { lastTradeTime } from '../src/composables/usePosition.js'
import { createBroker } from '../src/api/broker.js'
import { createRepo } from '../src/data/repo.js'
import { openAccountDb } from '../src/store/db.js'
import { money, pct } from '../src/format.js'
import { t } from '../src/i18n.js'

const TS = (d, hh = 0, mm = 0) => Date.parse(`${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) / 1000

// --- synthetic broker data
const PS = {
  acc: [{ curr: 'USD', currval: 1, s: 100 }],
  pos: [
    { i: 'AAA.US', name: 'Alpha Corp', q: 10, mkt_price: 110, market_value: 1100, close_price: 100, bal_price_a: 80, curr: 'USD', currval: 1 },
    { i: 'KZT.KZ', name: 'Kappa', q: 100, mkt_price: 500, market_value: 100, close_price: 490, bal_price_a: 400, curr: 'KZT', currval: 0.002 },
  ],
}
const INFO = {
  c: 'AAA.US', name: 'Alpha Corporation', ltp: 110, pp: 100, ClosePrice: 108, mintp: 99, maxtp: 112, vol: 1234567,
  kind: 1, x_curr: 'USD', codesub_nm: 'NASDAQ', ltr: 'FIX', ltt: '2026-10-30T19:58:25', op: 1,
}
// 300 daily candles: close 50..349, high = close + 2, low = close - 2, open = close - 1, volume 1000 + i.
const DAILY = Array.from({ length: 300 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 8, 1) + i * 864e5).toISOString().slice(0, 10)
  return { ts: TS(d), date: d, high: 52 + i, low: 48 + i, open: 49 + i, close: 50 + i, vol: 1000 + i }
})
// Two sessions of 15-min bars from 01:00 to 16:45 (broker encoding), the main session 06:30-12:45.
const bars = (d, from) => Array.from({ length: 64 }, (_, k) => {
  const ts = TS(d, 1) + k * 900
  return { ts, date: d, high: from + k + 1, low: from + k - 1, open: from + k, close: from + k, vol: 10 }
})
const INTRADAY = [...bars('2026-10-29', 90), ...bars('2026-10-30', 100)]
const SESSIONS = sessionBounds([
  { date: '2026-10-30', ts: TS('2026-10-30', 6, 30) }, { date: '2026-10-30', ts: TS('2026-10-30', 12, 45) },
])
const SEC = { info: INFO, intraday: INTRADAY, daily: DAILY, max: null, sessions: SESSIONS, errors: {}, loading: [] }

// computeCore-like period rows: ZZZ.US was closed within the period.
const CORE_YTD = {
  series: [], summary: null,
  positions: [{ ticker: 'ZZZ.US', name: 'Zeta', status: 'закрыта', qty_start: 5, qty_end: 0, price_start: 20, price_end: 22, change_pct: 10, pnl: 9.5, value: 0, weight: 0 }],
}

function setup({ route = '/position/AAA.US', sec = SEC, quotes = null, prefs = {}, ps = PS, openFor = null } = {}) {
  const q = new Map(Object.entries(quotes || {}))
  const app = {
    session: ref({ cabinetId: 'global', sid: 's', userId: 1 }),
    expired: ref(false),
    fatal: ref(''),
    route: ref(route),
    state: ref({ rawPs: ps, positions: [], trades: [] }),
    tick: ref(0),
    live: { isLive: ref(!!quotes), usOpen: ref(false), quotes: q },
    prefs: reactive({ hide: false, period: 'YTD', sorts: {}, ...prefs }),
    liveQuotesForCalc: () => (quotes ? q : undefined),
    // live for this security: its own market open (default: open whenever quotes stream)
    isLiveFor: vi.fn((tk) => (openFor ? openFor.includes(tk) : !!quotes)),
    coreFor: vi.fn((p) => (p === 'YTD' ? CORE_YTD : null)),
    ensurePrices: vi.fn(async () => {}),
    security: vi.fn(() => sec),
    loadSecurity: vi.fn(async () => {}),
    go: vi.fn((p) => { app.route.value = p }),
    logout: vi.fn(),
    retry: vi.fn(),
  }
  installApp(app)
  return app
}
const mountCard = (props = {}) => mount(PositionScreen, { props: { ticker: 'AAA.US', ...props } })

beforeEach(() => { window.location.hash = '' })
afterEach(() => { installApp(null); vi.useRealTimers() })

describe('position route', () => {
  it('parses and builds card paths', () => {
    expect(parseHash('#/position/AAA.US')).toBe('/position/AAA.US')
    expect(parseHash('#/position/AAA.US/news')).toBe('/position/AAA.US/news')
    expect(parseHash('#/position/')).toBe('/')
    expect(parseHash('#/position/%E0%A4%A')).toBe('/') // broken encoding
    expect(positionRoute('/position/AAA.US')).toEqual({ ticker: 'AAA.US', tab: 'summary' })
    expect(positionRoute('/position/BRK%2FB.US/summary')).toEqual({ ticker: 'BRK/B.US', tab: 'summary' })
    expect(positionRoute('/compare')).toBeNull()
    expect(positionPath('BRK/B.US')).toBe('/position/BRK%2FB.US')
    expect(positionPath('AAA.US', 'news')).toBe('/position/AAA.US/news')
  })

  it('go() reaches a card with a session; hashchange is routed too', async () => {
    const app = createAppState({
      sessionStore: { load: () => ({ cabinetId: 'global', sid: 's', userId: 1, loggedAt: 0 }), save() {}, clear() {} },
      prefsStore: { load: () => ({}), save() {} },
      openAccountDb: async () => ({ close() {}, clear: async () => {} }),
      createBroker: () => ({}),
      createRepo: () => ({ subscribe: () => () => {}, onSessionExpired: () => () => {}, load: async () => {} }),
      createLive: () => ({ quotes: new Map(), isLive: () => false, marketsOpen: () => ({}), on: () => () => {}, start() {}, stop() {}, pause() {} }),
    })
    app.start()
    app.go('/position/AAA.US')
    expect(app.route.value).toBe('/position/AAA.US')
    expect(window.location.hash).toBe('#/position/AAA.US')
    window.location.hash = '#/position/BBB.US'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(app.route.value).toBe('/position/BBB.US')
    app.stop()
  })

  it('App renders the card for a position route', () => {
    setup()
    const w = mount(App)
    expect(w.get('[data-test="p-ticker"]').text()).toBe('AAA.US')
  })

  it('Back goes to the main screen', async () => {
    const app = setup()
    const w = mountCard()
    await w.get('[data-test="back"]').trigger('click')
    expect(app.go).toHaveBeenCalledWith('/')
  })
})

describe('tabs', () => {
  it('filters tabs by security kind; Summary only for now', () => {
    const list = [{ id: 'summary' }, { id: 'news' }, { id: 'analysis', kinds: [1, 2] }]
    expect(tabsFor(1, list).map((x) => x.id)).toEqual(['summary', 'news', 'analysis'])
    expect(tabsFor(7, list).map((x) => x.id)).toEqual(['summary', 'news'])
    expect(tabsFor(null, list).map((x) => x.id)).toEqual(['summary', 'news'])
    expect(CARD_TABS.map((x) => x.id)).toEqual(['summary'])
  })

  it('renders the tab list; an unknown tab falls back to Summary; switching replaces history', async () => {
    const app = setup()
    const w = mountCard({ tab: 'financials' })
    const tabs = w.findAll('[role="tab"]')
    expect(tabs.map((x) => x.text())).toEqual([t('pos.tab.summary')])
    expect(tabs[0].attributes('aria-selected')).toBe('true')
    expect(w.find('[data-test="p-price"]').exists()).toBe(true)
    await tabs[0].trigger('click')
    expect(app.go).toHaveBeenCalledWith('/position/AAA.US', { replace: true })
  })
})

describe('Summary', () => {
  it('header: name, venue, price, day change, "At close" when not live', () => {
    setup()
    const w = mountCard()
    expect(w.get('[data-test="p-name"]').text()).toBe('Alpha Corp (AAA.US)')
    expect(w.get('[data-test="p-venue"]').text()).toBe('NASDAQ · USD')
    expect(w.get('[data-test="p-price"]').text()).toBe('110.00')
    expect(w.get('[data-test="p-change"]').text()).toBe(`+10.00 (${pct(10)})`)
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.atClose', { at: 'Oct 30, 2026, 7:58 PM' }))
    expect(w.get('[data-test="p-change"]').classes()).toContain('pos')
  })

  it('live: price and change follow the quote; "Live" label', async () => {
    const app = setup({ quotes: { 'AAA.US': { c: 'AAA.US', ltp: 95, pp: 100 } } })
    const w = mountCard()
    expect(w.get('[data-test="p-price"]').text()).toBe('95.00')
    expect(w.get('[data-test="p-change"]').text()).toBe(`−5.00 (${pct(-5)})`)
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.live'))
    app.live.quotes.set('AAA.US', { c: 'AAA.US', ltp: 120, pp: 100 })
    app.tick.value++
    await nextTick()
    expect(w.get('[data-test="p-price"]').text()).toBe('120.00')
    // My holdings follow the live price too: 10 x (120 - 100)
    expect(w.get('[data-test="ph-day"]').text()).toContain(money(200, { sign: true }))
  })

  it("app live but this security's market closed: 'At close', no live 1D bar", () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-30T17:00:00Z'))
    const quotes = { 'AAA.US': { c: 'AAA.US', ltp: 999, pp: 100 } }
    setup({ quotes, openFor: [] })
    const w = mountCard()
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.atClose', { at: 'Oct 30, 2026, 7:58 PM' }))
    expect(w.get('[data-test="p-chart"]').text()).not.toContain('999.00')
    installApp(null)
    setup({ quotes, openFor: ['AAA.US'] })
    const w2 = mountCard()
    expect(w2.get('[data-test="p-asof"]').text()).toBe(t('pos.live'))
    expect(w2.get('[data-test="p-chart"]').text()).toContain('999.00') // last bar follows the quote
  })

  it('My holdings: day and total gain from the average cost, shares, market value', () => {
    setup()
    const w = mountCard()
    expect(w.get('[data-test="ph-day"]').text()).toBe(`${money(100, { sign: true })} (${pct(10)})`)
    expect(w.get('[data-test="ph-total"]').text()).toBe(`${money(300, { sign: true })} (${pct(37.5)})`)
    expect(w.get('[data-test="ph-shares"]').text()).toBe('10')
    expect(w.get('[data-test="ph-avg"]').text()).toBe('80.00')
    expect(w.get('[data-test="ph-value"]').text()).toBe(money(1100))
  })

  it('hide amounts: money and shares become ***, percents and prices stay', () => {
    setup({ prefs: { hide: true } })
    const w = mountCard()
    expect(w.get('[data-test="ph-day"]').text()).toBe(`*** (${pct(10)})`)
    expect(w.get('[data-test="ph-total"]').text()).toBe(`*** (${pct(37.5)})`)
    expect(w.get('[data-test="ph-shares"]').text()).toBe('***')
    expect(w.get('[data-test="ph-value"]').text()).toBe('***')
    expect(w.get('[data-test="ph-avg"]').text()).toBe('80.00')
    expect(w.get('[data-test="p-price"]').text()).toBe('110.00')
    expect(w.get('[data-test="p-holdings"]').text()).not.toContain('$')
  })

  it('closed position: period result instead of market value', () => {
    setup({ route: '/position/ZZZ.US', sec: { ...SEC, info: { ...INFO, c: 'ZZZ.US', name: 'Zeta' } } })
    const w = mountCard({ ticker: 'ZZZ.US' })
    expect(w.find('[data-test="ph-value"]').exists()).toBe(false)
    expect(w.get('[data-test="ph-closed"]').text()).toBe(t('pos.closed'))
    const r = w.get('[data-test="ph-period"]')
    expect(r.text()).toBe(`${money(9.5, { sign: true })} (${pct(10)})`)
    expect(w.get('[data-test="p-holdings"]').text()).toContain(t('pos.periodResult', { period: 'YTD' }))
  })

  it('no position and no period row: no My holdings block', () => {
    setup({ sec: { ...SEC, info: { ...INFO, c: 'QQQ.US' } } })
    const w = mountCard({ ticker: 'QQQ.US' })
    expect(w.find('[data-test="p-holdings"]').exists()).toBe(false)
  })

  it('Key statistics: Task 22 set, ranges with markers, missing values hidden', () => {
    setup()
    const w = mountCard()
    const stats = w.get('[data-test="p-stats"]')
    expect(stats.get('[data-test="pk-prevClose"]').text()).toContain('100.00')
    // regular-session open: the 06:30 bar (k = 22) of the last session, not the daily candle (348)
    expect(stats.get('[data-test="pk-open"]').text()).toContain('122.00')
    expect(stats.get('[data-test="pk-volume"]').text()).toContain('1,234,567')
    expect(stats.get('[data-test="pk-kind"]').text()).toContain(t('pos.kind.stock'))
    expect(stats.get('[data-test="pk-day"]').text()).toContain('99.00')
    expect(stats.get('[data-test="pk-day"]').text()).toContain('112.00')
    expect(stats.get('[data-test="pk-year"]').text()).toContain(`${(48 + 48).toFixed(2)}`)
    // No P/E, beta, market cap, yield, NAV.
    for (const k of ['pe', 'beta', 'marketCap', 'yield', 'nav']) expect(stats.find(`[data-test="pk-${k}"]`).exists()).toBe(false)

    installApp(null)
    setup({ sec: { ...SEC, info: { ...INFO, mintp: 0, maxtp: 0, vol: null, kind: 5 } } })
    const w2 = mountCard()
    expect(w2.find('[data-test="pk-day"]').exists()).toBe(false)
    expect(w2.find('[data-test="pk-volume"]').exists()).toBe(false)
    expect(w2.find('[data-test="pk-kind"]').exists()).toBe(false)
    expect(w2.find('[data-test="pk-year"]').exists()).toBe(true)
  })

  it('chart periods: persisted in prefs, fetch the needed dataset', async () => {
    const app = setup()
    const w = mountCard()
    await flushPromises()
    expect(app.loadSecurity).toHaveBeenLastCalledWith('AAA.US', ['info', 'daily', 'intraday'], { force: false })
    await w.get('[data-cperiod="5Y"]').trigger('click')
    await flushPromises()
    expect(app.prefs.cardPeriod).toBe('5Y')
    expect(app.loadSecurity).toHaveBeenLastCalledWith('AAA.US', ['info', 'daily', 'intraday', 'max'], { force: false })
    await w.get('[data-cperiod="6M"]').trigger('click')
    await flushPromises()
    // intraday bars are always needed: Key statistics' Open
    expect(app.loadSecurity).toHaveBeenLastCalledWith('AAA.US', ['info', 'daily', 'intraday'], { force: false })
  })

  it('draws the 1D chart with the previous close level and volume bars', () => {
    setup()
    const w = mountCard()
    expect(w.find('[data-test="p-chart"] svg').exists()).toBe(true)
    expect(w.find('[data-test="pc-base"]').exists()).toBe(true)
    expect(w.find('[data-test="pc-vol"]').exists()).toBe(true)
  })

  it('info error with nothing cached: message with retry', async () => {
    const app = setup({ sec: { ...SEC, info: null, errors: { info: 'boom' } } })
    const w = mountCard()
    const b = w.get('[data-test="p-error"]')
    expect(b.text()).toContain(t('pos.error'))
    await b.get('button').trigger('click')
    expect(app.loadSecurity).toHaveBeenLastCalledWith('AAA.US', ['info', 'daily', 'intraday'], { force: true })
  })
})

describe('calc', () => {
  it('parseCandles: [high, low, open, close], volumes, NY dates, ascending', () => {
    const rows = parseCandles({
      hloc: { 'AAA.US': [[12, 9, 10, 11], [13, 10, 11, 12]] },
      xSeries: { 'AAA.US': [TS('2026-10-29', 21), TS('2026-10-28', 21)] },
      vl: { 'AAA.US': [100, 200] },
    }, 'AAA.US')
    expect(rows).toEqual([
      { ts: TS('2026-10-28', 21), date: '2026-10-29', high: 13, low: 10, open: 11, close: 12, vol: 200 },
      { ts: TS('2026-10-29', 21), date: '2026-10-30', high: 12, low: 9, open: 10, close: 11, vol: 100 },
    ])
    expect(parseCandles({ hloc: {} }, 'AAA.US')).toEqual([])
  })

  it('keyStats: prev close pp, open from the last daily candle, 52 weeks and 3M volume from candles', () => {
    const s = keyStats({ info: INFO, daily: DAILY })
    expect(s.prevClose).toBe(100)
    expect(s.open).toBe(49 + 299)
    expect(s.dayLow).toBe(99)
    expect(s.dayHigh).toBe(112)
    expect(s.low52).toBe(48 + 48) // last 252 candles: i = 48..299
    expect(s.high52).toBe(52 + 299)
    expect(s.volume).toBe(1234567)
    expect(s.avgVolume).toBe(1000 + (237 + 299) / 2) // last 63 candles: i = 237..299
    expect(s.kind).toBe('stock')
    expect(keyStats({ info: { kind: 7 } }).kind).toBe('fund')
    // no intraday bars: the daily candle open is the fallback
    expect(keyStats({ info: INFO, daily: DAILY, intraday: [] }).open).toBe(348)
    expect(keyStats({})).toMatchObject({ prevClose: null, open: null, low52: null, avgVolume: null, kind: null })
  })

  it('keyStats: Open = first regular-session bar of the last session (pre-market skipped)', () => {
    expect(keyStats({ info: INFO, daily: DAILY, intraday: INTRADAY, sessions: SESSIONS }).open).toBe(122)
    // no session bounds (KASE and others): the session's own first bar, as on the 1D chart
    expect(keyStats({ info: INFO, daily: DAILY, intraday: INTRADAY, sessions: null }).open).toBe(100)
  })

  it('positionHolding: USD and foreign-currency positions, zero qty', () => {
    expect(positionHolding(PS, 'AAA.US', { price: 110, prevClose: 100 })).toEqual({
      qty: 10, currency: 'USD', avgCost: 80, dayGain: 100, dayGainPct: 10, totalGain: 300, totalGainPct: 37.5, marketValue: 1100,
    })
    // KZT position: fx = 0.002 -> 100 x (510 - 490) x 0.002 = 4 USD
    const k = positionHolding(PS, 'KZT.KZ', { price: 510, prevClose: 490 })
    expect(k.dayGain).toBeCloseTo(4)
    expect(k.totalGain).toBeCloseTo(100 * 110 * 0.002)
    expect(k.marketValue).toBeCloseTo(102)
    expect(k.avgCost).toBe(400)
    // average cost falls back to open_bal / q
    const ob = { acc: PS.acc, pos: [{ i: 'X.US', q: 4, mkt_price: 10, market_value: 40, open_bal: 32, currval: 1 }] }
    expect(positionHolding(ob, 'X.US', { price: 10 }).avgCost).toBe(8)
    expect(positionHolding({ ...PS, pos: [{ ...PS.pos[0], q: 0 }] }, 'AAA.US')).toBeNull()
    expect(positionHolding(PS, 'NOPE.US')).toBeNull()
  })

  it('chartRows: 1D = last session inside the regular session with NY minutes; 5D keeps both days', () => {
    const d1 = chartRows('1D', { intraday: INTRADAY }, { today: '2026-10-30', sessions: SESSIONS })
    expect(d1.every((r) => r.date === '2026-10-30')).toBe(true)
    expect(d1[0].ts).toBe(TS('2026-10-30', 6, 30))
    expect(d1[0].min).toBe(9 * 60 + 30)
    expect(d1.at(-1).ts).toBe(TS('2026-10-30', 12, 45))
    expect(d1.at(-1).min).toBe(15 * 60 + 45)
    const d5 = chartRows('5D', { intraday: INTRADAY }, { today: '2026-10-30', sessions: SESSIONS })
    // the older day has no index bars: the latest session's time of day applies
    expect(new Set(d5.map((r) => r.date))).toEqual(new Set(['2026-10-29', '2026-10-30']))
    expect(d5.filter((r) => r.date === '2026-10-29')).toHaveLength(26)
    // without session data all bars stay
    expect(chartRows('1D', { intraday: INTRADAY }, {})).toHaveLength(64)
  })

  it('chartRows: US pre-market (today has only pre-market bars) keeps the last real sessions', () => {
    const pre = bars('2026-10-31', 200).slice(0, 22) // 01:00-06:15 = 04:00-09:15 NY, no index bars yet
    const intraday = [...INTRADAY, ...pre]
    const d1 = chartRows('1D', { intraday }, { today: '2026-10-31', sessions: SESSIONS })
    expect(d1).toHaveLength(26)
    expect(d1.every((r) => r.date === '2026-10-30')).toBe(true)
    const d5 = chartRows('5D', { intraday }, { today: '2026-10-31', sessions: SESSIONS })
    expect(new Set(d5.map((r) => r.date))).toEqual(new Set(['2026-10-29', '2026-10-30']))
    expect(keyStats({ info: INFO, daily: DAILY, intraday, sessions: SESSIONS }).open).toBe(122)
  })

  // During a session: 10-29 full index session, 10-30 index bars only up to 08:00 (11:00 NY).
  const LIVE_SESSIONS = sessionBounds([
    { date: '2026-10-29', ts: TS('2026-10-29', 6, 30) }, { date: '2026-10-29', ts: TS('2026-10-29', 12, 45) },
    { date: '2026-10-30', ts: TS('2026-10-30', 6, 30) }, { date: '2026-10-30', ts: TS('2026-10-30', 8, 0) },
  ])

  it('chartRows 5D during a session: older days keep a full session, not today\'s time of day', () => {
    const intraday = [...bars('2026-10-28', 80), ...INTRADAY] // 10-28: no index bars
    const d5 = chartRows('5D', { intraday }, { today: '2026-10-30', sessions: LIVE_SESSIONS })
    const on = (d) => d5.filter((r) => r.date === d)
    expect(on('2026-10-28')).toHaveLength(26)
    expect(on('2026-10-28').at(-1).min).toBe(15 * 60 + 45)
    expect(on('2026-10-29')).toHaveLength(26)
    // today is open-ended up to a full session, post-market still excluded
    expect(on('2026-10-30')).toHaveLength(26)
    expect(on('2026-10-30').at(-1).ts).toBe(TS('2026-10-30', 12, 45))
  })

  it('chartRows 1D: today\'s newest bars stay while the index bars lag', () => {
    const today = bars('2026-10-30', 100).filter((r) => r.ts <= TS('2026-10-30', 8, 30)) // stock up to 11:30 NY
    const d1 = chartRows('1D', { intraday: [...bars('2026-10-29', 90), ...today] }, { today: '2026-10-30', sessions: LIVE_SESSIONS })
    expect(d1).toHaveLength(9) // 09:30 .. 11:30 NY
    expect(d1.at(-1).min).toBe(11 * 60 + 30)
  })

  it('chartRows: daily periods keep the last close before the start as the baseline', () => {
    expect(chartStart('YTD', '2026-03-10')).toBe('2025-12-31')
    expect(chartStart('1M', '2026-03-10')).toBe('2026-02-10')
    expect(chartStart('ALL', '2026-03-10')).toBeNull()
    const rows = chartRows('1M', { daily: DAILY }, { today: DAILY.at(-1).date })
    const start = chartStart('1M', DAILY.at(-1).date)
    expect(rows[0].date <= start).toBe(true)
    expect(rows[1].date > start).toBe(true)
    expect(rows.at(-1)).toEqual(DAILY.at(-1))
    expect(chartRows('ALL', { max: DAILY }, { today: '2026-11-01' })).toHaveLength(300)
  })

  it('rangePos clamps; unknown range is null', () => {
    expect(rangePos(105, 100, 110)).toBe(0.5)
    expect(rangePos(120, 100, 110)).toBe(1)
    expect(rangePos(90, 100, 110)).toBe(0)
    expect(rangePos(105, null, 110)).toBeNull()
    expect(rangePos(105, 110, 110)).toBeNull()
  })

  it('lastTradeTime formats the broker wall clock without a zone shift', () => {
    expect(lastTradeTime('2026-10-30T19:58:25')).toBe('Oct 30, 2026, 7:58 PM')
    expect(lastTradeTime('')).toBeNull()
  })
})

describe('data layer', () => {
  const ok = (body) => ({ json: async () => body })

  it('broker.securityInfo: anonymous GET getSecurityInfo with sup=false', async () => {
    const f = vi.fn(async () => ok({ c: 'AAA.US' }))
    const b = createBroker({ cabinet: { rest: 'https://tradernet.global' }, sid: 'S', fetchImpl: f })
    await b.securityInfo('AAA.US')
    const u = new URL(f.mock.calls[0][0])
    expect(u.pathname).toBe('/api/getSecurityInfo')
    expect(Object.fromEntries(u.searchParams)).toEqual({ ticker: 'AAA.US', sup: 'false' })
    expect(f.mock.calls[0][1]?.method).toBeUndefined()
  })

  it('repo.loadSecurity: fetches parts, caches by TTL, records errors, sessions from SP500.IDX', async () => {
    let clock = Date.parse('2026-10-30T18:00:00Z')
    const calls = []
    const broker = {
      async securityInfo(tk) { calls.push(['info', tk]); return { ...INFO } },
      async hlocDaily(ts, from, count) {
        calls.push(['daily', ts.join(','), from, count])
        return { hloc: { [ts[0]]: [[12, 9, 10, 11]] }, xSeries: { [ts[0]]: [TS('2026-10-29', 21)] }, vl: { [ts[0]]: [5] } }
      },
      async hlocIntraday(ts, from, to, tf) {
        calls.push(['intraday', ts.join(','), from, to, tf])
        return { hloc: { [ts[0]]: [[1, 1, 1, 1]] }, xSeries: { [ts[0]]: [TS('2026-10-30', 7)] } }
      },
    }
    const db = await openAccountDb('global:1', new IDBFactory())
    const repo = createRepo({ broker, db, now: () => clock })
    const seen = []
    repo.subscribe(() => seen.push(1))
    await repo.loadSecurity('AAA.US', ['info', 'daily', 'intraday', 'max'])
    expect(calls).toEqual([
      ['info', 'AAA.US'],
      ['daily', 'AAA.US', '2025-09-25', -1],
      ['intraday', 'AAA.US', '2026-10-22', '2026-10-31', 15],
      ['daily', 'AAA.US', '1990-01-01', -1],
    ])
    const s = repo.security('AAA.US')
    expect(s.info.name).toBe('Alpha Corporation')
    expect(s.daily).toEqual([{ ts: TS('2026-10-29', 21), date: '2026-10-30', high: 12, low: 9, open: 10, close: 11, vol: 5 }])
    expect(s.intraday).toHaveLength(1)
    expect(s.max).toHaveLength(1)
    expect(s.sessions).toBeInstanceOf(Map)
    expect(seen.length).toBeGreaterThan(1)

    // within TTL: nothing refetched; past the info TTL only info
    calls.length = 0
    await repo.loadSecurity('AAA.US', ['info', 'daily'])
    expect(calls).toEqual([])
    clock += 61e3
    await repo.loadSecurity('AAA.US', ['info', 'daily'])
    expect(calls.map((c) => c[0])).toEqual(['info'])

    // an error keeps the old data and is reported per part
    broker.securityInfo = async () => { throw new Error('nope') }
    await repo.loadSecurity('AAA.US', ['info'], { force: true })
    expect(repo.security('AAA.US').info.name).toBe('Alpha Corporation')
    expect(repo.security('AAA.US').errors.info).toBe('nope')
    // KASE tickers: no US session filter
    expect(repo.security('KZT.KZ').sessions).toBeNull()
    db.close()
  })
})

describe('card opened before the account is attached', () => {
  it('loads the security data once the repo state arrives', async () => {
    const app = setup({ sec: { ...SEC, info: null, intraday: null, daily: null } })
    const st = app.state.value
    app.state.value = null
    mountCard()
    await flushPromises()
    const n = app.loadSecurity.mock.calls.length
    app.state.value = st
    await flushPromises()
    expect(app.loadSecurity.mock.calls.length).toBe(n + 1)
  })
})
