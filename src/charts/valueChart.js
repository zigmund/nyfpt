// Value block chart: TWR % (perf) or value $ (value) with hover rule, dot and a date pill.
import { select, scaleLinear, scalePoint, line, area, minIndex, min, max } from 'd3'
import { svgIn, xLabels, widthOf, nextId, dateFull, onOutsidePointer, pointerX } from './util.js'

const H = 220

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
  const m = { t: 30, r: 8, b: 22, l: 4 }
  const v0 = val(rows[0])
  const lr = rows[rows.length - 1]
  const up = val(lr) >= v0
  const col = up ? 'var(--c-pos)' : 'var(--c-neg)'
  const y = scaleLinear([Math.min(v0, min(rows, val)), Math.max(v0, max(rows, val))], [H - m.b, m.t]).nice()
  const x = scalePoint(rows.map((r) => r.date), [m.l, W - m.r])

  const svg = svgIn(el, W, H, 'vchart__svg')
  const gid = nextId('vgrad')
  const grad = svg.append('defs').append('linearGradient').attr('id', gid)
    .attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1)
  for (const [o, a] of [[0, 0.22], [0.5, 0.08], [1, 0]]) {
    grad.append('stop').attr('offset', o).style('stop-color', col).style('stop-opacity', a)
  }
  svg.append('path').datum(rows).attr('fill', `url(#${gid})`)
    .attr('d', area().x((r) => x(r.date)).y0(H - m.b).y1((r) => y(val(r))))
  svg.append('line').attr('class', 'chart-base')
    .attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v0)).attr('y2', y(v0))
  svg.append('path').datum(rows).attr('class', 'chart-line').style('stroke', col)
    .attr('d', line().x((r) => x(r.date)).y((r) => y(val(r))))
  const endDot = svg.append('circle').attr('class', 'chart-dot').style('fill', col)
    .attr('cx', x(lr.date)).attr('cy', y(val(lr))).attr('r', 4)

  const { long, labels } = xLabels(svg, rows, x, { W, left: m.l, right: m.r })
  svg.append('g').attr('class', 'chart-text').selectAll('text').data(labels).join('text')
    .attr('x', (d) => x(d.date)).attr('y', H - 6)
    .attr('text-anchor', (d, i) => (long ? 'middle' : i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'))
    .text((d) => d.text)

  const rule = svg.append('line').attr('class', 'chart-rule').attr('y1', m.t - 4).attr('y2', H - m.b).style('opacity', 0)
  const dot = svg.append('circle').attr('class', 'chart-dot').attr('r', 5).style('fill', col).style('opacity', 0)
  const pill = select(el).append('div').attr('class', 'chart-pill num').attr('aria-hidden', 'true').style('opacity', 0)

  let active = false
  const showRow = (r) => {
    const px = x(r.date)
    rule.attr('x1', px).attr('x2', px).style('opacity', 0.5)
    dot.attr('cx', px).attr('cy', y(val(r))).style('opacity', 1)
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
