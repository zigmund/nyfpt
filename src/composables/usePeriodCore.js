// computeCore for the selected period, shared by the main and compare screens.
// While a new period loads (coreFor -> null) the last result stays visible with `stale` = true;
// with nothing to show yet `core` is null and the UI renders skeletons.
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useApp } from './useApp.js'
import { PERIODS } from '../calc/periods.js'
import { nyDate } from '../data/repo.js'

const CLOCK_MS = 60e3

/** Selected period from prefs; unknown values fall back to YTD. */
export const periodOf = (prefs) => (PERIODS.includes(prefs.period) ? prefs.period : 'YTD')

/** Tickers that need closes: current positions and traded tickers (currency pairs skipped). */
export const pricedTickersKey = (st) => [...new Set([
  ...(st?.positions || []).filter((r) => r.kind === 'position').map((r) => r.ticker),
  ...(st?.trades || []).map((r) => r.ticker),
])].filter((t) => t && !String(t).includes('/')).sort().join(',')

export function usePeriodCore({ now = () => Date.now() } = {}) {
  const app = useApp()
  const { state, tick, prefs } = app

  const period = computed(() => periodOf(prefs))

  // NY trading date, checked on a clock and when the app becomes visible again (resumed PWA).
  const day = ref(nyDate(now()))
  const checkDay = () => { day.value = nyDate(now()) }
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
    if (ready.value) Promise.resolve(app.ensurePrices(period.value)).catch(() => {})
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
