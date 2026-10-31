<!-- Position card, Summary tab: name and price, price chart with periods, My holdings,
     Key statistics (Task 22 set; a stat without a value is hidden). Broker text is rendered
     only through interpolation. -->
<template>
  <div class="psum">
    <p v-if="loadError" class="banner" role="status" data-test="p-error">
      {{ t('pos.error') }}
      <button type="button" class="link" @click="pos.load(true)">{{ t('error.retry') }}</button>
    </p>

    <section class="card phead" :aria-label="t('pos.quote')">
      <p v-if="venue" class="card__hint" data-test="p-venue">{{ venue }}</p>
      <h2 class="phead__name" data-test="p-name">{{ pos.name === ticker ? ticker : `${pos.name} (${ticker})` }}</h2>
      <p class="phead__line">
        <span v-if="pos.price != null" ref="bigEl" class="big num" data-test="p-price">{{ fPrice(pos.price) }}</span>
        <span v-else ref="bigEl" class="big skel" aria-hidden="true">&nbsp;</span>
        <span v-if="pos.change != null" class="phead__chg num" :class="tone(pos.change)" data-test="p-change">{{ fChange(pos.change) }} ({{ fPct(pos.changePct) }})</span>
      </p>
      <p class="status" data-test="p-asof">
        <template v-if="pos.isLive">
          <span class="dot dot--on" aria-hidden="true" />
          <span>{{ t('pos.live') }}</span>
        </template>
        <span v-else-if="pos.closedAt">{{ t('pos.atClose', { at: pos.closedAt }) }}</span>
      </p>

      <div v-if="rows.length > 1" class="pchart" :aria-label="t('pos.chartLabel', { period })" role="img" data-test="p-chart">
        <PriceChart :rows="rows" :base="base" :intraday="intraday" />
      </div>
      <div v-else-if="chartLoading" class="pchart skel" aria-hidden="true" data-test="p-chart-skel" />
      <p v-else class="card__hint pchart__none" data-test="p-chart-none">{{ t('pos.noChart') }}</p>

      <div class="periods" role="group" :aria-label="t('period.label')">
        <button
          v-for="p in PERIODS"
          :key="p"
          type="button"
          class="periods__btn"
          :aria-pressed="p === mainPeriod ? 'true' : 'false'"
          :data-cperiod="p"
          @click="app.prefs.period = p"
        >{{ PERIOD_LABELS[p] }}</button>
      </div>
    </section>

    <section v-if="h || closed" class="card" aria-labelledby="ph-h" data-test="p-holdings">
      <h2 id="ph-h" class="label">{{ t('pos.holdings') }}</h2>
      <template v-if="h">
        <dl class="kv num">
          <dt>{{ t('pos.dayGain') }}</dt>
          <dd data-test="ph-day" :class="tone(h.dayGain)">{{ fMoney(h.dayGain, { hide, sign: true }) }} ({{ fPct(h.dayGainPct) }})</dd>
          <dt>{{ t('pos.totalGain') }}</dt>
          <dd data-test="ph-total" :class="tone(h.totalGain)">{{ fMoney(h.totalGain, { hide, sign: true }) }} ({{ fPct(h.totalGainPct) }})</dd>
        </dl>
        <div class="pgrid">
          <div>
            <p class="pgrid__k">{{ t('pos.shares') }}</p>
            <p class="pgrid__v num" data-test="ph-shares">{{ fQty(h.qty, hide) }}</p>
          </div>
          <div>
            <p class="pgrid__k">{{ t('pos.avgCost') }}</p>
            <p class="pgrid__v num" data-test="ph-avg">{{ fPrice(h.avgCost) }}<template v-if="foreign"> {{ h.currency }}</template></p>
          </div>
          <div>
            <p class="pgrid__k">{{ t('pos.marketValue') }}</p>
            <p class="pgrid__v num" data-test="ph-value">{{ fMoney(h.marketValue, { hide }) }}</p>
          </div>
        </div>
      </template>
      <template v-else>
        <p class="card__hint" data-test="ph-closed">{{ t('pos.closed') }}</p>
        <dl class="kv num">
          <dt>{{ t('pos.periodResult', { period: periodLabel }) }}</dt>
          <dd data-test="ph-period" :class="tone(closed.pnl)">{{ fMoney(closed.pnl, { hide, sign: true }) }} ({{ fPct(closed.change_pct) }})</dd>
        </dl>
      </template>
    </section>

    <section v-if="hasStats" class="card" aria-labelledby="pk-h" data-test="p-stats">
      <h2 id="pk-h" class="label">{{ t('pos.keyStats') }}</h2>
      <div v-for="r in ranges" :key="r.key" class="prange" :data-test="`pk-${r.key}`">
        <div class="prange__head num">
          <span>{{ fPrice(r.lo) }}</span>
          <span class="prange__name">{{ r.label }}</span>
          <span>{{ fPrice(r.hi) }}</span>
        </div>
        <div class="prange__track" aria-hidden="true">
          <span v-if="r.at != null" class="prange__mark" :style="{ left: `${r.at * 100}%` }" />
        </div>
      </div>
      <dl class="pstats">
        <div v-for="s in statRows" :key="s.key" class="pstats__item" :data-test="`pk-${s.key}`">
          <dt>{{ s.label }}</dt>
          <dd class="num">{{ s.text }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n.js'
import { fMoney, fPct, fPrice, fQty, tone, n, PERIOD_LABELS } from '../display.js'
import { useApp } from '../composables/useApp.js'
import { usePeriodCore } from '../composables/usePeriodCore.js'
import { nyDate } from '../data/repo.js'
import { PERIODS } from '../calc/periods.js'
import { chartRows, chartSource, rangePos } from '../calc/position.js'
import PriceChart from './PriceChart.vue'

const props = defineProps({
  /** reactive usePosition() result */
  pos: { type: Object, required: true },
  period: { type: String, default: '1D' },
})
const emit = defineEmits(['price-visible'])

const app = useApp()
const ticker = computed(() => props.pos.ticker)
const hide = computed(() => !!app.prefs.hide)

const MINUS = '−'
const fChange = (v) => {
  const x = n(v)
  if (x === null) return '—'
  return `${x < 0 ? MINUS : x > 0 ? '+' : ''}${fPrice(Math.abs(x))}`
}

const venue = computed(() => [props.pos.exchange, props.pos.currency].filter(Boolean).join(' · '))
const loadError = computed(() => !!props.pos.sec.errors?.info && !props.pos.sec.info)

// --- chart
const intraday = computed(() => chartSource(props.period) === 'intraday')
const rows = computed(() => {
  const s = props.pos.sec
  const today = nyDate(Date.now())
  const list = chartRows(props.period, s, { today, sessions: s.sessions })
  // Live: the last bar of today's session follows the quote.
  const px = props.pos.price
  if (props.period === '1D' && props.pos.isLive && px != null && list.length && list[list.length - 1].date === today) {
    list[list.length - 1] = { ...list[list.length - 1], close: px }
  }
  return list
})
const base = computed(() => (props.period === '1D' ? props.pos.prevClose : null))
const chartLoading = computed(() => {
  const src = chartSource(props.period)
  return props.pos.sec[src] == null && !props.pos.sec.errors?.[src]
})

// --- My holdings; a closed position shows its result for the selected (main) period.
const h = computed(() => props.pos.holding)
const foreign = computed(() => h.value?.currency && h.value.currency !== 'USD')
const { core, period: mainPeriod } = usePeriodCore()
const periodLabel = computed(() => PERIOD_LABELS[mainPeriod.value] || mainPeriod.value)
const closed = computed(() => {
  if (h.value) return null
  return (core.value?.positions || []).find((r) => r.ticker === ticker.value && !r.qty_end) || null
})

// --- key statistics
const KIND_KEYS = { stock: 'pos.kind.stock', preferred: 'pos.kind.preferred', fund: 'pos.kind.fund' }
const vol = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const ranges = computed(() => {
  const s = props.pos.stats
  const px = props.pos.price
  return [
    { key: 'day', label: t('pos.ks.dayRange'), lo: s.dayLow, hi: s.dayHigh },
    { key: 'year', label: t('pos.ks.yearRange'), lo: s.low52, hi: s.high52 },
  ].filter((r) => r.lo != null && r.hi != null).map((r) => ({ ...r, at: rangePos(px, r.lo, r.hi) }))
})
const statRows = computed(() => {
  const s = props.pos.stats
  return [
    { key: 'prevClose', v: s.prevClose, text: fPrice(s.prevClose) },
    { key: 'open', v: s.open, text: fPrice(s.open) },
    { key: 'volume', v: s.volume, text: s.volume == null ? '' : vol.format(s.volume) },
    { key: 'avgVolume', v: s.avgVolume, text: s.avgVolume == null ? '' : vol.format(s.avgVolume) },
    { key: 'kind', v: s.kind, text: s.kind ? t(KIND_KEYS[s.kind]) : '' },
  ].filter((r) => r.v != null).map((r) => ({ ...r, label: t(`pos.ks.${r.key}`) }))
})
const hasStats = computed(() => ranges.value.length > 0 || statRows.value.length > 0)

// --- big price visibility (compact header in the screen's top bar)
const bigEl = ref(null)
let io = null
function observe(el) {
  io?.disconnect()
  if (!el || typeof IntersectionObserver === 'undefined') return
  // The sticky top bar covers the page top: the price counts as hidden once under it.
  io ||= new IntersectionObserver((entries) => {
    for (const e of entries) emit('price-visible', e.isIntersecting)
  }, { rootMargin: '-56px 0px 0px 0px' })
  io.observe(el)
}
onMounted(() => observe(bigEl.value))
watch(bigEl, (el) => observe(el))
onBeforeUnmount(() => io?.disconnect())
</script>
