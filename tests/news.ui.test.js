// @vitest-environment happy-dom
// Task 21: News tab of the position card (list, language fallback, paging, states, article).
// Synthetic data only; the news store is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import PositionScreen from '../src/components/PositionScreen.vue'
import { installApp, positionRoute, positionPath, parseHash } from '../src/composables/useApp.js'
import { tabsFor, CARD_TABS } from '../src/calc/position.js'
import { BrokerError } from '../src/api/transport.js'
import { t } from '../src/i18n.js'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const SEC = { info: { ltp: 110, pp: 100, kind: 1 }, intraday: null, daily: null, max: null, sessions: null, clock: { offset: 10800, dt: 420, tz: null }, today: '2026-10-31', errors: {}, loading: [] }

const item = (id, extra = {}) => ({
  id, title: `Headline ${id}`, provider: 'Oninvest', lang: 'en', date: '2026-10-31 12:00:00', url: '', sentiment: '',
  tickers: ['AAA.US', 'BBB.US', 'CCC.US', 'DDD.US'], images: ['https://tradernet.global/x.png'], ...extra,
})
const range = (from, n) => Array.from({ length: n }, (_, i) => item(from + i))

function fakeStore(pages, details = {}) {
  // pages: {'en:0': {list, total} | Error}
  const answer = (key) => {
    const v = pages[key]
    if (v instanceof Error) return Promise.reject(v)
    return Promise.resolve({ data: v || { list: [], total: 0 }, stale: false })
  }
  return {
    peekList: vi.fn(async () => null),
    list: vi.fn(({ lang, skip }) => answer(`${lang}:${skip}`)),
    peekDetail: vi.fn(async () => null),
    detail: vi.fn(async (id) => {
      const d = details[id]
      if (d instanceof Error) throw d
      return { data: d, stale: false }
    }),
    learnedOffset: vi.fn(() => null),
  }
}

function setup({ store, session = true, quotes = {}, ps = null } = {}) {
  const app = {
    session: ref(session ? { cabinetId: 'global', sid: 's', userId: 1 } : null),
    expired: ref(false),
    fatal: ref(''),
    route: ref('/position/AAA.US/news'),
    state: ref({ rawPs: ps || { pos: [{ i: 'BBB.US', mkt_price: 99, close_price: 100 }] }, positions: [], trades: [] }),
    tick: ref(0),
    live: { isLive: ref(false), usOpen: ref(false), quotes: new Map(Object.entries(quotes)) },
    prefs: reactive({ hide: false, period: 'YTD', sorts: {} }),
    liveQuotesForCalc: () => undefined,
    isLiveFor: () => false,
    coreFor: () => null,
    ensurePrices: vi.fn(async () => {}),
    security: vi.fn(() => SEC),
    loadSecurity: vi.fn(async () => {}),
    news: () => store,
    go: vi.fn((p) => { app.route.value = p }),
    logout: vi.fn(),
    retry: vi.fn(),
  }
  installApp(app)
  return app
}
const mountNews = (props = {}) => mount(PositionScreen, { props: { ticker: 'AAA.US', tab: 'news', ...props }, attachTo: document.body })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  window.location.hash = ''
})
afterEach(() => { installApp(null); vi.useRealTimers(); document.body.innerText = '' })

