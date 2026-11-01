// Value block chart: TWR % (perf) or value $ (value) with hover rule, dot and a date pill.
import { select, scaleLinear, scalePoint, line, area, minIndex, min, max } from 'd3'
import { svgIn, xLabels, widthOf, heightOf, splitPaint, segOf, dateFull, onOutsidePointer, pointerX } from './util.js'

/**
 * Draws into `el` and returns a cleanup function.
 * @param {HTMLElement} el
 * @param {Array<{date, value, portfolio, pnl}>} series computeCore series
 * @param {{mode: 'perf'|'value', onHover?: (row|null) => void, hoverDate?: string|null}} opts
 *   hoverDate: date hovered before a redraw (live recalc); shown again when still present.
 */
export function drawValueChart(el, series, { mode = 'perf', onHover = () => {}, hoverDate = null } = {}) {
  el.replaceChildren()
  const val = mode === 'value' ? (r) => r.value : (r) => r.portfolio
  const rows = (series || []).filter((r) => val(r) != null && Number.isFinite(+val(r)))
  if (rows.length < 2) {
    if (hoverDate) onHover(null) // nothing to hover: drop the kept hover
    return () => el.replaceChildren()
  }

  const W = widthOf(el)
  const H = heightOf(el)
  const m = { t: 30, r: 8, b: 22, l: 4 }
  const v0 = val(rows[0])
  const lr = rows[rows.length - 1]
  const lastSeg = segOf(val(lr), v0)
  const y = scaleLinear([Math.min(v0, min(rows, val)), Math.max(v0, max(rows, val))], [H - m.b, m.t]).nice()
  const x = scalePoint(rows.map((r) => r.date), [m.l, W - m.r])

  const svg = svgIn(el, W, H, 'vchart__svg')
  const yb = y(v0)
  const paint = splitPaint(svg, {
    yb, W, ys: rows.map((r) => y(val(r))), span: [m.t, H - m.b],
    lineD: line().x((r) => x(r.date)).y((r) => y(val(r)))(rows),
    fillD: area().x((r) => x(r.date)).y0(yb).y1((r) => y(val(r)))(rows),
    lineCls: 'chart-line', fillCls: 'vchart__fill',
  })
  paint.fill()
  svg.append('line').attr('class', 'chart-base')
    .attr('x1', m.l).attr('x2', W - m.r).attr('y1', yb).attr('y2', yb)
  paint.line()
  const endDot = svg.append('circle').attr('class', `chart-dot ${lastSeg}`)
    .attr('cx', x(lr.date)).attr('cy', y(val(lr))).attr('r', 4)

  const { long, labels } = xLabels(svg, rows, x, { W, left: m.l, right: m.r })
  svg.append('g').attr('class', 'chart-text').selectAll('text').data(labels).join('text')
    .attr('x', (d) => x(d.date)).attr('y', H - 6)
    .attr('text-anchor', (d, i) => (long ? 'middle' : i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'))
    .text((d) => d.text)

  const rule = svg.append('line').attr('class', 'chart-rule').attr('y1', m.t - 4).attr('y2', H - m.b).style('opacity', 0)
  const dot = svg.append('circle').attr('class', 'chart-dot').attr('r', 5).style('opacity', 0)
  const pill = select(el).append('div').attr('class', 'chart-pill num').attr('aria-hidden', 'true').style('opacity', 0)

  let active = false
  const showRow = (r) => {
    const px = x(r.date)
    rule.attr('x1', px).attr('x2', px).style('opacity', 0.5)
    dot.attr('class', `chart-dot ${segOf(val(r), v0)}`).attr('cx', px).attr('cy', y(val(r))).style('opacity', 1)
    endDot.style('opacity', 0)
    pill.text(dateFull(r.date))
    const cw = el.clientWidth || W
    const pw = pill.node().offsetWidth || 0
    const left = Math.min(Math.max(px * (cw / W), pw / 2), cw - pw / 2)
    pill.style('left', `${left}px`).style('opacity', 1)
    active = true
    onHover(r)
  }
  const show = (ev) => {
    const mx = pointerX(ev, svg.node(), W)
    showRow(rows[minIndex(rows, (d) => Math.abs(x(d.date) - mx))])
  }
  const hide = () => {
    if (!active) return
    active = false
    rule.style('opacity', 0)
    dot.style('opacity', 0)
    endDot.style('opacity', 1)
    pill.style('opacity', 0)
    onHover(null)
  }
  svg.append('rect').attr('class', 'chart-hit').attr('x', 0).attr('y', 0).attr('width', W).attr('height', H)
    .on('pointerdown', show).on('pointermove', show).on('pointercancel', hide)
    .on('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hide() })

  const kept = hoverDate && rows.find((r) => r.date === hoverDate)
  if (kept) showRow(kept)
  else if (hoverDate) onHover(null)

  const ac = new AbortController()
  onOutsidePointer(el, hide, ac.signal)
  return () => {
    ac.abort()
    el.replaceChildren()
  }
}
