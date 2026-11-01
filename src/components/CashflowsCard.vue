<!-- Cash flows for the period: a disclosure inside the value card (collapsed by default; the open
     state is remembered in prefs.flowsOpen). Reuses the Contributions toggle/body styling. -->
<template>
  <div class="flows-block" data-test="flows">
    <button
      type="button"
      class="contrib__toggle"
      :class="{ 'is-open': open }"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="id"
      data-test="flows-toggle"
      @click="prefs.flowsOpen = !open"
    >
      <span>{{ t('flows.title') }}</span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    <div v-if="open" :id="id" class="contrib__body">
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
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
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
const id = `flows-${Math.random().toString(36).slice(2, 8)}`
const open = computed(() => prefs.flowsOpen === true)
const count = (v) => (n(v) === null ? DASH : String(n(v)))
</script>
