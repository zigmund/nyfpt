<!-- Main screen: markets strip, value card (value, chart, periods, contributions),
     holdings (day / selected period) and cash flows. -->
<template>
  <div class="screen">
    <header class="topbar">
      <h1 class="topbar__title">{{ t('app.name') }}</h1>
      <p class="topbar__status" role="status" data-test="updated">
        <span class="dot" :class="{ 'dot--on': live.isLive.value }" aria-hidden="true" />
        <span>{{ live.isLive.value ? t('main.live') : updated }}</span>
      </p>
      <a class="icon-btn" href="#/settings" :aria-label="t('nav.settings')" :title="t('nav.settings')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-test="gear">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </a>
    </header>

    <p v-if="errorNames" class="banner" role="status" data-test="errors">{{ t('main.errors', { names: errorNames }) }}</p>

    <MarketsStrip />

    <section class="card vcard" :aria-label="t('value.label')">
      <ValueBlock :core="core" :stale="stale" :period="period" :current="current" />
      <PeriodPicker compare />
      <Contributions :positions="core?.positions || null" :stale="stale" />
    </section>

    <Holdings :core="core" :stale="stale" :period="period" />

    <CashflowsCard :summary="core?.summary || null" :stale="stale" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { t } from '../i18n.js'
import { n } from '../display.js'
import { useApp } from '../composables/useApp.js'
import { usePeriodCore } from '../composables/usePeriodCore.js'
import MarketsStrip from './MarketsStrip.vue'
import ValueBlock from './ValueBlock.vue'
import PeriodPicker from './PeriodPicker.vue'
import Contributions from './Contributions.vue'
import CashflowsCard from './CashflowsCard.vue'
import Holdings from './Holdings.vue'

const app = useApp()
const { live } = app
const state = computed(() => app.state.value)
const { core, stale, period } = usePeriodCore()

// Current value from positions (incl. cash), shown until the period is computed.
const current = computed(() => {
  const rows = state.value?.positions
  if (!rows) return null
  return rows.reduce((sum, r) => sum + (n(r.value) ?? 0), 0)
})

// "Updated N min ago", refreshed every 30 s.
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 30e3)
onBeforeUnmount(() => clearInterval(timer))
const updated = computed(() => {
  const at = state.value?.updatedAt
  if (!at) return state.value?.loading?.length ? t('main.loading') : ''
  const min = Math.max(0, Math.floor((now.value - at) / 60e3))
  if (min < 1) return t('main.updatedNow')
  if (min < 60) return t('main.updatedMin', { n: min })
  return t('main.updatedHours', { n: Math.floor(min / 60) })
})

// Short, non-blocking: which datasets failed to refresh (cached data stays on screen).
const ERR_KEYS = new Set(['positions', 'trades', 'cashflows', 'markets', 'candles'])
const errorNames = computed(() => [...new Set(Object.keys(state.value?.errors || {})
  .map((k) => t(`main.err.${ERR_KEYS.has(k) ? k : 'other'}`)))].join(', '))
</script>
