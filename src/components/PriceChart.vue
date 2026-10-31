<!-- Position card price chart wrapper (charts/priceChart.js). -->
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

const el = ref(null)
// Redraw only when what is drawn changes (live ticks often repeat the price).
const key = () => {
  const r = props.rows
  const a = r[0]
  const b = r[r.length - 1]
  return [props.intraday, props.base, r.length, a?.ts, b?.ts, b?.close].join('|')
}
useChart(el, key, (node) => drawPriceChart(node, props.rows, { base: props.base, intraday: props.intraday }))
</script>
