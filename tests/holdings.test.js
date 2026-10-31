// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import Holdings from '../src/components/Holdings.vue'
import MarketSpark from '../src/components/MarketSpark.vue'
import { daySparks, periodSpark } from '../src/calc/sparks.js'
import { marketClock } from '../src/calc/marketTime.js'
import { installApp } from '../src/composables/useApp.js'
import { money, pct } from '../src/format.js'
import { computeCore } from '../src/calc/portfolio.js'
import { t } from '../src/i18n.js'
import { readFileSync } from 'node:fs'

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
  'GGG.US': [10, 10, 10, 10, 11],
}
const pricesFrom = (start) => Object.entries(CLOSES).flatMap(([ticker, cs]) => DATES
  .map((date, i) => ({ ticker, date, close: cs[i], window_start: start }))
  .filter((r) => r.date >= start))
const CORE_YTD = computeCore(POSITIONS, TRADES, [], pricesFrom('2025-12-31'))
const CORE_1D = computeCore(POSITIONS, TRADES, [], pricesFrom('2026-10-29'))
// No position closed over the period.
const CORE_OPEN = { ...CORE_YTD, positions: CORE_YTD.positions.filter((r) => r.qty_end) }
// Day sparks (last session, 15-min closes) as repo.state().sparks; CCC has none.
const SPARKS = {
  'AAA.US': { date: '2026-10-30', spark: [98, 99.5, 99, 100] },
  'BBB.US': { date: '2026-10-30', spark: [52, 51, 50.5, 50] },
}
// Daily closes per ticker as repo.state().closes.
const CLOSES_MAP = new Map(Object.entries(CLOSES).map(([tk, cs]) => [tk, DATES.map((date, i) => ({ date, close: cs[i] }))]))

function setup({ prefs = {}, isLive = false, cores = { '1d': CORE_1D } } = {}) {
  const quotes = new Map()
  const app = {
    state: ref({ rawPs: PS, positions: POSITIONS, trades: TRADES, sparks: SPARKS, closes: CLOSES_MAP }),
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
const sparkOf = (row) => row.findComponent(MarketSpark).props()

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); installApp(null) })

