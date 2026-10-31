<!-- Portfolio value: mode switch, eye, big value, day line, period line and the chart.
     Hovering the chart shows the values for that date. core == null -> skeletons. -->
<template>
  <div class="vblock">
    <div class="vblock__head">
      <div class="seg seg--inline" role="group" :aria-label="t('value.view')">
        <button
          v-for="m in MODES"
          :key="m"
          type="button"
          class="seg__btn"
          :aria-pressed="vmode === m ? 'true' : 'false'"
          :data-test="`vmode-${m}`"
          @click="prefs.vmode = m"
        >{{ t(`value.mode.${m}`) }}</button>
      </div>
      <button
        type="button"
        class="icon-btn"
        :aria-pressed="prefs.hide ? 'true' : 'false'"
        :aria-label="prefs.hide ? t('value.show') : t('value.hide')"
        :title="prefs.hide ? t('value.show') : t('value.hide')"
        data-test="eye"
        @click="prefs.hide = !prefs.hide"
      >
        <svg v-if="prefs.hide" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 12c1.7-4.1 5.5-7 10-7s8.3 2.9 10 7c-1.7 4.1-5.5 7-10 7s-8.3-2.9-10-7z" /><circle cx="12" cy="12" r="3" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.4 5.4A9.7 9.7 0 0 1 12 5c4.5 0 8.3 2.9 10 7a11.5 11.5 0 0 1-2.6 3.8" /><path d="M6.6 6.6C4.5 8 2.9 9.8 2 12c1.7 4.1 5.5 7 10 7 1.9 0 3.6-.5 5.1-1.4" />
        </svg>
      </button>
    </div>

    <p v-if="big != null" class="vblock__big big" :class="{ 'is-stale': stale }" data-test="v-big" aria-live="polite">{{ fMoney(big, { hide: prefs.hide }) }}</p>
    <p v-else class="vblock__big big skel" data-test="v-big-skel" aria-hidden="true">&nbsp;</p>

    <div v-if="summary" class="vblock__body" :class="{ 'is-stale': stale }" :aria-busy="stale ? 'true' : 'false'">
      <p v-if="summary.missing" class="warn">{{ t('value.missing', { list: summary.missing }) }}</p>
      <p class="vline num" data-test="v-day">
        <span :class="tone(summary.day_pnl)">{{ fMoney(summary.day_pnl, { hide: prefs.hide, sign: true }) }}</span>
        {{ ' ' }}<span :class="tone(summary.day_pct)">({{ fPct(summary.day_pct) }})</span>
        {{ ' ' }}<span class="vline__lab">{{ summary.day_date ? t('value.day', { date: dateShort(summary.day_date) }) : '' }}</span>
      </p>
      <p class="vline num" data-test="v-period">
        <span :class="tone(per.amount)">{{ fMoney(per.amount, { hide: prefs.hide, sign: true }) }}</span>
        {{ ' ' }}<span :class="tone(per.pct)">({{ fPct(per.pct) }})</span>
        {{ ' ' }}<span class="vline__lab">{{ per.label }}</span>
      </p>
      <PerfChart :series="core.series" :mode="vmode" @hover="hover = $event" />
    </div>
    <div v-else class="vblock__body" data-test="v-skel" aria-hidden="true">
      <p class="vline skel">&nbsp;</p>
      <p class="vline skel">&nbsp;</p>
      <div class="vchart skel" />
    </div>
  </div>
</template>

<script setup>
import { computed, shallowRef, watch } from 'vue'
import { t } from '../i18n.js'
import { dateShort, dateRange } from '../format.js'
import { fMoney, fPct, tone, n, PERIOD_LABELS } from '../display.js'
import { useApp } from '../composables/useApp.js'
import PerfChart from './PerfChart.vue'

const MODES = ['perf', 'value']

const props = defineProps({
  /** computeCore result for the period, or null while not covered by the cache */
  core: { type: Object, default: null },
  /** core belongs to the previous period (new one loading) */
  stale: { type: Boolean, default: false },
  period: { type: String, default: 'YTD' },
  /** current value from positions, shown before the period is computed */
  current: { type: Number, default: null },
})

const { prefs } = useApp()
const vmode = computed(() => (prefs.vmode === 'value' ? 'value' : 'perf'))
const summary = computed(() => props.core?.summary || null)
const hover = shallowRef(null)
// The chart reports null on every redraw; also drop the hover when the chart goes away.
watch(() => !!summary.value, (on) => { if (!on) hover.value = null })

const big = computed(() => {
  if (hover.value) return n(hover.value.value)
  if (summary.value) return n(summary.value.value_end)
  return n(props.current)
})

// Period line: P&L without deposits + TWR (perf) or value change incl. deposits (value);
// for the hovered date: from the period start to that date.
const per = computed(() => {
  const s = summary.value
  const r = hover.value
  const value = vmode.value === 'value'
  if (r) {
    const r0 = props.core.series[0]
    return {
      amount: value ? r.value - r0.value : r.pnl,
      pct: value ? (r0.value ? (r.value / r0.value - 1) * 100 : null) : r.portfolio,
      label: dateRange(r0.date, r.date),
    }
  }
  const label = t(value ? 'value.perValue' : 'value.perPerf', { period: PERIOD_LABELS[props.period] || props.period })
  return value
    ? { amount: s.value_change, pct: s.value_change_pct, label }
    : { amount: s.pnl, pct: s.twr, label }
})
</script>
