<!-- Main screen: header (status, search, settings), markets strip, value card (value, chart, periods,
     contributions, cash flows), holdings (day / selected period, closed positions); search sheet. -->
<template>
  <div class="screen" @click.capture="app.rememberScroll?.()">
    <header class="topbar">
      <h1 class="topbar__title">{{ t('app.name') }}</h1>
      <p class="topbar__status" role="status" data-test="updated">
        <span class="dot" :class="{ 'dot--on': live.isLive.value }" aria-hidden="true" />
        <span>{{ live.isLive.value ? t('main.live') : updated }}</span>
      </p>
      <button
        ref="searchBtn" type="button" class="icon-btn sbtn" aria-haspopup="dialog" :aria-label="t('search.open')"
        :title="t('search.open')" data-test="search-open" @click="searchOpen = true"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
        <span class="sbtn__text" aria-hidden="true">{{ t('search.open') }}</span>
      </button>
      <a class="icon-btn" href="#/settings" :aria-label="t('nav.settings')" :title="t('nav.settings')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-test="gear">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </a>
    </header>

    <p v-if="errorNames" class="banner" role="status" data-test="errors">{{ t('main.errors', { names: errorNames }) }}</p>

    <MarketsStrip />

    <!-- aria-busy sits on the card: on desktop the value block's body is display: contents. -->
    <section class="card vcard" :aria-label="t('value.label')" :aria-busy="stale ? 'true' : 'false'">
      <ValueBlock :core="core" :stale="stale" :period="period" :current="current" />
      <PeriodPicker compare />
      <Contributions :positions="core?.positions || null" :stale="stale" />
      <CashflowsCard :summary="core?.summary || null" :stale="stale" />
    </section>

    <Holdings :core="core" :stale="stale" :period="period" />

    <SearchSheet v-if="searchOpen" @close="closeSearch" />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
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
import SearchSheet from './SearchSheet.vue'

const app = useApp()
const { live } = app
const state = computed(() => app.state.value)
const { core, stale, period } = usePeriodCore()

// Back to this screen (history traversal): its entry carries the scroll it was left at. Restored
// once mounted and laid out (the browser's own restore ran before this screen was rendered).
onMounted(() => {
  const y = app.savedScroll?.() || 0
  if (!y) return
  nextTick(() => {
    const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0))
    raf(() => globalThis.window?.scrollTo?.(0, y))
  })
})

// Search sheet; closing it returns focus to the search button.
const searchOpen = ref(false)
const searchBtn = ref(null)
function closeSearch() {
  searchOpen.value = false
  nextTick(() => searchBtn.value?.focus())
}

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
const ERR_KEYS = new Set(['positions', 'trades', 'cashflows', 'markets', 'candles', 'sparks'])
const errorNames = computed(() => [...new Set(Object.keys(state.value?.errors || {})
  .map((k) => t(`main.err.${ERR_KEYS.has(k) ? k : 'other'}`)))].join(', '))
</script>
