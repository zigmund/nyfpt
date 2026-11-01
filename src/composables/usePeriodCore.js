// computeCore for the selected period, shared by the main and compare screens.
// While a new period loads (coreFor -> null) the last result stays visible with `stale` = true;
// with nothing to show yet `core` is null and the UI renders skeletons.
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useApp, periodOf } from './useApp.js'
import { localDay } from '../calc/marketTime.js'

export { periodOf }

const CLOCK_MS = 60e3

/** Tickers that need closes: current positions and traded tickers (currency pairs skipped). */
export const pricedTickersKey = (st) => [...new Set([
  ...(st?.positions || []).filter((r) => r.kind === 'position').map((r) => r.ticker),
  ...(st?.trades || []).map((r) => r.ticker),
])].filter((t) => t && !String(t).includes('/')).sort().join(',')

/**
 * `period` fixes the period instead of prefs.period; `fetch: false` never calls ensurePrices
 * (the core is computed only from what the selected period already loaded).
 */
export function usePeriodCore({ now = () => Date.now(), period: fixed = null, fetch = true } = {}) {
  const app = useApp()
  const { state, tick, prefs } = app

  const period = computed(() => fixed || periodOf(prefs))

  // US trading date (repo: market clock from the broker), checked on a clock, on repo / live
  // updates (the market clock may arrive later) and when the app becomes visible again (resumed PWA).
  const dayOf = (ms) => (app.today ? app.today(ms) : localDay(ms))
  const day = ref(dayOf(now()))
  const checkDay = () => { day.value = dayOf(now()) }
  watch(tick, checkDay)
  const clock = setInterval(checkDay, CLOCK_MS)
  const doc = globalThis.document
  const onVisible = () => { if (!doc.hidden) checkDay() }
  doc?.addEventListener('visibilitychange', onVisible)
  onScopeDispose(() => {
    clearInterval(clock)
    doc?.removeEventListener('visibilitychange', onVisible)
  })

  // tick: repo emits and live updates (quotes) -> recompute; day: coreFor's default date moved.
  const fresh = computed(() => {
    void tick.value
    void day.value
    return state.value ? app.coreFor(period.value) : null
  })
  const last = shallowRef(null)
  const ready = computed(() => !!state.value)
  const tickers = computed(() => pricedTickersKey(state.value))

  function ensure() {
    if (fetch && ready.value) Promise.resolve(app.ensurePrices(period.value)).catch(() => {})
  }

  // Covered -> not covered for the same period (cache dropped, new data arrived): fetch once.
  // Not keyed on tick: an offline failure emits again and would loop.
  let freshPeriod = null
  watch(fresh, (c, prev) => {
    if (c) last.value = c
    else if (prev && freshPeriod === period.value) ensure()
    freshPeriod = period.value
  }, { immediate: true })
  watch(() => state.value, (s) => { if (!s) last.value = null })

  const core = computed(() => fresh.value || last.value)
  const stale = computed(() => !fresh.value && !!last.value)

  // Load closes on mount, period change, account attach, a new priced ticker, a new NY date.
  watch([period, ready, tickers, day], ensure, { immediate: true })

  return { core, stale, period }
}