describe('routing and tab list', () => {
  it('article paths', () => {
    expect(positionRoute('/position/AAA.US/news/52378106')).toEqual({ ticker: 'AAA.US', tab: 'news', item: '52378106' })
    expect(positionRoute('/position/AAA.US/news')).toEqual({ ticker: 'AAA.US', tab: 'news' })
    expect(positionPath('AAA.US', 'news', 7)).toBe('/position/AAA.US/news/7')
    expect(parseHash('#/position/AAA.US/news/7')).toBe('/position/AAA.US/news/7')
    expect(parseHash('#/position/AAA.US/news/7/x')).toBe('/')
  })

  it('News is a session-only tab in CARD_TABS', () => {
    expect(CARD_TABS.map((x) => x.id)).toEqual(['summary', 'news'])
    expect(tabsFor(1, CARD_TABS, { session: true }).map((x) => x.id)).toEqual(['summary', 'news'])
    expect(tabsFor(1, CARD_TABS, { session: false }).map((x) => x.id)).toEqual(['summary'])
  })

  it('the card shows the News tab with a session', async () => {
    setup({ store: fakeStore({ 'en:0': { list: range(1, 2), total: 2 } }) })
    const w = mountNews()
    expect(w.findAll('[role="tab"]').map((x) => x.text())).toEqual([t('pos.tab.summary'), t('pos.tab.news')])
    expect(w.get('[data-tab="news"]').attributes('aria-selected')).toBe('true')
    w.unmount()
  })

  it('without a session the tab is hidden and the card falls back to Summary', () => {
    setup({ store: fakeStore({}), session: false })
    const w = mountNews()
    expect(w.findAll('[role="tab"]').map((x) => x.text())).toEqual([t('pos.tab.summary')])
    expect(w.find('[data-test="news"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('news list', () => {
  it('skeleton with aria-busy while loading, then rows: provider · time, title, up to 3 tickers', async () => {
    const store = fakeStore({ 'en:0': { list: [item(1, { date: '2026-10-31 12:00:00' })], total: 1 } })
    let release
    store.list.mockImplementationOnce(() => new Promise((r) => { release = r }))
    setup({ store, quotes: { 'AAA.US': { ltp: 102, pp: 100 }, 'CCC.US': { pcp: 0 } } })
    const w = mountNews()
    await flushPromises()
    const box = w.get('[data-test="news-list"]')
    expect(box.attributes('aria-busy')).toBe('true')
    expect(w.findAll('[data-test="news-skel"]').length).toBeGreaterThan(0)
    release({ data: { list: [item(1)], total: 1 }, stale: false })
    await flushPromises()
    expect(box.attributes('aria-busy')).toBe('false')
    const rows = w.findAll('[data-test="news-item"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].get('[data-test="news-meta"]').text()).toBe('Oninvest · 3h ago')
    // full local time in the title (server 12:00 +0300 = 09:00 UTC)
    const time = rows[0].get('time')
    expect(time.attributes('datetime')).toBe('2026-10-31T09:00:00.000Z')
    expect(time.attributes('title')).toMatch(/^Oct 31, 2026, /)
    expect(rows[0].get('[data-test="news-title"]').text()).toBe('Headline 1')
    const tks = rows[0].findAll('[data-test="news-tk"]')
    expect(tks.map((x) => x.text().replace(/\s+/g, ' '))).toEqual(['AAA.US +2.00%', 'BBB.US −1.00%', 'CCC.US 0.00%'])
    expect(tks[0].find('.pos').exists()).toBe(true)
    expect(tks[1].find('.neg').exists()).toBe(true)
    expect(w.find('img').exists()).toBe(false)
    expect(rows[0].get('a').attributes('href')).toBe('#/position/AAA.US/news/1')
    w.unmount()
  })

  it('a ticker without a cached quote shows no change', async () => {
    setup({ store: fakeStore({ 'en:0': { list: [item(1, { tickers: ['ZZZ.US'] })], total: 1 } }) })
    const w = mountNews()
    await flushPromises()
    expect(w.get('[data-test="news-tk"]').text()).toBe('ZZZ.US')
    w.unmount()
  })

  it('sentiment badge only for known values', async () => {
    setup({ store: fakeStore({ 'en:0': { list: [item(1, { sentiment: 'Positive' }), item(2, { sentiment: 'mixed' })], total: 2 } }) })
    const w = mountNews()
    await flushPromises()
    const rows = w.findAll('[data-test="news-item"]')
    expect(rows[0].get('[data-test="news-sent"]').text()).toBe(t('news.sentiment.positive'))
    expect(rows[1].find('[data-test="news-sent"]').exists()).toBe(false)
    w.unmount()
  })

  it('Load more: skip += 20, duplicates dropped, button hidden at total', async () => {
    const store = fakeStore({
      'en:0': { list: range(1, 20), total: 25 },
      'en:20': { list: [item(20), ...range(21, 5)], total: 25 },
    })
    setup({ store })
    const w = mountNews()
    await flushPromises()
    expect(w.findAll('[data-test="news-item"]')).toHaveLength(20)
    await w.get('[data-test="news-more"]').trigger('click')
    await flushPromises()
    expect(store.list).toHaveBeenLastCalledWith({ ticker: 'AAA.US', lang: 'en', skip: 20 })
    expect(w.findAll('[data-test="news-item"]')).toHaveLength(25)
    expect(w.find('[data-test="news-more"]').exists()).toBe(false)
    w.unmount()
  })

  it('a failed Load more keeps the list and offers the button again', async () => {
    const store = fakeStore({ 'en:0': { list: range(1, 20), total: 40 }, 'en:20': new BrokerError('down') })
    setup({ store })
    const w = mountNews()
    await flushPromises()
    await w.get('[data-test="news-more"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-test="news-item"]')).toHaveLength(20)
    expect(w.get('[data-test="news-more-error"]').text()).toBe(t('news.moreError'))
    expect(w.find('[data-test="news-more"]').exists()).toBe(true)
    w.unmount()
  })

  it('no English news: Russian ones with a one-line note', async () => {
    const store = fakeStore({ 'en:0': { list: [], total: 0 }, 'ru:0': { list: [item(9, { lang: 'ru', title: 'Новость' })], total: 1 } })
    setup({ store })
    const w = mountNews()
    await flushPromises()
    expect(store.list.mock.calls.map((c) => c[0].lang)).toEqual(['en', 'ru'])
    expect(w.get('[data-test="news-ru"]').text()).toBe(t('news.ruOnly'))
    expect(w.get('[data-test="news-title"]').text()).toBe('Новость')
    w.unmount()
  })

  it('nothing in either language: empty state (tab stays)', async () => {
    setup({ store: fakeStore({}) })
    const w = mountNews()
    await flushPromises()
    expect(w.get('[data-test="news-empty"]').text()).toBe(t('news.empty'))
    expect(w.find('[data-test="news-ru"]').exists()).toBe(false)
    expect(w.find('[data-tab="news"]').exists()).toBe(true)
    w.unmount()
  })

  it('error without cache: message and retry', async () => {
    const store = fakeStore({ 'en:0': new BrokerError('Broker says no') })
    setup({ store })
    const w = mountNews()
    await flushPromises()
    expect(w.get('[data-test="news-error"]').text()).toContain(t('news.error'))
    store.list.mockResolvedValueOnce({ data: { list: [item(1)], total: 1 }, stale: false })
    await w.get('[data-test="news-retry"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="news-error"]').exists()).toBe(false)
    expect(w.findAll('[data-test="news-item"]')).toHaveLength(1)
    w.unmount()
  })

  it('cache first: a cached page shows at once; a stale answer is marked', async () => {
    const store = fakeStore({})
    store.peekList.mockResolvedValue({ list: [item(1)], total: 1 })
    let release
    store.list.mockImplementationOnce(() => new Promise((r) => { release = r }))
    setup({ store })
    const w = mountNews()
    await flushPromises()
    expect(w.findAll('[data-test="news-item"]')).toHaveLength(1)
    expect(w.find('[data-test="news-skel"]').exists()).toBe(false)
    release({ data: { list: [item(1), item(2)], total: 2 }, stale: true, error: new BrokerError('down') })
    await flushPromises()
    expect(w.findAll('[data-test="news-item"]')).toHaveLength(2)
    expect(w.get('[data-test="news-stale"]').text()).toContain(t('news.stale'))
    w.unmount()
  })

  it('times use the zone of the data when the item carries one', async () => {
    setup({ store: fakeStore({ 'en:0': { list: [item(1, { date: '2026-10-31 11:00:00', timeZone: '+0000' })], total: 1 } }) })
    const w = mountNews()
    await flushPromises()
    expect(w.get('time').attributes('datetime')).toBe('2026-10-31T11:00:00.000Z')
    expect(w.get('[data-test="news-meta"]').text()).toBe('Oninvest · 1h ago')
    w.unmount()
  })
})

describe('article', () => {
  const DETAIL = {
    id: 1, title: 'Full headline', provider: 'Oninvest', dateTime: '2026-10-31 11:00:00', timeZone: '+0300',
    url: 'https://finance.yahoo.com/a', text: '<p>Hello <b>world</b></p><script>alert(1)</script><img src=x onerror=alert(1)><p><a href="javascript:alert(1)">bad</a> <a href="https://tap.tradernet.global/x">good</a></p>',
  }

  it('opening an item pushes the article route', async () => {
    const app = setup({ store: fakeStore({ 'en:0': { list: [item(1)], total: 1 } }) })
    const w = mountNews()
    await flushPromises()
    await w.get('[data-test="news-item"] a').trigger('click')
    expect(app.go).toHaveBeenCalledWith('/position/AAA.US/news/1')
    w.unmount()
  })

  it('shows title, provider, local time, the sanitized body and the https source link', async () => {
    const store = fakeStore({ 'en:0': { list: [item(1)], total: 1 } }, { 1: DETAIL })
    setup({ store })
    const w = mountNews({ item: '1' })
    await flushPromises()
    const art = w.get('[data-test="news-article"]')
    expect(art.attributes('aria-busy')).toBe('false')
    expect(art.get('h2').text()).toBe('Full headline')
    expect(art.get('[data-test="news-meta"]').text()).toBe('Oninvest · 4h ago')
    expect(art.get('time').attributes('datetime')).toBe('2026-10-31T08:00:00.000Z')
    const body = art.get('.nbody')
    expect(body.html()).not.toMatch(/script|img|onerror|javascript/)
    expect(body.findAll('a').map((a) => a.attributes('href'))).toEqual(['https://tap.tradernet.global/x'])
    expect(body.text()).toContain('Hello world')
    expect(body.text()).toContain('bad')
    const src = art.get('[data-test="news-source"]')
    expect(src.attributes()).toMatchObject({ href: 'https://finance.yahoo.com/a', target: '_blank', rel: 'noopener noreferrer' })
    expect(w.get('[data-test="news-list"]').isVisible()).toBe(false)
    w.unmount()
  })

  it('no source link unless the url is absolute https', async () => {
    for (const url of ['', '/news/1', 'http://x.example/', 'javascript:alert(1)']) {
      setup({ store: fakeStore({}, { 1: { ...DETAIL, url } }) })
      const w = mountNews({ item: '1' })
      await flushPromises()
      expect(w.find('[data-test="news-source"]').exists()).toBe(false)
      w.unmount()
    }
  })

  it('the list row is the placeholder header while the detail loads (skeleton body, aria-busy)', async () => {
    const store = fakeStore({ 'en:0': { list: [item(1)], total: 1 } })
    store.detail.mockImplementationOnce(() => new Promise(() => {}))
    setup({ store })
    const w = mountNews()
    await flushPromises()
    await w.setProps({ item: '1' })
    await flushPromises()
    const art = w.get('[data-test="news-article"]')
    expect(art.attributes('aria-busy')).toBe('true')
    expect(art.get('h2').text()).toBe('Headline 1')
    expect(art.find('[data-test="news-body-skel"]').exists()).toBe(true)
    w.unmount()
  })

  it('an article error does not break the list', async () => {
    const store = fakeStore({ 'en:0': { list: [item(1)], total: 1 } }, { 1: new BrokerError('gone') })
    setup({ store })
    const w = mountNews()
    await flushPromises()
    await w.setProps({ item: '1' })
    await flushPromises()
    expect(w.get('[data-test="news-article-error"]').text()).toContain(t('news.articleError'))
    await w.setProps({ item: null })
    await flushPromises()
    expect(w.findAll('[data-test="news-item"]')).toHaveLength(1)
    expect(w.get('[data-test="news-list"]').isVisible()).toBe(true)
    w.unmount()
  })

  it('Back from a deep-linked article replaces it with the list; after opening from the list it goes back in history', async () => {
    const app = setup({ store: fakeStore({ 'en:0': { list: [item(1)], total: 1 } }, { 1: DETAIL }) })
    const w = mountNews({ item: '1' })
    await flushPromises()
    await w.get('[data-test="news-back"]').trigger('click')
    expect(app.go).toHaveBeenLastCalledWith('/position/AAA.US/news', { replace: true })

    await w.setProps({ item: null })
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await w.get('[data-test="news-item"] a').trigger('click')
    await w.setProps({ item: '1' })
    await flushPromises()
    await w.get('[data-test="back"]').trigger('click') // top bar back also closes the article
    expect(back).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('returning to the list restores its scroll position', async () => {
    setup({ store: fakeStore({ 'en:0': { list: [item(1)], total: 1 } }, { 1: DETAIL }) })
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const w = mountNews()
    await flushPromises()
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true })
    await w.setProps({ item: '1' })
    await flushPromises()
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
    await w.setProps({ item: null })
    await flushPromises()
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640)
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    w.unmount()
  })
})
