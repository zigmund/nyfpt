<!-- Security card, Summary tab: name and price (Live / As of while its market is open / At close),
     price chart with periods, My holdings (held or closed positions only, else no block), Key
     statistics (Task 22 set; a stat without a value is hidden). Broker text only through interpolation.
     Header change (Task 44): 1D — the day change; other periods — the price vs the first point of
     the chart, with the period label; pointer on the chart — that point's price, change and time. -->
<template>
  <div class="psum">
    <p v-if="loadError" class="banner" role="status" data-test="p-error">
      {{ t('pos.error') }}
      <button type="button" class="link" @click="pos.load(true)">{{ t('error.retry') }}</button>
    </p>

    <section class="card phead" :aria-label="t('pos.quote')">
      <p v-if="venue" class="card__hint" data-test="p-venue">{{ venue }}</p>
      <h2 v-if="nameLoading" class="phead__name skel" aria-hidden="true" data-test="p-name-skel">&nbsp;</h2>
      <h2 v-else class="phead__name" data-test="p-name">{{ pos.name === ticker ? ticker : `${pos.name} (${ticker})` }}</h2>
      <p ref="lineEl" class="phead__line" :style="lineLock">
        <span v-if="bigPrice != null" ref="bigEl" class="big num" data-test="p-price">{{ fPrice(bigPrice) }}</span>
        <span v-else-if="priceSettled" ref="bigEl" class="big num" data-test="p-price">—</span>
        <span v-else ref="bigEl" class="big skel" aria-hidden="true">&nbsp;</span>
        <!-- change + label wrap together: the line breaks between price and change, whatever the figures -->
        <span v-if="chg.kind !== 'none'" class="phead__chgrp">
          <span v-if="chg.kind === 'value'" class="phead__chg num" :class="tone(chg.change)" data-test="p-change">{{ chgText(chg) }}</span>
          <span v-else-if="chg.kind === 'dash'" class="phead__chg num" data-test="p-change">—</span>
          <span v-else class="phead__chg skel" aria-hidden="true">&nbsp;</span>
          <span v-if="chg.label && chg.kind !== 'skel'" class="phead__per" data-test="p-chg-label">{{ chg.label }}</span>
        </span>
      </p>
      <!-- The period change for screen readers: announced on a period switch only (not per pointer move or tick). -->
      <p class="vh" aria-live="polite" data-test="p-chg-live">{{ announced }}</p>
      <p class="status" data-test="p-asof">
        <span v-if="hoverWhen">{{ hoverWhen }}</span>
        <template v-else-if="pos.isLive">
          <span class="dot dot--on" aria-hidden="true" />
          <span>{{ t('pos.live') }}</span>
        </template>
        <span v-else-if="pos.closedAt && pos.marketOpen">{{ t('pos.asOf', { at: pos.closedAt }) }}</span>
        <span v-else-if="pos.closedAt">{{ t('pos.atClose', { at: pos.closedAt }) }}</span>
      </p>

      <!-- One fixed-height area in every state: chart, old chart while a new period loads, skeleton, message. -->
      <div
        class="pchart"
        :aria-label="t('pos.chartLabel', { period: periodLabel })"
        :aria-busy="chartLoading ? 'true' : 'false'"
        :role="shown ? 'img' : null"
        data-test="p-chart"
      >
        <div v-if="shown" class="pchart__plot" :class="{ 'is-stale': chartStale }">
          <PriceChart :rows="shown.rows" :base="shown.base" :intraday="shown.intraday" @hover="hover = $event" />
        </div>
        <div v-else-if="chartLoading" class="pchart__skel skel" aria-hidden="true" data-test="p-chart-skel" />
        <p v-else class="card__hint pchart__none" data-test="p-chart-none">{{ t('pos.noChart') }}</p>
        <p v-if="chartLoading" class="pchart__busy card__hint" role="status" data-test="p-chart-busy">{{ t('main.loading') }}</p>
      </div>

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

    <section v-if="holdingsPending" class="card" :aria-label="t('pos.holdings')" aria-busy="true" data-test="p-holdings-skel">
      <div aria-hidden="true" class="p-hold">
        <p class="label skel skel--inline">&nbsp;</p>
        <dl class="kv">
          <dt class="skel">&nbsp;</dt><dd class="skel">&nbsp;</dd>
          <dt class="skel">&nbsp;</dt><dd class="skel">&nbsp;</dd>
        </dl>
        <div class="pgrid">
          <div v-for="i in 3" :key="i"><p class="pgrid__k skel">&nbsp;</p><p class="pgrid__v skel">&nbsp;</p></div>
        </div>
      </div>
    </section>

    <section v-else-if="h || closed" class="card p-hold" aria-labelledby="ph-h" data-test="p-holdings">
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

    <section v-if="statsPending" class="card" :aria-label="t('pos.keyStats')" aria-busy="true" data-test="p-stats-skel">
      <div aria-hidden="true" class="pskel p-stats">
        <div v-for="i in 2" :key="`r${i}`" class="prange"><p class="prange__head skel">&nbsp;</p><div class="prange__track" /></div>
        <dl class="pstats">
          <div v-for="i in 5" :key="i" class="pstats__item"><dt class="skel">&nbsp;</dt><dd class="skel">&nbsp;</dd></div>
        </dl>
      </div>
    </section>

    <section v-else-if="hasStats" class="card p-stats" aria-labelledby="pk-h" data-test="p-stats">
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
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { t } from '../i18n.js'
import { fMoney, fPct, fPrice, fQty, tone, n, PERIOD_LABELS } from '../display.js'
import { useApp } from '../composables/useApp.js'
import { usePeriodCore } from '../composables/usePeriodCore.js'
import { localDay } from '../calc/marketTime.js'
import { PERIODS } from '../calc/periods.js'
import { CHART_PERIOD, chartRows, chartSource, rangePos } from '../calc/position.js'
import { whenOf } from '../charts/priceChart.js'
import { DATASET } from '../data/repo.js'
import PriceChart from './PriceChart.vue'

