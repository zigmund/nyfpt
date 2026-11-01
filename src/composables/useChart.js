// Runs a d3 draw function on mount, when `source` changes, when the container element appears
// (v-if) and when its width changes. `draw(el, value)` returns a cleanup function (listeners,
// DOM); it is called before every redraw and on unmount.
import { onMounted, onBeforeUnmount, watch } from 'vue'

export function useChart(elRef, source, draw) {
  let cleanup = null
  let width = -1
  let ro = null
  let observed = null
  let stop = null

  function observe(el) {
    if (observed === el) return
    ro?.disconnect()
    observed = el
    if (!el || typeof ResizeObserver === 'undefined') return
    ro ||= new ResizeObserver(() => {
      if (observed && observed.clientWidth !== width) run()
    })
    ro.observe(el)
  }

  function run() {
    cleanup?.()
    cleanup = null
    const el = elRef.value
    observe(el)
    if (!el) return
    width = el.clientWidth
    cleanup = draw(el, source()) || null
  }

  onMounted(() => {
    run()
    stop = watch([elRef, source], run, { flush: 'post' })
  })

  onBeforeUnmount(() => {
    stop?.()
    ro?.disconnect()
    cleanup?.()
    cleanup = null
  })
}

/** Cheap identity of a computeCore series: redraw key for charts. */
export function seriesKey(rows) {
  if (!rows || !rows.length) return '0'
  const a = rows[0]
  const b = rows[rows.length - 1]
  return [rows.length, a.date, b.date, b.value, b.portfolio, b.spy, b.qqq, b.pnl].join(',')
}
