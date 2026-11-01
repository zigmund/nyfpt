// Market card sparkline: last session (15-min closes), 12% fill to the previous close, end dot.
import { scaleLinear, line, area, min, max } from 'd3'
import { widthOf, svgIn } from './util.js'

const H = 36
const PAD = 3

/**
 * @param {HTMLElement} el
 * @param {number[]} spark closes of the last session
 * @param {{prev: number|null, down: boolean}} opts prev close (dashed level), down: red tone
 */
export function drawSparkline(el, spark, { prev = null, down = false } = {}) {
  el.replaceChildren()
  const pts = (spark || []).filter((v) => Number.isFinite(v))
  if (pts.length < 2) return () => el.replaceChildren()
  const W = widthOf(el, 80)
  const base = Number.isFinite(prev) ? prev : pts[0]
  const y = scaleLinear([min([...pts, base]), max([...pts, base])], [H - PAD, PAD])
  const x = scaleLinear([0, pts.length - 1], [0, W - 4])
  const svg = svgIn(el, W, H, `spark__svg ${down ? 'spark--neg' : 'spark--pos'}`)
    .attr('height', H).attr('preserveAspectRatio', 'none')
  svg.append('path').datum(pts).attr('class', 'spark__fill').attr('d', area().x((v, i) => x(i)).y0(y(base)).y1((v) => y(v)))
  svg.append('line').attr('class', 'chart-base').attr('x1', 0).attr('x2', W).attr('y1', y(base)).attr('y2', y(base))
  svg.append('path').datum(pts).attr('class', 'spark__line').attr('d', line().x((v, i) => x(i)).y((v) => y(v)))
  svg.append('circle').attr('class', 'spark__dot').attr('cx', x(pts.length - 1)).attr('cy', y(pts[pts.length - 1])).attr('r', 2.5)
  return () => el.replaceChildren()
}
