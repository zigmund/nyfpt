<!-- Markets strip: status line + the cards of prefs.marketStrip (default: S&P 500, Nasdaq 100, oil, gold,
     silver) scrolling inside the strip; hidden when the list is empty. Live quotes (ltp, pcp) override
     the daily data when present. A card whose ticker was fetched without data shows dashes. A card is a
     link to its security card (the name link covers the whole card). -->
<template>
  <section v-if="items.length" class="mkts" :aria-label="t('mkts.label')" data-test="markets">
    <p class="status">
      <span class="dot" :class="{ 'dot--on': usOpen }" aria-hidden="true" />
      <span>{{ usOpen ? t('mkts.open') : t('mkts.closed') }}</span>
      <template v-if="date">
        <span aria-hidden="true">·</span>
        <span class="num">{{ t('mkts.dataFor', { date: dateShort(date) }) }}</span>
      </template>
    </p>
    <ul class="mkts__row">
      <li v-for="c in cards" :key="c.ticker" class="mcard">
        <a
          class="mcard__name" :href="`#${positionPath(c.ticker)}`" :title="c.note ? `${c.label} ${c.note}` : c.label"
          data-test="mcard-link"
        >{{ c.label }}<small v-if="c.note">{{ c.note }}</small></a>
        <MarketSpark v-if="c.ready" :spark="c.spark" :prev="c.prev" />
        <div v-else-if="c.empty" class="spark" aria-hidden="true" />
        <div v-else class="spark skel" aria-hidden="true" />
        <template v-if="c.ready">
          <p class="mcard__last num">{{ fPrice(c.last) }}</p>
          <p class="mcard__chg num" :class="tone(c.change)">{{ fPct(c.change) }}</p>
        </template>
        <template v-else-if="c.empty">
          <p class="mcard__last num">—</p>
          <p class="mcard__chg num">—</p>
        </template>
        <template v-else>
          <p class="mcard__last skel" aria-hidden="true">&nbsp;</p>
          <p class="mcard__chg skel" aria-hidden="true">&nbsp;</p>
        </template>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { t } from '../i18n.js'
import { dateShort } from '../format.js'
import { fPct, fPrice, tone, n } from '../display.js'
import { positionPath, useApp } from '../composables/useApp.js'
import MarketSpark from './MarketSpark.vue'

const app = useApp()
const { state, tick, live } = app

const usOpen = computed(() => live.usOpen.value)
const items = computed(() => app.marketStrip.value)

const strip = computed(() => {
  void tick.value
  return state.value?.markets || app.marketsStrip() || null
})

const date = computed(() => strip.value?.find((r) => r.ticker === 'SP500.IDX')?.date || null)

const cards = computed(() => {
  void tick.value // live.quotes is a plain Map: tick marks its updates
  const quotes = live.quotes
  return items.value.map((m) => {
    // No row: not fetched yet (skeleton); a row without a close: fetched, no data (dashes).
    const r = strip.value?.find((x) => x.ticker === m.ticker) || null
    const q = quotes?.get?.(m.ticker) || null
    const last = n(q?.ltp) ?? n(r?.last)
    const change = n(q?.pcp) ?? n(r?.change_pct)
    return {
      ...m,
      ready: last !== null,
      empty: last === null && !!r,
      last,
      change,
      prev: n(r?.prev),
      spark: r?.spark || [],
    }
  })
})
</script>
