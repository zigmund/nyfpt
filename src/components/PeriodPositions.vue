<!-- All positions over the period (including sold ones), sortable; persisted sort in prefs.sorts.
     Before the period is computed: a simple table of current positions. -->
<template>
  <section class="card" aria-labelledby="ppos-h" data-test="ppos">
    <h2 id="ppos-h" class="label">{{ t('ppos.title') }}</h2>
    <p class="card__hint">{{ rows ? t('ppos.note') : t('ppos.noteCurrent') }}</p>

    <div v-if="rows" class="tablebox" :class="{ 'is-stale': stale }">
      <table class="ptable num">
        <thead>
          <tr>
            <th v-for="c in COLS" :key="c.key" scope="col" :class="{ 'is-wide': c.wide }" :aria-sort="ariaSort(c.key)">
              <button type="button" class="ptable__sort" :data-sort="c.key" @click="sortBy(c.key)">{{ t(`ppos.col.${c.key}`) }}</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in sorted" :key="r.ticker">
            <th scope="row">{{ r.ticker }}</th>
            <td class="is-wide ptable__st">{{ statusText(r.status) }}</td>
            <td class="is-wide">{{ fQty(r.qty_start, prefs.hide) }}</td>
            <td>{{ fQty(r.qty_end, prefs.hide) }}</td>
            <td class="is-wide">{{ fPrice(r.price_end) }}</td>
            <td :class="tone(r.change_pct)">{{ fPct(r.change_pct) }}</td>
            <td :class="tone(r.pnl)">{{ fMoney(r.pnl, { hide: prefs.hide, sign: true }) }}</td>
            <td>{{ fMoney(r.value, { hide: prefs.hide }) }}</td>
            <td>{{ fWeight(r.weight) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="current" class="tablebox">
      <table class="ptable num" data-test="ppos-current">
        <thead>
          <tr>
            <th scope="col">{{ t('ppos.col.ticker') }}</th>
            <th scope="col">{{ t('ppos.col.qty') }}</th>
            <th scope="col">{{ t('ppos.col.price_end') }}</th>
            <th scope="col">{{ t('ppos.col.value') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in current" :key="r.ticker">
            <th scope="row">{{ r.ticker }}</th>
            <td>{{ fQty(r.qty, prefs.hide) }}</td>
            <td>{{ fPrice(r.price) }}</td>
            <td>{{ fMoney(r.value, { hide: prefs.hide }) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="skel-rows" aria-hidden="true">
      <p v-for="i in 4" :key="i" class="skel">&nbsp;</p>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { t } from '../i18n.js'
import { fMoney, fPct, fPrice, fQty, fWeight, tone, n } from '../display.js'
import { useApp } from '../composables/useApp.js'

const props = defineProps({
  /** computeCore positions or null */
  rows: { type: Array, default: null },
  stale: { type: Boolean, default: false },
  /** parsePositions rows (current holdings + cash) for the pre-computation table */
  positions: { type: Array, default: null },
})

const COLS = [
  { key: 'ticker' }, { key: 'status', wide: true }, { key: 'qty_start', wide: true }, { key: 'qty_end' },
  { key: 'price_end', wide: true }, { key: 'change_pct' }, { key: 'pnl' }, { key: 'value' }, { key: 'weight' },
]
const TEXT_KEYS = new Set(['ticker', 'status'])
// computeCore reports status in Russian; mapped to English labels.
const STATUS = { 'новая': 'new', 'докуплена': 'added', 'сокращена': 'reduced', 'закрыта': 'closed' }
const DEFAULT_SORT = { key: 'value', dir: -1 }

const { prefs } = useApp()

const sort = computed(() => {
  const s = prefs.sorts?.positions
  return s && COLS.some((c) => c.key === s.key) && (s.dir === 1 || s.dir === -1) ? s : DEFAULT_SORT
})

function sortBy(key) {
  const s = sort.value
  const dir = s.key === key ? -s.dir : TEXT_KEYS.has(key) ? 1 : -1
  prefs.sorts = { ...(prefs.sorts || {}), positions: { key, dir } }
}

const ariaSort = (key) => (sort.value.key === key ? (sort.value.dir > 0 ? 'ascending' : 'descending') : 'none')
const statusText = (s) => (STATUS[s] ? t(`ppos.status.${STATUS[s]}`) : '')

const sorted = computed(() => {
  const { key, dir } = sort.value
  const val = (r) => (key === 'status' ? statusText(r.status) : r[key])
  return props.rows.slice().sort((a, b) => {
    const A = val(a)
    const B = val(b)
    if (TEXT_KEYS.has(key)) return String(A || '').localeCompare(String(B || '')) * dir
    return ((n(A) ?? -Infinity) - (n(B) ?? -Infinity)) * dir || 0
  })
})

const current = computed(() => {
  if (!props.positions) return null
  return props.positions.filter((r) => r.kind === 'position').slice().sort((a, b) => (n(b.value) ?? 0) - (n(a.value) ?? 0))
})
</script>
