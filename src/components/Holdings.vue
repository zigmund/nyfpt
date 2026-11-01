<!-- Holdings with a Day / selected-period switch (prefs.holdingsMode).
     Day: live day change total + table; price cells flash for 600 ms on a tick, live mode only.
     Period: period P&L total (same numbers as the value card) + positions open at the period end;
     before the period is computed: current positions without period columns.
     Below, in both modes: a collapsible "Closed positions" block (Day: last trading day = 1D core).
     Rows (Yahoo style): ticker + name linking to the position card, a sparkline (Day: last session
     15-min closes with the previous-close level; Period: daily closes over the period), price and
     a change pill. < 48rem: CSS turns each row into a card with the other amounts on a second line.
     Separate persisted sorts in prefs.sorts. No aria-live: cells change every tick. -->
<template>
  <section class="card" aria-labelledby="hold-h" data-test="holdings">
    <div class="hold__head">
      <h2 id="hold-h" class="label">{{ t('hold.title') }}</h2>
      <div class="seg seg--inline" role="group" :aria-label="t('hold.mode.label')" data-test="hmode">
        <button
          type="button"
          class="seg__btn"
          :aria-pressed="mode === 'day' ? 'true' : 'false'"
          data-test="hmode-day"
          @click="prefs.holdingsMode = 'day'"
        >{{ t('hold.mode.day') }}</button>
        <button
          type="button"
          class="seg__btn"
          :aria-pressed="mode === 'period' ? 'true' : 'false'"
          data-test="hmode-period"
          @click="prefs.holdingsMode = 'period'"
        >{{ periodLabel }}</button>
      </div>
    </div>

    <template v-if="mode === 'day'">
      <template v-if="rows">
        <p class="hold__total num" data-test="h-total">
          <span class="hold__total-label">{{ t('hold.today') }}</span>
          <span class="hold__total-value" data-test="h-total-value">{{ fMoney(dayTotal.valueUsd, { hide: prefs.hide }) }}</span>
          <span :class="tone(dayTotal.dayChangeUsd)">{{ fMoney(dayTotal.dayChangeUsd, { hide: prefs.hide, sign: true }) }}</span>
          <span :class="tone(dayTotal.dayChangePct)">({{ fPct(dayTotal.dayChangePct) }})</span>
        </p>

        <div class="tablebox tablebox--rows">
          <table class="ptable htable num">
            <thead>
              <tr>
                <th v-for="c in DAY_COLS" :key="c.key" scope="col" :class="headClass(c)" :aria-sort="c.key === 'chart' ? undefined : daySort.aria(c.key)">
                  <span v-if="c.key === 'chart'" class="vh">{{ t('hold.col.chart') }}</span>
                  <button v-else type="button" class="ptable__sort" :data-sort="c.key" @click="daySort.by(c.key)">{{ t(`hold.col.${c.key}`) }}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in daySorted" :key="r.ticker" class="hrow" data-test="h-row" :data-ticker="r.ticker">
                <th scope="row" class="hc-sym">
                  <a class="hrow__link" :href="posHref(r.ticker)" data-test="h-link">
                    <span class="hrow__sym" data-test="h-sym">{{ r.ticker }}</span>{{ ' ' }}<span class="hrow__name" data-test="h-name">{{ r.name }}</span>
                  </a>
                </th>
                <td class="hc-spark"><MarketSpark v-bind="daySpark(r)" /></td>
                <td data-test="h-price" class="hc-price" :class="flashes[r.ticker]">{{ fPrice(r.price) }}</td>
                <td class="hc-pill"><span data-test="h-daypct" :class="pill(r.dayChangePct)">{{ fPct(r.dayChangePct) }}</span></td>
                <td data-test="h-dayusd" class="hc-meta" :class="tone(r.dayChangeUsd)" :data-label="t('hold.col.dayChangeUsd')">{{ fMoney(r.dayChangeUsd, { hide: prefs.hide, sign: true }) }}</td>
                <td data-test="h-qty" class="hc-meta hc-qty" :data-label="t('hold.col.qty')">{{ fQty(r.qty, prefs.hide) }}</td>
                <td data-test="h-value" class="hc-meta" :data-label="t('hold.col.valueUsd')">{{ fMoney(r.valueUsd, { hide: prefs.hide }) }}</td>
                <td data-test="h-weight" class="hc-meta hc-weight" :data-label="t('hold.col.weight')">{{ fWeight(r.weight * 100) }}</td>
              </tr>
              <tr v-for="c in dayCash" :key="c.curr" class="hrow hrow--cash" data-test="h-cash-row" :data-cash="c.curr">
                <th scope="row" class="hc-sym">
                  <span class="hrow__sym" data-test="h-cash-sym">{{ t('hold.cash') }}</span>{{ ' ' }}<span class="hrow__name">{{ c.curr }}</span>
                </th>
                <td v-for="k in 5" :key="k" class="hc-empty" />
                <td data-test="h-cash-value" class="hc-meta" :data-label="t('hold.col.valueUsd')">{{ fMoney(c.value, { hide: prefs.hide }) }}</td>
                <td data-test="h-cash-weight" class="hc-meta hc-weight" :data-label="t('hold.col.weight')">{{ fWeight(c.weight) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div v-else class="skel-rows" aria-hidden="true">
        <p v-for="i in 4" :key="i" class="skel">&nbsp;</p>
      </div>
    </template>

    <template v-else-if="core">
      <p v-if="summary" class="hold__total num" :class="{ 'is-stale': stale }" data-test="h-total">
        <span class="hold__total-label">{{ periodLabel }}</span>
        <span class="hold__total-value" data-test="h-total-value">{{ fMoney(periodTotal, { hide: prefs.hide }) }}</span>
        <span :class="tone(summary.pnl)">{{ fMoney(summary.pnl, { hide: prefs.hide, sign: true }) }}</span>
        <span :class="tone(summary.twr)">({{ fPct(summary.twr) }})</span>
      </p>

      <div class="tablebox tablebox--rows" :class="{ 'is-stale': stale }" :aria-busy="stale ? 'true' : 'false'">
        <table class="ptable htable num" data-test="hp-table">
          <thead>
            <tr>
              <th v-for="c in PERIOD_COLS" :key="c.key" scope="col" :class="headClass(c)" :aria-sort="c.key === 'chart' ? undefined : periodSort.aria(c.key)">
                <span v-if="c.key === 'chart'" class="vh">{{ t('hold.col.chart') }}</span>
                <button v-else type="button" class="ptable__sort" :data-sort="c.key" @click="periodSort.by(c.key)">{{ t(`hold.pcol.${c.key}`) }}</button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in periodSorted" :key="r.ticker" class="hrow" data-test="hp-row" :data-ticker="r.ticker">
              <th scope="row" class="hc-sym">
                <a class="hrow__link" :href="posHref(r.ticker)" data-test="h-link">
                  <span class="hrow__sym" data-test="h-sym">{{ r.ticker }}</span>{{ ' ' }}<span class="hrow__name" data-test="h-name">{{ r.name }}</span>
                </a>
              </th>
              <td class="hc-spark"><MarketSpark :spark="periodSparks[r.ticker] || EMPTY" :prev="null" :down="(n(r.change_pct) ?? 0) < 0" /></td>
              <td data-test="hp-status" class="h-narrow ptable__st">{{ statusText(r.status) }}</td>
              <td data-test="hp-qstart" class="h-narrow">{{ fQty(r.qty_start, prefs.hide) }}</td>
              <td data-test="hp-qend" class="hc-meta hc-qty" :data-label="t('hold.col.qty')">{{ fQty(r.qty_end, prefs.hide) }}</td>
              <td data-test="hp-price" class="hc-price">{{ fPrice(r.price_end) }}</td>
              <td class="hc-pill"><span data-test="hp-pct" :class="pill(r.change_pct)">{{ fPct(r.change_pct) }}</span></td>
              <td data-test="hp-pnl" class="hc-meta" :class="tone(r.pnl)" :data-label="t('hold.pcol.pnl')">{{ fMoney(r.pnl, { hide: prefs.hide, sign: true }) }}</td>
              <td data-test="hp-value" class="hc-meta" :data-label="t('hold.pcol.value')">{{ fMoney(r.value, { hide: prefs.hide }) }}</td>
              <td data-test="hp-weight" class="hc-meta hc-weight" :data-label="t('hold.pcol.weight')">{{ fWeight(r.weight) }}</td>
            </tr>
            <tr v-for="c in periodCash" :key="c.curr" class="hrow hrow--cash" data-test="hp-cash-row" :data-cash="c.curr">
              <th scope="row" class="hc-sym">
                <span class="hrow__sym">{{ t('hold.cash') }}</span>{{ ' ' }}<span class="hrow__name">{{ c.curr }}</span>
              </th>
              <td v-for="k in 7" :key="k" class="hc-empty" :class="{ 'h-narrow': k === 2 || k === 3 }" />
              <td data-test="hp-cash-value" class="hc-meta" :data-label="t('hold.pcol.value')">{{ fMoney(c.value, { hide: prefs.hide }) }}</td>
              <td data-test="hp-cash-weight" class="hc-meta hc-weight" :data-label="t('hold.pcol.weight')">{{ fWeight(c.weight) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="current">
      <p class="card__hint">{{ t('hold.noteCurrent') }}</p>
      <div class="tablebox">
        <table class="ptable num" data-test="hold-current">
          <thead>
            <tr>
              <th scope="col">{{ t('hold.col.ticker') }}</th>
              <th scope="col">{{ t('hold.col.qty') }}</th>
              <th scope="col">{{ t('hold.col.price') }}</th>
              <th scope="col">{{ t('hold.col.valueUsd') }}</th>
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
    </template>

    <div v-else class="skel-rows" aria-hidden="true">
      <p v-for="i in 4" :key="i" class="skel">&nbsp;</p>
    </div>

    <div v-if="closedShown" class="hold__closed">
      <button
        type="button"
        class="contrib__toggle"
        :class="{ 'is-open': closedOpen }"
        :aria-expanded="closedOpen ? 'true' : 'false'"
        :aria-controls="CLOSED_ID"
        data-test="hc-toggle"
        @click="prefs.holdingsClosedOpen = !closedOpen"
      >
        <span>{{ closedStale ? t('hold.closed') : t('hold.closedN', { n: closed.length }) }}</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div
        v-if="closedOpen"
        :id="CLOSED_ID"
        class="hold__closed-body"
        :class="{ 'is-stale': closedStale }"
        :aria-busy="closedStale ? 'true' : 'false'"
        data-test="hc-body"
      >
        <div class="tablebox">
          <table class="ptable num">
            <thead>
              <tr>
                <th v-for="c in CLOSED_COLS" :key="c.key" scope="col" :aria-sort="closedSort.aria(c.key)">
                  <button type="button" class="ptable__sort" :data-sort="c.key" @click="closedSort.by(c.key)">{{ t(`hold.pcol.${c.key}`) }}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in closedSorted" :key="r.ticker" data-test="hc-row" :data-ticker="r.ticker">
                <th scope="row">{{ r.ticker }}</th>
                <td data-test="hc-qstart">{{ fQty(r.qty_start, prefs.hide) }}</td>
                <td data-test="hc-pct" :class="tone(r.change_pct)">{{ fPct(r.change_pct) }}</td>
                <td data-test="hc-pnl" :class="tone(r.pnl)">{{ fMoney(r.pnl, { hide: prefs.hide, sign: true }) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { t } from '../i18n.js'
import { fMoney, fPct, fPrice, fQty, fWeight, tone, n, PERIOD_LABELS } from '../display.js'
import { holdingsRows, holdingsTotal } from '../calc/live.js'
import { periodSpark } from '../calc/sparks.js'
import MarketSpark from './MarketSpark.vue'
import { useApp } from '../composables/useApp.js'
import { usePeriodCore } from '../composables/usePeriodCore.js'

const props = defineProps({
  /** computeCore result for the selected period, null while not covered by the cache */
  core: { type: Object, default: null },
  /** core belongs to the previous period (new one loading) */
  stale: { type: Boolean, default: false },
  period: { type: String, default: 'YTD' },
})

// 'chart' is the sparkline column (not sortable).
const DAY_COLS = [
  { key: 'ticker' }, { key: 'chart' }, { key: 'price' }, { key: 'dayChangePct' }, { key: 'dayChangeUsd' },
  { key: 'qty' }, { key: 'valueUsd' }, { key: 'weight' },
]
const PERIOD_COLS = [
  { key: 'ticker' }, { key: 'chart' }, { key: 'status', narrow: true }, { key: 'qty_start', narrow: true }, { key: 'qty_end' },
  { key: 'price_end' }, { key: 'change_pct' }, { key: 'pnl' }, { key: 'value' }, { key: 'weight' },
]
const CLOSED_COLS = [{ key: 'ticker' }, { key: 'qty_start' }, { key: 'change_pct' }, { key: 'pnl' }]
const TEXT_KEYS = new Set(['ticker', 'status'])
// computeCore reports status in Russian; mapped to English labels (closed rows are listed separately).
const STATUS = { 'новая': 'new', 'докуплена': 'added', 'сокращена': 'reduced' }
const CLOSED_ID = 'hold-closed'
const EMPTY = Object.freeze([])
const FLASH_MS = 600

const app = useApp()
const { prefs, live } = app

const mode = computed(() => (prefs.holdingsMode === 'period' ? 'period' : 'day'))
const periodLabel = computed(() => PERIOD_LABELS[props.period] || props.period)
const statusText = (s) => (STATUS[s] ? t(`hold.status.${STATUS[s]}`) : '')
const headClass = (c) => ({ 'h-narrow': c.narrow, 'hc-spark': c.key === 'chart' })
const pill = (v) => ['pill', `pill--${tone(v) || 'flat'}`]
// Position card route (Task 20); a no-op until the route exists.
const posHref = (ticker) => `#/position/${encodeURIComponent(ticker)}`

/** Sort persisted in prefs.sorts[name]; text columns start ascending, numbers descending. */
function tableSort(name, cols, fallback, valueOf = (r, key) => r[key]) {
  const sort = computed(() => {
    const s = prefs.sorts?.[name]
    return s && cols.some((c) => c.key === s.key) && (s.dir === 1 || s.dir === -1) ? s : fallback
  })
  return {
    by(key) {
      const s = sort.value
      const dir = s.key === key ? -s.dir : TEXT_KEYS.has(key) ? 1 : -1
      prefs.sorts = { ...(prefs.sorts || {}), [name]: { key, dir } }
    },
    aria: (key) => (sort.value.key === key ? (sort.value.dir > 0 ? 'ascending' : 'descending') : 'none'),
    apply(list) {
      const { key, dir } = sort.value
      return list.slice().sort((a, b) => {
        const A = valueOf(a, key)
        const B = valueOf(b, key)
        if (TEXT_KEYS.has(key)) return String(A || '').localeCompare(String(B || '')) * dir
        return ((n(A) ?? -Infinity) - (n(B) ?? -Infinity)) * dir || 0
      })
    },
  }
}

// Day: quotes Map is mutated in place; `tick` is the change signal.
const rows = computed(() => {
  void app.tick.value
  const ps = app.state.value?.rawPs
  return ps ? holdingsRows(ps, app.liveQuotesForCalc()) : null
})
const total = computed(() => holdingsTotal(rows.value || []))
// Cash per currency: kind 'cash' rows of the positions (USD value) — the same source as the value
// card's current value. Zero balances are skipped; each row is marked with the currency code.
const cashList = computed(() => (app.state.value?.positions || [])
  .filter((r) => r.kind === 'cash' && (n(r.value) ?? 0) !== 0)
  .map((r) => ({ curr: r.ticker, value: n(r.value) })))
const cashTotal = computed(() => cashList.value.reduce((s, c) => s + c.value, 0))
// Day total incl. cash (cash does not move on the day); % base incl. cash, like the value card.
const dayTotal = computed(() => {
  const tt = total.value
  const valueUsd = tt.valueUsd + cashTotal.value
  if (tt.dayChangeUsd == null) return { ...tt, valueUsd }
  const base = valueUsd - tt.dayChangeUsd
  return { valueUsd, dayChangeUsd: tt.dayChangeUsd, dayChangePct: base ? (tt.dayChangeUsd / base) * 100 : null }
})
const dayCash = computed(() => cashList.value.map((c) => ({ ...c, weight: dayTotal.value.valueUsd ? (c.value / dayTotal.value.valueUsd) * 100 : 0 })))
const daySort = tableSort('holdings', DAY_COLS, { key: 'valueUsd', dir: -1 })
const daySorted = computed(() => daySort.apply(rows.value || []))
// Last-session closes from the repo (state.sparks); none yet: an empty spark of the same height.
// Dashed level at the previous close, tone by the day change. A `prior` session (US, right after
// the open) is not what they refer to: no level, tone by the drawn line's own direction.
function daySpark(r) {
  const s = app.state.value?.sparks?.[r.ticker]
  const spark = s?.spark || EMPTY
  if (s?.prior) return { spark, prev: null, down: spark[spark.length - 1] < spark[0] }
  return { spark, prev: n(r.prevClose), down: (n(r.dayChangePct) ?? 0) < 0 }
}

// Period: positions still open at the period end.
const summary = computed(() => props.core?.summary || null)
const periodSort = tableSort('holdingsPeriod', PERIOD_COLS, { key: 'pnl', dir: -1 },
  (r, key) => (key === 'status' ? statusText(r.status) : r[key]))
const periodSorted = computed(() => periodSort.apply((props.core?.positions || []).filter((r) => r.qty_end)))
// Period-end value incl. cash: the value card's number (cash at the end = current cash).
const periodTotal = computed(() => n(summary.value?.value_end)
  ?? periodSorted.value.reduce((s, r) => s + (n(r.value) ?? 0), 0) + cashTotal.value)
const periodCash = computed(() => cashList.value.map((c) => ({ ...c, weight: periodTotal.value ? (c.value / periodTotal.value) * 100 : 0 })))
// Daily closes (state.closes) between the period base and end, framed by price_start / price_end.
const periodSparks = computed(() => {
  const s = summary.value
  const closes = app.state.value?.closes
  const out = {}
  for (const r of periodSorted.value) {
    out[r.ticker] = periodSpark(closes?.get?.(r.ticker), s?.base_close, s?.end, n(r.price_start), n(r.price_end))
  }
  return out
})
const current = computed(() => {
  const list = app.state.value?.positions
  if (!list) return null
  return list.filter((r) => r.kind === 'position').slice().sort((a, b) => (n(b.value) ?? 0) - (n(a.value) ?? 0))
})

// Closed positions: Day -> the last trading day (1D core, priced by the selected period's load).
const day = usePeriodCore({ period: '1d', fetch: false })
const closedCore = computed(() => (mode.value === 'day' ? day.core.value : props.core))
const closedStale = computed(() => (mode.value === 'day' ? day.stale.value : props.stale))
const closed = computed(() => (closedCore.value?.positions || []).filter((r) => !r.qty_end))
const closedShown = computed(() => !!closedCore.value && (closedStale.value || closed.value.length > 0))
const closedOpen = computed(() => prefs.holdingsClosedOpen === true)
const closedSort = tableSort('holdingsClosed', CLOSED_COLS, { key: 'pnl', dir: -1 })
const closedSorted = computed(() => closedSort.apply(closed.value))

// Price flash (Day mode, live only): ticker -> 'flash-up' | 'flash-down', cleared after FLASH_MS.
const flashes = reactive({})
const timers = new Map()
let prev = new Map()
watch(rows, (list) => {
  const next = new Map()
  for (const r of list || []) {
    next.set(r.ticker, r.price)
    const was = prev.get(r.ticker)
    if (!live.isLive.value || mode.value !== 'day' || was == null || r.price == null || r.price === was) continue
    flashes[r.ticker] = r.price > was ? 'flash-up' : 'flash-down'
    clearTimeout(timers.get(r.ticker))
    timers.set(r.ticker, setTimeout(() => { delete flashes[r.ticker]; timers.delete(r.ticker) }, FLASH_MS))
  }
  prev = next
}, { immediate: true })
onBeforeUnmount(() => { for (const id of timers.values()) clearTimeout(id) })
</script>
