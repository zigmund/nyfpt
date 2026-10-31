// @vitest-environment happy-dom
// Task 30: Contributions bars on a linear scale; labels do not eat the bar area. Synthetic data only.
import { describe, expect, it } from 'vitest'
import { drawBarsChart } from '../src/charts/barsChart.js'

const boxW = (w) => {
  const el = document.body.appendChild(document.createElement('div'))
  Object.defineProperty(el, 'clientWidth', { value: w })
  return el
}
const mk = () => [
  ['AAA', 6931.69], ['ZZZZZ9.0199.AIX.KZ', 1240], ['BBB', 400.5], ['CCC', 20], ['DDD', 0.01],
  ['EEE', -15], ['FFF', -812.4], ['GGG', -1500.25],
  ...Array.from({ length: 22 }, (_, i) => [`T${i}`, (i % 2 ? 1 : -1) * (50 + i * 7)]),
].map(([ticker, pnl]) => ({ ticker, pnl }))
const bars = (el) => [...el.querySelectorAll('rect.bars__bar')]
const num = (n, a) => +n.getAttribute(a)

describe.each([[360], [800]])('bars chart at %ipx', (W) => {
  it('bar area is wide, largest bar spans the whole positive part, proportions linear', () => {
    const el = boxW(W)
    drawBarsChart(el, mk())
    const bs = bars(el)
    expect(bs).toHaveLength(30)
    const axis = el.querySelector('line.chart-axis')
    const x0 = num(axis, 'x1')
    // all bars start at x0 and grow right; linear on |pnl|; largest |pnl| fills the area
    for (const b of bs) expect(num(b, 'x')).toBe(x0)
    const areaR = Math.max(...bs.map((b) => num(b, 'x') + num(b, 'width')))
    expect(areaR - x0).toBeGreaterThanOrEqual(W * (W < 768 ? 0.8 : 0.6) - 1)
    const unit = (areaR - x0) / 6931.69
    const pn = mk().map((r) => r.pnl).sort((a, b) => b - a)
    bs.forEach((b, i) => { if (Math.abs(pn[i]) > 100) expect(Math.abs(num(b, 'width') - Math.abs(pn[i]) * unit)).toBeLessThanOrEqual(1) })
    // colour by sign, negatives grow right too
    bs.forEach((b, i) => expect(b.classList.contains('bars__bar--neg')).toBe(pn[i] < 0))
    expect(num(bs.find((b, i) => pn[i] === -1500.25), 'width')).toBeCloseTo(1500.25 * unit, 0)
    for (const b of bs) { expect(num(b, 'height')).toBeGreaterThanOrEqual(10); expect(num(b, 'width')).toBeGreaterThanOrEqual(2) }
    expect(el.querySelector('svg').getAttribute('viewBox').split(' ')[2]).toBe(String(W))
  })
  it('long ticker does not shrink the bar area; full ticker kept in <title>', () => {
    const a = boxW(W); const b = boxW(W)
    drawBarsChart(a, [{ ticker: 'A', pnl: 100 }, { ticker: 'B', pnl: -50 }])
    drawBarsChart(b, [{ ticker: 'ZZZZZ9.0199.AIX.KZ', pnl: 100 }, { ticker: 'B', pnl: -50 }])
    const span = (el) => Math.max(...bars(el).map((r) => num(r, 'x') + num(r, 'width'))) - Math.min(...bars(el).map((r) => num(r, 'x')))
    if (W < 768) expect(span(b)).toBeCloseTo(span(a), 5)
    else expect(span(b)).toBeGreaterThan(W * 0.5)
    expect([...b.querySelectorAll('title')].map((t) => t.textContent)).toContain('ZZZZZ9.0199.AIX.KZ')
  })
  it('hidden amounts and sign classes; no style attributes', () => {
    const el = boxW(W)
    drawBarsChart(el, mk(), { hide: true })
    const vals = [...el.querySelectorAll('.bars__val')].map((t) => t.textContent)
    expect(vals).toHaveLength(30)
    expect(vals.every((v) => v.includes('***') && !/\d/.test(v))).toBe(true)
    expect(el.querySelectorAll('.bars__val--neg').length).toBeGreaterThan(0)
    expect(el.querySelector('[style]')).toBeNull()
  })
})

