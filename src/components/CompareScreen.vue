<!-- Compare with indices: shared period, summary line, 4 tiles, cumulative return chart. -->
<template>
  <div class="screen">
    <header class="topbar">
      <button type="button" class="icon-btn" :aria-label="t('nav.back')" data-test="back" @click="app.go('/')">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <h1 class="topbar__title">{{ t('main.compare') }}</h1>
    </header>

    <PeriodPicker />

    <template v-if="s">
      <p class="lede" :class="{ 'is-stale': stale }" data-test="lede">
        <template v-for="(p, i) in lede" :key="i">
          <b v-if="p.var" :class="p.cls">{{ p.text }}</b>
          <template v-else>{{ p.text }}</template>
        </template>
      </p>
      <div class="tiles" :class="{ 'is-stale': stale }">
        <div v-for="tile in tiles" :key="tile.key" class="card tile" :data-test="`tile-${tile.key}`">
          <p class="label">{{ tile.label }}</p>
          <p class="tile__big num" :class="tile.cls">{{ tile.big }}</p>
          <p class="card__hint">{{ tile.subLabel }} <span class="num" :class="tile.subCls">{{ tile.sub }}</span></p>
        </div>
      </div>
    </template>
    <template v-else>
      <p class="lede skel" aria-hidden="true">&nbsp;</p>
      <div class="tiles" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="card tile"><p class="tile__big skel">&nbsp;</p></div>
      </div>
    </template>

    <section class="card cmp-card" aria-labelledby="cmp-h">
      <h2 id="cmp-h" class="label">{{ t('compare.chartTitle') }}</h2>
      <p class="card__hint">{{ t('compare.chartNote') }}</p>
      <ul class="legend">
        <li v-for="(l, i) in LABELS" :key="l"><i class="legend__sw" :class="SERIES[i].cls" aria-hidden="true" />{{ l }}</li>
      </ul>
      <div v-if="s" ref="el" class="cchart" :class="{ 'is-stale': stale }" role="img" :aria-label="t('compare.chartTitle')" />
      <div v-else class="cchart skel" aria-hidden="true" />
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { t } from '../i18n.js'
import { dateShort } from '../format.js'
import { fMoney, fPct, fPp, tone } from '../display.js'
import { useApp } from '../composables/useApp.js'
import { usePeriodCore } from '../composables/usePeriodCore.js'
import { useChart, seriesKey } from '../composables/useChart.js'
import { drawCompareChart, SERIES } from '../charts/compareChart.js'
import PeriodPicker from './PeriodPicker.vue'

const app = useApp()
const { prefs } = app
const { core, stale } = usePeriodCore()
const s = computed(() => core.value?.summary || null)
const LABELS = [t('compare.portfolio'), t('compare.spy'), t('compare.qqq')]

// "From {start} to {end}: portfolio {twr}, ..." with the values in bold.
const lede = computed(() => {
  const v = {
    start: { text: dateShort(s.value.base_close) },
    end: { text: dateShort(s.value.end) },
    twr: { text: fPct(s.value.twr), cls: tone(s.value.twr) },
    spy: { text: fPct(s.value.spy), cls: tone(s.value.spy) },
    qqq: { text: fPct(s.value.qqq), cls: tone(s.value.qqq) },
  }
  return t('compare.lede').split(/(\{\w+\})/).filter(Boolean).map((part) => {
    const k = part.match(/^\{(\w+)\}$/)?.[1]
    return k && v[k] ? { var: true, ...v[k] } : { text: part }
  })
})

const tiles = computed(() => {
  const x = s.value
  const hide = prefs.hide
  return [
    { key: 'twr', label: t('compare.tileTwr'), big: fPct(x.twr), cls: tone(x.twr), subLabel: t('compare.value'), sub: fMoney(x.value_end, { hide }) },
    { key: 'spy', label: t('compare.tileSpy'), big: fPct(x.spy), cls: tone(x.spy), subLabel: t('compare.vs'), sub: fPp(x.vs_spy), subCls: tone(x.vs_spy) },
    { key: 'qqq', label: t('compare.tileQqq'), big: fPct(x.qqq), cls: tone(x.qqq), subLabel: t('compare.vs'), sub: fPp(x.vs_qqq), subCls: tone(x.vs_qqq) },
    { key: 'pnl', label: t('compare.tilePnl'), big: fMoney(x.pnl, { hide, sign: true }), cls: tone(x.pnl), subLabel: t('compare.deposits'), sub: fMoney(x.deposits, { hide, sign: true }) },
  ]
})

const el = ref(null)
// The tooltip's date survives redraws on live recalcs (shown again while the date exists).
let hoverDate = null
useChart(el, () => seriesKey(core.value?.series), (node) => drawCompareChart(node, core.value?.series, {
  labels: LABELS,
  hide: () => prefs.hide,
  hoverDate,
  onHover: (d) => { hoverDate = d },
}))
</script>
