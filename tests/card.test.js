// @vitest-environment happy-dom
// Security card for any ticker (Task 41): a ticker without a position (search, markets strip),
// the card's search button, Back by the app history, the status line by the security's market.
// Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../src/App.vue'
import MarketsStrip from '../src/components/MarketsStrip.vue'
import { createAppState, installApp, positionRoute, parseHash } from '../src/composables/useApp.js'
import { marketClock, marketClockFor } from '../src/calc/marketTime.js'
import { lastTradeTime } from '../src/composables/usePosition.js'
import { keyStats } from '../src/calc/position.js'
import { t } from '../src/i18n.js'

const TS = (d) => Date.parse(`${d}T00:00:00Z`) / 1000
const PS = {
  acc: [{ curr: 'USD', currval: 1, s: 100 }],
  pos: [{ i: 'AAA.US', name: 'Alpha Corp', q: 10, mkt_price: 110, market_value: 1100, close_price: 100, bal_price_a: 80, curr: 'USD', currval: 1 }],
}
const POSITIONS = [{ ticker: 'AAA.US', kind: 'position', qty: 10, value: 1100 }]
const STATUS = {
  t: '2026-10-31 12:00:00', at: Date.parse('2026-10-31T09:00:00Z'),
  m: [{ n: 'FIX', n2: 'FIX', s: 'CLOSE', o: '16:30:00', c: '03:00:00', dt: '420' }],
}
const MC = marketClockFor(marketClock(STATUS, { offset: null, markets: { FIX: { post: 23 * 60 } } }), 'FIX')
const DAILY = Array.from({ length: 300 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 8, 1) + i * 864e5).toISOString().slice(0, 10)
  return { ts: TS(d), date: d, high: 52 + i, low: 48 + i, open: 49 + i, close: 50 + i, vol: 1000 + i }
})
const info = (c, extra = {}) => ({
  c, name: `${c} name`, ltp: 41.5, pp: 40, ClosePrice: 40, mintp: 39, maxtp: 42, vol: 5000, kind: 7,
  x_curr: 'USD', codesub_nm: 'ARCA', ltr: 'FIX', ltt: '2026-10-30T15:58:00', ...extra,
})
const secOf = (inf, extra = {}) => ({
  info: inf, intraday: [], daily: DAILY, max: null, sessions: null, clock: MC, today: '2026-10-31', errors: {}, loading: [], ...extra,
})
const SECS = {
  'DIA.US': secOf(info('DIA.US', { name: 'Mock Dow ETF' })),
  'AAA.US': secOf(info('AAA.US', { name: 'Alpha Corporation', kind: 1, codesub_nm: 'NASDAQ', ltp: 110, pp: 100 })),
}

function makeApp({ route = '/position/DIA.US', secs = SECS, open = [], liveQuotes = new Map(), isLive = false, findTickers, histState = null } = {}) {
  window.location.hash = `#${route}`
  window.history.replaceState(histState, '') // the entry's state as a reload would find it
  const state = {
    positions: POSITIONS, rawPs: PS, trades: [], cashflows: [], markets: null, inception: null,
    updatedAt: Date.now(), errors: {}, loading: [],
  }
  const repo = {
    subscribe: (fn) => { fn(state); return () => {} },
    onSessionExpired: () => () => {},
    load: async () => {},
    coreFor: () => null,
    ensurePrices: vi.fn(async () => {}),
    marketsStrip: () => null,
    setStrip: vi.fn(async () => {}),
    findTickers: findTickers || vi.fn(async () => []),
    searchQuotes: vi.fn(async (ts) => Object.fromEntries(ts.map((x) => [x, { last: 10, change: 1 }]))),
    security: vi.fn((tk) => secs[tk] || secOf(null)),
    loadSecurity: vi.fn(async () => {}),
  }
  const live = {
    quotes: liveQuotes,
    isLive: () => isLive,
    isOpenFor: (tk) => isLive && open.includes(liveQuotes.get(tk)?.ltr),
    isMarketOpen: (name) => open.includes(name),
    marketsOpen: () => ({ us: false }),
    on: () => () => {}, start() {}, stop() {}, pause() {}, resume() {},
  }
  const app = installApp(createAppState({
    createBroker: () => ({}),
    openAccountDb: async () => ({ close() {}, clear: async () => {} }),
    createRepo: () => repo,
    createLive: () => live,
    createNews: () => null,
    socketFactory: () => () => ({}),
    sessionStore: { load: () => ({ cabinetId: 'global', sid: 's', userId: 1, loggedAt: 0 }), save() {}, clear() {} },
    prefsStore: { load: () => ({ hide: false, sorts: {}, period: 'YTD' }), save() {} },
    recentStore: { load: () => [], save() {} },
  }))
  app.start()
  return { app, repo, live }
}

