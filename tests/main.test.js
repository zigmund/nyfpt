// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ValueBlock from '../src/components/ValueBlock.vue'
import PeriodPicker from '../src/components/PeriodPicker.vue'
import PeriodPositions from '../src/components/PeriodPositions.vue'
import MainScreen from '../src/components/MainScreen.vue'
import CompareScreen from '../src/components/CompareScreen.vue'
import { createAppState, installApp } from '../src/composables/useApp.js'
import { money, pct } from '../src/format.js'
import { t } from '../src/i18n.js'

// Synthetic computeCore output (shape per docs/CALCULATIONS.md); not real account data.
const CORE = {
  series: [
    { date: '2026-10-26', pnl: 0, portfolio: 0, spy: 0, qqq: 0, value: 10000 },
    { date: '2026-10-27', pnl: 120.5, portfolio: 1.2, spy: 0.4, qqq: 0.6, value: 10120 },
    { date: '2026-10-28', pnl: 80.25, portfolio: 0.8, spy: -0.3, qqq: 0.1, value: 10580 },
  ],
  positions: [
    { ticker: 'AAA.US', name: 'Alpha', status: '', qty_start: 10, qty_end: 10, price_start: 100, price_end: 105, change_pct: 5, pnl: 50, value: 1050, weight: 9.9 },
    { ticker: 'BBB.US', name: 'Beta', status: 'новая', qty_start: 0, qty_end: 20, price_start: 50, price_end: 48, change_pct: -4, pnl: -40, value: 960, weight: 9.1 },
    { ticker: 'CCC.US', name: 'Gamma', status: 'закрыта', qty_start: 5, qty_end: 0, price_start: 20, price_end: 22, change_pct: 10, pnl: 9, value: 0, weight: 0 },
  ],
  summary: {
    base_close: '2026-10-26', end: '2026-10-28', value_start: 10000, value_end: 10580.4,
    twr: 0.8, spy: -0.3, qqq: 0.1, vs_spy: 1.1, vs_qqq: 0.7, pnl: 80.25, deposits: 500,
    income: 12, taxes: -1.8, commissions: -2.5, trades: 3, missing: '',
    value_change: 580.4, value_change_pct: 5.8, day_pnl: -44.75, day_pct: -0.42, day_date: '2026-10-28',
  },
}

const STATE = {
  positions: [
    { ticker: 'AAA.US', name: 'Alpha', kind: 'position', qty: 10, price: 105, value: 1050 },
    { ticker: 'USD', name: 'USD', kind: 'cash', qty: 500, price: 1, value: 500 },
  ],
  trades: [], cashflows: [], markets: null, inception: null,
  updatedAt: Date.now() - 3 * 60e3, errors: {}, loading: [],
}

function makeApp({ core = CORE, prefs = {} } = {}) {
  const saved = []
  const repo = {
    subscribe: (fn) => { fn(STATE); return () => {} },
    onSessionExpired: () => () => {},
    load: async () => {},
    coreFor: vi.fn(() => core),
    ensurePrices: vi.fn(async () => {}),
    marketsStrip: () => null,
  }
  const deps = {
    createBroker: () => ({}),
    openAccountDb: async () => ({ close() {}, clear: async () => {} }),
    createRepo: () => repo,
    createLive: () => ({
      quotes: new Map(), isLive: () => false, marketsOpen: () => ({ us: false }),
      on: () => () => {}, start() {}, stop() {}, pause() {}, resume() {},
    }),
    socketFactory: () => () => ({}),
    sessionStore: { load: () => ({ cabinetId: 'global', sid: 's', userId: 1, loggedAt: 0 }), save() {}, clear() {} },
    prefsStore: { load: () => ({ hide: false, period: 'YTD', vmode: 'perf', sorts: {}, ...prefs }), save: (p) => saved.push(p) },
  }
  const app = installApp(createAppState(deps))
  app.start()
  return { app, repo, saved }
}

beforeEach(() => { window.location.hash = '' })
afterEach(() => { installApp(null) })

describe('ValueBlock', () => {
  it('Performance mode: day line, P&L without deposits + TWR', async () => {
    makeApp({ prefs: { vmode: 'perf' } })
    const w = mount(ValueBlock, { props: { core: CORE, period: 'YTD' } })
    expect(w.get('[data-test="v-big"]').text()).toBe(money(10580.4))
    const day = w.get('[data-test="v-day"]').text()
    expect(day).toContain(money(-44.75))
    expect(day).toContain(`(${pct(-0.42)})`)
    expect(day).toContain('Oct 28')
    const per = w.get('[data-test="v-period"]').text()
    expect(per).toContain(money(80.25, { sign: true }))
    expect(per).toContain(`(${pct(0.8)})`)
    expect(per).toContain(t('value.perPerf', { period: 'YTD' }))
  })

  it('Value mode: value change including deposits', async () => {
    const { app } = makeApp({ prefs: { vmode: 'value' } })
    const w = mount(ValueBlock, { props: { core: CORE, period: '1m' } })
    const per = w.get('[data-test="v-period"]').text()
    expect(per).toContain(money(580.4, { sign: true }))
    expect(per).toContain(`(${pct(5.8)})`)
    expect(per).toContain(t('value.perValue', { period: '1M' }))

    await w.get('[data-test="vmode-perf"]').trigger('click')
    expect(app.prefs.vmode).toBe('perf')
    expect(w.get('[data-test="v-period"]').text()).toContain(money(80.25, { sign: true }))
  })

  it('hide amounts: money becomes ***, percents stay', async () => {
    const { app } = makeApp()
    const w = mount(ValueBlock, { props: { core: CORE, period: 'YTD' } })
    await w.get('[data-test="eye"]').trigger('click')
    expect(app.prefs.hide).toBe(true)
    expect(w.get('[data-test="eye"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-test="v-big"]').text()).toBe('***')
    const day = w.get('[data-test="v-day"]').text()
    expect(day).toContain('***')
    expect(day).toContain(pct(-0.42))
    expect(day).not.toContain('$')
    const per = w.get('[data-test="v-period"]').text()
    expect(per).toContain('***')
    expect(per).toContain(pct(0.8))
    // tone survives hiding
    expect(w.get('[data-test="v-day"] span').classes()).toContain('neg')
  })

  it('core null: skeleton, no zero amounts', () => {
    makeApp()
    const w = mount(ValueBlock, { props: { core: null, period: 'YTD' } })
    expect(w.find('[data-test="v-skel"]').exists()).toBe(true)
    expect(w.find('[data-test="v-big-skel"]').exists()).toBe(true)
    expect(w.text()).not.toContain('$0.00')
  })

  it('guards NaN / null broker fields with a dash', () => {
    makeApp()
    const core = { ...CORE, summary: { ...CORE.summary, day_pnl: NaN, day_pct: null } }
    const w = mount(ValueBlock, { props: { core, period: 'YTD' } })
    const day = w.get('[data-test="v-day"]').text()
    expect(day).not.toContain('NaN')
    expect(day).toContain('—')
  })
})

