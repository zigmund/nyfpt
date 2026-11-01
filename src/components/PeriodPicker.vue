<!-- Period buttons (shared prefs.period, persisted); optional button to the compare screen. -->
<template>
  <div class="periods" role="group" :aria-label="t('period.label')">
    <button
      v-for="p in PERIODS"
      :key="p"
      type="button"
      class="periods__btn"
      :aria-pressed="p === current ? 'true' : 'false'"
      :data-period="p"
      @click="select(p)"
    >{{ PERIOD_LABELS[p] }}</button>
    <button
      v-if="compare"
      type="button"
      class="periods__icon"
      :aria-label="t('main.compare')"
      :title="t('main.compare')"
      data-test="to-compare"
      @click="app.go('/compare')"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15 4h5v5" /><path d="M20 4l-6 6" /><path d="M9 20H4v-5" /><path d="M4 20l6-6" />
      </svg>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { t } from '../i18n.js'
import { PERIODS } from '../calc/periods.js'
import { PERIOD_LABELS } from '../display.js'
import { useApp } from '../composables/useApp.js'
import { periodOf } from '../composables/usePeriodCore.js'

defineProps({
  compare: { type: Boolean, default: false },
})

const app = useApp()
const current = computed(() => periodOf(app.prefs))

function select(p) {
  app.prefs.period = p
}
</script>