describe('Holdings', () => {
  it('defaults to Value descending and shows the day total', () => {
    setup()
    const w = mountH()
    expect(tickers(w)).toEqual(['CCC.US', 'AAA.US', 'BBB.US'])
    // day: AAA +20, BBB -40, CCC 0 => -20 on a base of 4520 (incl. 500 cash)
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain(money(-20))
    expect(total).toContain(pct((-20 / 4520) * 100))
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
    expect(row.get('[data-test="h-dayusd"]').text()).toBe('+$***')
    expect(row.get('[data-test="h-qty"]').text()).toBe('***')
    expect(row.get('[data-test="h-value"]').text()).toBe('$***')
    expect(row.get('[data-test="h-daypct"]').text()).toBe(pct(((100 - 98) / 98) * 100))
    expect(row.get('[data-test="h-price"]').text()).toBe('100.00')
    expect(row.get('[data-test="h-weight"]').text()).toBe('22.2%')
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain('$***')
    expect(total).not.toMatch(/\$\d/)
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
    expect(heads).toEqual(['Symbol', t('hold.col.chart'), 'Status', 'Qty start', 'Qty end', 'Price', 'Range %', 'Range $', 'Value', 'Weight'])
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
    // Status and Qty start are hidden on narrow screens (the position card has them).
    for (const k of ['status', 'qty_start']) {
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

  it('a round-trip inside the period (bought and sold on the last day) is listed as closed in both modes', async () => {
    const rt = [
      ...TRADES,
      { id: '4', date: '2026-10-30', ticker: 'GGG.US', side: 1, qty: 2, price: 10.5, commission: 0 },
      { id: '5', date: '2026-10-30', ticker: 'GGG.US', side: -1, qty: 2, price: 11, commission: 0 },
    ]
    const ytd = computeCore(POSITIONS, rt, [], pricesFrom('2025-12-31'))
    const d1 = computeCore(POSITIONS, rt, [], pricesFrom('2026-10-29'))
    setup({ prefs: { holdingsClosedOpen: true }, cores: { '1d': d1 } })
    const w = mountH({ core: ytd })
    expect(cTickers(w)).toEqual(['DDD.US', 'GGG.US'])
    const ggg = () => w.get('[data-test="hc-row"][data-ticker="GGG.US"]')
    expect(ggg().get('[data-test="hc-qstart"]').text()).toBe('0')
    expect(ggg().get('[data-test="hc-pnl"]').text()).toBe(money(1, { sign: true })) // 2 * (11 - 10.5)
    await w.get('[data-test="hmode-period"]').trigger('click')
    expect(cTickers(w)).toEqual(['EEE.US', 'DDD.US', 'GGG.US'])
    expect(w.get('[data-test="hc-toggle"]').text()).toBe(t('hold.closedN', { n: 3 }))
    expect(pTickers(w)).not.toContain('GGG.US')
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
    // chart, status, start, end, price, Range %, Range $, value, weight
    expect(cells).toEqual(['', '', '***', '***', '100.00', pct((100 / 90 - 1) * 100), '+$***', '$***', fWeightOf('AAA.US')])
    const closed = w.get('[data-test="hc-row"][data-ticker="DDD.US"]').findAll('td').map((x) => x.text())
    expect(closed).toEqual(['***', pct((21 / 18 - 1) * 100), '+$***'])
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain('$***')
    expect(total).not.toMatch(/\$\d/)
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

describe('Holdings: Yahoo-style rows', () => {
  it('Day row: ticker and name in a link to the position card, price, change pill', () => {
    setup()
    const w = mountH()
    const row = w.get('[data-test="h-row"][data-ticker="AAA.US"]')
    const link = row.get('a[data-test="h-link"]')
    expect(link.attributes('href')).toBe('#/position/AAA.US')
    expect(link.get('[data-test="h-sym"]').text()).toBe('AAA.US')
    expect(link.get('[data-test="h-name"]').text()).toBe('Alpha')
    expect(row.get('[data-test="h-price"]').text()).toBe('100.00')
    const pill = row.get('[data-test="h-daypct"]')
    expect(pill.text()).toBe(pct(((100 - 98) / 98) * 100))
    expect(pill.classes()).toEqual(expect.arrayContaining(['pill', 'pill--pos']))
    expect(w.get('[data-ticker="BBB.US"] [data-test="h-daypct"]').classes()).toContain('pill--neg')
    expect(w.get('[data-ticker="CCC.US"] [data-test="h-daypct"]').classes()).toContain('pill--flat') // 0 %
  })

  it('link URL-encodes the ticker', () => {
    const { app } = setup()
    app.state.value = { ...app.state.value, rawPs: { ...PS, pos: [{ ...PS.pos[0], i: 'A&B/C.US' }] } }
    const w = mountH()
    expect(w.get('[data-test="h-link"]').attributes('href')).toBe('#/position/A%26B%2FC.US')
  })

  it('Day spark: last-session closes from the repo, previous-close level', () => {
    setup()
    const w = mountH()
    expect(sparkOf(w.get('[data-ticker="AAA.US"]'))).toEqual({ spark: [98, 99.5, 99, 100], prev: 98 })
    expect(sparkOf(w.get('[data-ticker="BBB.US"]'))).toEqual({ spark: [52, 51, 50.5, 50], prev: 52 })
    // No data: an empty spark of the same height (no skeleton swap, no jump when it arrives).
    const ccc = w.get('[data-ticker="CCC.US"]')
    expect(sparkOf(ccc).spark).toEqual([])
    expect(ccc.find('.spark').exists()).toBe(true)
  })

  it('Day spark of the previous session (prior): no previous-close level (split at its own first close)', () => {
    const { app } = setup()
    app.state.value = { ...app.state.value, sparks: { ...SPARKS, 'BBB.US': { date: '2026-10-29', spark: [49, 51], prior: true } } }
    const w = mountH()
    // BBB is down today (pill), but the drawn session rose: the line is not measured against today's base.
    expect(sparkOf(w.get('[data-ticker="BBB.US"]'))).toEqual({ spark: [49, 51], prev: null })
    expect(w.get('[data-ticker="BBB.US"] [data-test="h-daypct"]').classes()).toContain('pill--neg')
  })

  it('Period spark: closes over the period from the start price to the end price', () => {
    setup({ prefs: { holdingsMode: 'period' } })
    const w = mountH()
    const aaa = w.get('[data-test="hp-row"][data-ticker="AAA.US"]')
    expect(aaa.get('a[data-test="h-link"]').attributes('href')).toBe('#/position/AAA.US')
    expect(aaa.get('[data-test="h-name"]').text()).toBe('Alpha')
    // base 2025-12-31 (90) -> 95, 96, 98 -> end 2026-10-30 (100)
    expect(sparkOf(aaa)).toEqual({ spark: [90, 95, 96, 98, 100], prev: null })
    const pill = aaa.get('[data-test="hp-pct"]')
    expect(pill.classes()).toEqual(expect.arrayContaining(['pill', 'pill--pos']))
    expect(aaa.get('[data-test="hp-price"]').text()).toBe('100.00')
  })

  it('total line: holdings value incl. cash, then change $ and %', () => {
    setup()
    const w = mountH()
    expect(w.get('[data-test="h-total-value"]').text()).toBe(money(4500))
    installApp(null)
    setup({ prefs: { holdingsMode: 'period' } })
    const p = mountH()
    expect(p.get('[data-test="h-total-value"]').text()).toBe(money(CORE_YTD.summary.value_end))
  })

  it('hide amounts: total value and row amounts ***, the pill and price stay', () => {
    setup({ prefs: { hide: true } })
    const w = mountH()
    expect(w.get('[data-test="h-total-value"]').text()).toBe('$***')
    const row = w.get('[data-ticker="AAA.US"]')
    expect(row.get('[data-test="h-daypct"]').text()).toBe(pct(((100 - 98) / 98) * 100))
    expect(row.get('[data-test="h-price"]').text()).toBe('100.00')
    expect(row.text()).not.toMatch(/\$\d/)
  })

  it('second-line cells carry their labels for the mobile card layout', () => {
    setup()
    const w = mountH()
    const row = w.get('[data-ticker="AAA.US"]')
    expect(row.get('[data-test="h-dayusd"]').attributes('data-label')).toBe(t('hold.col.dayChangeUsd'))
    expect(row.get('[data-test="h-value"]').attributes('data-label')).toBe(t('hold.col.valueUsd'))
  })
})

describe('sparks calc', () => {
  // Broker-like 15-min rows: date as parseHloc derives it, ts in seconds.
  const bar = (ticker, date, hhmm, close) => {
    const [h, m] = hhmm.split(':').map(Number)
    return { ticker, date, ts: Date.parse(`${date}T00:00:00Z`) / 1000 + h * 3600 + m * 60, close }
  }
  const IDX = [
    bar('SP500.IDX', '2026-10-29', '09:30', 1), bar('SP500.IDX', '2026-10-29', '15:45', 1),
    bar('SP500.IDX', '2026-10-30', '09:30', 1), bar('SP500.IDX', '2026-10-30', '15:45', 1),
  ]
  // Broker status of a server on UTC (axis = wall clock): US market opens 09:30, dt 0.
  const CLK = marketClock({ t: '2026-10-31 12:00:00', at: Date.parse('2026-10-31T12:00:00Z'), m: [{ n: 'FIX', o: '09:30:00', c: '20:00:00', dt: '0' }] })

  it('US tickers: the last S&P 500 session, regular hours only', () => {
    const rows = [
      bar('AAA.US', '2026-10-29', '10:00', 5),
      bar('AAA.US', '2026-10-30', '08:00', 9), // pre-market
      bar('AAA.US', '2026-10-30', '09:30', 10), bar('AAA.US', '2026-10-30', '12:00', 11),
      bar('AAA.US', '2026-10-30', '15:45', 12),
      bar('AAA.US', '2026-10-30', '17:00', 13), // post-market
      bar('AAA.US', '2026-10-31', '08:00', 14), // pre-market of a day without an index session yet
    ]
    expect(daySparks(rows, IDX, CLK, '2026-10-31')['AAA.US']).toEqual({ date: '2026-10-30', spark: [10, 11, 12] })
  })

  it('US tickers before their first regular bar of the index session: the previous session, flagged prior', () => {
    // The markets cache (TTL 60 s) already has today's open; cached position bars (TTL 5 min) only pre-market.
    const rows = [
      bar('AAA.US', '2026-10-29', '08:00', 4), // pre-market of 10-29: clipped by that day's index session
      bar('AAA.US', '2026-10-29', '09:30', 5), bar('AAA.US', '2026-10-29', '15:45', 6),
      bar('AAA.US', '2026-10-30', '08:00', 7), // pre-market only
    ]
    expect(daySparks(rows, IDX, CLK, '2026-10-30')['AAA.US']).toEqual({ date: '2026-10-29', spark: [5, 6], prior: true })
    expect(daySparks([bar('AAA.US', '2026-10-30', '08:00', 7)], IDX, CLK, '2026-10-30')['AAA.US']).toEqual({ date: '2026-10-30', spark: [] })
  })

  it('other markets (KZ): their own last session', () => {
    const rows = [
      bar('CCC_KZ.KZ', '2026-10-30', '11:30', 3),
      bar('CCC_KZ.KZ', '2026-10-31', '11:30', 4), bar('CCC_KZ.KZ', '2026-10-31', '12:00', 5),
    ]
    expect(daySparks(rows, IDX, CLK, '2026-10-31')['CCC_KZ.KZ']).toEqual({ date: '2026-10-31', spark: [4, 5] })
  })

  it('US tickers without index candles: their own last date', () => {
    const rows = [bar('AAA.US', '2026-10-29', '10:00', 5), bar('AAA.US', '2026-10-30', '10:00', 6), bar('AAA.US', '2026-10-30', '10:15', 7)]
    expect(daySparks(rows, [], CLK, '2026-10-31')['AAA.US']).toEqual({ date: '2026-10-30', spark: [6, 7] })
  })

  it('periodSpark: start price, closes strictly inside (from, to), end price', () => {
    const cs = [['2026-01-01', 1], ['2026-01-02', 2], ['2026-01-05', 3], ['2026-01-06', 4]].map(([date, close]) => ({ date, close }))
    expect(periodSpark(cs, '2026-01-01', '2026-01-06', 1.5, 4.5)).toEqual([1.5, 2, 3, 4.5])
    expect(periodSpark(undefined, '2026-01-01', '2026-01-06', 1.5, 4.5)).toEqual([1.5, 4.5])
    expect(periodSpark(cs, '2026-01-01', '2026-01-06', null, 4.5)).toEqual([2, 3, 4.5])
  })
})

describe('Holdings cash row', () => {
  it('Day: total includes cash, cash row is last, labelled, outside sorting, no spark/pill', async () => {
    setup()
    const w = mountH()
    // positions 4000 + cash 500; day pct base includes cash like the value card
    expect(w.get('[data-test="h-total-value"]').text()).toBe(money(4500))
    expect(w.get('[data-test="h-total"]').text()).toContain(pct((-20 / 4520) * 100))
    const cash = w.findAll('[data-test="h-cash-row"]')
    expect(cash).toHaveLength(1)
    expect(cash[0].text()).toContain('Cash')
    expect(cash[0].text()).toContain('USD')
    expect(cash[0].get('[data-test="h-cash-value"]').text()).toBe(money(500))
    expect(cash[0].get('[data-test="h-cash-weight"]').text()).toBe(`${((500 / 4500) * 100).toFixed(1)}%`)
    expect(cash[0].findComponent(MarketSpark).exists()).toBe(false)
    expect(cash[0].find('.pill').exists()).toBe(false)
    expect(cash[0].find('a').exists()).toBe(false)
    expect(tickers(w)).toEqual(['CCC.US', 'AAA.US', 'BBB.US'])
    await w.get('[data-sort="ticker"]').trigger('click')
    const trs = w.findAll('tbody tr')
    expect(trs[trs.length - 1].attributes('data-test')).toBe('h-cash-row')
    await w.get('[data-sort="ticker"]').trigger('click')
    const trs2 = w.findAll('tbody tr')
    expect(trs2[trs2.length - 1].attributes('data-test')).toBe('h-cash-row')
  })

  it('Day: position + cash weights sum to 100% (also after a live tick)', () => {
    const { push } = setup({ isLive: true })
    const w = mountH()
    const sum = () => [...w.findAll('[data-test="h-weight"]'), ...w.findAll('[data-test="h-cash-weight"]')]
      .reduce((s, e) => s + parseFloat(e.text()), 0)
    expect(sum()).toBeCloseTo(100, 0)
    push('AAA.US', 130)
    return w.vm.$nextTick().then(() => expect(sum()).toBeCloseTo(100, 0))
  })

  it('Day: unknown day change gives a null change and % (dashes), total still incl. cash', () => {
    const { app } = setup()
    app.state.value = { ...app.state.value, rawPs: { ...PS, pos: PS.pos.map((p) => ({ ...p, close_price: null })) } }
    const w = mountH()
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain(money(4500))
    expect(total).not.toMatch(/\d%/)
  })

  it('Day: hidden amounts mask the cash value', () => {
    setup({ prefs: { hide: true } })
    const w = mountH()
    expect(w.get('[data-test="h-cash-value"]').text()).not.toContain('500')
  })

  it('Period: total equals the value card (summary.value_end), cash row last with weight', () => {
    setup({ prefs: { holdingsMode: 'period' } })
    const w = mountH()
    const end = CORE_YTD.summary.value_end
    expect(w.get('[data-test="h-total-value"]').text()).toBe(money(end))
    const cash = w.findAll('[data-test="hp-cash-row"]')
    expect(cash).toHaveLength(1)
    expect(cash[0].text()).toContain('Cash')
    expect(cash[0].get('[data-test="hp-cash-value"]').text()).toBe(money(500))
    expect(cash[0].get('[data-test="hp-cash-weight"]').text()).toBe(`${((500 / end) * 100).toFixed(1)}%`)
    const trs = w.findAll('tbody tr')
    expect(trs[trs.length - 1].attributes('data-test')).toBe('hp-cash-row')
  })

  it('one row per currency; zero balances are skipped', () => {
    const { app } = setup()
    app.state.value = { ...app.state.value, positions: [...POSITIONS, { ticker: 'EUR', name: 'EUR', kind: 'cash', qty: 100, price: 1.1, value: 110 }, { ticker: 'KZT', name: 'KZT', kind: 'cash', qty: 0, price: 0, value: 0 }] }
    const w = mountH()
    expect(w.findAll('[data-test="h-cash-row"]').map((r) => r.text())).toHaveLength(2)
    expect(w.get('[data-test="h-total-value"]').text()).toBe(money(4610))
  })

  it('link name has a separator between ticker and name', () => {
    setup()
    const w = mountH()
    expect(w.get('[data-test="h-link"]').text()).toMatch(/^[A-Z.]+ \S/)
  })
})

describe('dev mock (?mock)', () => {
  it('serves intraday candles for position tickers (sparks under ?mock)', async () => {
    const { createMockBroker } = await import('../src/dev/mock.js')
    const { parseHloc } = await import('../src/calc/portfolio.js')
    const b = createMockBroker()
    const tickers = ['AAA.US', 'BBB.US', 'CCC_KZ.KZ']
    const today = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10)
    const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10)
    const { marketClock, marketClockFor, marketDay } = await import('../src/calc/marketTime.js')
    const pending = Promise.all([b.hlocIntraday(tickers, from, to, 15), b.hlocIntraday(['SP500.IDX'], from, to, 15), b.marketStatus()])
    await vi.advanceTimersByTimeAsync(1000)
    const [ai, ax, st] = await pending
    const clock = marketClock({ ...st.result.markets, at: Date.now() })
    const [pos, idx] = [ai, ax].map((a) => parseHloc({ answer: a }, clock).rows)
    const sp = daySparks(pos, idx, clock, marketDay(marketClockFor(clock, 'FIX'), Date.now()))
    for (const tk of tickers) expect(sp[tk]?.spark.length, `${tk} ${today}`).toBeGreaterThan(2)
  })

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

// Task 32: columns must not move when amounts are hidden / shown or prices tick.
describe('Holdings column stability (Task 32)', () => {
  const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[^]*?\*\//g, '')
  const rule = (sel) => {
    const m = css.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'))
    return m ? m[1] : ''
  }
  const widthCh = (sel) => Number((rule(sel).match(/width:\s*calc\((\d+(?:\.\d+)?)ch/) || [])[1])
  const cols = (w, table) => w.get(table).findAll('col').map((c) => c.attributes('class'))

  it('every Holdings table is fixed-layout with a colgroup per column, identical in hide and shown states', async () => {
    const out = {}
    for (const hide of [false, true]) {
      setup({ prefs: { hide, holdingsMode: 'day', holdingsClosedOpen: true } })
      const w = mountH()
      const day = cols(w, 'table.htable')
      await w.get('[data-test="hmode-period"]').trigger('click')
      const period = cols(w, '[data-test="hp-table"]')
      const closed = cols(w, '[data-test="hc-table"]')
      for (const t of w.findAll('table')) expect(t.classes(), 'ptable--fixed').toContain('ptable--fixed')
      expect(day).toHaveLength(8)
      expect(period).toHaveLength(10)
      expect(closed).toHaveLength(4)
      out[hide] = { day, period, closed }
      w.unmount()
    }
    expect(out.true).toEqual(out.false)
  })

  it('the current-positions table is fixed too', () => {
    setup({ prefs: { holdingsMode: 'period' } })
    const w = mountH({ core: null })
    expect(w.get('[data-test="hold-current"]').classes()).toContain('ptable--fixed')
    expect(w.get('[data-test="hold-current"]').findAll('col')).toHaveLength(4)
  })

  it('stylesheet: fixed table layout and widths reserve the widest mask / number', () => {
    expect(rule('.ptable--fixed')).toMatch(/table-layout:\s*fixed/)
    // "−$9,999,999.99" = 14 chars, "$9,999,999.99" = 13; a 6-digit quantity with sign and comma = 8.
    expect(widthCh('.hcol--money')).toBeGreaterThanOrEqual(14)
    expect(widthCh('.hcol--qty')).toBeGreaterThanOrEqual(8)
    expect(widthCh('.hcol--price')).toBeGreaterThanOrEqual(10)
    expect(widthCh('.hcol--pct')).toBeGreaterThanOrEqual(8)
    expect(widthCh('.hcol--weight')).toBeGreaterThanOrEqual(7)
    expect(css).toMatch(/\.hcol--spark\s*\{[^}]*width:/)
    expect(rule('.hcol--sym')).not.toMatch(/width:/) // the symbol column takes the rest
    expect(css).toMatch(/\.ptable\s*\{[^}]*width:\s*100%/)
  })

  it('numbers are tabular and right-aligned; the total line reserves width per figure', () => {
    expect(rule('.num')).toMatch(/tabular-nums/)
    expect(css).toMatch(/\.ptable td\s*\{[^}]*text-align:\s*right/)
    expect(rule('.hold__total > .num-slot')).toMatch(/min-width:\s*\d+ch/)
    expect(rule('.hold__total > .num-slot')).toMatch(/text-align:\s*right/)
  })

  it('the total line figures are slots in both modes', async () => {
    setup()
    const w = mountH()
    expect(w.get('[data-test="h-total"]').findAll('.num-slot')).toHaveLength(3)
    await w.get('[data-test="hmode-period"]').trigger('click')
    expect(w.get('[data-test="h-total"]').findAll('.num-slot')).toHaveLength(3)
  })

  // --- width budget per breakpoint, computed from the parsed stylesheet
  const mediaBody = (query) => {
    const head = `@media ${query} {`
    const out = []
    let i = 0
    while ((i = css.indexOf(head, i)) >= 0) {
      let depth = 0
      let j = i + head.length - 1
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++
        else if (css[j] === '}' && --depth === 0) break
      }
      out.push(css.slice(i + head.length, j))
      i = j
    }
    return out.join('\n')
  }
  const baseCss = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '')
  /** Last `<sel> { width: calc(...) }` in the sources that apply, as px at the given digit width. */
  function colPx(cls, { vw, gap, ch, tight }) {
    const sources = [baseCss]
    if (vw < 768) sources.push(mediaBody('(max-width: 47.99rem)'))
    if (vw >= 768) sources.push(mediaBody('(min-width: 48rem)'))
    if (vw >= 1024) sources.push(mediaBody('(min-width: 64rem)'))
    let expr = null
    for (const src of sources) {
      const re = new RegExp(`(^|[\\s}])((?:\\.ptable--fixed:not\\(\\.htable\\) )?)\\.hcol--${cls}\\s*\\{\\s*width:\\s*([^;]+);`, 'g')
      for (const m of src.matchAll(re)) if (!m[2] || tight) expr = m[3]
    }
    if (!expr) throw new Error(`no width for ${cls}`)
    const g = tight ? 4 : gap
    const px = expr.replace(/var\(--gap\)/g, `${g}px`).replace(/var\(--pad\)/g, '14px')
      .replace(/([\d.]+)rem/g, (_, n) => `${n * 16}px`).replace(/([\d.]+)ch/g, (_, n) => `${n * ch}px`)
    try { return Function(`return (${px.replace(/^calc/, '').replace(/px/g, '')})`)() } catch (e) { throw new Error(`${cls}: ${expr} -> ${px}`) }
  }
  const room = (cols, env) => {
    const avail = env.vw - 2 * env.gutter - 2
    return avail - cols.reduce((sum, c) => sum + colPx(c, env), 0)
  }
  // caption 13px (mono digit .6em) below 64rem, .875rem at 64rem+; gap .5rem, .75rem at 64rem+.
  const MOBILE = { vw: 375, gutter: 12, gap: 8, ch: 7.8, tight: true }
  const TABLET = { vw: 768, gutter: 20, gap: 8, ch: 7.8 }
  const DESKTOP = { vw: 1280, gutter: 32, gap: 12, ch: 8.4 }
  const DAY = ['spark', 'price', 'pct', 'money', 'qty', 'money', 'weight']

  it('width budget: the Day table leaves >= 12ch for the symbol at tablet and desktop', () => {
    expect(room(DAY, TABLET)).toBeGreaterThanOrEqual(12 * TABLET.ch)
    expect(room(DAY, DESKTOP)).toBeGreaterThanOrEqual(12 * DESKTOP.ch)
  })

  it('width budget: closed / current tables on mobile leave a readable symbol column', () => {
    // first cell has 14px left padding; "AAA.US" = 6 digits
    expect(room(['qty', 'pcttxt', 'money'], MOBILE) - 14).toBeGreaterThanOrEqual(8 * MOBILE.ch)
    expect(room(['qty', 'price', 'value'], MOBILE) - 14).toBeGreaterThanOrEqual(8 * MOBILE.ch)
  })

  it('mobile total line is a grid: placement does not depend on the figures', () => {
    const m = mediaBody('(max-width: 47.99rem)')
    expect(m).toMatch(/\.hold__total\s*\{[^}]*display:\s*grid/)
  })
})
