// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import Holdings from '../src/components/Holdings.vue'
import { installApp } from '../src/composables/useApp.js'
import { money, pct } from '../src/format.js'

// Synthetic raw `ps` (broker shape); not real account data.
const PS = {
  acc: [{ curr: 'USD', s: 500, currval: 1 }],
  pos: [
    { i: 'AAA.US', name: 'Alpha', q: 10, mkt_price: 100, close_price: 98, market_value: 1000, currval: 1, curr: 'USD' },
    { i: 'BBB.US', name: 'Beta', q: 20, mkt_price: 50, close_price: 52, market_value: 1000, currval: 1, curr: 'USD' },
    { i: 'CCC.US', name: 'Gamma', q: 5, mkt_price: 400, close_price: 400, market_value: 2000, currval: 1, curr: 'USD' },
  ],
}

function setup({ prefs = {}, isLive = false } = {}) {
  const quotes = new Map()
  const app = {
    state: ref({ rawPs: PS }),
    tick: ref(0),
    live: { isLive: ref(isLive), usOpen: ref(false), quotes },
    prefs: reactive({ hide: false, sorts: {}, ...prefs }),
    liveQuotesForCalc: () => (app.live.isLive.value ? quotes : undefined),
  }
  installApp(app)
  const push = (ticker, ltp) => {
    quotes.set(ticker, { c: ticker, ltp, pp: ticker === 'BBB.US' ? 52 : 98 })
    app.tick.value++
  }
  return { app, push }
}

const tickers = (w) => w.findAll('[data-test="h-row"]').map((r) => r.attributes('data-ticker'))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); installApp(null) })

describe('Holdings', () => {
  it('defaults to Value descending and shows the day total', () => {
    setup()
    const w = mount(Holdings)
    expect(tickers(w)).toEqual(['CCC.US', 'AAA.US', 'BBB.US'])
    // day: AAA +20, BBB -40, CCC 0 => -20 on a base of 4020
    const total = w.get('[data-test="h-total"]').text()
    expect(total).toContain(money(-20))
    expect(total).toContain(pct((-20 / 4020) * 100))
  })

  it('sorts on header click, toggles direction, persists to prefs.sorts', async () => {
    const { app } = setup()
    const w = mount(Holdings)
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
    const w = mount(Holdings)
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
    const w = mount(Holdings)
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
    const w = mount(Holdings)
    app.state.value = { rawPs: { ...PS, pos: PS.pos.map((p) => ({ ...p, mkt_price: p.mkt_price + 5 })) } }
    app.tick.value++
    await nextTick()
    expect(w.findAll('.flash-up, .flash-down')).toHaveLength(0)
  })

  it('has no aria-live regions', () => {
    setup()
    const w = mount(Holdings)
    expect(w.find('[aria-live], [role="status"]').exists()).toBe(false)
  })
})
