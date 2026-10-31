// Contributions: horizontal P&L bars per position, from zero to the left/right.
import { scaleLinear, min, max } from 'd3'
import { svgIn, measure, widthOf } from './util.js'
import { fMoney } from '../display.js'

const BH = 22

/**
 * @param {HTMLElement} el
 * @param {Array<{ticker, pnl}>} positions computeCore positions
 * @param {{hide: boolean}} opts hide: amount labels become $***
 */
export function drawBarsChart(el, positions, { hide = false } = {}) {
  el.replaceChildren()
  const rows = (positions || []).filter((r) => r.pnl != null && Number.isFinite(+r.pnl))
    .slice().sort((a, b) => b.pnl - a.pnl)
  if (!rows.length) return () => el.replaceChildren()

  const W = widthOf(el)
  const m = { t: 6, r: 8, b: 6 }
  const H = m.t + m.b + rows.length * BH
  const svg = svgIn(el, W, H, 'bars__svg')
  const label = (r) => fMoney(r.pnl, { hide, sign: true })
  const lw = measure(svg, rows.map((r) => r.ticker)) + 10
  const vw = measure(svg, rows.map(label)) + 8
  const lo = Math.min(0, min(rows, (r) => r.pnl))
  const hi = Math.max(0, max(rows, (r) => r.pnl))
  const x = scaleLinear([lo, hi], [lw + (lo < 0 ? vw : 0), W - m.r - (hi > 0 ? vw : 0)])
  const yb = (i) => m.t + i * BH

  svg.append('line').attr('class', 'chart-axis').attr('x1', x(0)).attr('x2', x(0)).attr('y1', m.t).attr('y2', H - m.b)
  const row = svg.append('g').attr('class', 'chart-text').selectAll('g').data(rows).join('g')
  row.append('text').attr('class', 'bars__tk').attr('x', 0).attr('y', (r, i) => yb(i) + BH / 2).attr('dy', '0.32em').text((r) => r.ticker)
  row.append('rect').attr('class', (r) => (r.pnl < 0 ? 'bars__bar bars__bar--neg' : 'bars__bar bars__bar--pos'))
    .attr('x', (r) => Math.min(x(0), x(r.pnl))).attr('y', (r, i) => yb(i) + 4).attr('height', BH - 8)
    .attr('width', (r) => Math.max(1, Math.abs(x(r.pnl) - x(0)))).attr('rx', 3)
  row.append('text').attr('x', (r) => (r.pnl < 0 ? x(r.pnl) - 4 : x(r.pnl) + 4)).attr('y', (r, i) => yb(i) + BH / 2)
    .attr('dy', '0.32em').attr('text-anchor', (r) => (r.pnl < 0 ? 'end' : 'start')).text(label)
  return () => el.replaceChildren()
}
