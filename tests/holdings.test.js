// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import Holdings from '../src/components/Holdings.vue'
import { installApp } from '../src/composables/useApp.js'
import { money, pct } from '../src/format.js'
import { computeCore } from '../src/calc/portfolio.js'
import { t } from '../src/i18n.js'

// Synthetic raw `ps` (broker shape); not real account data.
const PS = {
  acc: [{ curr: 'USD', s: 500, currval: 1 }],
  pos: [
    { i: 'AAA.US', name: 'Alpha', q: 10, mkt_price: 100, close_price: 98, market_value: 1000, currval: 1, curr: 'USD' },
    { i: 'BBB.US', name: 'Beta', q: 20, mkt_price: 50, close_price: 52, market_value: 1000, currval: 1, curr: 'USD' },
    { i: 'CCC.US', name: 'Gamma', q: 5, mkt_price: 400, close_price: 400, market_value: 2000, currval: 1, curr: 'USD' },
  ],
}

// Synthetic positions/trades/closes for computeCore (same holdings as PS).
const POSITIONS = [
  { ticker: 'AAA.US', name: 'Alpha', kind: 'position', qty: 10, price: 100, value: 1000 },
  { ticker: 'BBB.US', name: 'Beta', kind: 'position', qty: 20, price: 50, value: 1000 },
  { ticker: 'CCC.US', name: 'Gamma', kind: 'position', qty: 5, price: 400, value: 2000 },
  { ticker: 'USD', name: 'USD', kind: 'cash', qty: 500, price: 1, value: 500 },
]
// BBB bought in June (new), EEE sold in May, DDD sold on the last trading day (10-30).
const TRADES = [
  { id: '1', date: '2026-05-05', ticker: 'EEE.US', side: -1, qty: 4, price: 30, commission: 1 },
  { id: '2', date: '2026-06-10', ticker: 'BBB.US', side: 1, qty: 20, price: 50, commission: 1 },
  { id: '3', date: '2026-10-30', ticker: 'DDD.US', side: -1, qty: 5, price: 21, commission: 1 },
]
const DATES = ['2025-12-31', '2026-05-05', '2026-06-10', '2026-10-29', '2026-10-30']
const CLOSES = {
  'SPY.US': [500, 505, 510, 520, 521],
  'QQQ.US': [400, 404, 408, 416, 417],
  'AAA.US': [90, 95, 96, 98, 100],
  'BBB.US': [45, 48, 50, 52, 50],
  'CCC.US': [400, 400, 400, 400, 400],
  'DDD.US': [18, 19, 19, 20, 21],
  'EEE.US': [25, 30, 31, 31, 31],
}
const pricesFrom = (start) => Object.entries(CLOSES).flatMap(([ticker, cs]) => DATES
  .map((date, i) => ({ ticker, date, close: cs[i], window_start: start }))
  .filter((r) => r.date >= start))
const CORE_YTD = computeCore(POSITIONS, TRADES, [], pricesFrom('2025-12-31'))
const CORE_1D = computeCore(POSITIONS, TRADES, [], pricesFrom('2026-10-29'))
// No position closed over the period.
const CORE_OPEN = { ...CORE_YTD, positions: CORE_YTD.positions.filter((r) => r.qty_end) }

function setup({ prefs = {}, isLive = false, cores = { '1d': CORE_1D } } = {}) {
  const quotes = new Map()
  const app = {
    state: ref({ rawPs: PS, positions: POSITIONS, trades: TRADES }),
    tick: ref(0),
    live: { isLive: ref(isLive), usOpen: ref(false), quotes },
    prefs: reactive({ hide: false, sorts: {}, ...prefs }),
    liveQuotesForCalc: () => (app.live.isLive.value ? quotes : undefined),
    coreFor: vi.fn((p) => cores[p] ?? null),
    ensurePrices: vi.fn(async () => {}),
  }
  installApp(app)
  const push = (ticker, ltp) => {
    quotes.set(ticker, { c: ticker, ltp, pp: ticker === 'BBB.US' ? 52 : 98 })
    app.tick.value++
  }
  return { app, push }
}