describe('PeriodPicker', () => {
  it('stores the chosen period in prefs (persisted)', async () => {
    const { app, saved } = makeApp()
    const w = mount(PeriodPicker)
    expect(w.get('[data-period="YTD"]').attributes('aria-pressed')).toBe('true')
    await w.get('[data-period="1m"]').trigger('click')
    await nextTick()
    expect(app.prefs.period).toBe('1m')
    expect(saved.at(-1).period).toBe('1m')
    expect(w.get('[data-period="1m"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-period="YTD"]').attributes('aria-pressed')).toBe('false')
  })
})

describe('PeriodPositions', () => {
  it('sorts by value desc by default and persists a header-click sort', async () => {
    const { app } = makeApp()
    const w = mount(PeriodPositions, { props: { rows: CORE.positions } })
    const tickers = () => w.findAll('tbody th').map((x) => x.text())
    expect(tickers()).toEqual(['AAA.US', 'BBB.US', 'CCC.US'])
    await w.get('[data-sort="pnl"]').trigger('click')
    expect(app.prefs.sorts.positions).toEqual({ key: 'pnl', dir: -1 })
    expect(tickers()).toEqual(['AAA.US', 'CCC.US', 'BBB.US'])
    await w.get('[data-sort="pnl"]').trigger('click')
    expect(tickers()).toEqual(['BBB.US', 'CCC.US', 'AAA.US'])
    expect(w.text()).toContain(t('ppos.status.new'))
  })

  it('hide amounts: quantities, P&L and value hidden; prices, Δ and weights stay', async () => {
    makeApp({ prefs: { hide: true } })
    const w = mount(PeriodPositions, { props: { rows: CORE.positions } })
    const cells = w.findAll('tbody tr')[0].findAll('td').map((x) => x.text())
    // status, start, end, price, Δ, P&L, value, weight
    expect(cells).toEqual(['', '***', '***', '105.00', pct(5), '***', '***', '9.9%'])
  })
})

describe('MainScreen', () => {
  it('coreFor null: skeletons instead of "$0.00", positions total shown', async () => {
    const { repo } = makeApp({ core: null })
    const w = mount(MainScreen)
    await flushPromises()
    expect(repo.ensurePrices.mock.calls.at(-1)[0]).toBe('YTD')
    expect(w.find('[data-test="v-skel"]').exists()).toBe(true)
    expect(w.text()).not.toContain('$0.00')
    expect(w.get('[data-test="v-big"]').text()).toBe(money(1550))
    expect(w.find('[data-test="ppos-current"]').exists()).toBe(true)
    expect(w.get('[data-test="updated"]').text()).toBe(t('main.updatedMin', { n: 3 }))
    w.unmount()
  })

  it('renders the period data and fetches prices again on period change', async () => {
    const { repo } = makeApp()
    const w = mount(MainScreen)
    await flushPromises()
    expect(w.get('[data-test="v-big"]').text()).toBe(money(10580.4))
    expect(w.get('[data-test="flows"]').text()).toContain(money(500, { sign: true }))
    await w.get('[data-period="7d"]').trigger('click')
    await flushPromises()
    expect(repo.ensurePrices.mock.calls.at(-1)[0]).toBe('7d')
    expect(repo.coreFor).toHaveBeenLastCalledWith('7d', undefined, undefined)
    w.unmount()
  })
})

describe('CompareScreen', () => {
  it('summary line and tiles; skeleton when core is null', async () => {
    makeApp()
    const w = mount(CompareScreen)
    await flushPromises()
    const lede = w.get('[data-test="lede"]').text()
    expect(lede).toContain('Oct 26')
    expect(lede).toContain(pct(0.8))
    expect(lede).toContain(pct(-0.3))
    expect(w.get('[data-test="tile-spy"]').text()).toContain('+1.10 pp')
    w.unmount()
    installApp(null)

    makeApp({ core: null })
    const w2 = mount(CompareScreen)
    await flushPromises()
    expect(w2.find('[data-test="lede"]').exists()).toBe(false)
    expect(w2.text()).not.toContain('$0.00')
    w2.unmount()
  })
})
