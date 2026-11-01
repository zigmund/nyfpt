// News cache over getNewsList / getNewsDetail (SID calls), in the account's kv store:
//   news:list:<ticker>:<lang>:<skip>   {list, total}   TTL 10 min (liquid tickers get ~5 a day)
//   news:detail:<id>                   broker answer   TTL 24 h (articles do not change after release)
//   news:index                         {key: savedAt}  for evicting the oldest rows beyond the caps
// Only broker answers are stored, never the SID. Logout erases the account partition
// (AccountDb.clear), news included.
import { SessionExpiredError } from '../api/transport.js'
import { parseOffset } from '../calc/news.js'

export const NEWS_TTL = { list: 10 * 60e3, detail: 24 * 3600e3 }
export const NEWS_TAKE = 20
const CAPS = { list: 100, detail: 200 }
const INDEX = 'news:index'

const listKey = ({ ticker, lang, skip }) => `news:list:${ticker}:${lang}:${skip}`
const detailKey = (id) => `news:detail:${id}`
const kindOf = (key) => (key.startsWith('news:detail:') ? 'detail' : 'list')

function normList(a) {
  const total = a && a.total !== null && a.total !== undefined && a.total !== '' ? Number(a.total) : NaN
  const list = a && Array.isArray(a.list) ? a.list : []
  return { list, total: Number.isFinite(total) ? total : list.length }
}

/**
 * @param {{broker, db, now?, onExpired?: () => void, caps?: {list, detail}}} deps
 * list / detail resolve to {data, at, stale, error?}: a fresh cached row, else the broker's answer,
 * else (broker failed) an expired cached row with stale: true and the error; they reject when
 * there is nothing to show. A SessionExpiredError is also reported through onExpired.
 */
export function createNews({ broker, db, now = () => Date.now(), onExpired = () => {}, caps = CAPS }) {
  const inflight = new Map()
  let learned = null
  let indexChain = Promise.resolve()

  // Index updates run one after another; eviction failures never fail the caller.
  function track(key) {
    indexChain = indexChain.then(async () => {
      const index = { ...((await db.getKv(INDEX))?.data || {}) }
      index[key] = now()
      const kind = kindOf(key)
      const mine = Object.keys(index).filter((k) => kindOf(k) === kind).sort((a, b) => index[a] - index[b])
      for (const k of mine.slice(0, Math.max(0, mine.length - caps[kind]))) {
        delete index[k]
        await db.deleteKv(k)
      }
      await db.putKv(INDEX, index, now())
    }).catch(() => {})
    return indexChain
  }

  // A refetched first page: deeper pages of the same feed are dropped, so a later "Load more" is
  // never older than page 0 (an older page 1 under a newer page 0 would skip items).
  function dropDeeper(ticker, lang) {
    const prefix = `news:list:${ticker}:${lang}:`
    indexChain = indexChain.then(async () => {
      const index = { ...((await db.getKv(INDEX))?.data || {}) }
      const deeper = Object.keys(index).filter((k) => k.startsWith(prefix) && k !== `${prefix}0`)
      if (!deeper.length) return
      for (const k of deeper) {
        delete index[k]
        await db.deleteKv(k)
      }
      await db.putKv(INDEX, index, now())
    }).catch(() => {})
    return indexChain
  }

  async function peek(key) {
    try {
      return await db.getKv(key)
    } catch {
      return null // storage trouble: behave as uncached
    }
  }

  function get(key, ttl, fetch, { force = false, fetched = null } = {}) {
    if (inflight.has(key)) return inflight.get(key)
    const p = (async () => {
      const row = await peek(key)
      if (row && !force && now() - row.fetchedAt < ttl) return { data: row.data, at: row.fetchedAt, stale: false }
      let data
      try {
        data = await fetch()
      } catch (e) {
        if (e instanceof SessionExpiredError) onExpired()
        if (row) return { data: row.data, at: row.fetchedAt, stale: true, error: e }
        throw e
      }
      const at = now()
      try {
        await db.putKv(key, data, at)
        await track(key)
        if (fetched) await fetched()
      } catch {
        // not cached this time; the answer is still shown
      }
      return { data, at, stale: false }
    })().finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  const learn = (d) => {
    const off = parseOffset(d && d.timeZone)
    if (off !== null) learned = off
    return d
  }

  return {
    /** Cached page of any age ({list, total}) or null. */
    async peekList(q) {
      return (await peek(listKey(q)))?.data ?? null
    },
    list({ ticker, lang, skip = 0, force = false }) {
      return get(listKey({ ticker, lang, skip }), NEWS_TTL.list,
        async () => normList(await broker.newsList({ ticker, lang, take: NEWS_TAKE, skip })),
        { force, fetched: skip === 0 ? () => dropDeeper(ticker, lang) : null })
    },
    /** Cached article of any age or null. */
    async peekDetail(id) {
      return learn((await peek(detailKey(id)))?.data ?? null)
    },
    async detail(id, { force = false } = {}) {
      const r = await get(detailKey(id), NEWS_TTL.detail, async () => {
        const a = await broker.newsDetail(id)
        if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Bad article answer')
        return a
      }, { force })
      learn(r.data)
      return r
    },
    /** Zone of the news times (s east of UTC) from the last article seen; null before one. */
    learnedOffset: () => learned,
  }
}
