<!-- Security search: a modal sheet (phone: from the bottom; desktop: a centred panel). The broker search
     (tickerFinder, partial ticker / name, debounced) and Recent (securities opened from here, filtered
     locally while typing). A row: code, type, name, market · currency, price and day change (one batched
     quote request for the rows shown; live quotes win), and a star = the security is in the markets strip
     (held positions show "Held" instead). Tapping a row opens its card. Keyboard: Down / Up move between
     the input and the rows, Enter in the input opens the first row, Esc closes, Tab stays inside.
     Broker strings are text only; the query never goes into the URL. -->
<template>
  <div class="srch" data-test="search">
    <div class="srch__backdrop" aria-hidden="true" data-test="search-backdrop" @click="close" />
    <section ref="panel" class="srch__panel" role="dialog" aria-modal="true" aria-labelledby="srch-title" tabindex="-1">
      <header class="srch__head">
        <h2 id="srch-title" class="srch__title">{{ t('search.title') }}</h2>
        <button
          type="button" class="icon-btn srch__close" :aria-label="t('search.close')" :title="t('search.close')"
          data-test="search-close" @click="close"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </button>
      </header>

      <div class="srch__field">
        <svg class="srch__glass" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" /><path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        <input
          ref="input" v-model="query" class="input srch__input" type="search" enterkeyhint="search"
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="60"
          :aria-label="t('search.label')" :placeholder="t('search.placeholder')" data-test="search-input"
        >
      </div>
      <p class="srch__status" role="status" data-test="search-status">{{ status }}</p>

      <div class="srch__body">
        <section
          v-for="sec in sections" :key="sec.id" class="srch__sec" :aria-labelledby="`srch-${sec.id}`"
          :data-test="`search-${sec.id}`"
        >
          <div class="srch__sechead">
            <h3 :id="`srch-${sec.id}`" class="label" :class="{ vh: sec.id === 'results' && !recentRows.length }">{{ sec.label }}</h3>
            <button
              v-if="sec.id === 'recent' && !text" type="button" class="srch__clear" :aria-label="t('search.clearLabel')"
              data-test="search-clear" @click="clearRecent"
            >{{ t('search.clear') }}</button>
          </div>
          <ul class="srch__list">
            <li v-for="r in sec.rows" :key="r.ticker" class="srow" data-test="search-item">
              <button type="button" class="srow__main" :data-ticker="r.ticker" data-test="search-row" @click="openRow(r)">
                <span class="srow__top">
                  <span class="srow__code num"><template v-for="(p, i) in splitMatch(codeOf(r), text)" :key="i"><mark v-if="p.hit" class="srow__hit">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></span>
                  <span v-if="typeOf(r)" class="srow__type">{{ typeOf(r) }}</span>
                  <span v-if="metaOf(r)" class="srow__meta">{{ metaOf(r) }}</span>
                </span>
                <span class="srow__name"><template v-for="(p, i) in splitMatch(r.name, text)" :key="i"><mark v-if="p.hit" class="srow__hit">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></span>
                <span class="srow__price num">{{ fPrice(priceOf(r.ticker).last) }}</span>
                <span class="srow__chg num" :class="tone(priceOf(r.ticker).change)">{{ fPct(priceOf(r.ticker).change) }}</span>
              </button>
              <span class="srow__side">
                <span v-if="held.has(r.ticker)" class="srow__held" data-test="search-held">{{ t('search.held') }}</span>
                <button
                  v-else type="button" class="srow__star" :class="{ 'srow__star--on': app.inStrip(r.ticker) }"
                  :aria-pressed="app.inStrip(r.ticker) ? 'true' : 'false'"
                  :aria-disabled="starBlocked(r) ? 'true' : null"
                  :aria-label="starLabel(r)" :title="starLabel(r)" data-test="search-star" @click="toggleStar(r)"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>
                </button>
              </span>
            </li>
          </ul>
        </section>
        <p v-if="!sections.length && !text" class="srch__empty card__hint">{{ t('search.empty') }}</p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n.js'
import { MARKET_STRIP_MAX } from '../config.js'
import { fPct, fPrice, n, tone } from '../display.js'
import { tickerCode } from '../store/session.js'
import { positionPath, useApp } from '../composables/useApp.js'
import { filterRecent, splitMatch, useTickerSearch } from '../composables/useTickerSearch.js'

const emit = defineEmits(['close'])

const app = useApp()
const panel = ref(null)
const input = ref(null)

const { query, text, results, status, settled } = useTickerSearch(app.findTickers)

const recentRows = computed(() => filterRecent(app.recent.value, text.value))
// Server rows a recent row already shows are not repeated.
const resultRows = computed(() => {
  if (!text.value) return []
  const shown = new Set(recentRows.value.map((r) => r.ticker))
  return results.value.filter((r) => !shown.has(r.ticker))
})
const sections = computed(() => [
  { id: 'recent', label: t('search.recent'), rows: recentRows.value },
  { id: 'results', label: t('search.results'), rows: resultRows.value },
].filter((s) => s.rows.length))