const tickers = (w) => w.findAll('[data-test="h-row"]').map((r) => r.attributes('data-ticker'))
const pTickers = (w) => w.findAll('[data-test="hp-row"]').map((r) => r.attributes('data-ticker'))
const cTickers = (w) => w.findAll('[data-test="hc-row"]').map((r) => r.attributes('data-ticker'))
const fWeightOf = (tk) => `${CORE_YTD.positions.find((r) => r.ticker === tk).weight.toFixed(1)}%`
const mountH = (props = {}) => mount(Holdings, { props: { core: CORE_YTD, period: 'YTD', ...props } })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); installApp(null) })

describe('Holdings', () => {
  it('defaults to Value descending and shows the day total', () => {
    setup()
    const w = mountH()
    expect(tickers(w)).toEqual(['CCC.US', 'AAA.US', 'BBB.US'])
    // day: AAA +20, BBB -40, CCC 0 => -20 on a base of 4020
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain(money(-20))
    expect(total).toContain(pct((-20 / 4020) * 100))
  })

  it('sorts on header click, toggles direction, persists to prefs.sorts', async () => {
    const { app } = setup()
    const w = mountH()
    await w.get('[data-sort="ticker"]').trigger('click')
    expect(tickers(w)).toEqual(['AAA.US', 'BBB.US', 'CCC.US'])
    expect(app.prefs.sorts.holdings).toEqual({ key: 'ticker', dir: 1 })
    await w.get('[data-sort="ticker"]').trigger('click')
    expect(tickers(w)).toEqual(['CCC.US', 'BBB.US', 'AAA.US'])
    await w.get('[data-sort="dayChangePct"]').trigger('click')
    expect(tickers(w)).toEqual(['AAA.US', 'CCC.US', 'BBB.US'])
  })

  it('hide amounts: Day $, Qty, Value, total $ become ***; percents, prices, weight stay', () => {
    setup({ prefs: { hide: true } })
    const w = mountH()
    const row = w.get('[data-ticker="AAA.US"]')
    expect(row.get('[data-test="h-dayusd"]').text()).toBe('***')
    expect(row.get('[data-test="h-qty"]').text()).toBe('***')
    expect(row.get('[data-test="h-value"]').text()).toBe('***')
    expect(row.get('[data-test="h-daypct"]').text()).toBe(pct(((100 - 98) / 98) * 100))
    expect(row.get('[data-test="h-price"]').text()).toBe('100.00')
    expect(row.get('[data-test="h-weight"]').text()).toBe('22.2%')
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain('***')
    expect(total).not.toContain('$')
    expect(total).toContain('%')
  })

  it('flashes the price cell on a rise in live mode and clears it after 600 ms', async () => {
    const { push } = setup({ isLive: true })
    const w = mountH()
    push('AAA.US', 100) // same as the snapshot price: no change
    await nextTick()
    push('AAA.US', 101)
    await nextTick()
    const cell = () => w.get('[data-ticker="AAA.US"] [data-test="h-price"]')
    expect(cell().classes()).toContain('flash-up')
    push('BBB.US', 49)
    await nextTick()
    expect(w.get('[data-ticker="BBB.US"] [data-test="h-price"]').classes()).toContain('flash-down')
    vi.advanceTimersByTime(600)
    await nextTick()
    expect(cell().classes()).not.toContain('flash-up')
  })

  it('does not flash outside live mode', async () => {
    const { app } = setup({ isLive: false })
    const w = mountH()
    app.state.value = { rawPs: { ...PS, pos: PS.pos.map((p) => ({ ...p, mkt_price: p.mkt_price + 5 })) } }
    app.tick.value++
    await nextTick()
    expect(w.findAll('.flash-up, .flash-down')).toHaveLength(0)
  })

  it('has no aria-live regions', () => {
    setup()
    const w = mountH()
    expect(w.find('[aria-live], [role="status"]').exists()).toBe(false)
  })
})

