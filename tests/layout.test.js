// @vitest-environment happy-dom
// Desktop / tablet layout (Task 16, option B: full-width bands in the mobile order, fluid width).
// Structural checks of the templates the CSS grid relies on, the stylesheet's breakpoints and
// charts sized by their container. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import MainScreen from '../src/components/MainScreen.vue'
import ValueBlock from '../src/components/ValueBlock.vue'
import Contributions from '../src/components/Contributions.vue'
import CompareScreen from '../src/components/CompareScreen.vue'
import SettingsScreen from '../src/components/SettingsScreen.vue'
import PositionSummary from '../src/components/PositionSummary.vue'
import { createAppState, installApp } from '../src/composables/useApp.js'
import { drawValueChart } from '../src/charts/valueChart.js'
import { drawPriceChart } from '../src/charts/priceChart.js'
import { drawCompareChart } from '../src/charts/compareChart.js'

const CORE = {
  series: [
    { date: '2026-10-26', pnl: 0, portfolio: 0, spy: 0, qqq: 0, value: 10000 },
    { date: '2026-10-27', pnl: 120.5, portfolio: 1.2, spy: 0.4, qqq: 0.6, value: 10120 },
    { date: '2026-10-28', pnl: 80.25, portfolio: 0.8, spy: -0.3, qqq: 0.1, value: 10580 },
  ],
  positions: [
    { ticker: 'AAA.US', name: 'Alpha', status: '', qty_start: 10, qty_end: 10, price_start: 100, price_end: 105, change_pct: 5, pnl: 50, value: 1050, weight: 9.9 },
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

function makeApp({ coreFor = () => CORE, prefs = {} } = {}) {
  const saved = []
  const repo = {
    subscribe: (fn) => { fn(STATE); return () => {} },
    onSessionExpired: () => () => {},
    load: async () => {},
    coreFor: vi.fn(coreFor),
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
  return { app, saved }
}

beforeEach(() => { window.location.hash = '' })
afterEach(() => { installApp(null) })

// --- stylesheet helpers: flat rules inside a media block (or outside every media block)
const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[^]*?\*\//g, '')

/** Bodies of every `@media <query> {…}` block, joined. */
function media(query) {
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

/** Stylesheet without its @media / @keyframes blocks. */
const base = (() => {
  let s = css
  for (;;) {
    const i = s.search(/@(media|keyframes)[^{]*\{/)
    if (i < 0) return s
    let depth = 0
    let j = s.indexOf('{', i)
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) break
    }
    s = s.slice(0, i) + s.slice(j + 1)
  }
})()

/** Declarations of all flat rules in `text` whose selector list contains `sel`. */
function decls(text, sel) {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel))
    .map((m) => m[2]).join(';')
}

const TABLET = '(min-width: 48rem)'
const DESKTOP = '(min-width: 64rem)'
const MOBILE = '(max-width: 47.99rem)'

describe('stylesheet breakpoints', () => {
  it('has the 48rem and 64rem media queries', () => {
    expect(media(TABLET)).not.toBe('')
    expect(media(DESKTOP)).not.toBe('')
  })

  it('mobile column unchanged; from 48rem the page is full width (no max-width container)', () => {
    expect(decls(base, '.app')).toMatch(/max-width:\s*44rem/)
    expect(decls(media(TABLET), '.app')).toMatch(/max-width:\s*none/)
    expect(decls(media(DESKTOP), '.app')).not.toMatch(/max-width:\s*(?!none)/)
    expect(css).not.toMatch(/80rem/)
  })

  it('side gutters grow per breakpoint from spacing tokens', () => {
    expect(decls(base, '.app')).toContain('var(--gutter)')
    expect(decls(media(TABLET), '.app')).toMatch(/--gutter:\s*calc\(var\(--gap-lg\)/)
    expect(decls(media(DESKTOP), '.app')).toMatch(/--gutter:\s*calc\(var\(--gap-lg\)/)
  })

  it('chart boxes get their height from CSS per breakpoint', () => {
    expect(decls(base, '.vchart')).toMatch(/(^|;)\s*height:\s*220px/)
    expect(decls(base, '.pchart')).toMatch(/(^|;)\s*height:\s*240px/)
    expect(decls(base, '.cchart')).toMatch(/(^|;)\s*height:\s*280px/)
    expect(decls(base, '.pchart__box')).toMatch(/height:\s*100%/)
    for (const q of [TABLET, DESKTOP]) {
      const m = media(q)
      expect(decls(m, '.vchart') + decls(m, '.vcard .vchart'), q).toMatch(/height:\s*\d+px/)
      expect(decls(m, '.pchart'), q).toMatch(/height:\s*\d+px/)
      expect(decls(m, '.cchart'), q).toMatch(/height:\s*\d+px/)
    }
  })

  it('markets: a 5-column grid from 48rem (no clipping), a fade hint on mobile', () => {
    const row = decls(media(TABLET), '.mkts__row')
    expect(row).toContain('repeat(5, minmax(0, 1fr))')
    expect(row).toMatch(/overflow:\s*visible/)
    expect(decls(media(MOBILE), '.mkts::after')).toContain('var(--c-bg)')
  })

  it('desktop value card: figures beside the chart (display: contents on the block)', () => {
    const d = media(DESKTOP)
    expect(decls(d, '.vcard')).toMatch(/grid-template-columns:/)
    expect(decls(d, '.vcard .vblock')).toMatch(/display:\s*contents/)
    expect(decls(d, '.vcard .vblock__body')).toMatch(/display:\s*contents/)
    // opacity on a display: contents box does nothing: the dimming moves to the children
    expect(decls(d, '.vcard .vblock__body.is-stale > *')).toMatch(/opacity/)
  })

  it('desktop: cash flows in one row, holdings head on one row, tables not height-capped', () => {
    const d = media(DESKTOP)
    expect(decls(d, '.kv.flows')).toMatch(/grid-auto-flow:\s*column/)
    expect(decls(d, '.hold__head')).toMatch(/display:\s*contents/)
    expect(decls(d, '.tablebox')).toMatch(/max-height:\s*none/)
    expect(decls(d, '.pstats')).toContain('repeat(4, minmax(0, 1fr))')
  })

  it('layout blocks use color tokens only', () => {
    for (const q of [TABLET, DESKTOP, MOBILE]) expect(media(q), q).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})

describe('no inline styles in templates (CSP)', () => {
  it('no static style attributes in components', () => {
    const dir = 'src/components'
    const files = [...readdirSync(dir).map((f) => join(dir, f)), 'src/App.vue']
    for (const f of files) {
      const tpl = readFileSync(f, 'utf8').split('<script')[0]
      expect(tpl, f).not.toMatch(/\sstyle="/)
    }
  })
})

describe('charts read their height from the container', () => {
  const box = (w, h) => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientWidth', { value: w })
    Object.defineProperty(el, 'clientHeight', { value: h })
    document.body.append(el)
    return el
  }
  const vb = (el) => el.querySelector('svg').getAttribute('viewBox')

  it('value chart', () => {
    for (const h of [220, 300]) {
      const el = box(800, h)
      drawValueChart(el, CORE.series, { mode: 'perf' })
      expect(vb(el)).toBe(`0 0 800 ${h}`)
      el.remove()
    }
  })

  it('price chart', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ts: i, date: `2026-10-2${i}`, close: 100 + i, vol: 10 + i }))
    for (const h of [240, 340]) {
      const el = box(900, h)
      drawPriceChart(el, rows, {})
      expect(vb(el)).toBe(`0 0 900 ${h}`)
      el.remove()
    }
  })

  it('compare chart', () => {
    const el = box(1000, 360)
    drawCompareChart(el, CORE.series, { labels: ['Portfolio', 'S&P 500', 'Nasdaq 100'] })
    expect(vb(el)).toBe('0 0 1000 360')
    el.remove()
  })

  it('a container not laid out yet (0 height) still gets a drawable chart', () => {
    const el = box(800, 0)
    drawValueChart(el, CORE.series, { mode: 'perf' })
    const h = Number(vb(el).split(' ')[3])
    expect(h).toBeGreaterThan(100)
    el.remove()
  })
})

describe('main screen: one spine of bands in the mobile order', () => {
  it('topbar, markets, value card, holdings, cash flows are direct children of the screen', async () => {
    makeApp()
    const w = mount(MainScreen)
    await flushPromises()
    const kids = [...w.get('.screen').element.children]
    const at = (pred) => kids.findIndex(pred)
    const order = [
      at((el) => el.classList.contains('topbar')),
      at((el) => el.dataset.test === 'markets'),
      at((el) => el.classList.contains('vcard')),
      at((el) => el.dataset.test === 'holdings'),
      at((el) => el.dataset.test === 'flows'),
    ]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    w.unmount()
  })

  it('value card carries aria-busy (its body is display: contents on desktop)', async () => {
    const { app } = makeApp({ coreFor: (p) => (p === 'YTD' ? CORE : null) })
    const w = mount(MainScreen)
    await flushPromises()
    expect(w.get('.vcard').attributes('aria-busy')).toBe('false')
    expect(w.get('.vblock__body').attributes('aria-busy')).toBeUndefined()
    app.prefs.period = '1m'
    await nextTick()
    expect(w.get('.vcard').attributes('aria-busy')).toBe('true')
    w.unmount()
  })

  it('value lines are tagged for grid placement, in data and skeleton states', () => {
    makeApp()
    const w = mount(ValueBlock, { props: { core: CORE, period: 'YTD' } })
    expect(w.get('[data-test="v-day"]').classes()).toContain('vline--day')
    expect(w.get('[data-test="v-period"]').classes()).toContain('vline--period')
    const s = mount(ValueBlock, { props: { core: null, period: 'YTD' } })
    expect(s.find('[data-test="v-skel"] .vline--day').exists()).toBe(true)
    expect(s.find('[data-test="v-skel"] .vline--period').exists()).toBe(true)
  })

  it('holdings: head (title, switch) and total are grid items of the card', async () => {
    makeApp({ prefs: { holdingsMode: 'period' } })
    const w = mount(MainScreen)
    await flushPromises()
    const hold = w.get('[data-test="holdings"]')
    expect(hold.classes()).toContain('hold')
    const head = hold.get(':scope > .hold__head')
    expect(head.find('#hold-h').exists()).toBe(true)
    expect(head.find('[data-test="hmode"]').exists()).toBe(true)
    expect(hold.find(':scope > [data-test="h-total"]').exists()).toBe(true)
    w.unmount()
  })

  it('cash flows: one dl of dt/dd pairs (one row on desktop)', async () => {
    makeApp()
    const w = mount(MainScreen)
    await flushPromises()
    const dl = w.get('[data-test="flows"] dl.kv.flows')
    const tags = [...dl.element.children].map((el) => el.tagName)
    expect(tags.length).toBe(14)
    expect(tags.every((t, i) => t === (i % 2 ? 'DD' : 'DT'))).toBe(true)
    w.unmount()
  })
})

describe('Contributions open state is remembered', () => {
  it('toggle writes prefs.contribOpen (persisted)', async () => {
    const { app, saved } = makeApp()
    const w = mount(Contributions, { props: { positions: CORE.positions } })
    expect(w.find('.contrib__body').exists()).toBe(false)
    await w.get('[data-test="contrib-toggle"]').trigger('click')
    await nextTick()
    expect(app.prefs.contribOpen).toBe(true)
    expect(saved.at(-1).contribOpen).toBe(true)
    expect(w.find('.contrib__body').exists()).toBe(true)
  })

  it('opens expanded when prefs say so', () => {
    makeApp({ prefs: { contribOpen: true } })
    const w = mount(Contributions, { props: { positions: CORE.positions } })
    expect(w.get('[data-test="contrib-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(w.find('.contrib__body').exists()).toBe(true)
  })
})

describe('other screens', () => {
  it('compare: legend and chart are siblings in the chart card (legend beside the chart on desktop)', async () => {
    makeApp()
    const w = mount(CompareScreen)
    await flushPromises()
    const card = w.get('.cmp-card')
    expect(card.find(':scope > .legend').exists()).toBe(true)
    expect(card.find(':scope > .cchart').exists()).toBe(true)
    w.unmount()
  })

  it('settings: a narrow centred screen', () => {
    makeApp()
    const w = mount(SettingsScreen)
    expect(w.get('.screen').classes()).toContain('screen--narrow')
    w.unmount()
  })

  it('position summary: My holdings and Key statistics have their layout classes', async () => {
    makeApp()
    const pos = reactive({
      ticker: 'AAA.US', name: 'Alpha Corp', exchange: 'NASDAQ', currency: 'USD',
      price: 110, change: 2, changePct: 1.85, prevClose: 108, isLive: false, closedAt: null,
      sec: { info: { c: 'AAA.US' }, intraday: [], daily: [], errors: {}, sessions: [] },
      stats: { dayLow: 100, dayHigh: 112, low52: 50, high52: 120, prevClose: 108, open: 109, volume: 1000, avgVolume: 900, kind: 'stock' },
      holding: { qty: 10, avgCost: 80, marketValue: 1100, dayGain: 20, dayGainPct: 1.85, totalGain: 300, totalGainPct: 37.5, currency: 'USD' },
      load: () => {},
    })
    const w = mount(PositionSummary, { props: { pos, period: '1D' } })
    await flushPromises()
    expect(w.get('[data-test="p-holdings"]').classes()).toContain('p-hold')
    expect(w.get('[data-test="p-stats"]').classes()).toContain('p-stats')
    w.unmount()
  })
})
