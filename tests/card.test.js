// @vitest-environment happy-dom
// Security card for any ticker (Task 41): a ticker without a position (search, markets strip),
// the card's search button, Back by the app history, the status line by the security's market.
// Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../src/App.vue'
import PriceChart from '../src/components/PriceChart.vue'
import MarketsStrip from '../src/components/MarketsStrip.vue'
import { createAppState, installApp, positionRoute, parseHash } from '../src/composables/useApp.js'
import { axisAt, marketClock, marketClockFor } from '../src/calc/marketTime.js'
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

function makeApp({ route = '/position/DIA.US', secs = SECS, period = 'YTD', open = [], liveQuotes = new Map(), isLive = false, findTickers, histState = null } = {}) {
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
    prefsStore: { load: () => ({ hide: false, sorts: {}, period }), save() {} },
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
    // YTD (the default period): price vs the first close of the YTD chart (Dec 31: 171)
    expect(w.get('[data-test="p-change"]').text()).toBe('−129.50 (−75.73%)')
    expect(w.get('[data-test="p-chg-label"]').text()).toBe(t('pos.per.YTD'))
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

describe('compact header', () => {
  it('the big price counts as hidden under the sticky card bar: rootMargin = the bar\'s measured height', async () => {
    const seen = []
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb, opts) { seen.push(opts) }
      observe() {}
      disconnect() {}
    })
    const rect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList.contains('pcard__bar') ? { top: 0, bottom: 61.6, height: 61.6, left: 0, right: 375, width: 375 } : rect.call(this)
    })
    try {
      await mountApp()
      expect(seen.map((o) => o.rootMargin)).toContain('-62px 0px 0px 0px')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('index card (getSecurityInfo without prices)', () => {
  it('price and day change (1D) from the daily closes; At close from the last candle date, never the epoch', async () => {
    const { w } = await mountApp({ route: '/position/SP500.IDX', secs: { 'SP500.IDX': secOf(IDX_INFO) }, period: '1d' })
    expect(w.get('[data-test="p-name"]').text()).toBe('Index S&P 500 (SP500.IDX)')
    expect(w.get('[data-test="p-venue"]').text()).toBe('INDEX · USD')
    expect(w.get('[data-test="p-price"]').text()).toBe('349.00') // last daily close
    expect(w.get('[data-test="p-change"]').text()).toBe('+1.00 (+0.29%)') // vs the previous daily close
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.atClose', { at: LAST_DAY }))
    expect(w.find('[data-test="p-holdings"]').exists()).toBe(false)
    expect(w.text()).not.toMatch(/1969|1970/)
  })

  it('no price anywhere (no ltp, no daily close): a dash once info and daily have settled, a skeleton before', async () => {
    const bare = (extra) => secOf({ ...IDX_INFO, c: 'NONE.IDX' }, { daily: [], ...extra })
    let ctx = await mountApp({ route: '/position/NONE.IDX', secs: { 'NONE.IDX': bare({ loading: ['daily'] }) } })
    expect(ctx.w.find('[data-test="p-price"]').exists()).toBe(false)
    expect(ctx.w.find('.phead__line .big.skel').exists()).toBe(true)
    ctx.w.unmount()
    ctx = await mountApp({ route: '/position/NONE.IDX', secs: { 'NONE.IDX': bare({}) } })
    expect(ctx.w.get('[data-test="p-price"]').text()).toBe('—')
    expect(ctx.w.find('.phead__line .skel').exists()).toBe(false)
    ctx.w.unmount()
    // daily failed, info answered: settled too
    ctx = await mountApp({ route: '/position/NONE.IDX', secs: { 'NONE.IDX': bare({ daily: null, errors: { daily: 'x' } }) } })
    expect(ctx.w.get('[data-test="p-price"]').text()).toBe('—')
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

  it('Back from a card restores the main-screen scroll (kept in the main entry next to depth)', async () => {
    const { app, w } = await mountApp({ route: '/' })
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true })
    try {
      // A followed link: the click inside the main screen records its scroll before the hash changes.
      await w.get('[data-test="updated"]').trigger('click')
      expect(window.history.state).toMatchObject({ depth: 0, scroll: 640 })
      // go() from the main screen records it too.
      Object.defineProperty(window, 'scrollY', { value: 700, configurable: true })
      app.go('/position/DIA.US')
      await flushPromises()
      expect(window.history.state).toMatchObject({ depth: 1 })
      expect(window.history.state.scroll).toBeUndefined()
      // Back: the main entry (with its scroll) comes back; the main screen restores it once mounted.
      const to = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
      window.history.pushState({ depth: 0, scroll: 700 }, '', '#/')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await flushPromises()
      await new Promise((r) => setTimeout(r, 50))
      expect(w.find('[data-test="updated"]').exists()).toBe(true)
      expect(to).toHaveBeenLastCalledWith(0, 700)
    } finally {
      delete window.scrollY
    }
  })

  it('a main entry without a saved scroll (a new push) is not scrolled', async () => {
    const to = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    await mountApp({ route: '/' })
    await new Promise((r) => setTimeout(r, 50))
    expect(to).not.toHaveBeenCalled()
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

// Task 51: US on the regular close; the after-hours / pre-market trade on its own line.
describe('card price on the US regular close (Task 51)', () => {
  it('after the close: the header is the regular close vs the previous one, after hours apart', async () => {
    const after = info('DIA.US', { name: 'Mock Dow ETF', ltp: 41.9, chg: 1.9, pcp: 4.75, pp: 40, ClosePrice: 41.5, ltt: '2026-10-30T19:58:00' })
    const { w, repo } = await mountApp({ period: '1d', secs: { 'DIA.US': secOf(after) } })
    expect(w.get('[data-test="p-price"]').text()).toBe('41.50')
    expect(w.get('[data-test="p-change"]').text()).toBe('+1.50 (+3.75%)')
    expect(w.get('[data-test="p-ext"]').text()).toContain(t('pos.afterHours'))
    expect(w.get('[data-test="p-ext-price"]').text()).toBe('41.90')
    expect(w.get('[data-test="p-ext-change"]').text()).toBe('+0.4000 (+0.96%)') // fPrice: 4 decimals under 1
    expect(w.get('[data-test="p-ext-at"]').text()).toBe(lastTradeTime('2026-10-30T19:58:00', MC))
    // "At close" names the regular close (16:00 New York), not the after-hours trade
    expect(w.get('[data-test="p-asof"]').text()).toBe(t('pos.atClose', { at: lastTradeTime('2026-10-30T16:00:00', MC) }))
    expect(repo.security).toHaveBeenCalled()
  })

  it('during the session or on other markets: no extra line', async () => {
    const { w } = await mountApp()
    expect(w.find('[data-test="p-ext"]').exists()).toBe(false)
  })

  it('a daily chart asks the repo for the regular close of its first date', async () => {
    const ensure = vi.fn(async () => {})
    const ctx = makeApp({ period: 'YTD' })
    ctx.repo.ensureRegular = ensure
    await flushPromises()
    mount(App, { attachTo: document.body })
    await flushPromises()
    expect(ensure).toHaveBeenCalledWith('DIA.US', ['2025-12-31'])
  })
})

// Fix round 1: the broker pre-open (07:10-09:30 New York) on the 1D chart.
describe('1D in the US pre-open (Task 51 fix round 1)', () => {
  // Market clock with the broker pre-open (p 14:10 server = 07:10 New York) and the regular close.
  const PMC = marketClockFor(marketClock(STATUS, { offset: null, markets: { FIX: { post: 23 * 60, p: 14 * 60 + 10 } } }), 'FIX')
  const bar = (d, min, close) => ({ ts: axisAt(10800, d, min), date: d, open: close, high: close, low: close, close, vol: 1 })
  const session = (d, close) => Array.from({ length: 26 }, (_, i) => bar(d, 570 + i * 15, i === 25 ? close : close - 1))
  const INTRA = [...session('2026-10-29', 40.02), ...session('2026-10-30', 41.52),
    bar('2026-11-02', 435, 41.6), bar('2026-11-02', 450, 41.8), bar('2026-11-02', 465, 41.9)]
  // Monday 07:45: pp / chg already rolled to Friday (pp = ClosePrice = Friday's close).
  const PRE = { c: 'DIA.US', ltr: 'FIX', ltp: 41.9, chg: 0.4, pcp: 0.96, pp: 41.5, ClosePrice: 41.5, ltt: '2026-11-02T07:45:00' }
  const sec = () => ({ 'DIA.US': secOf(info('DIA.US', { ...PRE, name: 'Mock Dow ETF' }), { intraday: INTRA, clock: PMC, today: '2026-11-02' }) })

  it('header: Friday vs Thursday; chart: today\'s pre-open bars against Friday\'s close, no spike to it', async () => {
    const { w } = await mountApp({
      period: '1d', secs: sec(), liveQuotes: new Map([['DIA.US', PRE]]), isLive: true, open: ['FIX'],
    })
    expect(w.get('[data-test="p-price"]').text()).toBe('41.50')
    expect(w.get('[data-test="p-change"]').text()).toBe('+1.48 (+3.70%)')
    expect(w.get('[data-test="p-ext"]').text()).toContain(t('pos.preMarket'))
    const chart = w.getComponent(PriceChart).props()
    expect(chart.rows.map((r) => r.date)).toEqual(['2026-11-02', '2026-11-02', '2026-11-02'])
    expect(chart.rows.at(-1).close).toBe(41.9) // the bar's own close, not overwritten by 41.50
    expect(chart.base).toBe(41.5) // the last regular close, not Thursday's
    expect(w.get('[data-test="pk-prevClose"]').text()).toContain('40.02') // Key statistics = the header's prev
  })
})
