<!-- Value block chart wrapper; emits the hovered series row (or null). -->
<template>
  <div ref="el" class="vchart" :aria-label="t('value.chartLabel')" role="img" />
</template>

<script setup>
import { ref } from 'vue'
import { t } from '../i18n.js'
import { drawValueChart } from '../charts/valueChart.js'
import { useChart, seriesKey } from '../composables/useChart.js'

const props = defineProps({
  series: { type: Array, default: () => [] },
  mode: { type: String, default: 'perf', validator: (v) => ['perf', 'value'].includes(v) },
})
const emit = defineEmits(['hover'])

const el = ref(null)
// The hovered date survives redraws (live recalcs every few seconds): the chart shows it again
// and reports the recomputed row; it is dropped only when the date left the series.
let hoverDate = null
const onHover = (r) => {
  hoverDate = r ? r.date : null
  emit('hover', r)
}
// Redraw only when what is drawn changes (live recalcs produce new but often equal series).
useChart(el, () => `${props.mode}|${seriesKey(props.series)}`, (node) =>
  drawValueChart(node, props.series, { mode: props.mode, hoverDate, onHover }))
</script>
