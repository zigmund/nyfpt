// @vitest-environment happy-dom
// Security search (Task 40): recent list, shared search helpers, the search sheet on the main screen
// and its star (markets strip membership). Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import MainScreen from '../src/components/MainScreen.vue'
import SearchSheet from '../src/components/SearchSheet.vue'
import { createAppState, installApp } from '../src/composables/useApp.js'
import { filterRecent, splitMatch, SEARCH_MS } from '../src/composables/useTickerSearch.js'
import { loadRecent, saveRecent, pushRecent, RECENT_MAX, stripCardOf } from '../src/store/session.js'
import { MARKET_STRIP, MARKET_STRIP_MAX } from '../src/config.js'
import { t } from '../src/i18n.js'

function fakeStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  }
}

const AMZN = { ticker: 'AMZN.US', name: 'Amazon.com Inc', market: 'FIX', code: 'AMZN', currency: 'USD', type: 'equity' }
const AMZK = { ticker: 'AMZN_KZ.KZ', name: 'Amazon.com, Inc.', market: 'KASE', code: 'AMZN_KZ', currency: 'USD', type: 'equity' }
const ETP = { ticker: 'AMZ3.EU', name: 'Leverage Shares 3x Amazon ETP', market: 'EU', code: 'AMZ3', currency: 'USD', type: 'etf' }
const GLD = { ticker: 'GLD.US', name: 'Gold Trust', market: 'FIX', code: 'GLD', currency: 'USD', type: 'etf' }
const HELD = { ticker: 'AAA.US', name: 'Alpha Corp', market: 'FIX', code: 'AAA', currency: 'USD', type: 'equity' }
const ODD = { ticker: 'ODD.US', name: 'Odd <b>Corp</b>', market: 'FIX', code: 'ODD', currency: 'USD', type: 'mystery' }

const recentOf = (r) => ({ ticker: r.ticker, name: r.name, code: r.code, type: r.type, market: r.market, currency: r.currency })

describe('recent searches (store)', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', fakeStorage()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('pushRecent: newest first, a ticker once (moved to the front), at most RECENT_MAX', () => {
    let list = []
    list = pushRecent(list, AMZN)
    list = pushRecent(list, GLD)
    list = pushRecent(list, AMZN)
    expect(list.map((r) => r.ticker)).toEqual(['AMZN.US', 'GLD.US'])
    for (let i = 0; i < RECENT_MAX + 3; i++) list = pushRecent(list, { ticker: `T${i}.US`, name: `T${i}` })
    expect(RECENT_MAX).toBe(10)
    expect(list).toHaveLength(RECENT_MAX)
    expect(list[0].ticker).toBe(`T${RECENT_MAX + 2}.US`)
  })

  it('keeps only the descriptive fields: no prices', () => {
    const list = pushRecent([], { ...AMZN, last: 240.35, change: -1.41, extra: 'x' })
    expect(list).toEqual([recentOf(AMZN)])
  })

  it('round-trips through localStorage', () => {
    saveRecent([recentOf(AMZN), recentOf(GLD)])
    expect(loadRecent()).toEqual([recentOf(AMZN), recentOf(GLD)])
    expect(localStorage.getItem('nyfpt.recent')).not.toContain('240')
  })

  it('broken storage reads as empty; broken entries are dropped', () => {
    expect(loadRecent()).toEqual([])
    localStorage.setItem('nyfpt.recent', '{bad')
    expect(loadRecent()).toEqual([])
    localStorage.setItem('nyfpt.recent', '{"a":1}')
    expect(loadRecent()).toEqual([])
    localStorage.setItem('nyfpt.recent', JSON.stringify([null, 5, { ticker: '' }, { name: 'x' }, { ticker: 'A.US', name: 7 }, recentOf(GLD), recentOf(GLD)]))
    expect(loadRecent()).toEqual([{ ticker: 'A.US', name: 'A.US', code: '', type: '', market: '', currency: '' }, recentOf(GLD)])
    const many = Array.from({ length: 15 }, (_, i) => ({ ticker: `T${i}.US`, name: `T${i}` }))
    localStorage.setItem('nyfpt.recent', JSON.stringify(many))
    expect(loadRecent()).toHaveLength(RECENT_MAX)
  })

  it('survives throwing localStorage', () => {
    const boom = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    expect(loadRecent()).toEqual([])
    expect(() => saveRecent([recentOf(AMZN)])).not.toThrow()
  })
})