const props = defineProps({
  /** reactive usePosition() result */
  pos: { type: Object, required: true },
  /** chart period code (CHART_PERIOD value) */
  period: { type: String, default: CHART_PERIOD['1d'] },
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
// The price sources have answered (security info and daily candles, data or error) and none is
// in flight: no price now means none to come, so a dash instead of a skeleton.
const priceSettled = computed(() => {
  const s = props.pos.sec
  const done = (part) => (s[part] != null || !!s.errors?.[part]) && !(s.loading || []).includes(part)
  return done('info') && done('daily')
})
const loadError = computed(() => !!props.pos.sec.errors?.info && !props.pos.sec.info)

// --- chart
const intraday = computed(() => chartSource(props.period) === 'intraday')
const rows = computed(() => {
  const s = props.pos.sec
  const today = s.today || localDay(Date.now())
  const list = chartRows(props.period, s, { today, sessions: s.sessions, clock: s.clock })
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

// What the chart area draws: the current dataset, or the last drawn one (dimmed) while the new
// period loads, so the area never collapses.
const last = shallowRef(null)
watch([rows, base, intraday], ([r, b, i]) => {
  if (r.length > 1) last.value = { rows: r, base: b, intraday: i, period: props.period }
}, { immediate: true })
const shown = computed(() => {
  if (rows.value.length > 1) return { rows: rows.value, base: base.value, intraday: intraday.value, period: props.period }
  return chartLoading.value ? last.value : null
})
const chartStale = computed(() => chartLoading.value && rows.value.length <= 1 && !!shown.value)

// --- header change: the period's or the hovered chart point's (Task 44)
const hover = shallowRef(null)
// The chart reports null when the hovered bar is gone after a redraw; it also goes away with the chart.
watch(() => !!shown.value, (on) => { if (!on) hover.value = null })
const posNum = (v) => {
  const x = n(v)
  return x !== null && x > 0 ? x : null
}
/** Base of a period: the first drawable point of its chart (the chart's waterline); unknown -> null. */
const firstClose = (list) => {
  const pts = (list || []).filter((r) => Number.isFinite(r.close))
  return pts.length > 1 ? posNum(pts[0].close) : null
}
/** What the drawn chart measures against: the previous close on 1D, else its first point. */
const baseOf = (d) => (d.period === '1D' ? posNum(d.base) : firstClose(d.rows))
const changeOf = (px, b) => {
  const x = n(px)
  return x !== null && b !== null ? { kind: 'value', change: x - b, pct: (x / b - 1) * 100 } : { kind: 'dash' }
}
const periodName = (p) => (p === '1D' ? '' : t(`pos.per.${p}`))

/** Header change without a pointer: the day change on 1D (as before), else the period change. */
const periodChg = computed(() => {
  const loadingPrice = props.pos.price == null && !priceSettled.value
  if (props.period === '1D') {
    if (props.pos.change != null) return { kind: 'value', change: props.pos.change, pct: props.pos.changePct, label: '' }
    return { kind: loadingPrice ? 'skel' : 'none', label: '' }
  }
  const label = periodName(props.period)
  if (loadingPrice || (chartLoading.value && rows.value.length <= 1)) return { kind: 'skel', label }
  const b = firstClose(rows.value)
  return { ...(b === null ? { kind: 'dash' } : changeOf(props.pos.price, b)), label }
})
const chg = computed(() => {
  const r = hover.value
  const d = shown.value
  if (!r || !d) return periodChg.value
  const b = baseOf(d)
  // The label stays the period's (the status line shows the point's time): no width change, no wrap.
  return { ...(b === null ? { kind: 'dash' } : changeOf(r.close, b)), label: periodName(d.period) }
})
const bigPrice = computed(() => (hover.value && shown.value ? hover.value.close : props.pos.price))
const hoverWhen = computed(() => (hover.value && shown.value ? whenOf(hover.value, shown.value.intraday) : ''))
const chgText = (c) => `${fChange(c.change)} (${fPct(c.pct)})`
// While the pointer is on the chart the price line keeps at least its height: a shorter figure
// does not unwrap it and move the chart under the finger (the label keeps its text, see chg).
const lineEl = ref(null)
const lockH = ref(0)
watch(() => !!hover.value, (on) => { lockH.value = on ? (lineEl.value?.offsetHeight || 0) : 0 }, { flush: 'pre' })
const lineLock = computed(() => (lockH.value ? { minHeight: `${lockH.value}px` } : null))

// Screen readers hear the change once per period switch: live ticks and pointer moves stay silent.
const announced = ref('')
let announcedFor = props.period
watch([() => props.period, periodChg], ([p, c]) => {
  if (p === announcedFor || c.kind === 'skel') return
  announcedFor = p
  announced.value = [c.kind === 'value' ? chgText(c) : c.kind === 'dash' ? '—' : '', c.label].filter(Boolean).join(' ')
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

// Placeholders until the data arrives, so the card has its final layout from the first frame.
const CORE_ERRS = [DATASET.positions, DATASET.trades, DATASET.candles, DATASET.sparks]
const plausible = computed(() => {
  const st = app.state.value
  const tk = ticker.value
  return [st?.positions, st?.trades, st?.rawPs?.pos].some((l) => (l || []).some((r) => (r.ticker ?? r.i) === tk))
})
// Only while the period core is really loading (not on an error), for a held or traded ticker.
const holdingsPending = computed(() => {
  const st = app.state.value
  return !h.value && !core.value && plausible.value && !!st?.loading?.length
    && !CORE_ERRS.some((k) => st.errors?.[k])
})
const nameLoading = computed(() => props.pos.name === ticker.value && !props.pos.sec.info && !loadError.value)

// --- key statistics
const KIND_KEYS = { stock: 'pos.kind.stock', preferred: 'pos.kind.preferred', fund: 'pos.kind.fund', index: 'pos.kind.index' }
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
    // An index without a volume: a dash (the row stays, as on Yahoo); otherwise a missing value hides the row.
    { key: 'volume', v: s.volume ?? (s.kind === 'index' ? 0 : null), text: s.volume == null ? '—' : vol.format(s.volume) },
    { key: 'avgVolume', v: s.avgVolume, text: s.avgVolume == null ? '' : vol.format(s.avgVolume) },
    { key: 'kind', v: s.kind, text: s.kind ? t(KIND_KEYS[s.kind]) : '' },
  ].filter((r) => r.v != null).map((r) => ({ ...r, label: t(`pos.ks.${r.key}`) }))
})
const hasStats = computed(() => ranges.value.length > 0 || statRows.value.length > 0)
const statsPending = computed(() => !hasStats.value && !props.pos.sec.info && !loadError.value)

// --- big price visibility (compact header in the screen's top bar)
const bigEl = ref(null)
let io = null
// Height of the card's sticky bar (PositionScreen .pcard__bar), measured: no copy of its CSS here.
const barHeight = (el) => Math.ceil(el.closest('.pcard')?.querySelector('.pcard__bar')?.getBoundingClientRect().height || 0)
function observe(el) {
  io?.disconnect()
  if (!el || typeof IntersectionObserver === 'undefined') return
  // The sticky top bar covers the page top: the price counts as hidden once under it.
  io ||= new IntersectionObserver((entries) => {
    for (const e of entries) emit('price-visible', e.isIntersecting)
  }, { rootMargin: `-${barHeight(el)}px 0px 0px 0px` })
  io.observe(el)
}
onMounted(() => observe(bigEl.value))
watch(bigEl, (el) => observe(el))
onBeforeUnmount(() => io?.disconnect())
</script>
