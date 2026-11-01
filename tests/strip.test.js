// @vitest-environment happy-dom
// Customizable markets strip (Task 38): prefs.marketStrip, the strip on the main screen and its
// editor in Settings. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import MarketsStrip from '../src/components/MarketsStrip.vue'
import MarketStripEditor from '../src/components/MarketStripEditor.vue'
import SettingsScreen from '../src/components/SettingsScreen.vue'
import { createAppState, installApp } from '../src/composables/useApp.js'
import { marketStripOf } from '../src/store/session.js'
import { MARKET_STRIP, MARKET_STRIP_MAX } from '../src/config.js'
import { pct } from '../src/format.js'

const DEFAULT_TICKERS = MARKET_STRIP.map((m) => m.ticker)
const row = (ticker, last, change_pct = 1) => ({ ticker, date: '2026-10-30', last, prev: last ? last - 1 : null, change_pct: last ? change_pct : null, spark: [] })

function makeApp({ prefs = {}, markets = null, loading = [], findTickers, quotes = new Map() } = {}) {
  const saved = []
  const created = []
  const state = {
    positions: [], trades: [], cashflows: [], markets, inception: null,
    updatedAt: Date.now(), errors: {}, loading,
  }
  const repo = {
    subscribe: (fn) => { fn(state); return () => {} },
    onSessionExpired: () => () => {},
    load: async () => {},
    coreFor: () => null,
    ensurePrices: async () => {},
    marketsStrip: () => markets,
    setStrip: vi.fn(async () => {}),
    findTickers: findTickers || vi.fn(async () => []),
  }
  const app = installApp(createAppState({
    createBroker: () => ({}),
    openAccountDb: async () => ({ close() {}, clear: async () => {} }),
    createRepo: (opts) => { created.push(opts); return repo },
    createLive: () => ({
      quotes, isLive: () => false, marketsOpen: () => ({ us: false }),
      on: () => () => {}, start() {}, stop() {}, pause() {}, resume() {},
    }),
    socketFactory: () => () => ({}),
    sessionStore: { load: () => ({ cabinetId: 'global', sid: 's', userId: 1, loggedAt: 0 }), save() {}, clear() {} },
    prefsStore: { load: () => ({ hide: false, sorts: {}, ...prefs }), save: (p) => saved.push(JSON.parse(JSON.stringify(p))) },
  }))
  app.start()
  return { app, saved, repo, created }
}

beforeEach(() => { window.location.hash = '' })
afterEach(() => { installApp(null); vi.useRealTimers() })

