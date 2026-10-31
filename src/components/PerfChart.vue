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
// Redraw only when what is drawn changes (live recalcs produce new but often equal series).
useChart(el, () => `${props.mode}|${seriesKey(props.series)}`, (node) => {
  emit('hover', null)
  return drawValueChart(node, props.series, { mode: props.mode, onHover: (r) => emit('hover', r) })
})
</script>
