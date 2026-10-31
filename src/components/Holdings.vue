<!-- Live holdings: day change total + sortable table (persisted sort in prefs.sorts.holdings).
     Price cells flash for 600 ms on a tick, live mode only. No aria-live: cells change every tick. -->
<template>
  <section class="card" aria-labelledby="hold-h" data-test="holdings">
    <h2 id="hold-h" class="label">{{ t('hold.title') }}</h2>

    <template v-if="rows">
      <p class="hold__total num" data-test="h-total">
        <span class="hold__total-label">{{ t('hold.today') }}</span>
        <span :class="tone(total.dayChangeUsd)">{{ fMoney(total.dayChangeUsd, { hide: prefs.hide, sign: true }) }}</span>
        <span :class="tone(total.dayChangePct)">({{ fPct(total.dayChangePct) }})</span>
      </p>

      <div class="tablebox">
        <table class="ptable num">
          <thead>
            <tr>
              <th v-for="c in COLS" :key="c.key" scope="col" :class="{ 'h-narrow': c.narrow }" :aria-sort="ariaSort(c.key)">
                <button type="button" class="ptable__sort" :data-sort="c.key" @click="sortBy(c.key)">{{ t(`hold.col.${c.key}`) }}</button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in sorted" :key="r.ticker" data-test="h-row" :data-ticker="r.ticker">
              <th scope="row">{{ r.ticker }}</th>
              <td data-test="h-price" :class="flashes[r.ticker]">{{ fPrice(r.price) }}</td>
              <td data-test="h-daypct" :class="tone(r.dayChangePct)">{{ fPct(r.dayChangePct) }}</td>
              <td data-test="h-dayusd" :class="tone(r.dayChangeUsd)">{{ fMoney(r.dayChangeUsd, { hide: prefs.hide, sign: true }) }}</td>
              <td data-test="h-qty" class="h-narrow">{{ fQty(r.qty, prefs.hide) }}</td>
              <td data-test="h-value">{{ fMoney(r.valueUsd, { hide: prefs.hide }) }}</td>
              <td data-test="h-weight" class="h-narrow">{{ fWeight(r.weight * 100) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div v-else class="skel-rows" aria-hidden="true">
      <p v-for="i in 4" :key="i" class="skel">&nbsp;</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { t } from '../i18n.js'
import { fMoney, fPct, fPrice, fQty, fWeight, tone, n } from '../display.js'
import { holdingsRows, holdingsTotal } from '../calc/live.js'
import { useApp } from '../composables/useApp.js'

const COLS = [
  { key: 'ticker' }, { key: 'price' }, { key: 'dayChangePct' }, { key: 'dayChangeUsd' },
  { key: 'qty', narrow: true }, { key: 'valueUsd' }, { key: 'weight', narrow: true },
]
const DEFAULT_SORT = { key: 'valueUsd', dir: -1 }
const FLASH_MS = 600

const app = useApp()
const { prefs, live } = app

// Quotes Map is mutated in place; `tick` is the change signal.
const rows = computed(() => {
  void app.tick.value
  const ps = app.state.value?.rawPs
  return ps ? holdingsRows(ps, app.liveQuotesForCalc()) : null
})
const total = computed(() => holdingsTotal(rows.value || []))

const sort = computed(() => {
  const s = prefs.sorts?.holdings
  return s && COLS.some((c) => c.key === s.key) && (s.dir === 1 || s.dir === -1) ? s : DEFAULT_SORT
})

function sortBy(key) {
  const s = sort.value
  const dir = s.key === key ? -s.dir : key === 'ticker' ? 1 : -1
  prefs.sorts = { ...(prefs.sorts || {}), holdings: { key, dir } }
}

const ariaSort = (key) => (sort.value.key === key ? (sort.value.dir > 0 ? 'ascending' : 'descending') : 'none')

const sorted = computed(() => {
  const { key, dir } = sort.value
  return rows.value.slice().sort((a, b) => {
    if (key === 'ticker') return a.ticker.localeCompare(b.ticker) * dir
    return ((n(a[key]) ?? -Infinity) - (n(b[key]) ?? -Infinity)) * dir || 0
  })
})

// Price flash: ticker -> 'flash-up' | 'flash-down', cleared after FLASH_MS.
const flashes = reactive({})
const timers = new Map()
let prev = new Map()
watch(rows, (list) => {
  const next = new Map()
  for (const r of list || []) {
    next.set(r.ticker, r.price)
    const was = prev.get(r.ticker)
    if (!live.isLive.value || was == null || r.price == null || r.price === was) continue
    flashes[r.ticker] = r.price > was ? 'flash-up' : 'flash-down'
    clearTimeout(timers.get(r.ticker))
    timers.set(r.ticker, setTimeout(() => { delete flashes[r.ticker]; timers.delete(r.ticker) }, FLASH_MS))
  }
  prev = next
}, { immediate: true })
onBeforeUnmount(() => { for (const id of timers.values()) clearTimeout(id) })
</script>
