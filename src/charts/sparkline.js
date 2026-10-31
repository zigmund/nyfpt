// Market card sparkline: last session (15-min closes), 12% fill to the previous close, end dot.
import { scaleLinear, line, area, min, max } from 'd3'
import { widthOf, svgIn, splitPaint, segOf } from './util.js'

const H = 36
const PAD = 3

/**
 * @param {HTMLElement} el
 * @param {number[]} spark closes of the last session
 * @param {{prev: number|null}} opts prev close = the waterline (dashed); without it the first point is.
 * The line and fill are green above the waterline and red below it.
 */
export function drawSparkline(el, spark, { prev = null } = {}) {
  el.replaceChildren()
  const pts = (spark || []).filter((v) => Number.isFinite(v))
  if (pts.length < 2) return () => el.replaceChildren()
  const W = widthOf(el, 80)
  const base = Number.isFinite(prev) ? prev : pts[0]
  const y = scaleLinear([min([...pts, base]), max([...pts, base])], [H - PAD, PAD])
  const x = scaleLinear([0, pts.length - 1], [0, W - 4])
  const svg = svgIn(el, W, H, 'spark__svg').attr('height', H).attr('preserveAspectRatio', 'none')
  const yb = y(base)
  const paint = splitPaint(svg, {
    yb, W, ys: pts.map((v) => y(v)), span: [0, H],
    lineD: line().x((v, i) => x(i)).y((v) => y(v))(pts),
    fillD: area().x((v, i) => x(i)).y0(yb).y1((v) => y(v))(pts),
    lineCls: 'spark__line', fillCls: 'spark__fill',
  })
  paint.fill()
  svg.append('line').attr('class', 'chart-base').attr('x1', 0).attr('x2', W).attr('y1', yb).attr('y2', yb)
  paint.line()
  const last = pts[pts.length - 1]
  svg.append('circle').attr('class', `spark__dot ${segOf(last, base)}`).attr('cx', x(pts.length - 1)).attr('cy', y(last)).attr('r', 2.5)
  return () => el.replaceChildren()
}