describe('search helpers', () => {
  it('splitMatch: the first case-insensitive match as its own part', () => {
    expect(splitMatch('Amazon.com Inc', 'AZ')).toEqual([{ text: 'Am', hit: false }, { text: 'az', hit: true }, { text: 'on.com Inc', hit: false }])
    expect(splitMatch('AMZN', 'amzn')).toEqual([{ text: 'AMZN', hit: true }])
    expect(splitMatch('AMZN', 'x')).toEqual([{ text: 'AMZN', hit: false }])
    expect(splitMatch('AMZN', '  ')).toEqual([{ text: 'AMZN', hit: false }])
  })

  it('filterRecent: substring of the ticker, code or name, any case', () => {
    const list = [recentOf(AMZN), recentOf(GLD)]
    expect(filterRecent(list, '')).toEqual(list)
    expect(filterRecent(list, ' gold ').map((r) => r.ticker)).toEqual(['GLD.US'])
    expect(filterRecent(list, 'mzn').map((r) => r.ticker)).toEqual(['AMZN.US'])
    expect(filterRecent(list, '.us')).toHaveLength(2)
    expect(filterRecent(list, 'zzz')).toEqual([])
  })

  it('stripCardOf: label = name, note = the broker code, else the ticker without its suffix', () => {
    expect(stripCardOf(AMZK)).toEqual({ ticker: 'AMZN_KZ.KZ', label: 'Amazon.com, Inc.', note: 'AMZN_KZ' })
    expect(stripCardOf({ ticker: 'USO.US', name: 'Oil Fund', code: '' })).toEqual({ ticker: 'USO.US', label: 'Oil Fund', note: 'USO' })
    expect(stripCardOf({ ticker: 'ZZZ.US', name: '' })).toEqual({ ticker: 'ZZZ.US', label: 'ZZZ.US', note: 'ZZZ' })
  })
})

// --- the sheet
const STATE = {
  positions: [
    { ticker: 'AAA.US', name: 'Alpha Corp', kind: 'position', qty: 10, price: 105, value: 1050 },
    { ticker: 'USD', name: 'USD', kind: 'cash', qty: 500, price: 1, value: 500 },
  ],
  trades: [], cashflows: [], markets: null, inception: null, updatedAt: Date.now(), errors: {}, loading: [],
}

function makeApp({ prefs = {}, recent = [], findTickers, searchQuotes, liveQuotes = new Map(), auth } = {}) {
  const saved = []
  const recentSaved = []
  const repo = {
    subscribe: (fn) => { fn(STATE); return () => {} },
    onSessionExpired: () => () => {},
    load: async () => {},
    coreFor: () => null,
    ensurePrices: async () => {},
    marketsStrip: () => null,
    setStrip: vi.fn(async () => {}),
    findTickers: findTickers || vi.fn(async () => []),
    searchQuotes: searchQuotes || vi.fn(async (ts) => Object.fromEntries(ts.map((x) => [x, { last: 240.35, change: -1.41 }]))),
  }
  const app = installApp(createAppState({
    createBroker: () => ({ positions: async () => ({ result: { ps: { acc: [{ curr: 'USD', s: 1 }], pos: [] } } }) }),
    auth,
    openAccountDb: async () => ({ close() {}, clear: async () => {} }),
    createRepo: () => repo,
    createLive: () => ({
      quotes: liveQuotes, isLive: () => false, marketsOpen: () => ({ us: false }),
      on: () => () => {}, start() {}, stop() {}, pause() {}, resume() {},
    }),
    socketFactory: () => () => ({}),
    sessionStore: { load: () => ({ cabinetId: 'global', sid: 's', userId: 1, loggedAt: 0 }), save() {}, clear() {} },
    prefsStore: { load: () => ({ hide: false, sorts: {}, ...prefs }), save: (p) => saved.push(JSON.parse(JSON.stringify(p))) },
    recentStore: { load: () => recent.map((r) => ({ ...r })), save: (l) => recentSaved.push(JSON.parse(JSON.stringify(l))) },
  }))
  app.start()
  return { app, saved, recentSaved, repo }
}

