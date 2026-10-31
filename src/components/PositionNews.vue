<!-- Position card, News tab: the ticker's news list (cache first, English then Russian, Load more)
     and one article (#/position/<ticker>/news/<id>). The list stays mounted under the article, so
     its state and scroll position survive. Broker text only through interpolation; the article
     body through NewsBody (whitelist tree, no raw HTML). No images (CSP). -->
<template>
  <div class="pnews" data-test="news">
    <section
      v-show="!item"
      class="pnews__list"
      :aria-label="t('news.list')"
      :aria-busy="feed.status === 'loading' || feed.status === 'waiting' ? 'true' : 'false'"
      data-test="news-list"
    >
      <p v-if="feed.stale" class="banner" role="status" data-test="news-stale">
        {{ t('news.stale') }}
        <button type="button" class="link" @click="load(true)">{{ t('error.retry') }}</button>
      </p>
      <p v-if="feed.lang === 'ru' && feed.items.length" class="card__hint" data-test="news-ru">{{ t('news.ruOnly') }}</p>

      <template v-if="feed.status === 'loading' || feed.status === 'waiting'">
        <p class="vh" role="status">{{ t('news.loading') }}</p>
        <div v-for="i in 4" :key="i" class="card nitem" aria-hidden="true" data-test="news-skel">
          <p class="nitem__meta skel">&nbsp;</p>
          <p class="nitem__title skel nitem__skel-title">&nbsp;</p>
          <p class="nitem__tks skel nitem__skel-tks">&nbsp;</p>
        </div>
      </template>
      <p v-else-if="feed.status === 'error'" class="banner" role="alert" data-test="news-error">
        {{ t('news.error') }}
        <button type="button" class="link" data-test="news-retry" @click="load(true)">{{ t('error.retry') }}</button>
      </p>
      <p v-else-if="!feed.items.length" class="card card__hint" data-test="news-empty">{{ t('news.empty') }}</p>
      <ul v-else class="nlist">
        <li v-for="x in rows" :key="x.key" class="card nitem" data-test="news-item">
          <p class="nitem__meta" data-test="news-meta">
            <span>{{ x.provider }}</span><template v-if="x.time"><span v-if="x.provider"> · </span><time :datetime="x.time.iso" :title="x.time.full">{{ x.time.ago }}</time></template><span v-else-if="x.date">{{ x.provider ? ' · ' : '' }}{{ x.date }}</span>
          </p>
          <a class="nitem__link" :href="`#${x.path}`" @click.prevent="emit('open', x.id)">
            <h3 class="nitem__title" data-test="news-title">{{ x.title }}</h3>
          </a>
          <p v-if="x.sentiment" class="nsent" :class="`nsent--${x.sentiment}`" data-test="news-sent">{{ t(`news.sentiment.${x.sentiment}`) }}</p>
          <ul v-if="x.tickers.length" class="nitem__tks" :aria-label="t('news.related')">
            <li v-for="tk in x.tickers" :key="tk.ticker" class="ntk" data-test="news-tk">
              <span>{{ tk.ticker }}</span> <span v-if="tk.chg !== null" class="num" :class="tone(tk.chg)">{{ fPct(tk.chg) }}</span>
            </li>
          </ul>
        </li>
      </ul>

      <template v-if="feed.status === 'ready' && feed.items.length">
        <p v-if="feed.moreError" class="warn" role="status" data-test="news-more-error">{{ t('news.moreError') }}</p>
        <button
          v-if="feed.more"
          type="button"
          class="btn btn--block"
          :disabled="feed.loadingMore"
          :aria-busy="feed.loadingMore ? 'true' : 'false'"
          data-test="news-more"
          @click="loadMore"
        >{{ feed.loadingMore ? t('main.loading') : t('news.more') }}</button>
      </template>
    </section>

    <article v-if="item" class="card narticle" :aria-busy="art.loading ? 'true' : 'false'" data-test="news-article">
      <button type="button" class="link narticle__back" data-test="news-back" @click="emit('close')">‹ {{ t('news.back') }}</button>
      <h2 v-if="head.title" class="narticle__title">{{ head.title }}</h2>
      <h2 v-else class="narticle__title skel" aria-hidden="true">&nbsp;</h2>
      <p class="nitem__meta" data-test="news-meta">
        <span>{{ head.provider }}</span><template v-if="head.time"><span v-if="head.provider"> · </span><time :datetime="head.time.iso" :title="head.time.full">{{ head.time.ago }}</time></template>
      </p>
      <p v-if="head.time" class="card__hint" data-test="news-full-time">{{ head.time.full }}</p>
      <div v-if="!art.data && art.loading" class="narticle__skel" aria-hidden="true" data-test="news-body-skel">
        <p v-for="i in 6" :key="i" class="skel">&nbsp;</p>
      </div>
      <p v-else-if="!art.data && art.error" class="banner" role="alert" data-test="news-article-error">
        {{ t('news.articleError') }}
        <button type="button" class="link" @click="loadArticle(true)">{{ t('error.retry') }}</button>
      </p>
      <template v-else-if="art.data">
        <NewsBody v-if="hasText" :text="art.data.text" />
        <p v-else class="card__hint">{{ t('news.noText') }}</p>
      </template>
      <a v-if="source" class="link narticle__src" :href="source" target="_blank" rel="noopener noreferrer" data-test="news-source">{{ t('news.source') }}</a>
    </article>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { t } from '../i18n.js'
import { fPct, tone, n } from '../display.js'
import { useApp, positionPath } from '../composables/useApp.js'
import { useNews } from '../composables/useNews.js'
import { newsOffset, newsTime, sentimentOf, httpsUrl, relatedTickers } from '../calc/news.js'
import NewsBody from './NewsBody.vue'

const props = defineProps({
  ticker: { type: String, required: true },
  item: { type: String, default: null },
  /** Server offset of the market clock (s); the fallback zone of the news times. */
  clockOffset: { type: Number, default: null },
})
const emit = defineEmits(['open', 'close'])

const app = useApp()
const { feed, load, loadMore, store } = useNews(props.ticker)

// Relative times move on; one tick a minute.
const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 60e3) })
onUnmounted(() => clearInterval(timer))

