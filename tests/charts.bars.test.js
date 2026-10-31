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

describe.each([[360], [1280]])('bars chart at %ipx', (W) => {
  it('bar area is wide, largest bar spans the whole positive part, proportions linear', () => {
    const el = boxW(W)
    drawBarsChart(el, mk())
    const bs = bars(el)
    expect(bs).toHaveLength(30)
    const axis = el.querySelector('line.chart-axis')
    const x0 = num(axis, 'x1')
    const lefts = bs.map((b) => num(b, 'x')); const rights = bs.map((b) => num(b, 'x') + num(b, 'width'))
    const areaL = Math.min(...lefts); const areaR = Math.max(...rights)
    expect(areaR - areaL).toBeGreaterThanOrEqual(W * (W < 768 ? 0.8 : 0.6) - 1)
    const unit = (areaR - x0) / 6931.69
    expect(areaR).toBeCloseTo(x0 + 6931.69 * unit, 5)
    const b1240 = bs.find((b, i) => i === 1)
    expect(num(b1240, 'width') / (areaR - x0)).toBeCloseTo(1240 / 6931.69, 2)
    expect(Math.abs(num(b1240, 'width') - (areaR - x0) * 1240 / 6931.69)).toBeLessThanOrEqual(1)
    // negatives share the same unit (asymmetric domain, zero proportional)
    const neg = bs.find((b) => b.classList.contains('bars__bar--neg') && num(b, 'x') === areaL)
    expect(num(neg, 'width')).toBeCloseTo(1500.25 * unit, 0)
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
    const w = boxW(1280); drawBarsChart(w, mk())
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
    const el = boxW(1280)
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