describe('bars chart layout', () => {
  it('narrow: ticker and amount share a row above the bar; wide: single row', () => {
    const n = boxW(360); drawBarsChart(n, mk())
    const w = boxW(800); drawBarsChart(w, mk())
    const hN = +n.querySelector('svg').getAttribute('viewBox').split(' ')[3]
    const hW = +w.querySelector('svg').getAttribute('viewBox').split(' ')[3]
    expect(hN).toBeGreaterThan(hW)
    const t = n.querySelector('.bars__tk'); const r = n.querySelector('rect.bars__bar')
    expect(num(r, 'y')).toBeGreaterThan(num(t, 'y'))
  })
  it('single-sign sets and empty input still work', () => {
    const el = boxW(360)
    drawBarsChart(el, [{ ticker: 'A', pnl: 5 }, { ticker: 'B', pnl: 10 }])
    expect(bars(el)).toHaveLength(2)
    drawBarsChart(el, [{ ticker: 'A', pnl: -5 }])
    expect(bars(el)).toHaveLength(1)
    drawBarsChart(el, [])
    expect(el.children).toHaveLength(0)
  })
})

describe('bars chart label safety and a11y', () => {
  const long = 'VERYLONGTICKER.1234567890.EXCHANGE.SUFFIX.KZ'
  const shownOf = (el) => el.querySelector('.bars__tk tspan').textContent
  it('narrow: long ticker is truncated so it cannot hit a large amount', () => {
    const el = boxW(360)
    drawBarsChart(el, [{ ticker: long, pnl: 1234567.89 }, { ticker: 'B', pnl: -5 }])
    const s = shownOf(el)
    expect(s.endsWith('…')).toBe(true)
    const amount = el.querySelector('.bars__val').textContent
    expect(s.length * 7 + amount.length * 7).toBeLessThanOrEqual(360)
    expect(el.querySelector('.bars__tk title').textContent).toBe(long)
  })
  it('wide: long ticker gets an ellipsis', () => {
    const el = boxW(800)
    drawBarsChart(el, [{ ticker: long, pnl: 100 }])
    expect(shownOf(el).endsWith('…')).toBe(true)
  })
  it('svg has an accessible label and decorative rects are hidden', () => {
    const el = boxW(360)
    drawBarsChart(el, [{ ticker: 'AAA', pnl: 5 }, { ticker: 'B', pnl: -5 }])
    const svg = el.querySelector('svg')
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toContain('AAA')
    expect(svg.getAttribute('aria-label')).toContain('B')
    for (const r of el.querySelectorAll('rect.bars__bar')) expect(r.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('Task 33: axis stays out of labels, compact narrow rows', () => {
  const axes = (el) => [...el.querySelectorAll('line.chart-axis')].map((l) => ({ y1: num(l, 'y1'), y2: num(l, 'y2'), x1: num(l, 'x1'), x2: num(l, 'x2') }))
  const labelBand = (el) => [...el.querySelectorAll('.bars__tk, .bars__val')].map((t) => [num(t, 'y') - 7, num(t, 'y') + 7])
  it('narrow: no axis segment overlaps any label y-band; segments are vertical and sit in bar bands', () => {
    const el = boxW(375); drawBarsChart(el, mk())
    const segs = axes(el); const bands = labelBand(el)
    expect(segs.length).toBeGreaterThanOrEqual(30)
    for (const s of segs) {
      expect(s.x1).toBe(s.x2)
      for (const [a, b] of bands) expect(s.y2 <= a || s.y1 >= b).toBe(true)
    }
    const bs = bars(el)
    bs.forEach((b, i) => { expect(segs[i].y1).toBeLessThanOrEqual(num(b, 'y')); expect(segs[i].y2).toBeGreaterThanOrEqual(num(b, 'y') + num(b, 'height')) })
  })
  it('narrow: compact rows, bar right under its label', () => {
    const el = boxW(375); drawBarsChart(el, mk())
    const h = +el.querySelector('svg').getAttribute('viewBox').split(' ')[3]
    expect(h).toBeLessThanOrEqual(12 + 30 * 38)
    const tks = [...el.querySelectorAll('.bars__tk')]
    bars(el).forEach((b, i) => { const gap = num(b, 'y') - num(tks[i], 'y'); expect(gap).toBeGreaterThan(5); expect(gap).toBeLessThanOrEqual(10) })
  })
  it('wide: one axis line, right of the ticker column', () => {
    const el = boxW(800); drawBarsChart(el, mk())
    const segs = axes(el)
    expect(segs).toHaveLength(1)
    expect(segs[0].x1).toBeGreaterThan(20)
    for (const b of bars(el)) expect(num(b, 'x')).toBe(segs[0].x1)
  })
})

describe('Task 37: two columns on desktop', () => {
  const pairs = (el) => bars(el).map((b) => ({ x: num(b, 'x'), w: num(b, 'width'), y: num(b, 'y'), neg: b.classList.contains('bars__bar--neg') }))
  const sorted = () => mk().map((r) => r.pnl).sort((a, b) => b - a)
  it('below the threshold (899px) stays one column, at 1280 splits in two', () => {
    const one = boxW(899); drawBarsChart(one, mk())
    expect(one.querySelectorAll('line.chart-axis')).toHaveLength(1)
    const two = boxW(1280); drawBarsChart(two, mk())
    expect(two.querySelectorAll('line.chart-axis')).toHaveLength(2)
    const h1 = +one.querySelector('svg').getAttribute('viewBox').split(' ')[3]
    const h2 = +two.querySelector('svg').getAttribute('viewBox').split(' ')[3]
    expect(h2).toBeLessThan(h1 * 0.6)
  })
  describe.each([[1280], [1728]])('at %ipx', (W) => {
    it('first ceil(n/2) rows left top-down, rest right; order preserved', () => {
      const el = boxW(W); drawBarsChart(el, mk())
      const p = pairs(el); const n = p.length; const half = Math.ceil(n / 2)
      const [a, b] = el.querySelectorAll('line.chart-axis')
      const ax = [num(a, 'x1'), num(b, 'x1')]
      const left = p.filter((r) => r.x === ax[0]); const right = p.filter((r) => r.x === ax[1])
      expect(left).toHaveLength(half); expect(right).toHaveLength(n - half)
      // DOM order is sort order: first half are the left ones
      expect(p.slice(0, half).every((r) => r.x === ax[0])).toBe(true)
      for (const col of [left, right]) col.forEach((r, i) => i && expect(r.y).toBeGreaterThan(col[i - 1].y))
      expect(right[0].y).toBe(left[0].y)
      const pn = sorted()
      p.forEach((r, i) => expect(r.neg).toBe(pn[i] < 0))
    })
    it('one shared length scale; baseline at the same offset in each column', () => {
      const el = boxW(W); drawBarsChart(el, mk())
      const p = pairs(el); const half = Math.ceil(p.length / 2); const pn = sorted()
      expect(half).toBe(15)
      const unit = p[0].w / pn[0]
      p.forEach((r, i) => { if (Math.abs(pn[i]) > 100) expect(Math.abs(r.w - Math.abs(pn[i]) * unit)).toBeLessThanOrEqual(1) })
      // equal |pnl| in different columns -> equal width
      const eq = [{ ticker: 'A', pnl: 500 }, { ticker: 'B', pnl: 400 }, { ticker: 'C', pnl: -400 }, { ticker: 'D', pnl: 300 }, { ticker: 'E', pnl: 1000 }, { ticker: 'F', pnl: -300 }]
      const e = boxW(W); drawBarsChart(e, eq)
      // sorted desc: 1000, 500, 400 | 300, -300, -400 (left column | right column)
      const order = [1000, 500, 400, 300, -300, -400]
      const ep = pairs(e)
      expect(ep).toHaveLength(6)
      const widthsOf = (v) => ep.filter((r, i) => Math.abs(order[i]) === v).map((r) => r.w)
      const [w400left, w400right] = widthsOf(400) // +400 left, -400 right: same |pnl| across columns
      expect(w400left).toBeCloseTo(w400right, 5)
      const [w300, w300neg] = widthsOf(300) // same column, opposite signs
      expect(w300).toBeCloseTo(w300neg, 5)
      const axes = [...e.querySelectorAll('line.chart-axis')].map((l) => num(l, 'x1'))
      const colOff = ep.map((r, i) => r.x - axes[i < 3 ? 0 : 1])
      expect(colOff.every((o) => o === 0)).toBe(true)
      const lcol = axes[1] - axes[0]
      expect(lcol).toBeGreaterThan(300)
    })
    it('nothing crosses into the neighbouring column; visible gap', () => {
      const el = boxW(W); drawBarsChart(el, mk())
      const svgW = +el.querySelector('svg').getAttribute('viewBox').split(' ')[2]
      const p = pairs(el); const half = Math.ceil(p.length / 2)
      const [a, b] = [...el.querySelectorAll('line.chart-axis')].map((l) => num(l, 'x1'))
      const leftEnd = Math.max(...p.slice(0, half).map((r) => r.x + r.w))
      const vals = [...el.querySelectorAll('.bars__val')]
      const leftVal = vals.slice(0, half); const rightVal = vals.slice(half)
      const colRight = Math.min(...rightVal.map((v) => num(v, 'x'))) // right column's right edge (end anchor)
      const leftColRight = num(leftVal[0], 'x')
      expect(colRight).toBe(svgW)
      expect(leftEnd).toBeLessThan(leftColRight) // bars stop before the left amounts
      const tkR = [...el.querySelectorAll('.bars__tk')].slice(half)
      const rightColLeft = Math.min(...tkR.map((t) => num(t, 'x')))
      expect(rightColLeft - leftColRight).toBeGreaterThanOrEqual(24) // gap between columns
      expect(b).toBeGreaterThan(a)
      // The global max bar sits in the left column and ends where its amount column begins;
      // right bars must leave at least the same room before the right amounts.
      const rightEnd = Math.max(...p.slice(half).map((r) => r.x + r.w))
      expect(svgW - rightEnd).toBeGreaterThanOrEqual(leftColRight - leftEnd - 1e-6)
      expect(el.querySelector('line.bars__div')).not.toBeNull()
    })
    it('hidden amounts in both columns, no style attrs', () => {
      const el = boxW(W); drawBarsChart(el, mk(), { hide: true })
      const vals = [...el.querySelectorAll('.bars__val')].map((t) => t.textContent)
      expect(vals).toHaveLength(30)
      expect(vals.every((v) => v.includes('***'))).toBe(true)
      expect(el.querySelector('[style]')).toBeNull()
    })
  })
  it('odd count: left column has the extra row; tiny sets still work', () => {
    const el = boxW(1280)
    drawBarsChart(el, [{ ticker: 'A', pnl: 3 }, { ticker: 'B', pnl: 2 }, { ticker: 'C', pnl: 1 }])
    const xs = bars(el).map((b) => num(b, 'x'))
    expect(xs[0]).toBe(xs[1]); expect(xs[2]).toBeGreaterThan(xs[0])
    const one = boxW(1280); drawBarsChart(one, [{ ticker: 'A', pnl: 3 }])
    expect(bars(one)).toHaveLength(1)
    expect(one.querySelectorAll('line.chart-axis')).toHaveLength(1)
  })
})