async function openSheet(opts) {
  const ctx = makeApp(opts)
  const w = mount(MainScreen, { attachTo: document.body })
  await flushPromises()
  await w.get('[data-test="search-open"]').trigger('click')
  await flushPromises()
  return { ...ctx, w }
}
async function type(w, text) {
  await w.get('[data-test="search-input"]').setValue(text)
  await vi.advanceTimersByTimeAsync(SEARCH_MS + 50)
  await flushPromises()
}
const rows = (w) => w.findAll('[data-test="search-row"]')
const rowOf = (w, ticker) => w.findAll('[data-test="search-item"]').find((li) => li.get('[data-test="search-row"]').attributes('data-ticker') === ticker)
const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))

let wrapper = null
beforeEach(() => { window.location.hash = '' })
afterEach(() => { wrapper?.unmount(); wrapper = null; installApp(null); vi.useRealTimers() })

describe('search sheet: open and close', () => {
  it('the main screen header has a search button that opens a modal dialog focused on the input', async () => {
    const { w } = await openSheet()
    wrapper = w
    const btn = w.get('[data-test="search-open"]')
    expect(btn.attributes('aria-label')).toBe(t('search.open'))
    expect(btn.attributes('aria-haspopup')).toBe('dialog')
    const dlg = w.get('[role="dialog"]')
    expect(dlg.attributes('aria-modal')).toBe('true')
    expect(dlg.attributes('aria-labelledby')).toBeTruthy()
    const input = w.get('[data-test="search-input"]')
    expect(document.activeElement).toBe(input.element)
    // iOS: no zoom on focus (font-size >= 16px through the shared .input rule)
    expect(input.classes()).toContain('input')
  })

  it('Esc closes and focus returns to the search button', async () => {
    const { w } = await openSheet()
    wrapper = w
    key(w.get('[data-test="search-input"]').element, 'Escape')
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.get('[data-test="search-open"]').element)
  })

  it('the close button and the backdrop close it too', async () => {
    const { w } = await openSheet()
    wrapper = w
    await w.get('[data-test="search-close"]').trigger('click')
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.get('[data-test="search-open"]').element)
    await w.get('[data-test="search-open"]').trigger('click')
    await w.get('[data-test="search-backdrop"]').trigger('click')
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('Tab is trapped inside the dialog', async () => {
    const { w } = await openSheet({ recent: [recentOf(AMZN)] })
    wrapper = w
    await flushPromises()
    const dlg = w.get('[role="dialog"]').element
    const focusables = [...dlg.querySelectorAll('button:not([disabled]), input')]
    const first = focusables[0]
    const last = focusables.at(-1)
    last.focus()
    key(last, 'Tab')
    expect(document.activeElement).toBe(first)
    key(first, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})

describe('search sheet: results', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('partial text: one debounced request; rows show code, type, name, market and currency, price and change', async () => {
    const findTickers = vi.fn(async () => [AMZN, AMZK, ETP])
    const { w, repo } = await openSheet({ findTickers })
    wrapper = w
    await w.get('[data-test="search-input"]').setValue('a')
    await vi.advanceTimersByTimeAsync(100)
    await type(w, 'amaz')
    expect(findTickers).toHaveBeenCalledTimes(1)
    expect(findTickers).toHaveBeenCalledWith('amaz')
    expect(rows(w)).toHaveLength(3)
    const r = rows(w)[0]
    expect(r.get('.srow__code').text()).toBe('AMZN')
    expect(r.get('.srow__type').text()).toBe(t('search.type.equity'))
    expect(r.get('.srow__name').text()).toBe('Amazon.com Inc')
    expect(r.get('.srow__meta').text()).toBe('FIX · USD')
    expect(r.get('.srow__price').text()).toBe('240.35')
    expect(r.get('.srow__chg').text()).toBe('−1.41%')
    expect(rows(w)[2].get('.srow__type').text()).toBe('ETF')
    // prices: one batched call for the rows shown
    expect(repo.searchQuotes).toHaveBeenLastCalledWith(['AMZN.US', 'AMZN_KZ.KZ', 'AMZ3.EU'])
    // the matched part of the name is marked (text, not HTML)
    expect(r.get('.srow__name mark').text()).toBe('Amaz')
  })

  it('no price: dashes; a live quote wins over the REST snapshot', async () => {
    const live = new Map([['GLD.US', { ltp: 300.5, pcp: 2 }]])
    const searchQuotes = vi.fn(async () => ({ 'AMZN.US': { last: null, change: null }, 'GLD.US': { last: 1, change: 1 } }))
    const { w } = await openSheet({ findTickers: vi.fn(async () => [AMZN, GLD]), searchQuotes, liveQuotes: live })
    wrapper = w
    await type(w, 'a')
    expect(rows(w)[0].get('.srow__price').text()).toBe('—')
    expect(rows(w)[0].get('.srow__chg').text()).toBe('—')
    expect(rows(w)[1].get('.srow__price').text()).toBe('300.50')
    expect(rows(w)[1].get('.srow__chg').text()).toBe('+2.00%')
  })

  it('day change of a live quote: price vs previous close first, like the card', async () => {
    const live = new Map([['GLD.US', { ltp: 300, pp: 250, pcp: 2 }]])
    const { w } = await openSheet({ findTickers: vi.fn(async () => [GLD]), liveQuotes: live })
    wrapper = w
    await type(w, 'g')
    expect(rows(w)[0].get('.srow__chg').text()).toBe('+20.00%')
  })

  it('day change of a live quote with chg: ltp - chg, not a wrong pp (Task 42)', async () => {
    const live = new Map([['GLD.US', { ltp: 300, chg: 50, pp: 280, pcp: 20 }]])
    const { w } = await openSheet({ findTickers: vi.fn(async () => [GLD]), liveQuotes: live })
    wrapper = w
    await type(w, 'g')
    expect(rows(w)[0].get('.srow__chg').text()).toBe('+20.00%')
  })

  it('an unknown type gets no label; broker text is shown as text', async () => {
    const { w } = await openSheet({ findTickers: vi.fn(async () => [ODD]) })
    wrapper = w
    await type(w, 'odd')
    expect(rows(w)[0].find('.srow__type').exists()).toBe(false)
    expect(rows(w)[0].get('.srow__name').text()).toBe('Odd <b>Corp</b>')
    expect(rows(w)[0].find('.srow__name b').exists()).toBe(false)
  })

  it('ignores an answer to an older text', async () => {
    const pending = []
    const { w } = await openSheet({ findTickers: vi.fn(() => new Promise((r) => pending.push(r))) })
    wrapper = w
    await type(w, 'aa')
    await type(w, 'gl')
    pending[1]([GLD])
    await flushPromises()
    pending[0]([AMZN])
    await flushPromises()
    expect(rows(w).map((r) => r.attributes('data-ticker'))).toEqual(['GLD.US'])
  })

  it('nothing found and a failed search say so', async () => {
    const findTickers = vi.fn(async () => [])
    const { w } = await openSheet({ findTickers })
    wrapper = w
    await type(w, 'zzz')
    expect(w.get('[data-test="search-status"]').text()).toBe(t('search.none'))
    findTickers.mockImplementation(async () => { throw new Error('boom') })
    await type(w, 'zzzz')
    expect(w.get('[data-test="search-status"]').text()).toBe(t('search.failed'))
  })

  it('the query never reaches the URL', async () => {
    const { w } = await openSheet({ findTickers: vi.fn(async () => [AMZN]) })
    wrapper = w
    await type(w, 'secret')
    expect(window.location.href).not.toContain('secret')
  })

  it('tapping a result opens its card and remembers it in Recent (without prices)', async () => {
    const { w, app, recentSaved } = await openSheet({ findTickers: vi.fn(async () => [AMZN, AMZK]) })
    wrapper = w
    await type(w, 'amzn')
    await rows(w)[1].trigger('click')
    expect(app.route.value).toBe('/position/AMZN_KZ.KZ')
    expect(window.location.hash).toBe('#/position/AMZN_KZ.KZ')
    expect(app.recent.value).toEqual([recentOf(AMZK)])
    expect(recentSaved.at(-1)).toEqual([recentOf(AMZK)])
  })

  it('keyboard: Down from the input to the rows, Up back; Enter in the input opens the first row', async () => {
    const { w, app } = await openSheet({ findTickers: vi.fn(async () => [AMZN, AMZK]) })
    wrapper = w
    await type(w, 'amzn')
    const input = w.get('[data-test="search-input"]').element
    key(input, 'ArrowDown')
    expect(document.activeElement).toBe(rows(w)[0].element)
    key(document.activeElement, 'ArrowDown')
    expect(document.activeElement).toBe(rows(w)[1].element)
    key(document.activeElement, 'ArrowDown') // last row: stays
    expect(document.activeElement).toBe(rows(w)[1].element)
    key(document.activeElement, 'ArrowUp')
    key(document.activeElement, 'ArrowUp')
    expect(document.activeElement).toBe(input)
    key(input, 'Enter')
    await flushPromises()
    expect(app.route.value).toBe('/position/AMZN.US')
  })
})

describe('search sheet: recent', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('shown when the query is empty, with prices; Clear empties it', async () => {
    const { w, app, repo, recentSaved } = await openSheet({ recent: [recentOf(AMZN), recentOf(GLD)] })
    wrapper = w
    await flushPromises()
    expect(w.get('[data-test="search-recent"]').text()).toContain(t('search.recent'))
    expect(rows(w).map((r) => r.attributes('data-ticker'))).toEqual(['AMZN.US', 'GLD.US'])
    expect(repo.searchQuotes).toHaveBeenCalledWith(['AMZN.US', 'GLD.US'])
    expect(rows(w)[0].get('.srow__price').text()).toBe('240.35')
    await w.get('[data-test="search-clear"]').trigger('click')
    expect(app.recent.value).toEqual([])
    expect(recentSaved.at(-1)).toEqual([])
    expect(w.find('[data-test="search-recent"]').exists()).toBe(false)
  })

  it('filtered locally while typing; server results do not repeat a recent row', async () => {
    const { w } = await openSheet({ recent: [recentOf(AMZN), recentOf(GLD)], findTickers: vi.fn(async () => [AMZN, AMZK]) })
    wrapper = w
    await type(w, 'Amaz')
    const recent = w.get('[data-test="search-recent"]')
    expect(recent.findAll('[data-test="search-row"]').map((r) => r.attributes('data-ticker'))).toEqual(['AMZN.US'])
    expect(w.get('[data-test="search-results"]').findAll('[data-test="search-row"]').map((r) => r.attributes('data-ticker'))).toEqual(['AMZN_KZ.KZ'])
  })
})

describe('search sheet: star (markets strip)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  const star = (w, ticker) => rowOf(w, ticker).get('[data-test="search-star"]')

  it('pressed for tickers of the default strip', async () => {
    const { w } = await openSheet({ findTickers: vi.fn(async () => [GLD, AMZN]) })
    wrapper = w
    await type(w, 'g')
    expect(star(w, 'GLD.US').attributes('aria-pressed')).toBe('true')
    expect(star(w, 'AMZN.US').attributes('aria-pressed')).toBe('false')
    expect(star(w, 'AMZN.US').attributes('aria-label')).toBe(t('search.star', { name: 'Amazon.com Inc' }))
  })

  it('pressed for tickers of a custom strip', async () => {
    const { w } = await openSheet({ prefs: { marketStrip: [{ ticker: 'AMZN.US', label: 'Amazon' }] }, findTickers: vi.fn(async () => [GLD, AMZN]) })
    wrapper = w
    await type(w, 'g')
    expect(star(w, 'GLD.US').attributes('aria-pressed')).toBe('false')
    expect(star(w, 'AMZN.US').attributes('aria-pressed')).toBe('true')
  })

  it('toggles: adds at the end (label = name, note = code) and removes; saved in prefs; no navigation', async () => {
    const { w, app, saved } = await openSheet({ findTickers: vi.fn(async () => [AMZK, GLD]) })
    wrapper = w
    await type(w, 'a')
    await star(w, 'AMZN_KZ.KZ').trigger('click')
    expect(app.marketStrip.value.at(-1)).toEqual({ ticker: 'AMZN_KZ.KZ', label: 'Amazon.com, Inc.', note: 'AMZN_KZ' })
    expect(saved.at(-1).marketStrip.at(-1)).toEqual({ ticker: 'AMZN_KZ.KZ', label: 'Amazon.com, Inc.', note: 'AMZN_KZ' })
    expect(star(w, 'AMZN_KZ.KZ').attributes('aria-pressed')).toBe('true')
    await star(w, 'GLD.US').trigger('click')
    expect(app.marketStrip.value.map((m) => m.ticker)).toEqual([...MARKET_STRIP.map((m) => m.ticker).filter((x) => x !== 'GLD.US'), 'AMZN_KZ.KZ'])
    expect(saved.at(-1).marketStrip.some((m) => m.ticker === 'GLD.US')).toBe(false)
    expect(app.route.value).toBe('/')
    expect(window.location.hash).toBe('')
    expect(w.find('[role="dialog"]').exists()).toBe(true)
    expect(app.recent.value).toEqual([])
  })

  it('a full strip disables the star of tickers not on it (with a reason); removing still works', async () => {
    const full = Array.from({ length: MARKET_STRIP_MAX - 1 }, (_, i) => ({ ticker: `T${i}.US`, label: `T${i}` }))
    const { w, app } = await openSheet({ prefs: { marketStrip: [...full, { ticker: 'GLD.US', label: 'Gold' }] }, findTickers: vi.fn(async () => [AMZN, GLD]) })
    wrapper = w
    await type(w, 'a')
    const off = star(w, 'AMZN.US')
    expect(off.attributes('aria-disabled')).toBe('true')
    expect(off.attributes('aria-label')).toBe(t('search.starFull', { name: 'Amazon.com Inc', max: MARKET_STRIP_MAX }))
    expect(off.attributes('title')).toBe(off.attributes('aria-label'))
    await off.trigger('click')
    expect(app.marketStrip.value).toHaveLength(MARKET_STRIP_MAX)
    // a blocked tap is not silent (touch has no tooltip): the sheet's live region says why
    const status = () => w.get('[data-test="search-status"]')
    expect(status().attributes('role')).toBe('status')
    expect(status().text()).toBe(t('search.stripFull', { max: MARKET_STRIP_MAX }))
    await type(w, 'am') // a new text: the notice goes, the search status is back
    expect(status().text()).not.toBe(t('search.stripFull', { max: MARKET_STRIP_MAX }))
    expect(star(w, 'GLD.US').attributes('aria-disabled')).toBeUndefined()
    await star(w, 'GLD.US').trigger('click')
    expect(app.marketStrip.value).toHaveLength(MARKET_STRIP_MAX - 1)
    expect(star(w, 'AMZN.US').attributes('aria-disabled')).toBeUndefined()
  })

  it('held positions show a Held badge instead of a star', async () => {
    const { w } = await openSheet({ findTickers: vi.fn(async () => [HELD, AMZN]) })
    wrapper = w
    await type(w, 'a')
    const li = rowOf(w, 'AAA.US')
    expect(li.find('[data-test="search-star"]').exists()).toBe(false)
    expect(li.get('[data-test="search-held"]').text()).toBe(t('search.held'))
    expect(rowOf(w, 'AMZN.US').find('[data-test="search-held"]').exists()).toBe(false)
  })

  it('works in Recent rows too', async () => {
    const { w, app } = await openSheet({ recent: [recentOf(AMZN)] })
    wrapper = w
    await flushPromises()
    await star(w, 'AMZN.US').trigger('click')
    expect(app.marketStrip.value.at(-1)).toEqual({ ticker: 'AMZN.US', label: 'Amazon.com Inc', note: 'AMZN' })
    expect(app.route.value).toBe('/')
  })
})

