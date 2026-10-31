// Position card price chart: close line by bar index (no gaps for nights and weekends),
// dashed previous close (1D), max/min labels, volume bars, hover rule with a price pill.
import { select, scaleLinear, line, area, maxIndex, minIndex, max } from 'd3'
import { svgIn, widthOf, heightOf, splitPaint, segOf, dateFull, monthOf, measure, onOutsidePointer, pointerX } from './util.js'
import { dateShort } from '../format.js'
import { fPrice } from '../display.js'

const VOL_H = 32

/** '10:15 AM' from minutes since midnight. */
export function clock(min) {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
const hourLabel = (min) => {
  const h = Math.floor(min / 60) % 24
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
}

/** Hover text of a row: local date, time and zone for intraday bars (see chartRows), the date otherwise. */
export function whenOf(r, intraday) {
  if (intraday) return r.min != null ? `${dateShort(r.ldate || r.date)}, ${clock(r.min)}${r.zone ? ` ${r.zone}` : ''}` : dateShort(r.date)
  return dateFull(r.date)
}

/** Axis label candidates [{i, text}] for the rows. */
export function axisLabels(rows, intraday) {
  const out = []
  if (!rows.length) return out
  const days = new Set(rows.map((r) => r.date)).size
  if (intraday && days === 1) {
    rows.forEach((r, i) => { if (r.min != null && r.min % 60 === 0) out.push({ i, text: hourLabel(r.min) }) })
    return out
  }
  if (intraday) {
    rows.forEach((r, i) => { if (!i || r.date !== rows[i - 1].date) out.push({ i, text: dateShort(r.date) }) })
    return out
  }
  const span = (Date.parse(rows[rows.length - 1].date) - Date.parse(rows[0].date)) / 864e5
  rows.forEach((r, i) => {
    if (!i) return
    const p = rows[i - 1].date
    if (span <= 70) out.push({ i, text: dateShort(r.date) })
    else if (span <= 730) { if (r.date.slice(0, 7) !== p.slice(0, 7)) out.push({ i, text: monthOf(r.date) }) }
    else if (r.date.slice(0, 4) !== p.slice(0, 4)) out.push({ i, text: r.date.slice(0, 4) })
  })
  return out
}

/**
 * Draws into `el`, returns a cleanup function.
 * @param {HTMLElement} el
 * @param {Array<{ts, date, close, vol, min}>} rows ascending
 * @param {{base?: number|null, intraday?: boolean}} opts base: previous close (dashed level, color reference)
 */
export function drawPriceChart(el, rows, { base = null, intraday = false } = {}) {
  el.replaceChildren()
  const pts = (rows || []).filter((r) => Number.isFinite(r.close))
  if (pts.length < 2) return () => el.replaceChildren()

  const W = widthOf(el)
  const H = heightOf(el)
  const hasVol = pts.some((r) => r.vol > 0)
  const m = { t: 22, r: 8, b: 22, l: 4 }
  const bottom = H - m.b - (hasVol ? VOL_H + 6 : 0)
  const ref = Number.isFinite(base) ? base : pts[0].close
  const last = pts[pts.length - 1]
  const lastSeg = segOf(last.close, ref)
  const lo = Math.min(...pts.map((r) => r.close), ...(Number.isFinite(base) ? [base] : []))
  const hi = Math.max(...pts.map((r) => r.close), ...(Number.isFinite(base) ? [base] : []))
  const y = scaleLinear([lo, hi === lo ? lo + 1 : hi], [bottom, m.t])
  const x = scaleLinear([0, pts.length - 1], [m.l, W - m.r])

  const svg = svgIn(el, W, H, 'pchart__svg')
  const yb = y(ref)
  const paint = splitPaint(svg, {
    yb, W, ys: pts.map((r) => y(r.close)), span: [m.t, bottom],
    lineD: line().x((r, i) => x(i)).y((r) => y(r.close))(pts),
    fillD: area().x((r, i) => x(i)).y0(yb).y1((r) => y(r.close))(pts),
    lineCls: 'chart-line', fillCls: 'pchart__fill',
  })
  paint.fill()

  if (Number.isFinite(base)) {
    svg.append('line').attr('class', 'chart-base').attr('data-test', 'pc-base')
      .attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(base)).attr('y2', y(base))
    svg.append('text').attr('class', 'pchart__lab').attr('x', m.l).attr('y', y(base) - 4).text(fPrice(base))
  }

  if (hasVol) {
    const vmax = max(pts, (r) => r.vol || 0) || 1
    const vy = scaleLinear([0, vmax], [0, VOL_H])
    const bw = Math.max(1, Math.min(6, (W - m.l - m.r) / pts.length - 1))
    svg.append('g').attr('class', 'pchart__vol').attr('data-test', 'pc-vol').selectAll('rect').data(pts).join('rect')
      .attr('x', (r, i) => x(i) - bw / 2).attr('width', bw)
      .attr('y', (r) => H - m.b - vy(r.vol || 0)).attr('height', (r) => vy(r.vol || 0))
  }

  paint.line()

  // Max / min close labels, kept inside the plot.
  const mark = (i, dy, cls) => {
    const px = x(i)
    svg.append('text').attr('class', `pchart__lab ${cls}`)
      .attr('x', px).attr('y', y(pts[i].close) + dy)
      .attr('text-anchor', px < W * 0.2 ? 'start' : px > W * 0.8 ? 'end' : 'middle')
      .text(fPrice(pts[i].close))
  }
  const iMax = maxIndex(pts, (r) => r.close)
  const iMin = minIndex(pts, (r) => r.close)
  mark(iMax, -6, 'pchart__max')
  if (iMin !== iMax) mark(iMin, 14, 'pchart__min')

  const endDot = svg.append('circle').attr('class', `chart-dot ${lastSeg}`)
    .attr('cx', x(pts.length - 1)).attr('cy', y(last.close)).attr('r', 4)

  // X labels, thinned to fit.
  const cands = axisLabels(pts, intraday)
  const lw = measure(svg, cands.map((d) => d.text)) + 10
  let lastX = -Infinity
  const labels = cands.filter((d) => {
    const px = x(d.i)
    if (px - lastX < lw || px < lw / 2 || px > W - m.r - lw / 2) return false
    lastX = px
    return true
  })
  svg.append('g').attr('class', 'chart-text').selectAll('text').data(labels).join('text')
    .attr('x', (d) => x(d.i)).attr('y', H - 6).attr('text-anchor', 'middle').text((d) => d.text)

  const rule = svg.append('line').attr('class', 'chart-rule').attr('y1', m.t - 4).attr('y2', bottom).style('opacity', 0)
  const dot = svg.append('circle').attr('class', 'chart-dot').attr('r', 5).style('opacity', 0)
  const pill = select(el).append('div').attr('class', 'chart-pill num').attr('aria-hidden', 'true').style('opacity', 0)

  let active = false
  const show = (ev) => {
    const mx = pointerX(ev, svg.node(), W)
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(x.invert(mx))))
    const r = pts[i]
    const px = x(i)
    rule.attr('x1', px).attr('x2', px).style('opacity', 0.5)
    dot.attr('class', `chart-dot ${segOf(r.close, ref)}`).attr('cx', px).attr('cy', y(r.close)).style('opacity', 1)
    endDot.style('opacity', 0)
    pill.text(`${fPrice(r.close)} · ${whenOf(r, intraday)}`)
    const cw = el.clientWidth || W
    const pw = pill.node().offsetWidth || 0
    pill.style('left', `${Math.min(Math.max(px * (cw / W), pw / 2), cw - pw / 2)}px`).style('opacity', 1)
    active = true
  }
  const hide = () => {
    if (!active) return
    active = false
    rule.style('opacity', 0)
    dot.style('opacity', 0)
    endDot.style('opacity', 1)
    pill.style('opacity', 0)
  }
  svg.append('rect').attr('class', 'chart-hit').attr('x', 0).attr('y', 0).attr('width', W).attr('height', H)
    .on('pointerdown', show).on('pointermove', show).on('pointercancel', hide)
    .on('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hide() })

  const ac = new AbortController()
  onOutsidePointer(el, hide, ac.signal)
  return () => {
    ac.abort()
    el.replaceChildren()
  }
}
