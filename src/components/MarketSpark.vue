<!-- Sparkline of one market card or holdings row; an empty spark keeps its height. -->
<template>
  <div ref="el" class="spark" aria-hidden="true" />
</template>

<script setup>
import { ref } from 'vue'
import { drawSparkline } from '../charts/sparkline.js'
import { useChart } from '../composables/useChart.js'

const props = defineProps({
  spark: { type: Array, default: () => [] },
  prev: { type: Number, default: null },
  down: { type: Boolean, default: false },
})

const el = ref(null)
const key = () => `${props.down}|${props.prev}|${props.spark.length}|${props.spark[props.spark.length - 1]}`
useChart(el, key, (node) => drawSparkline(node, props.spark, { prev: props.prev, down: props.down }))
</script>
