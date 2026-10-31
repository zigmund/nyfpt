<!-- Position card: back, ticker (plus price once the big price scrolls away), tabs from
     CARD_TABS filtered by security kind; the tab lives in the hash (#/position/<ticker>/<tab>). -->
<template>
  <div class="screen pcard">
    <header class="topbar pcard__bar">
      <button type="button" class="icon-btn" :aria-label="t('nav.back')" data-test="back" @click="app.go('/')">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div class="pcard__title">
        <h1 class="topbar__title" :class="{ 'pcard__tk--small': compact }" data-test="p-ticker">{{ ticker }}</h1>
        <p v-if="compact && pos.price != null" class="pcard__px num" data-test="p-bar-price">{{ fPrice(pos.price) }}</p>
      </div>
    </header>

    <div class="ptabs" role="tablist" :aria-label="t('pos.tabs')">
      <button
        v-for="tb in tabs"
        :id="`ptab-${tb.id}`"
        :key="tb.id"
        type="button"
        role="tab"
        class="ptabs__btn"
        :aria-selected="tb.id === active ? 'true' : 'false'"
        aria-controls="ppanel"
        :data-tab="tb.id"
        @click="select(tb.id)"
      >{{ t(`pos.tab.${tb.id}`) }}</button>
    </div>

    <div id="ppanel" role="tabpanel" :aria-labelledby="`ptab-${active}`" class="pcard__panel">
      <PositionSummary v-if="active === 'summary'" :pos="pos" :period="period" @price-visible="compact = !$event" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { t } from '../i18n.js'
import { fPrice } from '../display.js'
import { useApp, positionPath } from '../composables/useApp.js'
import { usePosition } from '../composables/usePosition.js'
import { tabsFor, chartSource, CARD_PERIODS } from '../calc/position.js'
import PositionSummary from './PositionSummary.vue'

const props = defineProps({
  ticker: { type: String, required: true },
  tab: { type: String, default: 'summary' },
})

const app = useApp()
const period = computed(() => (CARD_PERIODS.includes(app.prefs.cardPeriod) ? app.prefs.cardPeriod : '1D'))
// The chart's dataset is fetched with the security info and daily candles.
const pos = reactive(usePosition(props.ticker, {
  parts: () => (chartSource(period.value) === 'daily' ? [] : [chartSource(period.value)]),
}))

const tabs = computed(() => tabsFor(pos.kind))
// An unknown tab or one not offered for this security kind shows Summary.
const active = computed(() => (tabs.value.some((x) => x.id === props.tab) ? props.tab : 'summary'))
// Tab switches replace the history entry: Back leaves the card.
const select = (id) => app.go(positionPath(props.ticker, id), { replace: true })

const compact = ref(false)

watch(period, () => pos.load())
onMounted(() => {
  pos.load()
  globalThis.window?.scrollTo?.(0, 0)
})
</script>