describe('prefs.marketStrip', () => {
  it('absent or null: the default list (a copy, so later default changes reach the user)', () => {
    expect(marketStripOf(undefined)).toEqual(MARKET_STRIP)
    expect(marketStripOf(null)).toEqual(MARKET_STRIP)
    const s = marketStripOf(null)
    s[0].label = 'changed'
    expect(MARKET_STRIP[0].label).toBe('S&P 500')
  })

  it('broken values fall back to the default', () => {
    const many = Array.from({ length: MARKET_STRIP_MAX + 1 }, (_, i) => ({ ticker: `T${i}.US`, label: `T${i}` }))
    for (const bad of [
      'x', 42, {}, [null], [{ ticker: '', label: 'a' }], [{ ticker: 'A.US' }], [{ ticker: 1, label: 'a' }],
      [{ ticker: 'A.US', label: '  ' }], [{ ticker: 'A.US', label: 'a', note: 5 }],
      [{ ticker: 'A.US', label: 'a' }, { ticker: 'A.US', label: 'b' }], many,
    ]) expect(marketStripOf(bad)).toEqual(MARKET_STRIP)
  })

  it('a valid custom list is kept (extra fields dropped); an empty list stays empty', () => {
    expect(marketStripOf([{ ticker: 'GLD.US', label: 'Gold', note: 'GLD', x: 1 }, { ticker: 'AAA.US', label: 'Alpha' }]))
      .toEqual([{ ticker: 'GLD.US', label: 'Gold', note: 'GLD' }, { ticker: 'AAA.US', label: 'Alpha' }])
    expect(marketStripOf([])).toEqual([])
  })

  it('the app uses the default without a pref and the saved list with one', () => {
    expect(makeApp().app.marketStrip.value).toEqual(MARKET_STRIP)
    installApp(null)
    const { app } = makeApp({ prefs: { marketStrip: [{ ticker: 'GLD.US', label: 'Gold' }] } })
    expect(app.marketStrip.value).toEqual([{ ticker: 'GLD.US', label: 'Gold' }])
  })

  it('the repo gets the strip tickers at start and on every change of the set', async () => {
    const { app, repo, created } = makeApp()
    await flushPromises()
    expect(created[0].strip).toEqual(DEFAULT_TICKERS)
    expect(app.setMarketStrip([{ ticker: 'GLD.US', label: 'Gold' }])).toBe(true)
    await nextTick()
    expect(repo.setStrip).toHaveBeenLastCalledWith(['GLD.US'])
    const calls = repo.setStrip.mock.calls.length
    app.setMarketStrip([{ ticker: 'GLD.US', label: 'Gold bar' }]) // label only: same set
    await nextTick()
    expect(repo.setStrip.mock.calls.length).toBe(calls)
  })

  it('setMarketStrip rejects invalid lists and stores the default as null', async () => {
    const { app, saved } = makeApp()
    expect(app.setMarketStrip([{ ticker: 'A.US', label: 'a' }, { ticker: 'A.US', label: 'b' }])).toBe(false)
    expect(app.prefs.marketStrip ?? null).toBeNull()
    app.setMarketStrip([{ ticker: 'GLD.US', label: 'Gold' }])
    await nextTick()
    expect(saved.at(-1).marketStrip).toEqual([{ ticker: 'GLD.US', label: 'Gold' }])
    app.setMarketStrip(MARKET_STRIP.map((m) => ({ ...m })))
    await nextTick()
    expect(saved.at(-1).marketStrip).toBeNull()
  })
})

describe('MarketsStrip', () => {
  it('default: the current cards in order, with labels and notes', () => {
    makeApp({ markets: DEFAULT_TICKERS.map((t, i) => row(t, 100 + i)) })
    const w = mount(MarketsStrip)
    expect(w.get('[data-test="markets"]').attributes('aria-label')).toBe('Markets') // cards may be anything
    expect(w.get('.status').text()).toContain('US markets') // the status line stays about the US
    const names = w.findAll('.mcard__name').map((n) => [n.element.firstChild.textContent, n.find('small').exists() ? n.get('small').text() : null])
    expect(names).toEqual(MARKET_STRIP.map((m) => [m.label, m.note ?? null]))
    w.unmount()
  })

  it('custom list: its order and labels; a label is plain text', async () => {
    makeApp({
      prefs: { marketStrip: [{ ticker: 'GLD.US', label: '<b>Gold</b>', note: 'GLD' }, { ticker: 'SP500.IDX', label: 'S&P' }] },
      markets: [row('SP500.IDX', 6000), row('GLD.US', 245)],
    })
    await flushPromises()
    const w = mount(MarketsStrip)
    expect(w.findAll('.mcard__name').map((n) => n.text())).toEqual(['<b>Gold</b>GLD', 'S&P'])
    expect(w.find('.mcard__name b').exists()).toBe(false)
    expect(w.findAll('.mcard__last').map((n) => n.text())).toEqual(['245.00', '6,000.00'])
    w.unmount()
  })

  it('day change: a quote\'s price vs previous close wins over its pcp (the rule the card uses)', async () => {
    const quotes = new Map([['SP500.IDX', { c: 'SP500.IDX', ltp: 6060, pp: 6000, pcp: 0.5 }]])
    makeApp({ prefs: { marketStrip: [{ ticker: 'SP500.IDX', label: 'S&P' }, { ticker: 'GLD.US', label: 'Gold' }] }, markets: [row('SP500.IDX', 6000), row('GLD.US', 245, 1.5)], quotes })
    await flushPromises()
    const w = mount(MarketsStrip)
    // GLD without a quote: its daily last vs prev (245 vs 244 in this fake row), the same rule
    expect(w.findAll('.mcard__chg').map((x) => x.text())).toEqual([pct(1), pct((245 / 244 - 1) * 100)])
    w.unmount()
  })

  it('an empty list hides the strip and its status line', () => {
    makeApp({ prefs: { marketStrip: [] }, markets: [row('SP500.IDX', 6000)] })
    const w = mount(MarketsStrip)
    expect(w.find('[data-test="markets"]').exists()).toBe(false)
    expect(w.find('.status').exists()).toBe(false)
    w.unmount()
  })

  it('a ticker without data shows a dash; one not fetched yet a skeleton', async () => {
    makeApp({
      prefs: { marketStrip: [{ ticker: 'SP500.IDX', label: 'S&P' }, { ticker: 'BAD.US', label: 'Bad' }, { ticker: 'NEW.US', label: 'New' }] },
      markets: [row('SP500.IDX', 6000), row('BAD.US', null)],
    })
    await flushPromises()
    const w = mount(MarketsStrip)
    const cards = w.findAll('.mcard')
    expect(cards[0].get('.mcard__last').text()).toBe('6,000.00')
    expect(cards[1].get('.mcard__last').text()).toBe('—')
    expect(cards[1].get('.mcard__chg').text()).toBe('—')
    expect(cards[1].find('.skel').exists()).toBe(false)
    expect(cards[2].find('.mcard__last.skel').exists()).toBe(true)
    w.unmount()
  })
})