describe('Holdings: Day / period switch', () => {
  it('synthetic cores: YTD closes DDD and EEE, 1D closes only DDD', () => {
    const closed = (c) => c.positions.filter((r) => r.qty_end === 0).map((r) => r.ticker).sort()
    expect(closed(CORE_YTD)).toEqual(['DDD.US', 'EEE.US'])
    expect(closed(CORE_1D)).toEqual(['DDD.US'])
  })

  it('segment: Day + the selected period label, Day by default, persisted in prefs.holdingsMode', async () => {
    const { app } = setup()
    const w = mountH()
    const day = () => w.get('[data-test="hmode-day"]')
    const per = () => w.get('[data-test="hmode-period"]')
    expect(w.get('[data-test="hmode"]').attributes('role')).toBe('group')
    expect(day().text()).toBe(t('hold.mode.day'))
    expect(per().text()).toBe('YTD')
    expect(day().attributes('aria-pressed')).toBe('true')
    expect(per().attributes('aria-pressed')).toBe('false')
    expect(w.find('[data-test="h-row"]').exists()).toBe(true)
    expect(w.find('[data-test="hp-table"]').exists()).toBe(false)

    await per().trigger('click')
    expect(app.prefs.holdingsMode).toBe('period')
    expect(per().attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-test="h-row"]').exists()).toBe(false)
    expect(w.find('[data-test="hp-table"]').exists()).toBe(true)

    await w.setProps({ period: '7d' })
    expect(per().text()).toBe('7D')

    await day().trigger('click')
    expect(app.prefs.holdingsMode).toBe('day')
    expect(w.find('[data-test="h-row"]').exists()).toBe(true)
  })

  it('Period: open positions only, period columns, Range $ descending by default', () => {
    setup({ prefs: { holdingsMode: 'period' } })
    const w = mountH()
    const heads = w.findAll('[data-test="hp-table"] thead th').map((x) => x.text())
    expect(heads).toEqual(['Symbol', 'Status', 'Qty start', 'Qty end', 'Price', 'Range %', 'Range $', 'Value', 'Weight'])
    // AAA +100, CCC 0, BBB -1 (bought at 50 + commission 1, ends at 50)
    expect(pTickers(w)).toEqual(['AAA.US', 'CCC.US', 'BBB.US'])
    const bbb = w.get('[data-test="hp-row"][data-ticker="BBB.US"]')
    expect(bbb.get('[data-test="hp-status"]').text()).toBe(t('hold.status.new'))
    expect(bbb.get('[data-test="hp-qstart"]').text()).toBe('0')
    expect(bbb.get('[data-test="hp-qend"]').text()).toBe('20')
    const aaa = w.get('[data-test="hp-row"][data-ticker="AAA.US"]')
    expect(aaa.get('[data-test="hp-price"]').text()).toBe('100.00')
    expect(aaa.get('[data-test="hp-pct"]').text()).toBe(pct((100 / 90 - 1) * 100))
    expect(aaa.get('[data-test="hp-pnl"]').text()).toBe(money(100, { sign: true }))
    expect(aaa.get('[data-test="hp-value"]').text()).toBe(money(1000))
    // Status, Qty start and Price are hidden on narrow screens.
    for (const k of ['status', 'qty_start', 'price_end']) {
      expect(w.get(`[data-test="hp-table"] [data-sort="${k}"]`).element.closest('th').classList.contains('h-narrow')).toBe(true)
    }
  })

  it('Period total = summary P&L and TWR (as in the value card), closed positions included', () => {
    setup({ prefs: { holdingsMode: 'period' } })
    const w = mountH()
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain('YTD')
    expect(total).toContain(money(CORE_YTD.summary.pnl, { sign: true }))
    expect(total).toContain(pct(CORE_YTD.summary.twr))
  })

  it('Period, core not computed yet: current positions without period columns', () => {
    setup({ prefs: { holdingsMode: 'period' } })
    const w = mountH({ core: null })
    expect(w.find('[data-test="hp-table"]').exists()).toBe(false)
    expect(w.find('[data-test="h-total"]').exists()).toBe(false)
    const cur = w.get('[data-test="hold-current"]')
    expect(cur.findAll('tbody th').map((x) => x.text())).toEqual(['CCC.US', 'AAA.US', 'BBB.US'])
  })

  it('Period stale: tables dimmed and aria-busy, closed button without N', () => {
    setup({ prefs: { holdingsMode: 'period', holdingsClosedOpen: true } })
    const w = mountH({ stale: true })
    const box = w.get('[data-test="hp-table"]').element.closest('.tablebox')
    expect(box.classList.contains('is-stale')).toBe(true)
    expect(box.getAttribute('aria-busy')).toBe('true')
    expect(w.get('[data-test="hc-toggle"]').text()).toBe(t('hold.closed'))
    const body = w.get('[data-test="hc-body"]')
    expect(body.classes()).toContain('is-stale')
    expect(body.attributes('aria-busy')).toBe('true')
  })

  it('closed positions: collapsed by default, toggles with aria-expanded, persisted', async () => {
    const { app } = setup({ prefs: { holdingsMode: 'period' } })
    const w = mountH()
    const btn = () => w.get('[data-test="hc-toggle"]')
    expect(btn().text()).toBe(t('hold.closedN', { n: 2 }))
    expect(btn().attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-test="hc-body"]').exists()).toBe(false)
    expect(pTickers(w)).not.toContain('DDD.US')

    await btn().trigger('click')
    expect(app.prefs.holdingsClosedOpen).toBe(true)
    expect(btn().attributes('aria-expanded')).toBe('true')
    const body = w.get('[data-test="hc-body"]')
    expect(body.attributes('id')).toBe(btn().attributes('aria-controls'))
    expect(body.findAll('thead th').map((x) => x.text())).toEqual(['Symbol', 'Qty start', 'Range %', 'Range $'])
    // Range $ descending: EEE 4*(30-25)-1 = 19, DDD 5*(21-18)-1 = 14
    expect(cTickers(w)).toEqual(['EEE.US', 'DDD.US'])
    const eee = w.get('[data-test="hc-row"][data-ticker="EEE.US"]')
    expect(eee.get('[data-test="hc-qstart"]').text()).toBe('4')
    expect(eee.get('[data-test="hc-pct"]').text()).toBe(pct((31 / 25 - 1) * 100))
    expect(eee.get('[data-test="hc-pnl"]').text()).toBe(money(19, { sign: true }))

    await btn().trigger('click')
    expect(app.prefs.holdingsClosedOpen).toBe(false)
    expect(w.find('[data-test="hc-body"]').exists()).toBe(false)
  })

  it('closed positions: no button when none were closed, or without a core', () => {
    setup({ prefs: { holdingsMode: 'period' } })
    expect(mountH({ core: CORE_OPEN }).find('[data-test="hc-toggle"]').exists()).toBe(false)
    installApp(null)
    setup({ cores: {} }) // Day mode, no 1D core
    expect(mountH().find('[data-test="hc-toggle"]').exists()).toBe(false)
  })

  it('Day mode: closed positions of the last trading day (1D core); Period: of the selected period', async () => {
    const { app } = setup({ prefs: { holdingsClosedOpen: true } })
    const w = mountH()
    expect(app.coreFor).toHaveBeenCalledWith('1d')
    expect(app.ensurePrices).not.toHaveBeenCalled() // 1D is priced by the selected period's load
    expect(w.get('[data-test="hc-toggle"]').text()).toBe(t('hold.closedN', { n: 1 }))
    expect(cTickers(w)).toEqual(['DDD.US'])
    // Range $ = that day's result: 5 * (21 - 20) - 1
    expect(w.get('[data-test="hc-row"] [data-test="hc-pnl"]').text()).toBe(money(4, { sign: true }))

    await w.get('[data-test="hmode-period"]').trigger('click')
    expect(cTickers(w)).toEqual(['EEE.US', 'DDD.US'])
    await w.setProps({ core: CORE_1D, period: '1d' })
    expect(cTickers(w)).toEqual(['DDD.US'])
  })

  it('separate persisted sorts per mode and for closed positions', async () => {
    const { app } = setup({ prefs: { holdingsClosedOpen: true } })
    const w = mountH()
    await w.get('[data-test="hmode-period"]').trigger('click')
    await w.get('[data-test="hp-table"] [data-sort="ticker"]').trigger('click')
    expect(pTickers(w)).toEqual(['AAA.US', 'BBB.US', 'CCC.US'])
    expect(app.prefs.sorts.holdingsPeriod).toEqual({ key: 'ticker', dir: 1 })
    expect(app.prefs.sorts.holdings).toBeUndefined()
    await w.get('[data-test="hc-body"] [data-sort="ticker"]').trigger('click')
    expect(cTickers(w)).toEqual(['DDD.US', 'EEE.US'])
    expect(app.prefs.sorts.holdingsClosed).toEqual({ key: 'ticker', dir: 1 })
    expect(app.prefs.sorts.holdingsPeriod).toEqual({ key: 'ticker', dir: 1 })

    await w.get('[data-test="hmode-day"]').trigger('click')
    expect(tickers(w)).toEqual(['CCC.US', 'AAA.US', 'BBB.US']) // Day keeps Value descending
  })

  it('hide amounts in Period mode and closed positions: $ and quantities ***, percents/prices/weight stay', () => {
    setup({ prefs: { holdingsMode: 'period', hide: true, holdingsClosedOpen: true } })
    const w = mountH()
    const cells = w.get('[data-test="hp-row"][data-ticker="AAA.US"]').findAll('td').map((x) => x.text())
    // status, start, end, price, Range %, Range $, value, weight
    expect(cells).toEqual(['', '***', '***', '100.00', pct((100 / 90 - 1) * 100), '***', '***', fWeightOf('AAA.US')])
    const closed = w.get('[data-test="hc-row"][data-ticker="DDD.US"]').findAll('td').map((x) => x.text())
    expect(closed).toEqual(['***', pct((21 / 18 - 1) * 100), '***'])
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain('***')
    expect(total).not.toContain('$')
    expect(total).toContain('%')
  })

  it('no price flashes in Period mode, even in live mode', async () => {
    const { push } = setup({ isLive: true, prefs: { holdingsMode: 'period' } })
    const w = mountH()
    push('AAA.US', 100)
    await nextTick()
    push('AAA.US', 101)
    await nextTick()
    expect(w.findAll('.flash-up, .flash-down')).toHaveLength(0)
    await w.get('[data-test="hmode-day"]').trigger('click')
    expect(w.findAll('.flash-up, .flash-down')).toHaveLength(0)
  })
})

describe('dev mock (?mock)', () => {
  it('positions carry close_price, so Day % and Day $ show outside live mode', async () => {
    const { createMockBroker } = await import('../src/dev/mock.js')
    const { holdingsRows, holdingsTotal } = await import('../src/calc/live.js')
    const pending = createMockBroker().positions()
    await vi.advanceTimersByTimeAsync(1000) // simulated latency
    const ps = (await pending).result.ps
    expect(ps.pos.length).toBeGreaterThan(0)
    for (const p of ps.pos) expect(Number(p.close_price)).toBeGreaterThan(0)
    const rows = holdingsRows(ps, new Map())
    for (const r of rows) {
      expect(r.dayChangePct, r.ticker).not.toBe(null)
      expect(r.dayChangeUsd, r.ticker).not.toBe(null)
    }
    expect(holdingsTotal(rows).dayChangePct).not.toBe(null)
  })
})
