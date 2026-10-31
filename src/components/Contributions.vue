<!-- "Contributions" disclosure: P&L bars per position for the period (collapsed by default;
     the open state is remembered in prefs.contribOpen). -->
<template>
  <div class="contrib">
    <button
      type="button"
      class="contrib__toggle"
      :class="{ 'is-open': open }"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="open ? id : null"
      data-test="contrib-toggle"
      @click="prefs.contribOpen = !open"
    >
      <span>{{ t('contrib.title') }}</span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    <div v-if="open" :id="id" class="contrib__body" :class="{ 'is-stale': stale }">
      <p class="card__hint">{{ t('contrib.note') }}</p>
      <div v-if="positions" ref="el" class="bars" role="img" :aria-label="t('contrib.title')" />
      <div v-else class="bars skel" aria-hidden="true" />
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { t } from '../i18n.js'
import { drawBarsChart } from '../charts/barsChart.js'
import { useChart } from '../composables/useChart.js'
import { useApp } from '../composables/useApp.js'

const props = defineProps({
  /** computeCore positions, null while the period is not computed */
  positions: { type: Array, default: null },
  stale: { type: Boolean, default: false },
})

const { prefs } = useApp()
const id = `contrib-${Math.random().toString(36).slice(2, 8)}`
const open = computed(() => prefs.contribOpen === true)
const el = ref(null)

const key = () => {
  const rows = props.positions || []
  return `${prefs.hide}|${rows.map((r) => `${r.ticker}:${r.pnl}`).join(';')}`
}
useChart(el, key, (node) => drawBarsChart(node, props.positions, { hide: prefs.hide }))
</script>
