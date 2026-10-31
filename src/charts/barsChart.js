// Contributions: horizontal P&L bars per position on a LINEAR scale, domain [min(0,min), max(0,max)].
// Narrow container (< 768px = 48rem): two tiers per row (ticker + amount on top, full-width bar below).
// Wide: columns ticker | bars | amount. Redraws on width change via useChart (ResizeObserver).
import { scaleLinear, min, max } from 'd3'
import { svgIn, measure, widthOf } from './util.js'
import { fMoney } from '../display.js'

export const WIDE = 768 // 48rem at the default 16px root
const TIER = { row: 46, top: 4, text: 10, bar: 22, bh: 14 } // narrow row geometry
const WROW = { row: 26, bh: 14 } // wide row geometry
const TK_CAP = 140 // wide ticker column cap (ellipsis beyond)
const GAP = 10
const MIN_BAR = 2

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
  const narrow = W < WIDE
  const m = { t: 6, b: 6 }
  const rh = narrow ? TIER.row : WROW.row
  const H = m.t + m.b + rows.length * rh
  const svg = svgIn(el, W, H, 'bars__svg')
  const label = (r) => fMoney(r.pnl, { hide, sign: true })
  svg.attr('role', 'img').attr('aria-label', rows.map((r) => `${r.ticker} ${label(r)}`).join(', '))
  const vw = measure(svg, rows.map(label))
  const lo = Math.min(0, min(rows, (r) => r.pnl))
  const hi = Math.max(0, max(rows, (r) => r.pnl))

  let bl = 0
  let br = W
  let tkMax = Infinity
  if (narrow) {
    tkMax = W - vw - GAP // top tier: ticker must not reach the amount
  } else {
    const tw = measure(svg, rows.map((r) => r.ticker))
    const lw = Math.min(tw, TK_CAP)
    tkMax = lw
    bl = lw + GAP
    br = W - vw - GAP
  }
  const x = scaleLinear([lo, hi], [bl, br])
  const x0 = x(0)
  const yr = (i) => m.t + i * rh
  const by = (i) => (narrow ? yr(i) + TIER.bar : yr(i) + (WROW.row - WROW.bh) / 2)
  const bh = narrow ? TIER.bh : WROW.bh
  const cy = (i) => (narrow ? yr(i) + TIER.top + TIER.text : yr(i) + WROW.row / 2)
  const shown = (t) => {
    if (!isFinite(tkMax)) return t
    const full = measure(svg, [t])
    if (full <= tkMax) return t
    const keep = Math.max(1, Math.floor((t.length * (tkMax - 8)) / full))
    return `${t.slice(0, keep)}…`
  }

  svg.append('line').attr('class', 'chart-axis').attr('x1', x0).attr('x2', x0).attr('y1', m.t).attr('y2', H - m.b)
  const row = svg.append('g').attr('class', 'chart-text').selectAll('g').data(rows).join('g')
  row.append('rect').attr('class', (r) => (r.pnl < 0 ? 'bars__bar bars__bar--neg' : 'bars__bar bars__bar--pos'))
    .attr('x', (r) => (r.pnl < 0 ? x0 - Math.max(MIN_BAR, x0 - x(r.pnl)) : x0))
    .attr('y', (r, i) => by(i)).attr('height', bh)
    .attr('width', (r) => Math.max(MIN_BAR, Math.abs(x(r.pnl) - x0))).attr('rx', 3).attr('aria-hidden', 'true')
  const tk = row.append('text').attr('class', 'bars__tk').attr('x', 0).attr('y', (r, i) => cy(i)).attr('dy', '0.32em')
  tk.append('title').text((r) => r.ticker)
  tk.append('tspan').text((r) => shown(r.ticker))
  row.append('text').attr('class', (r) => `bars__val ${r.pnl < 0 ? 'bars__val--neg' : 'bars__val--pos'}`)
    .attr('x', W).attr('y', (r, i) => cy(i)).attr('dy', '0.32em').attr('text-anchor', 'end').text(label)
  return () => el.replaceChildren()
}
