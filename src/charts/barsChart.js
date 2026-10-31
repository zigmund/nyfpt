// Contributions: horizontal P&L bars per position, all growing right from one baseline; LINEAR on |pnl|, domain [0, max|pnl|]; colour = sign.
// Narrow container (< 768px = 48rem): two tiers per row (ticker + amount on top, full-width bar below).
// Wide: columns ticker | bars | amount. Very wide (>= TWO = 900px): two such columns, newspaper order, one shared length scale.
// Redraws on width change via useChart (ResizeObserver).
import { scaleLinear, max } from 'd3'
import { svgIn, measure, widthOf } from './util.js'
import { fMoney } from '../display.js'

export const WIDE = 768 // 48rem at the default 16px root
const TIER = { row: 37, top: 3, text: 9, bar: 20, bh: 12 } // narrow row: label tier, bar 8px below the label centre
const WROW = { row: 26, bh: 14 } // wide row geometry
export const TWO = 900 // two-column threshold: each column >= (900 - COLGAP) / 2 = 434px, ~220px of bar even with a 140px ticker
const COLGAP = 32 // gap between the two columns (divider in the middle)
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
  const cols = W >= TWO && rows.length > 1 ? 2 : 1
  const cw = cols === 2 ? (W - COLGAP) / 2 : W // column width
  const per = Math.ceil(rows.length / cols) // rows per column (left gets the extra one)
  const m = { t: 6, b: 6 }
  const rh = narrow ? TIER.row : WROW.row
  const H = m.t + m.b + per * rh
  const svg = svgIn(el, W, H, 'bars__svg')
  const label = (r) => fMoney(r.pnl, { hide, sign: true })
  svg.attr('role', 'img').attr('aria-label', rows.map((r) => `${r.ticker} ${label(r)}`).join(', '))
  const vw = measure(svg, rows.map(label))
  const hi = max(rows, (r) => Math.abs(r.pnl)) || 1 // shared scale on |pnl|; sign is colour only

  let bl = 0
  let br = cw
  let tkMax = Infinity
  if (narrow) {
    tkMax = W - vw - GAP // top tier: ticker must not reach the amount
  } else {
    const tw = measure(svg, rows.map((r) => r.ticker))
    const lw = Math.min(tw, TK_CAP)
    tkMax = lw
    bl = lw + GAP
    br = cw - vw - GAP
  }
  const x = scaleLinear([0, hi], [bl, br])
  const x0 = x(0)
  const col = (i) => Math.floor(i / per)
  const ox = (i) => col(i) * (cw + COLGAP) // column x offset
  const yr = (i) => m.t + (i % per) * rh
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

  // Baseline at x0: wide = one line (it sits between the columns); narrow = a segment per bar band only,
  // so it never crosses the ticker/amount tier.
  const axis = (o, y1, y2) => svg.append('line').attr('class', 'chart-axis').attr('x1', o + x0).attr('x2', o + x0).attr('y1', y1).attr('y2', y2)
  if (narrow) rows.forEach((r, i) => axis(0, by(i), by(i) + bh))
  else for (let c = 0; c < cols; c++) axis(c * (cw + COLGAP), m.t, m.t + Math.min(per, rows.length - c * per) * rh)
  if (cols === 2) {
    svg.append('line').attr('class', 'bars__div').attr('x1', cw + COLGAP / 2).attr('x2', cw + COLGAP / 2).attr('y1', m.t).attr('y2', H - m.b)
  }
  const row = svg.append('g').attr('class', 'chart-text').selectAll('g').data(rows).join('g')
  row.append('rect').attr('class', (r) => (r.pnl < 0 ? 'bars__bar bars__bar--neg' : 'bars__bar bars__bar--pos'))
    .attr('x', (r, i) => ox(i) + x0)
    .attr('y', (r, i) => by(i)).attr('height', bh)
    .attr('width', (r) => Math.max(MIN_BAR, x(Math.abs(r.pnl)) - x0)).attr('rx', 3).attr('aria-hidden', 'true')
  const tk = row.append('text').attr('class', 'bars__tk').attr('x', (r, i) => ox(i)).attr('y', (r, i) => cy(i)).attr('dy', '0.32em')
  tk.append('title').text((r) => r.ticker)
  tk.append('tspan').text((r) => shown(r.ticker))
  row.append('text').attr('class', (r) => `bars__val ${r.pnl < 0 ? 'bars__val--neg' : 'bars__val--pos'}`)
    .attr('x', (r, i) => ox(i) + cw).attr('y', (r, i) => cy(i)).attr('dy', '0.32em').attr('text-anchor', 'end').text(label)
  return () => el.replaceChildren()
}
