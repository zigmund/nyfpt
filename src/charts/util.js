// Shared d3 helpers. Styling via classes / CSS variables only (CSP: no style attribute strings).
import { select } from 'd3'
import { dateShort } from '../format.js'

const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
const fullFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const utc = (d) => new Date(`${d}T00:00:00Z`)

export const monthOf = (d) => monthFmt.format(utc(d))
export const dateFull = (d) => fullFmt.format(utc(d))
export const daysBetween = (a, b) => (utc(b) - utc(a)) / 864e5

let uid = 0
export const nextId = (p) => `${p}${++uid}`

/** Chart width: the container's, at least `min` (hidden or not yet laid out containers report 0). */
export const widthOf = (el, min = 280) => Math.max(min, Math.floor(el.clientWidth || 0))

/** Responsive SVG filling the container width. */
export function svgIn(el, W, H, cls) {
  return select(el).append('svg')
    .attr('class', `chart-svg ${cls || ''}`.trim())
    .attr('width', '100%')
    .attr('viewBox', `0 0 ${W} ${H}`)
}

/** Widest rendered text among `texts` (falls back to an estimate where layout is unavailable). */
export function measure(svg, texts) {
  const g = svg.append('g').attr('class', 'chart-text')
  let w = 0
  for (const t of texts) {
    const node = g.append('text').text(t).node()
    const len = typeof node.getComputedTextLength === 'function' ? node.getComputedTextLength() : 0
    w = Math.max(w, len || String(t).length * 7)
  }
  g.remove()
  return w
}

/** X axis labels: dates on short periods, months when the range is longer than 70 days. */
export function xLabels(svg, rows, x, { W, left, right }) {
  const long = rows.length > 1 && daysBetween(rows[0].date, rows[rows.length - 1].date) > 70
  let xl
  if (long) {
    xl = rows.filter((r, i) => i > 0 && r.date.slice(0, 7) !== rows[i - 1].date.slice(0, 7))
      .map((r) => ({ date: r.date, text: monthOf(r.date) }))
    const lw = measure(svg, xl.map((d) => d.text)) + 10
    let lastX = -Infinity
    xl = xl.filter((d) => {
      const px = x(d.date)
      if (px - lastX < lw || px > W - right - lw / 2) return false
      lastX = px
      return true
    })
  } else {
    const lw = measure(svg, rows.map((r) => dateShort(r.date)))
    const step = rows.length > 1 ? (W - left - right) / (rows.length - 1) : W
    const every = Math.max(1, Math.ceil((lw * 1.5 + 12) / step))
    xl = rows.filter((r, i) => (i % every === 0 && i <= rows.length - 1 - every) || i === rows.length - 1)
      .map((r) => ({ date: r.date, text: dateShort(r.date) }))
  }
  return { long, labels: xl }
}

/** Hide on a pointerdown outside `el` (touch: the hover stays until tapping elsewhere). */
export function onOutsidePointer(el, fn, signal) {
  globalThis.document?.addEventListener('pointerdown', (ev) => {
    if (!el.contains(ev.target)) fn()
  }, { signal })
}
