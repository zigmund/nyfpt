// Broker instrument search shared by the search sheet and the strip editor: the text is debounced
// and an answer to an older text is dropped. Plus pure helpers for the result rows.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n.js'

export const SEARCH_MS = 300

/**
 * `find(text)` -> Promise<rows> (app.findTickers). Returns
 *   query    Ref<string>  bound to the input
 *   text     ComputedRef<string>  the trimmed query
 *   results  Ref<rows>    rows of the latest answer ([] for an empty query)
 *   state    Ref<'' | 'busy' | 'none' | 'failed'>
 *   settled  ComputedRef<boolean>  `results` answer the current text (nothing pending or debouncing)
 *   status   ComputedRef<string>  `state` as text for a live region
 */
export function useTickerSearch(find) {
  const query = ref('')
  const results = ref([])
  const state = ref('')
  const answered = ref('') // text the current `results` answer
  let timer = null
  let seq = 0

  watch(query, (v) => {
    clearTimeout(timer)
    const my = ++seq
    const text = String(v || '').trim()
    if (!text) { results.value = []; state.value = ''; answered.value = ''; return }
    timer = setTimeout(async () => {
      state.value = 'busy'
      try {
        const found = await find(text)
        if (my !== seq) return
        results.value = found
        answered.value = text
        state.value = found.length ? '' : 'none'
      } catch {
        if (my !== seq) return
        results.value = []
        answered.value = text
        state.value = 'failed'
      }
    }, SEARCH_MS)
  })

  onBeforeUnmount(() => { clearTimeout(timer); seq++ })

  const text = computed(() => String(query.value || '').trim())
  return {
    query,
    text,
    settled: computed(() => state.value !== 'busy' && answered.value === text.value),
    results,
    state,
    status: computed(() => (state.value ? t(`search.${state.value}`) : '')),
  }
}

const fold = (s) => String(s ?? '').toLowerCase()

/** `text` split around the first case-insensitive occurrence of `q`: [{text, hit}] (rendered as
 *  text with a <mark>, never as HTML). No match, an empty `q` or a case fold that changes the
 *  length (index mismatch): one part. */
export function splitMatch(text, q) {
  const s = String(text ?? '')
  const needle = fold(q).trim()
  const hay = fold(s)
  const i = needle && hay.length === s.length ? hay.indexOf(needle) : -1
  if (i < 0) return [{ text: s, hit: false }]
  const j = i + needle.length
  return [
    { text: s.slice(0, i), hit: false },
    { text: s.slice(i, j), hit: true },
    { text: s.slice(j), hit: false },
  ].filter((p) => p.text)
}

/** Recent entries whose ticker, code or name contains `q` (any case); all of them for an empty `q`. */
export function filterRecent(list, q) {
  const needle = fold(q).trim()
  if (!needle) return list
  return list.filter((r) => [r.ticker, r.code, r.name].some((v) => fold(v).includes(needle)))
}
