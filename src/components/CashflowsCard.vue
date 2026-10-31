<!-- Cash flows for the period: deposits, income, taxes, commissions, trades, start/end value. -->
<template>
  <section class="card" aria-labelledby="flows-h" data-test="flows">
    <h2 id="flows-h" class="label">{{ t('flows.title') }}</h2>
    <p class="card__hint">{{ t('flows.note') }}</p>
    <dl v-if="summary" class="kv flows num" :class="{ 'is-stale': stale }">
      <template v-for="f in FIELDS" :key="f.key">
        <dt>{{ t(`flows.${f.key}`) }}</dt>
        <dd>{{ f.count ? count(summary[f.key]) : fMoney(summary[f.key], { hide: prefs.hide, sign: f.sign }) }}</dd>
      </template>
    </dl>
    <dl v-else class="kv flows" aria-hidden="true">
      <template v-for="f in FIELDS" :key="f.key">
        <dt>{{ t(`flows.${f.key}`) }}</dt>
        <dd><span class="skel skel--inline">&nbsp;</span></dd>
      </template>
    </dl>
  </section>
</template>

<script setup>
import { t } from '../i18n.js'
import { fMoney, n, DASH } from '../display.js'
import { useApp } from '../composables/useApp.js'

defineProps({
  summary: { type: Object, default: null },
  stale: { type: Boolean, default: false },
})

const FIELDS = [
  { key: 'deposits', sign: true },
  { key: 'income', sign: true },
  { key: 'taxes', sign: true },
  { key: 'commissions', sign: true },
  { key: 'trades', count: true },
  { key: 'value_start' },
  { key: 'value_end' },
]

const { prefs } = useApp()
const count = (v) => (n(v) === null ? DASH : String(n(v)))
</script>