const codeOf = (r) => tickerCode(r)
// Known instrument types only (a recent entry from storage may carry anything).
const TYPES = new Set(['equity', 'etf', 'bond', 'future', 'index', 'crypto'])
const typeOf = (r) => (TYPES.has(r.type) ? t(`search.type.${r.type}`) : '')
const metaOf = (r) => [r.market, r.currency].filter(Boolean).join(' · ')

// Held: open positions of the account.
const held = computed(() => new Set((app.state.value?.positions || [])
  .filter((p) => p.kind === 'position').map((p) => p.ticker)))

// --- prices: one batched request per set of rows shown (repo memoizes per ticker); live quotes win.
// Only the answer for the latest set is applied (it covers every row shown), never after unmount.
const fetched = ref({})
const shownKey = computed(() => sections.value.flatMap((s) => s.rows.map((r) => r.ticker)).join(','))
let alive = true
let priceSeq = 0
watch(shownKey, async (key) => {
  const my = ++priceSeq
  if (!key) return
  const got = await app.searchQuotes(key.split(','))
  if (!alive || my !== priceSeq) return
  fetched.value = { ...fetched.value, ...got }
}, { immediate: true })
function priceOf(ticker) {
  void app.tick.value // live.quotes is a plain Map: tick marks its updates
  const q = app.live.quotes?.get?.(ticker)
  const f = fetched.value[ticker]
  return { last: n(q?.ltp) ?? f?.last ?? null, change: n(q?.pcp) ?? f?.change ?? null }
}

// --- star: the security is a card of the markets strip
const starBlocked = (r) => !app.inStrip(r.ticker) && app.stripFull.value
const starLabel = (r) => (starBlocked(r)
  ? t('search.starFull', { name: r.name, max: MARKET_STRIP_MAX })
  : t('search.star', { name: r.name }))
function toggleStar(r) {
  if (app.inStrip(r.ticker)) app.removeFromStrip(r.ticker)
  else app.addToStrip(r)
}

function clearRecent() {
  app.clearRecent()
  input.value?.focus()
}

function openRow(r) {
  app.addRecent(r)
  emit('close')
  app.go(positionPath(r.ticker))
}

function close() {
  emit('close')
}

// First row for Enter in the input: Recent rows are filtered locally (always current); server
// results only once they answer the current text.
function firstRow() {
  const sec = sections.value[0]
  if (!sec || (sec.id === 'results' && !settled.value)) return null
  return sec.rows[0] || null
}

// --- keyboard (on the document while open: the trap holds even when focus fell to <body>)
const rowButtons = () => [...(panel.value?.querySelectorAll('[data-test="search-row"]') || [])]
function focusables() {
  return [...(panel.value?.querySelectorAll('button, input, [href]') || [])]
    .filter((el) => !el.disabled && el.getAttribute('tabindex') !== '-1')
}
const inside = (el) => !!el && !!panel.value?.contains(el)
function onKey(e) {
  if (e.isComposing) return // IME: Enter / Esc belong to the composition
  if (e.key === 'Escape') { e.preventDefault(); close(); return }
  if (e.key === 'Tab') {
    const list = focusables()
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    const at = document.activeElement
    if (!inside(at) || at === panel.value) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
    else if (e.shiftKey && at === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus() }
    return
  }
  if (!inside(e.target)) return
  const onInput = e.target === input.value
  if (e.key === 'Enter' && onInput) {
    e.preventDefault()
    const first = firstRow()
    if (first) openRow(first)
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const rowsEls = rowButtons()
  // From a star: the row it belongs to.
  const from = onInput ? -1 : rowsEls.indexOf(e.target.closest?.('[data-test="search-item"]')?.querySelector('[data-test="search-row"]'))
  if (!onInput && from < 0) return
  e.preventDefault()
  const to = from + (e.key === 'ArrowDown' ? 1 : -1)
  if (to < 0) input.value?.focus()
  else rowsEls[Math.min(to, rowsEls.length - 1)]?.focus()
}

// Focus that lands outside the dialog (a background control) comes back to the input.
function onFocusIn(e) {
  if (!inside(e.target)) input.value?.focus()
}
// Session expired: the login overlay takes over (outside this dialog), so the sheet closes.
watch(() => app.expired.value, (x) => { if (x) close() }, { immediate: true })

// --- open: focus the input; the page behind does not scroll
onMounted(() => {
  document.documentElement.classList.add('srch-open')
  document.addEventListener('keydown', onKey)
  document.addEventListener('focusin', onFocusIn)
  nextTick(() => input.value?.focus())
})
onBeforeUnmount(() => {
  alive = false
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('focusin', onFocusIn)
  document.documentElement.classList.remove('srch-open')
})
</script>
