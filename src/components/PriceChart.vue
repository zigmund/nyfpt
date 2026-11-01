<!-- Position card price chart wrapper (charts/priceChart.js); emits the hovered row (or null). -->
<template>
  <div ref="el" class="pchart__box" />
</template>

<script setup>
import { ref } from 'vue'
import { drawPriceChart } from '../charts/priceChart.js'
import { useChart } from '../composables/useChart.js'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  /** previous close: dashed level (1D) */
  base: { type: Number, default: null },
  intraday: { type: Boolean, default: false },
})
const emit = defineEmits(['hover'])

const el = ref(null)
// The hovered bar survives redraws (live ticks move the last bar): the chart shows it again and
// reports the redrawn row; it is dropped only when the bar left the rows (as PerfChart).
let hoverTs = null
const onHover = (r) => {
  hoverTs = r ? r.ts : null
  emit('hover', r)
}
// Redraw only when what is drawn changes (live ticks often repeat the price).
const key = () => {
  const r = props.rows
  const a = r[0]
  const b = r[r.length - 1]
  return [props.intraday, props.base, r.length, a?.ts, b?.ts, b?.close].join('|')
}
useChart(el, key, (node) => drawPriceChart(node, props.rows, { base: props.base, intraday: props.intraday, hoverTs, onHover }))
</script>