describe('SearchSheet alone', () => {
  it('emits close on Esc', async () => {
    makeApp()
    const w = mount(SearchSheet, { attachTo: document.body })
    wrapper = w
    await nextTick()
    key(w.get('[data-test="search-input"]').element, 'Escape')
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('fix round 1', () => {
  it('logout clears Recent (it lists the account’s activity)', async () => {
    const { app, recentSaved } = makeApp({ recent: [recentOf(AMZN), recentOf(HELD)] })
    await app.logout()
    expect(app.recent.value).toEqual([])
    expect(recentSaved.at(-1)).toEqual([])
  })

  it('a login as another account (e.g. after an expiry) clears Recent; the same account keeps it', async () => {
    const auth = { loginByPassword: vi.fn(async () => ({ sid: 's2', userId: 1 })) }
    const { app, recentSaved } = makeApp({ recent: [recentOf(AMZN), recentOf(HELD)], auth })
    await flushPromises()
    await app.login('global', { login: 'u', password: 'p' }) // same cabinet:user as the stored session
    expect(app.recent.value.map((r) => r.ticker)).toEqual([AMZN.ticker, HELD.ticker])
    auth.loginByPassword.mockResolvedValue({ sid: 's3', userId: 2 }) // another user on this device
    await app.login('global', { login: 'v', password: 'p' })
    expect(app.recent.value).toEqual([])
    expect(recentSaved.at(-1)).toEqual([])
  })

  it('focus trap holds when focus fell to <body>; focus moved to a background control comes back', async () => {
    const { w } = await openSheet({ recent: [recentOf(AMZN)] })
    wrapper = w
    await flushPromises()
    const dlg = w.get('[role="dialog"]').element
    expect(dlg.getAttribute('tabindex')).toBe('-1')
    const focusables = [...dlg.querySelectorAll('button:not([disabled]), input')]
    document.activeElement.blur()
    expect(document.activeElement).toBe(document.body)
    key(document.body, 'Tab')
    expect(document.activeElement).toBe(focusables[0])
    document.activeElement.blur()
    key(document.body, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(focusables.at(-1))
    // the panel itself (a click on a non-focusable area) is inside: Tab goes to the first control
    dlg.focus()
    key(dlg, 'Tab')
    expect(document.activeElement).toBe(focusables[0])
    w.get('[data-test="search-open"]').element.focus()
    expect(document.activeElement).toBe(w.get('[data-test="search-input"]').element)
    // Esc from <body> still closes
    document.activeElement.blur()
    key(document.body, 'Escape')
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('a session expiry closes the sheet (the login overlay takes focus)', async () => {
    const { w, app } = await openSheet()
    wrapper = w
    app.expired.value = true
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  describe('Enter', () => {
    beforeEach(() => { vi.useFakeTimers() })

    it('opens a result only when the results answer the current text', async () => {
      const pending = []
      const findTickers = vi.fn((q) => new Promise((r) => pending.push({ q, r })))
      const { w, app } = await openSheet({ findTickers })
      wrapper = w
      await type(w, 'am')
      pending[0].r([AMZN])
      await flushPromises()
      const input = w.get('[data-test="search-input"]')
      await input.setValue('gl') // debouncing: AMZN is the previous text's answer
      key(input.element, 'Enter')
      await flushPromises()
      expect(app.route.value).toBe('/')
      await vi.advanceTimersByTimeAsync(SEARCH_MS + 50) // in flight
      key(input.element, 'Enter')
      await flushPromises()
      expect(app.route.value).toBe('/')
      pending[1].r([GLD])
      await flushPromises()
      key(input.element, 'Enter')
      await flushPromises()
      expect(app.route.value).toBe('/position/GLD.US')
    })

    it('Recent rows are current at once (filtered locally)', async () => {
      const { w, app } = await openSheet({ recent: [recentOf(GLD)], findTickers: vi.fn(() => new Promise(() => {})) })
      wrapper = w
      const input = w.get('[data-test="search-input"]')
      await input.setValue('gol')
      key(input.element, 'Enter')
      await flushPromises()
      expect(app.route.value).toBe('/position/GLD.US')
    })

    it('is ignored while an IME composes', async () => {
      const { w, app } = await openSheet({ findTickers: vi.fn(async () => [AMZN]) })
      wrapper = w
      await type(w, 'am')
      const input = w.get('[data-test="search-input"]').element
      key(input, 'Enter', { isComposing: true })
      key(input, 'Escape', { isComposing: true })
      await flushPromises()
      expect(app.route.value).toBe('/')
      expect(w.find('[role="dialog"]').exists()).toBe(true)
    })
  })

  describe('prices', () => {
    beforeEach(() => { vi.useFakeTimers() })

    it('only the answer for the latest rows is applied (out-of-order answers dropped)', async () => {
      const pending = []
      const searchQuotes = vi.fn((ts) => new Promise((r) => pending.push({ ts, r })))
      const { w } = await openSheet({ findTickers: vi.fn(async (q) => (q === 'a' ? [AMZN] : [AMZN, GLD])), searchQuotes })
      wrapper = w
      await type(w, 'a')
      await type(w, 'ab')
      expect(pending.map((p) => p.ts)).toEqual([['AMZN.US'], ['AMZN.US', 'GLD.US']])
      pending[1].r({ 'AMZN.US': { last: 2, change: 2 }, 'GLD.US': { last: 3, change: 3 } })
      await flushPromises()
      pending[0].r({ 'AMZN.US': { last: 1, change: 1 } })
      await flushPromises()
      expect(rows(w)[0].get('.srow__price').text()).toBe('2.00')
    })

    it('an answer after the sheet closed is dropped without errors', async () => {
      const pending = []
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { w } = await openSheet({ recent: [recentOf(AMZN)], searchQuotes: vi.fn(() => new Promise((r) => pending.push(r))) })
      wrapper = w
      await flushPromises()
      await w.get('[data-test="search-close"]').trigger('click')
      pending[0]({ 'AMZN.US': { last: 1, change: 1 } })
      await flushPromises()
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})