describe('MarketStripEditor', () => {
  const labels = (w) => w.findAll('[data-test="strip-label"]').map((i) => i.element.value)

  it('is a section of Settings', () => {
    makeApp()
    const w = mount(SettingsScreen)
    expect(w.find('[data-test="strip-ed"]').exists()).toBe(true)
    w.unmount()
  })

  it('lists the current cards; move up / down and remove are saved', async () => {
    const { saved } = makeApp()
    const w = mount(MarketStripEditor)
    expect(labels(w)).toEqual(MARKET_STRIP.map((m) => m.label))
    const items = () => w.findAll('[data-test="strip-item"]')
    expect(items()[0].get('[data-test="strip-up"]').attributes('disabled')).toBeDefined()
    expect(items()[4].get('[data-test="strip-down"]').attributes('disabled')).toBeDefined()
    await items()[0].get('[data-test="strip-down"]').trigger('click')
    expect(saved.at(-1).marketStrip.map((m) => m.ticker)).toEqual(['NASDAQ.IDX', 'SP500.IDX', 'USO.US', 'GLD.US', 'SLV.US'])
    await items()[4].get('[data-test="strip-up"]').trigger('click')
    expect(saved.at(-1).marketStrip.map((m) => m.ticker)).toEqual(['NASDAQ.IDX', 'SP500.IDX', 'USO.US', 'SLV.US', 'GLD.US'])
    await items()[2].get('[data-test="strip-remove"]').trigger('click')
    expect(saved.at(-1).marketStrip.map((m) => m.ticker)).toEqual(['NASDAQ.IDX', 'SP500.IDX', 'SLV.US', 'GLD.US'])
    expect(labels(w)).toEqual(['Nasdaq 100', 'S&P 500', 'Silver', 'Gold'])
    w.unmount()
  })

  it('focus follows a moved card; at the top / bottom edge it lands on the opposite move button, never Remove', async () => {
    makeApp()
    const w = mount(MarketStripEditor, { attachTo: document.body })
    const items = () => w.findAll('[data-test="strip-item"]')
    const act = () => document.activeElement?.getAttribute('data-act')
    const at = () => items().findIndex((li) => li.element.contains(document.activeElement))
    await items()[2].get('[data-test="strip-up"]').trigger('click')
    await nextTick()
    expect([at(), act()]).toEqual([1, 'up'])
    await items()[1].get('[data-test="strip-up"]').trigger('click') // reaches the top
    await nextTick()
    expect([at(), act()]).toEqual([0, 'down'])
    await items()[3].get('[data-test="strip-down"]').trigger('click') // reaches the bottom
    await nextTick()
    expect([at(), act()]).toEqual([4, 'up'])
    w.unmount()
  })

  it('a single card: both moves disabled, focus falls back to Remove', async () => {
    makeApp({ prefs: { marketStrip: [{ ticker: 'GLD.US', label: 'Gold' }, { ticker: 'SLV.US', label: 'Silver' }] } })
    const w = mount(MarketStripEditor, { attachTo: document.body })
    await w.findAll('[data-test="strip-remove"]')[0].trigger('click')
    await nextTick()
    expect(document.activeElement?.getAttribute('data-act')).toBe('remove')
    w.unmount()
  })

  it('buttons name their card for screen readers', () => {
    makeApp()
    const w = mount(MarketStripEditor)
    const first = w.findAll('[data-test="strip-item"]')[0]
    expect(first.get('[data-test="strip-down"]').attributes('aria-label')).toContain('S&P 500')
    expect(first.get('[data-test="strip-remove"]').attributes('aria-label')).toContain('S&P 500')
    expect(first.get('[data-test="strip-label"]').attributes('aria-label')).toContain('SP500.IDX')
    w.unmount()
  })

  it('renaming saves the label; a blank label is not saved', async () => {
    const { app, saved } = makeApp()
    const w = mount(MarketStripEditor)
    const input = () => w.findAll('[data-test="strip-label"]')[3]
    const commit = async (v) => { input().element.value = v; await input().trigger('change') }
    await commit('  Gold ETF ')
    expect(saved.at(-1).marketStrip[3]).toEqual({ ticker: 'GLD.US', label: 'Gold ETF', note: 'GLD' })
    await commit('   ')
    expect(app.marketStrip.value[3].label).toBe('Gold ETF')
    expect(input().element.value).toBe('Gold ETF')
    w.unmount()
  })

  it('removing every card leaves an empty list (the strip is hidden)', async () => {
    const { app, saved } = makeApp({ prefs: { marketStrip: [{ ticker: 'GLD.US', label: 'Gold' }] } })
    const w = mount(MarketStripEditor)
    await w.get('[data-test="strip-remove"]').trigger('click')
    expect(saved.at(-1).marketStrip).toEqual([])
    expect(app.marketStrip.value).toEqual([])
    expect(w.get('[data-test="strip-empty"]').text()).not.toBe('')
    w.unmount()
  })

  it('reset to default clears the pref; disabled while the default is shown', async () => {
    const { app, saved } = makeApp({ prefs: { marketStrip: [{ ticker: 'GLD.US', label: 'Gold' }] } })
    const w = mount(MarketStripEditor)
    const reset = () => w.get('[data-test="strip-reset"]')
    expect(reset().attributes('disabled')).toBeUndefined()
    await reset().trigger('click')
    expect(saved.at(-1).marketStrip).toBeNull()
    expect(app.marketStrip.value).toEqual(MARKET_STRIP)
    expect(labels(w)).toEqual(MARKET_STRIP.map((m) => m.label))
    expect(reset().attributes('disabled')).toBeDefined()
    w.unmount()
  })

  describe('search', () => {
    beforeEach(() => { vi.useFakeTimers() })

    it('is debounced: one request for the last text', async () => {
      const findTickers = vi.fn(async () => [])
      makeApp({ findTickers })
      const w = mount(MarketStripEditor)
      const input = w.get('[data-test="strip-search"]')
      await input.setValue('a')
      await vi.advanceTimersByTimeAsync(100)
      await input.setValue('ap')
      await vi.advanceTimersByTimeAsync(100)
      await input.setValue('app')
      expect(findTickers).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(400)
      expect(findTickers).toHaveBeenCalledTimes(1)
      expect(findTickers).toHaveBeenCalledWith('app')
      w.unmount()
    })

    it('ignores an answer to an older text', async () => {
      const pending = []
      const findTickers = vi.fn(() => new Promise((r) => pending.push(r)))
      makeApp({ findTickers })
      const w = mount(MarketStripEditor)
      const input = w.get('[data-test="strip-search"]')
      await input.setValue('aa')
      await vi.advanceTimersByTimeAsync(400)
      await input.setValue('bb')
      await vi.advanceTimersByTimeAsync(400)
      expect(pending).toHaveLength(2)
      pending[1]([{ ticker: 'BBB.US', name: 'Beta Corp', market: 'FIX' }])
      await flushPromises()
      pending[0]([{ ticker: 'AAA.US', name: 'Alpha Corp', market: 'FIX' }])
      await flushPromises()
      const found = w.findAll('[data-test="strip-result"]').map((b) => b.text())
      expect(found).toHaveLength(1)
      expect(found[0]).toContain('Beta Corp')
      w.unmount()
    })

    it('adds a result: label = name, note = ticker code; a ticker already shown cannot be added again', async () => {
      const findTickers = vi.fn(async () => [
        { ticker: 'GLD.US', name: 'Gold Trust', market: 'FIX' },
        { ticker: 'DDD.US', name: 'Delta Corp', market: 'FIX' },
      ])
      const { app, saved } = makeApp({ findTickers })
      const w = mount(MarketStripEditor)
      await w.get('[data-test="strip-search"]').setValue('d')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
      const results = () => w.findAll('[data-test="strip-result"]')
      expect(results()).toHaveLength(2)
      expect(results()[0].attributes('disabled')).toBeDefined() // GLD.US is on the strip
      await results()[0].trigger('click')
      expect(app.marketStrip.value).toHaveLength(5)
      await results()[1].trigger('click')
      expect(saved.at(-1).marketStrip.at(-1)).toEqual({ ticker: 'DDD.US', label: 'Delta Corp', note: 'DDD' })
      expect(app.marketStrip.value).toHaveLength(6)
      expect(results()[1].attributes('disabled')).toBeDefined()
      w.unmount()
    })

    it('the note is the broker code (code_nm) when it has one', async () => {
      const findTickers = vi.fn(async () => [{ ticker: 'NNN.KZ', name: 'Nu Corp', market: 'KASE', code: 'NNN_KZ' }])
      const { saved } = makeApp({ findTickers })
      const w = mount(MarketStripEditor)
      await w.get('[data-test="strip-search"]').setValue('n')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
      await w.get('[data-test="strip-result"]').trigger('click')
      expect(saved.at(-1).marketStrip.at(-1)).toEqual({ ticker: 'NNN.KZ', label: 'Nu Corp', note: 'NNN_KZ' })
      w.unmount()
    })

    it('at the limit nothing more can be added', async () => {
      const full = Array.from({ length: MARKET_STRIP_MAX }, (_, i) => ({ ticker: `T${i}.US`, label: `T${i}` }))
      const findTickers = vi.fn(async () => [{ ticker: 'DDD.US', name: 'Delta Corp', market: 'FIX' }])
      const { app } = makeApp({ prefs: { marketStrip: full }, findTickers })
      const w = mount(MarketStripEditor)
      expect(w.find('[data-test="strip-limit"]').exists()).toBe(true)
      await w.get('[data-test="strip-search"]').setValue('d')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
      const res = w.get('[data-test="strip-result"]')
      expect(res.attributes('disabled')).toBeDefined()
      await res.trigger('click')
      expect(app.marketStrip.value).toHaveLength(MARKET_STRIP_MAX)
      w.unmount()
    })

    it('a failed search says so', async () => {
      makeApp({ findTickers: vi.fn(async () => { throw new Error('boom') }) })
      const w = mount(MarketStripEditor)
      await w.get('[data-test="strip-search"]').setValue('x')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
      expect(w.get('[data-test="strip-search-status"]').text()).not.toBe('')
      expect(w.findAll('[data-test="strip-result"]')).toHaveLength(0)
      w.unmount()
    })
  })
})