const learned = ref(null) // zone seen in an article (getNewsDetail timeZone)
const timeOf = (x, date) => newsTime(date, newsOffset(x, { learned: learned.value, clock: props.clockOffset }), now.value)

/** Day change % from a cached quote (live stream) or the broker position; null when unknown. */
function changeOf(tk) {
  void app.tick?.value
  const q = app.live?.quotes?.get?.(tk)
  if (q) {
    const l = n(q.ltp)
    const pp = n(q.pp)
    if (l !== null && pp) return ((l - pp) / pp) * 100
    if (n(q.pcp) !== null) return n(q.pcp)
  }
  const p = (app.state?.value?.rawPs?.pos || []).find((x) => x.i === tk)
  const l = n(p?.mkt_price)
  const c = n(p?.close_price)
  return l !== null && c ? ((l - c) / c) * 100 : null
}

const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

const rows = computed(() => feed.items.map((x) => ({
  id: String(x.id),
  key: String(x.id),
  title: str(x.title),
  provider: str(x.provider),
  date: str(x.date),
  time: timeOf(x, x.date),
  path: positionPath(props.ticker, 'news', String(x.id)),
  sentiment: sentimentOf(x.sentiment),
  tickers: relatedTickers(x.tickers).map((tk) => ({ ticker: tk, chg: changeOf(tk) })),
})))

// --- article
const art = reactive({ id: null, data: null, loading: false, error: '' })
let artGen = 0
async function loadArticle(force = false) {
  const id = props.item
  const s = store()
  const my = ++artGen
  if (!id) return
  if (art.id !== id) Object.assign(art, { id, data: null, error: '' })
  if (!s) { art.loading = true; return }
  art.loading = true
  art.error = ''
  try {
    if (!art.data) {
      const c = await s.peekDetail(id)
      if (my !== artGen) return
      if (c) art.data = c
    }
    const r = await s.detail(id, { force })
    if (my !== artGen) return
    art.data = r.data
  } catch (e) {
    if (my === artGen) art.error = (e && e.message) || String(e)
  } finally {
    if (my === artGen) {
      art.loading = false
      learned.value = s.learnedOffset?.() ?? learned.value
    }
  }
}

const listItem = computed(() => feed.items.find((x) => String(x.id) === props.item) || null)
const head = computed(() => {
  const d = art.data || listItem.value || {}
  return { title: str(d.title), provider: str(d.provider), time: timeOf(d, d.dateTime || d.date) }
})
const hasText = computed(() => typeof art.data?.text === 'string' && art.data.text.trim() !== '')
const source = computed(() => httpsUrl((art.data || listItem.value || {}).url))

// Article opened over the list: remember where the list was; back: return there.
let listScroll = 0
const win = globalThis.window
watch(() => props.item, (id, old) => {
  if (id && !old) {
    listScroll = win?.scrollY || 0
    nextTick(() => win?.scrollTo?.(0, 0))
  } else if (!id && old) {
    nextTick(() => win?.scrollTo?.(0, listScroll))
  }
  if (id) loadArticle()
})

// Deep link at start-up: the news cache appears once the account attaches.
watch(() => !!app.state?.value && !!store(), (ready) => {
  if (ready && props.item && !art.data && !art.error) loadArticle()
})

onMounted(() => {
  load()
  if (props.item) loadArticle()
})
</script>
