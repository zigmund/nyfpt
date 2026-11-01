<!-- Settings: cards of the markets strip. Rename, move up / down, remove (buttons, keyboard friendly),
     add from the broker search (tickerFinder, debounced, stale answers ignored), reset to default.
     Saved in prefs.marketStrip through app.setMarketStrip. -->
<template>
  <section ref="root" class="card" aria-labelledby="set-strip" data-test="strip-ed">
    <h2 id="set-strip" class="label">{{ t('settings.strip') }}</h2>
    <p class="card__hint">{{ t('settings.stripHint', { max: MARKET_STRIP_MAX }) }}</p>

    <ol v-if="items.length" class="sed__list">
      <li v-for="(m, i) in items" :key="m.ticker" class="sed__item" data-test="strip-item">
        <span class="sed__text">
          <input
            class="input sed__label" type="text" :value="m.label" maxlength="60" autocomplete="off"
            :aria-label="t('settings.stripLabelFor', { ticker: m.ticker })" data-test="strip-label"
            @change="rename(i, $event)"
          >
          <span class="sed__ticker num">{{ m.ticker }}</span>
        </span>
        <span class="sed__btns">
          <button
            type="button" class="icon-btn" data-act="up" :disabled="i === 0"
            :aria-label="t('settings.stripUp', { label: m.label })" :title="t('settings.stripUp', { label: m.label })"
            data-test="strip-up" @click="move(i, -1)"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <button
            type="button" class="icon-btn" data-act="down" :disabled="i === items.length - 1"
            :aria-label="t('settings.stripDown', { label: m.label })" :title="t('settings.stripDown', { label: m.label })"
            data-test="strip-down" @click="move(i, 1)"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <button
            type="button" class="icon-btn" data-act="remove"
            :aria-label="t('settings.stripRemove', { label: m.label })" :title="t('settings.stripRemove', { label: m.label })"
            data-test="strip-remove" @click="remove(i)"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          </button>
        </span>
      </li>
    </ol>
    <p v-else class="card__hint" data-test="strip-empty">{{ t('settings.stripEmpty') }}</p>

    <div class="field">
      <label class="field__label" for="strip-search">{{ t('settings.stripAdd') }}</label>
      <input
        id="strip-search" ref="search" v-model="query" class="input" type="search" autocomplete="off"
        spellcheck="false" :placeholder="t('settings.stripSearch')" data-test="strip-search"
      >
      <span v-if="full" class="field__hint" data-test="strip-limit">{{ t('settings.stripLimit', { max: MARKET_STRIP_MAX }) }}</span>
    </div>
    <p class="sed__status" role="status" data-test="strip-search-status">{{ status }}</p>
    <ul v-if="results.length" class="sed__results" :aria-label="t('settings.stripResults')">
      <li v-for="r in results" :key="r.ticker">
        <button type="button" class="sed__result" :disabled="full || has(r.ticker)" data-test="strip-result" @click="add(r)">
          <span class="sed__rname">{{ r.name }}</span>
          <span class="sed__rmeta num">{{ r.market ? `${r.ticker} · ${r.market}` : r.ticker }}</span>
          <span v-if="has(r.ticker)" class="sed__rtag">{{ t('settings.stripAdded') }}</span>
        </button>
      </li>
    </ul>

    <div class="row">
      <button type="button" class="btn" :disabled="isDefault" data-test="strip-reset" @click="reset">{{ t('settings.stripReset') }}</button>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n.js'
import { MARKET_STRIP_MAX } from '../config.js'
import { useApp } from '../composables/useApp.js'

const SEARCH_MS = 300

const app = useApp()
const root = ref(null)
const search = ref(null)

const items = computed(() => app.marketStrip.value)
const isDefault = computed(() => app.prefs.marketStrip == null)
const full = computed(() => items.value.length >= MARKET_STRIP_MAX)
const has = (ticker) => items.value.some((m) => m.ticker === ticker)

const save = (list) => app.setMarketStrip(list)

// Focus the `act` button of card `i` (or the nearest one; the search field when no card is left):
// moved or removed cards must not drop keyboard focus.
function focusCard(i, act) {
  nextTick(() => {
    const rows = root.value?.querySelectorAll('[data-test="strip-item"]') || []
    if (!rows.length) { search.value?.focus(); return }
    const li = rows[Math.min(i, rows.length - 1)]
    const btn = li.querySelector(`[data-act="${act}"]:not(:disabled)`) || li.querySelector('[data-act="remove"]')
    btn?.focus()
  })
}

function move(i, d) {
  const j = i + d
  if (j < 0 || j >= items.value.length) return
  const list = items.value.map((m) => ({ ...m }))
  ;[list[i], list[j]] = [list[j], list[i]]
  save(list)
  focusCard(j, d < 0 ? 'up' : 'down')
}

function remove(i) {
  save(items.value.filter((_, k) => k !== i))
  focusCard(i, 'remove')
}

function rename(i, e) {
  const label = String(e.target.value || '').trim()
  if (!label) { e.target.value = items.value[i].label; return }
  save(items.value.map((m, k) => (k === i ? { ...m, label } : { ...m })))
}

// Note: the broker's code_nm (the ticker without its suffix, e.g. DIA, NVDA_KZ), else the ticker with
// its market suffix stripped, like the default cards (USO.US -> USO).
const noteOf = (r) => r.code || r.ticker.replace(/\.[^.]+$/, '') || r.ticker

function add(r) {
  if (full.value || has(r.ticker)) return
  save([...items.value, { ticker: r.ticker, label: r.name || r.ticker, note: noteOf(r) }])
}

function reset() {
  save(null)
}

// --- search: debounced; an answer to an older text is dropped
const query = ref('')
const results = ref([])
const status = ref('')
let timer = null
let seq = 0

watch(query, (v) => {
  clearTimeout(timer)
  const my = ++seq
  const text = String(v || '').trim()
  if (!text) { results.value = []; status.value = ''; return }
  timer = setTimeout(async () => {
    status.value = t('settings.stripSearching')
    try {
      const found = await app.findTickers(text)
      if (my !== seq) return
      results.value = found
      status.value = found.length ? '' : t('settings.stripNone')
    } catch {
      if (my !== seq) return
      results.value = []
      status.value = t('settings.stripFailed')
    }
  }, SEARCH_MS)
})

onBeforeUnmount(() => { clearTimeout(timer); seq++ })
</script>
