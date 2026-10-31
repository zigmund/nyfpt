// Cumulative return chart: portfolio vs S&P 500 vs Nasdaq 100, with a 3-value tooltip.
import { select, scaleLinear, scalePoint, line, pointer, minIndex, min, max } from 'd3'
import { svgIn, measure, widthOf, onOutsidePointer } from './util.js'
import { dateShort } from '../format.js'
import { fMoney, fPct } from '../display.js'

const H = 280
// Series: class sets stroke color/dash (see app.css .cmp-*).
export const SERIES = [
  { key: 'portfolio', cls: 'cmp-portfolio' },
  { key: 'spy', cls: 'cmp-spy' },
  { key: 'qqq', cls: 'cmp-qqq' },
]
const tickText = (v) => `${v > 0 ? '+' : v < 0 ? '\u2212' : ''}${+Math.abs(v).toFixed(2)}%`

/**
 * @param {HTMLElement} el
 * @param {Array} series computeCore series
 * @param {{labels: string[], hide: () => boolean}} opts labels per SERIES entry
 */
export function drawCompareChart(el, series, { labels, hide = () => false }) {
  el.replaceChildren()
  const rows = series || []
  if (!rows.length) return () => el.replaceChildren()

  const W = widthOf(el)
  const m = { t: 12, r: 12, b: 26, l: 0 }
  const vals = rows.flatMap((r) => SERIES.map((s) => r[s.key])).filter((v) => v != null)
  const y = scaleLinear([Math.min(0, min(vals) ?? 0), Math.max(0, max(vals) ?? 0)], [H - m.b, m.t]).nice(5)
  const svg = svgIn(el, W, H, 'cchart__svg')
  const yt = y.ticks(5)
  m.l = measure(svg, yt.map(tickText)) + 10
  const x = scalePoint(rows.map((r) => r.date), [m.l + 6, W - m.r])

  svg.append('g').selectAll('line').data(yt).join('line')
    .attr('class', (v) => (v === 0 ? 'chart-axis' : 'chart-grid'))
    .attr('x1', m.l).attr('x2', W - m.r).attr('y1', (v) => y(v)).attr('y2', (v) => y(v))
  svg.append('g').attr('class', 'chart-text').selectAll('text').data(yt).join('text')
    .attr('x', m.l - 6).attr('y', (v) => y(v)).attr('dy', '0.32em').attr('text-anchor', 'end').text(tickText)

  const lw = measure(svg, rows.map((r) => dateShort(r.date)))
  const step = rows.length > 1 ? (W - m.r - m.l - 6) / (rows.length - 1) : W
  const every = Math.max(1, Math.ceil((lw * 1.5 + 12) / step))
  const xl = rows.filter((r, i) => (i % every === 0 && i <= rows.length - 1 - every) || i === rows.length - 1)
  svg.append('g').attr('class', 'chart-text').selectAll('text').data(xl).join('text')
    .attr('x', (r) => x(r.date)).attr('y', H - 6)
    .attr('text-anchor', (r, i) => (xl.length === 1 ? 'end' : i === 0 ? 'start' : i === xl.length - 1 ? 'end' : 'middle'))
    .text((r) => dateShort(r.date))

  for (const s of SERIES) {
    svg.append('path').datum(rows.filter((r) => r[s.key] != null))
      .attr('class', `cmp-line ${s.cls}`)
      .attr('d', line().x((r) => x(r.date)).y((r) => y(r[s.key])))
  }

  const rule = svg.append('line').attr('class', 'chart-rule').attr('y1', m.t).attr('y2', H - m.b).style('opacity', 0)
  const dots = SERIES.map((s) => svg.append('circle').attr('class', `chart-dot cmp-dot ${s.cls}`).attr('r', 4).style('opacity', 0))
  const tip = select(el).append('div').attr('class', 'chart-tip num').attr('aria-hidden', 'true').style('opacity', 0)

  const show = (ev) => {
    const [mx] = pointer(ev, svg.node())
    const r = rows[minIndex(rows, (d) => Math.abs(x(d.date) - mx))]
    const px = x(r.date)
    rule.attr('x1', px).attr('x2', px).style('opacity', 1)
    SERIES.forEach((s, i) => dots[i].attr('cx', px).attr('cy', y(r[s.key] ?? 0)).style('opacity', r[s.key] == null ? 0 : 1))
    tip.selectChildren().remove()
    tip.append('div').attr('class', 'chart-tip__d').text(`${dateShort(r.date)} · ${fMoney(r.value, { hide: hide() })}`)
    SERIES.forEach((s, i) => {
      const row = tip.append('div')
      row.append('span').attr('class', `chart-tip__sw ${s.cls}`)
      row.append('span').text(`${labels[i]}: ${fPct(r[s.key])}`)
    })
    const cw = el.clientWidth || W
    const scale = cw / W
    const tw = tip.node().offsetWidth || 0
    let left = px * scale + 12
    if (left + tw > cw) left = px * scale - tw - 12
    tip.style('left', `${Math.max(0, left)}px`).style('top', '8px').style('opacity', 1)
  }
  const hideTip = () => {
    rule.style('opacity', 0)
    for (const d of dots) d.style('opacity', 0)
    tip.style('opacity', 0)
  }
  svg.append('rect').attr('class', 'chart-hit').attr('x', m.l).attr('y', 0).attr('width', Math.max(0, W - m.l - m.r)).attr('height', H)
    .on('pointerdown', show).on('pointermove', show).on('pointercancel', hideTip)
    .on('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hideTip() })

  const ac = new AbortController()
  onOutsidePointer(el, hideTip, ac.signal)
  return () => {
    ac.abort()
    el.replaceChildren()
  }
}
