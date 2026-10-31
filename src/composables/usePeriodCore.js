// computeCore for the selected period, shared by the main and compare screens.
// While a new period loads (coreFor -> null) the last result stays visible with `stale` = true;
// with nothing to show yet `core` is null and the UI renders skeletons.
import { computed, shallowRef, watch } from 'vue'
import { useApp } from './useApp.js'
import { PERIODS } from '../calc/periods.js'

/** Selected period from prefs; unknown values fall back to YTD. */
export const periodOf = (prefs) => (PERIODS.includes(prefs.period) ? prefs.period : 'YTD')

export function usePeriodCore() {
  const app = useApp()
  const { state, tick, prefs } = app

  const period = computed(() => periodOf(prefs))

  // tick: repo emits and live updates (quotes) -> recompute.
  const fresh = computed(() => {
    void tick.value
    return state.value ? app.coreFor(period.value) : null
  })
  const last = shallowRef(null)
  watch(fresh, (c) => { if (c) last.value = c }, { immediate: true })
  watch(() => state.value, (s) => { if (!s) last.value = null })

  const core = computed(() => fresh.value || last.value)
  const stale = computed(() => !fresh.value && !!last.value)

  // Load closes for the period on mount, on period change, and once an account is attached.
  watch([period, () => !!state.value], ([period, ready]) => {
    if (ready) Promise.resolve(app.ensurePrices(period)).catch(() => {})
  }, { immediate: true })

  return { core, stale, period }
}
