// News feed of one ticker for the position card: English first, Russian when there is no English
// news at all; cached page first, then the broker; "Load more" pages by skip += NEWS_TAKE.
import { reactive, watch } from 'vue'
import { useApp } from './useApp.js'
import { NEWS_TAKE } from '../data/news.js'
import { mergeItems, hasMore } from '../calc/news.js'

const LANGS = ['en', 'ru']
const isEmpty = (d) => !d || (!d.total && !(d.list && d.list.length))
const msg = (e) => (e && e.message) || String(e)

/**
 * feed: {status: 'waiting' | 'loading' | 'ready' | 'error', items, total, lang, stale, error,
 *        more, loadingMore, moreError}
 */
export function useNews(ticker) {
  const app = useApp()
  const store = () => app.news?.() || null
  const feed = reactive({
    status: 'waiting', items: [], total: null, lang: 'en', stale: false, error: '', more: false, loadingMore: false, moreError: '',
  })
  let next = 0
  let gen = 0

  function show(data, lang) {
    const { items, added } = mergeItems([], data.list)
    Object.assign(feed, { items, total: data.total, lang, moreError: '' })
    next = NEWS_TAKE
    feed.more = hasMore({ total: data.total, skip: 0, got: (data.list || []).length, added, take: NEWS_TAKE })
  }

  async function load(force = false) {
    const s = store()
    if (!s) { feed.status = 'waiting'; return }
    const my = ++gen
    if (!feed.items.length) feed.status = 'loading'
    feed.error = ''
    // A Load more still running belongs to the old generation: its result is dropped, so its
    // flags are reset here (it never clears them itself).
    feed.loadingMore = false
    feed.moreError = ''
    // Cached pages of any age first: no skeleton when the tab is reopened.
    if (!feed.items.length) {
      for (const lang of LANGS) {
        const c = await s.peekList({ ticker, lang, skip: 0 })
        if (my !== gen) return
        if (!c) break
        if (!isEmpty(c)) { show(c, lang); feed.status = 'ready'; break }
      }
    }
    try {
      let r = null
      let lang = LANGS[0]
      for (lang of LANGS) {
        r = await s.list({ ticker, lang, skip: 0, force })
        if (my !== gen) return
        if (!isEmpty(r.data)) break
      }
      show(r.data, lang)
      feed.stale = !!r.stale
      feed.error = r.error ? msg(r.error) : ''
      feed.status = 'ready'
    } catch (e) {
      if (my !== gen) return
      feed.error = msg(e)
      if (feed.items.length) { feed.stale = true; feed.status = 'ready' } else feed.status = 'error'
    }
  }

  async function loadMore() {
    const s = store()
    if (!s || feed.loadingMore || !feed.more) return
    const my = gen
    const skip = next
    feed.loadingMore = true
    feed.moreError = ''
    try {
      const r = await s.list({ ticker, lang: feed.lang, skip })
      if (my !== gen) return
      const { items, added } = mergeItems(feed.items, r.data.list)
      feed.items = items
      if (Number.isFinite(r.data.total)) feed.total = r.data.total
      next = skip + NEWS_TAKE
      feed.more = hasMore({ total: feed.total, skip, got: (r.data.list || []).length, added, take: NEWS_TAKE })
    } catch {
      if (my === gen) feed.moreError = 'error'
    } finally {
      if (my === gen) feed.loadingMore = false
    }
  }

  // Deep link at start-up: the account (and its news cache) attaches after the card mounts.
  watch(() => !!app.state?.value && !!store(), (ready) => { if (ready && feed.status === 'waiting') load() })

  return { feed, load, loadMore, store }
}
