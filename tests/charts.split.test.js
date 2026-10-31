// @vitest-environment happy-dom
// Task 29: line charts split colour at the waterline (green above, red below). Synthetic data only.
import { describe, expect, it } from 'vitest'
import { drawSparkline } from '../src/charts/sparkline.js'
import { drawPriceChart } from '../src/charts/priceChart.js'
import { drawValueChart } from '../src/charts/valueChart.js'

const box = () => document.body.appendChild(document.createElement('div'))
const rowsOf = (closes) => closes.map((close, i) => ({ ts: i, date: `2026-01-${String(i + 1).padStart(2, '0')}`, close, vol: 0, min: null }))
const seriesOf = (vals) => vals.map((v, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: v, portfolio: v, pnl: 0 }))

/** Checks: two clipped line halves split at the base y, unique clip ids, dot on its side. */
function expectSplit(el, { lineSel, dot }) {
  const lines = [...el.querySelectorAll(lineSel)]
  expect(lines.map((l) => l.classList.contains('chart-seg--pos'))).toEqual([true, false])
  const clips = [...el.querySelectorAll('clipPath')]
  expect(clips).toHaveLength(2)
  const [up, dn] = clips.map((c) => c.querySelector('rect'))
  const yb = +up.getAttribute('y') + +up.getAttribute('height')
  expect(+dn.getAttribute('y')).toBeCloseTo(yb, 5)
  for (const l of lines) expect(el.querySelector(`#${l.getAttribute('clip-path').slice(5, -1)}`)).not.toBeNull()
  expect(el.querySelector('.chart-base').getAttribute('y1')).toBe(String(yb))
  expect(el.querySelector('circle.chart-dot, circle.spark__dot').getAttribute('class')).toContain(dot)
}

describe('sparkline split', () => {
  it('crossing the baseline: pos part above, neg part below', () => {
    const el = box()
    drawSparkline(el, [10, 12, 8, 7, 9], { prev: 10 })
    expectSplit(el, { lineSel: '.spark__line', dot: 'chart-seg--neg' })
    expect(el.querySelectorAll('.spark__fill')).toHaveLength(2)
  })
  it('entirely above: only pos parts', () => {
    const el = box()
    drawSparkline(el, [10, 12, 13, 11.5], { prev: 10 })
    expect(el.querySelectorAll('.chart-seg--neg')).toHaveLength(0)
    expect(el.querySelectorAll('.spark__line.chart-seg--pos')).toHaveLength(1)
    expect(el.querySelector('.spark__dot').getAttribute('class')).toContain('chart-seg--pos')
  })
  it('clip ids are unique per instance', () => {
    const a = box(), b = box()
    drawSparkline(a, [1, 2, 0.5], { prev: 1 })
    drawSparkline(b, [1, 2, 0.5], { prev: 1 })
    const ids = [...a.querySelectorAll('clipPath'), ...b.querySelectorAll('clipPath')].map((c) => c.id)
    expect(new Set(ids).size).toBe(4)
  })
  it('no base given: first point is the waterline', () => {
    const el = box()
    drawSparkline(el, [10, 9, 11, 12])
    expect(el.querySelectorAll('.spark__line')).toHaveLength(2)
  })
})

describe('price chart split', () => {
  it('splits at the previous close; dot follows the last side; no style attributes on segments', () => {
    const el = box()
    drawPriceChart(el, rowsOf([10, 12, 8, 7, 9]), { base: 10, intraday: true })
    expectSplit(el, { lineSel: '.chart-line', dot: 'chart-seg--neg' })
    expect(el.querySelectorAll('.pchart__fill')).toHaveLength(2)
    for (const n of el.querySelectorAll('.chart-seg--pos, .chart-seg--neg')) expect(n.getAttribute('style')).toBeNull()
  })
  it('no base: splits at the first close without a dashed line', () => {
    const el = box()
    drawPriceChart(el, rowsOf([10, 12, 8, 13]), {})
    expect(el.querySelector('.chart-base')).toBeNull()
    expect(el.querySelectorAll('.chart-line')).toHaveLength(2)
    expect(el.querySelector('circle.chart-dot').getAttribute('class')).toContain('chart-seg--pos')
  })
})

describe('value chart split', () => {
  it('splits at the first value', () => {
    const el = box()
    drawValueChart(el, seriesOf([100, 110, 90, 85, 95]), { mode: 'value' })
    expectSplit(el, { lineSel: '.chart-line', dot: 'chart-seg--neg' })
  })
  it('all above: pos only', () => {
    const el = box()
    drawValueChart(el, seriesOf([100, 110, 120]), { mode: 'value' })
    expect(el.querySelectorAll('.chart-seg--neg')).toHaveLength(0)
  })
})