async function mountApp(opts) {
  const ctx = makeApp(opts)
  await flushPromises()
  const w = mount(App, { attachTo: document.body })
  await flushPromises()
  return { ...ctx, w }
}

beforeEach(() => { window.location.hash = ''; window.history.replaceState(null, '') })
afterEach(() => { installApp(null); document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('card route for any ticker', () => {
  it('/position/<ticker> stays the route for held and not held tickers; old links keep working', () => {
    expect(parseHash('#/position/DIA.US')).toBe('/position/DIA.US')
    expect(positionRoute('/position/DIA.US')).toEqual({ ticker: 'DIA.US', tab: 'summary' })
    expect(positionRoute('/position/AAA.US/news')).toEqual({ ticker: 'AAA.US', tab: 'news' })
    expect(positionRoute('/position/SP500.IDX')).toEqual({ ticker: 'SP500.IDX', tab: 'summary' })
  })
})

describe('card of a ticker without a position', () => {
  it('shows the quote, chart and key statistics; no My holdings and no placeholder for it', async () => {
    const { w, repo } = await mountApp()
    expect(w.get('[data-test="p-ticker"]').text()).toBe('DIA.US')
    expect(w.get('[data-test="p-venue"]').text()).toBe('ARCA · USD')
    expect(w.get('[data-test="p-name"]').text()).toBe('Mock Dow ETF (DIA.US)')
    expect(w.get('[data-test="p-price"]').text()).toBe('41.50')
    expect(w.get('[data-test="p-change"]').text()).toContain('+1.50')
    expect(w.find('[data-test="p-chart"] .pchart__plot').exists()).toBe(true)
    expect(w.find('[data-test="p-stats"]').exists()).toBe(true)
    expect(w.find('[data-test="p-holdings"]').exists()).toBe(false)
    expect(w.find('[data-test="p-holdings-skel"]').exists()).toBe(false)
    // only the per-ticker security data is requested for the card
    expect(repo.loadSecurity).toHaveBeenCalledWith('DIA.US', expect.any(Array), expect.anything())
    expect(repo.loadSecurity.mock.calls.every(([tk]) => tk === 'DIA.US')).toBe(true)
  })

  it('a held ticker keeps My holdings', async () => {
    const { w } = await mountApp({ route: '/position/AAA.US' })
    expect(w.find('[data-test="p-holdings"]').exists()).toBe(true)
    expect(w.get('[data-test="ph-shares"]').text()).toBe('10')
  })

  it('an index without security info: the strip label names it, the rest shows dashes / what exists', async () => {
    const { w } = await mountApp({
      route: '/position/SP500.IDX',
      secs: { 'SP500.IDX': secOf(null, { errors: { info: 'Not found' } }) },
    })
    expect(w.get('[data-test="p-name"]').text()).toBe('S&P 500 (SP500.IDX)')
    expect(w.find('[data-test="p-holdings"]').exists()).toBe(false)
    expect(w.find('[data-test="p-chart"] .pchart__plot').exists()).toBe(true) // daily candles exist
  })
})

// Real broker, anonymous getSecurityInfo sup:false for an index: zero prices and an epoch trade time.
const IDX_INFO = info('SP500.IDX', {
  name: 'Index S&P 500', codesub_nm: 'INDEX', kind: 1, ltp: 0, pp: 0, ClosePrice: 0, mintp: 0, maxtp: 0, ltt: '1970-01-01T00:00:00',
})
const LAST_DAY = 'Jun 27, 2026' // date of the last DAILY candle

describe('index card (getSecurityInfo without prices)', () => {
  it('price and day change from the daily closes; At close from the last candle date, never the epoch', async () => {
    const { w } = await mountApp({ route: '/position/SP500.IDX', secs: { 'SP500.IDX': secOf(IDX_INFO) } })
    expect(w.get('[data-test="p-name"]').text()).toBe('Index S&P 500 (SP500.IDX)')
    expect(w.get('[data-test="p-venue"]').text()).toBe('INDEX · USD')
    expect(w.get('[data-test="p-price"]').text()).toBe('349.00') // last daily close
    expect(w.get('[data-test="p-change"]').text()).toBe('+1.00 (+0.29%)') // vs the previous daily close
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.atClose', { at: LAST_DAY }))
    expect(w.find('[data-test="p-holdings"]').exists()).toBe(false)
    expect(w.text()).not.toMatch(/1969|1970/)
  })

  it('market open: As of the last candle date', async () => {
    const { w } = await mountApp({ route: '/position/SP500.IDX', secs: { 'SP500.IDX': secOf(IDX_INFO) }, open: ['FIX'] })
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.asOf', { at: LAST_DAY }))
  })

  it('a streamed index quote still wins over the daily closes', async () => {
    const q = new Map([['SP500.IDX', { c: 'SP500.IDX', ltp: 6000, pp: 5900, ltr: 'FIX' }]])
    const { w } = await mountApp({ route: '/position/SP500.IDX', secs: { 'SP500.IDX': secOf(IDX_INFO) }, open: ['FIX'], liveQuotes: q, isLive: true })
    expect(w.get('[data-test="p-price"]').text()).toBe('6,000.00')
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.live'))
  })

  it('Key statistics: Type Index, Volume a dash, no Avg. volume (the broker sends kind 1, vol 0; index vl is meaningless)', async () => {
    const { w } = await mountApp({ route: '/position/SP500.IDX', secs: { 'SP500.IDX': secOf({ ...IDX_INFO, vol: 0 }) } })
    expect(w.get('[data-test="pk-kind"] dd').text()).toBe(t('pos.kind.index'))
    expect(w.get('[data-test="pk-volume"] dd').text()).toBe('—')
    expect(w.find('[data-test="pk-avgVolume"]').exists()).toBe(false)
  })

  it('keyStats: avgVolume only for non-index kinds', () => {
    const daily = [{ date: '2026-10-29', vol: 100 }, { date: '2026-10-30', vol: 300 }]
    expect(keyStats({ info: { codesub_nm: 'INDEX', kind: 1 }, daily }).avgVolume).toBeNull()
    expect(keyStats({ info: { kind: 1 }, ticker: 'NASDAQ.IDX', daily }).avgVolume).toBeNull()
    expect(keyStats({ info: { codesub_nm: 'NASDAQ', kind: 1 }, daily }).avgVolume).toBe(200)
  })

  it('keyStats: index by codesub INDEX, else by the .IDX suffix; stocks and funds unchanged', () => {
    expect(keyStats({ info: { codesub_nm: 'INDEX', kind: 1, vol: 0 } })).toMatchObject({ kind: 'index', volume: null })
    expect(keyStats({ info: { c: 'DJI.IDX', kind: 1, vol: 0 } })).toMatchObject({ kind: 'index', volume: null })
    expect(keyStats({ info: { kind: 1, vol: 0 }, ticker: 'DJI.IDX' })).toMatchObject({ kind: 'index', volume: null })
    expect(keyStats({ info: { codesub_nm: 'INDEX', kind: 1, vol: 1200 } }).volume).toBe(1200) // a real index volume stays
    // a codesub other than INDEX wins over the suffix
    expect(keyStats({ info: { c: 'ODD.IDX', codesub_nm: 'NASDAQ', kind: 1, vol: 0 } })).toMatchObject({ kind: 'stock', volume: 0 })
    expect(keyStats({ info: { c: 'AAA.US', codesub_nm: 'NASDAQ', kind: 1, vol: 0 } })).toMatchObject({ kind: 'stock', volume: 0 })
    expect(keyStats({ info: { c: 'QQQ.US', codesub_nm: 'ARCA', kind: 7, vol: 0 } })).toMatchObject({ kind: 'fund', volume: 0 })
  })

  it('a stock with a real zero volume still shows 0', async () => {
    const secs = { 'DIA.US': secOf(info('DIA.US', { kind: 1, codesub_nm: 'NYSE', vol: 0 })) }
    const { w } = await mountApp({ secs })
    expect(w.get('[data-test="pk-kind"] dd').text()).toBe(t('pos.kind.stock'))
    expect(w.get('[data-test="pk-volume"] dd').text()).toBe('0')
  })

  it('lastTradeTime ignores implausible times (before 2000)', () => {
    expect(lastTradeTime('1970-01-01T00:00:00', MC)).toBeNull()
    expect(lastTradeTime('1999-12-31T10:00:00', MC)).toBeNull()
    expect(lastTradeTime('2026-10-30T15:58:00', MC)).not.toBeNull()
  })
})

describe('status line by the security market', () => {
  const at = () => lastTradeTime('2026-10-30T15:58:00', MC)

  it('market closed: At close', async () => {
    const { w } = await mountApp()
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.atClose', { at: at() }))
  })

  it('market open without a streamed quote: As of the last trade, not At close', async () => {
    const { w } = await mountApp({ open: ['FIX'] })
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.asOf', { at: at() }))
  })

  it('a streamed quote with its market open: Live (held card unchanged)', async () => {
    const q = new Map([['AAA.US', { c: 'AAA.US', ltp: 111, pp: 100, ltr: 'FIX' }]])
    const { w } = await mountApp({ route: '/position/AAA.US', open: ['FIX'], liveQuotes: q, isLive: true })
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.live'))
  })
})

describe('card header: search and Back', () => {
  it('the search button opens the search sheet; a result opens its card; closing returns focus', async () => {
    const findTickers = vi.fn(async () => [{ ticker: 'QQQ.US', name: 'Mock Nasdaq 100 ETF', code: 'QQQ', type: 'etf', market: 'FIX', currency: 'USD' }])
    const { w, app } = await mountApp({ findTickers })
    const btn = w.get('[data-test="p-search"]')
    expect(btn.attributes('aria-label')).toBe(t('search.open'))
    await btn.trigger('click')
    await flushPromises()
    expect(w.find('[data-test="search"]').exists()).toBe(true)
    await w.get('[data-test="search-close"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="search"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.get('[data-test="p-search"]').element)

    await w.get('[data-test="p-search"]').trigger('click')
    await w.get('[data-test="search-input"]').setValue('qqq')
    await new Promise((r) => setTimeout(r, 400)) // search debounce
    await flushPromises()
    await w.get('[data-test="search-row"]').trigger('click')
    await flushPromises()
    expect(app.route.value).toBe('/position/QQQ.US')
    expect(w.get('[data-test="p-ticker"]').text()).toBe('QQQ.US')
  })

  it('the search sheet closes when the card route changes (tab, article, Back / Forward)', async () => {
    const { w, app } = await mountApp()
    await w.get('[data-test="p-search"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="search"]').exists()).toBe(true)
    app.route.value = '/position/DIA.US/news'
    await flushPromises()
    expect(w.find('[data-test="search"]').exists()).toBe(false)
  })

  it('Back after an in-app navigation goes back in history', async () => {
    const { app } = makeApp({ route: '/' })
    app.go('/position/DIA.US')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    app.back()
    expect(back).toHaveBeenCalledTimes(1)
    expect(app.route.value).toBe('/position/DIA.US')
  })

  it('Back after a link (hashchange without app state) goes back in history too', async () => {
    const { app } = makeApp({ route: '/' })
    window.history.pushState(null, '', '#/position/DIA.US') // a followed link: a new entry, no state
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(app.route.value).toBe('/position/DIA.US')
    expect(window.history.state.depth).toBe(1)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    app.back()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('Back on a deep-linked card replaces it with the main screen (no card <-> main ping-pong)', async () => {
    const { app } = makeApp({ route: '/position/DIA.US' })
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    app.back()
    expect(back).not.toHaveBeenCalled()
    expect(app.route.value).toBe('/')
    expect(window.location.hash).toBe('#/')
    expect(window.history.state.depth).toBe(0) // the entry was replaced, not pushed
  })

  it('history traversal: an entry carrying its depth sets it; Back at depth 0 falls back to the main screen', async () => {
    const { app } = makeApp({ route: '/' })
    app.go('/position/DIA.US')
    expect(window.history.state.depth).toBe(1)
    // Back / Forward land on an entry that already has a depth (here: a first entry, depth 0)
    window.history.pushState({ depth: 0 }, '', '#/position/QQQ.US')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(app.route.value).toBe('/position/QQQ.US')
    expect(window.history.state.depth).toBe(0)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    app.back()
    expect(back).not.toHaveBeenCalled()
    expect(app.route.value).toBe('/')
  })

  it('after a reload start() reads the entry depth: Back uses the history', async () => {
    const { app } = makeApp({ route: '/position/DIA.US', histState: { depth: 2 } })
    expect(window.history.state.depth).toBe(2)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    app.back()
    expect(back).toHaveBeenCalledTimes(1)
    expect(app.route.value).toBe('/position/DIA.US')
  })
})

describe('markets strip', () => {
  it('each card links to its security card', async () => {
    makeApp({ route: '/' })
    const w = mount(MarketsStrip)
    await flushPromises()
    const links = w.findAll('[data-test="mcard-link"]')
    expect(links.map((a) => a.attributes('href'))).toEqual([
      '#/position/SP500.IDX', '#/position/NASDAQ.IDX', '#/position/USO.US', '#/position/GLD.US', '#/position/SLV.US',
    ])
    expect(links[2].attributes('aria-label')).toBe('Crude Oil USO') // label and note apart
    expect(links[0].attributes('aria-label')).toBe('S&P 500')
  })
})
