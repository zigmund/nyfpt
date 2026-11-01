// @vitest-environment happy-dom
// Task 51 views: Holdings Day and the security card on the US regular close; the card shows the
// after-hours / pre-market trade apart. Synthetic tickers and prices only.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import Holdings from '../src/components/Holdings.vue'
import MarketSpark from '../src/components/MarketSpark.vue'
import { installApp } from '../src/composables/useApp.js'
import { regularQuote } from '../src/calc/live.js'
import { money, pct } from '../src/format.js'

// US market clock (exchange wall minutes): open 09:30, regular close 16:00.
const US = { offset: 10800, dt: 0, tz: null, pre: 430, open: 570, close: 1200, regular: 960 }
const PS = {
  acc: [{ curr: 'USD', s: 0, currval: 1 }],
  pos: [{ i: 'AAA.US', name: 'Alpha', q: 10, mkt_price: 106, close_price: 104, market_value: 1060, currval: 1, curr: 'USD' }],
}
// Saturday snapshot: Friday's last after-hours trade 106, regular close 104, Thursday's 100.
const SNAP = new Map([['AAA.US', { c: 'AAA.US', ltr: 'FIX', ltp: 106, chg: 6, pcp: 6, pp: 100, ClosePrice: 104, ltt: '2026-10-30T19:58:00' }]])

afterEach(() => installApp(null))

describe('Holdings Day on the regular close (Task 51)', () => {
  it('price = the regular close, day change against the previous regular close', () => {
    installApp({
      state: ref({ rawPs: PS, positions: [], trades: [], sparks: {}, closes: new Map(), quotes: SNAP }),
      tick: ref(0),
      live: { isLive: ref(false), usOpen: ref(false), quotes: new Map() },
      prefs: reactive({ hide: false, sorts: {} }),
      liveQuotesForCalc: () => undefined,
      coreFor: vi.fn(() => null),
      ensurePrices: vi.fn(async () => {}),
      regularQuote: (tk, q) => regularQuote(q, US),
    })
    const w = mount(Holdings, { props: { core: null, period: 'YTD' } })
    const row = w.get('[data-ticker="AAA.US"]')
    expect(row.get('[data-test="h-price"]').text()).toBe('104.00')
    expect(row.get('[data-test="h-daypct"]').text()).toBe(pct(4))
    expect(w.get('[data-test="h-total"]').text()).toContain(money(40))
  })
})

describe('Holdings day spark in the US pre-open (fix round 1)', () => {
  it('today\'s pre-open spark is levelled at the last regular close, not the one before', () => {
    const pre = new Map([['AAA.US', { c: 'AAA.US', ltr: 'FIX', ltp: 106, chg: 2, pp: 104, ClosePrice: 104, ltt: '2026-11-02T08:00:00' }]])
    const closes = new Map([['2026-10-29', 100], ['2026-10-30', 104]])
    installApp({
      state: ref({ rawPs: PS, positions: [], trades: [], sparks: { 'AAA.US': { date: '2026-11-02', spark: [104.5, 105, 106] } }, closes: new Map(), quotes: pre }),
      tick: ref(0),
      live: { isLive: ref(false), usOpen: ref(false), quotes: new Map() },
      prefs: reactive({ hide: false, sorts: {} }),
      liveQuotesForCalc: () => undefined,
      coreFor: vi.fn(() => null),
      ensurePrices: vi.fn(async () => {}),
      regularQuote: (tk, q) => regularQuote(q, US, closes),
    })
    const w = mount(Holdings, { props: { core: null, period: 'YTD' } })
    const row = w.get('[data-ticker="AAA.US"]')
    expect(row.get('[data-test="h-price"]').text()).toBe('104.00')
    expect(row.get('[data-test="h-daypct"]').text()).toBe(pct(4))
    expect(row.findComponent(MarketSpark).props('prev')).toBe(104)
  })
})
