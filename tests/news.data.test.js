// Task 21: news broker calls (SID transport) and the IndexedDB news cache. Synthetic data only.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBroker } from '../src/api/broker.js'
import { BrokerError, SessionExpiredError } from '../src/api/transport.js'
import { createNews, NEWS_TTL } from '../src/data/news.js'
import { openAccountDb } from '../src/store/db.js'
import { CABINETS } from '../src/config.js'

const cabinet = CABINETS[0]
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const sentQ = (fn, i = 0) => JSON.parse(new URLSearchParams(fn.mock.calls[i][1].body).get('q'))

describe('broker news calls', () => {
  it('getNewsList / getNewsDetail go through the SID form POST', async () => {
    const f = vi.fn().mockResolvedValue(ok({ list: [], total: 0, take: 20, skip: 0 }))
    const b = createBroker({ cabinet, sid: 'S', fetchImpl: f })
    await b.newsList({ ticker: 'AAA.US', lang: 'en', take: 20, skip: 40 })
    await b.newsDetail(123)
    expect(f.mock.calls[0][0]).toBe(`${cabinet.rest}/api/`)
    expect(f.mock.calls[0][1].headers).toBeUndefined()
    expect(sentQ(f, 0)).toEqual({ cmd: 'getNewsList', SID: 'S', params: { ticker: 'AAA.US', lang: 'en', take: 20, skip: 40 } })
    expect(sentQ(f, 1)).toEqual({ cmd: 'getNewsDetail', SID: 'S', params: { id: 123 } })
  })

  it('code 12 (Invalid CSRF) with a dead SID -> SessionExpiredError', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ error: 'Invalid CSRF', code: 12 }))
      .mockResolvedValueOnce(ok({ error: 'Session not found', code: 5 }))
    await expect(createBroker({ cabinet, sid: 'S', fetchImpl: f }).newsList({ ticker: 'A', lang: 'en', take: 20, skip: 0 }))
      .rejects.toBeInstanceOf(SessionExpiredError)
    expect(sentQ(f, 1).cmd).toBe('getSidInfo')
  })

  it('code 12 with a live SID stays a broker error', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ error: 'Invalid CSRF', code: 12 }))
      .mockResolvedValueOnce(ok({ SID: 'S', user_id: 1 }))
    await expect(createBroker({ cabinet, sid: 'S', fetchImpl: f }).newsDetail(1)).rejects.toMatchObject({ name: 'BrokerError', code: 12 })
  })
})

// --- store
const item = (id, extra = {}) => ({ id, title: `T${id}`, provider: 'P', date: '2026-10-31 11:01:00', url: '', tickers: [], ...extra })
const page = (ids, total) => ({ list: ids.map((i) => item(i)), total, take: 20, skip: 0 })
const LIST = { ticker: 'AAA.US', lang: 'en', skip: 0 }

describe('news store', () => {
  let idb
  let db
  let clock
  let broker
  let onExpired
  let news
  beforeEach(async () => {
    idb = new IDBFactory()
    db = await openAccountDb('global:1', idb)
    clock = 1_000_000
    broker = {
      newsList: vi.fn(async ({ skip }) => page([skip + 1, skip + 2], 2)),
      newsDetail: vi.fn(async (id) => ({ ...item(id), text: '<p>x</p>', dateTime: '2026-10-31 11:01:00', timeZone: '+0300' })),
    }
    onExpired = vi.fn()
    news = createNews({ broker, db, now: () => clock, onExpired })
  })

  it('TTLs: list 10 min, detail 24 h', () => {
    expect(NEWS_TTL).toEqual({ list: 10 * 60e3, detail: 24 * 3600e3 })
  })

  it('list: fetched once, then served from the cache until the TTL passes', async () => {
    const a = await news.list(LIST)
    expect(a).toMatchObject({ stale: false, data: { total: 2 } })
    expect(a.data.list.map((x) => x.id)).toEqual([1, 2])
    expect(broker.newsList).toHaveBeenCalledWith({ ticker: 'AAA.US', lang: 'en', take: 20, skip: 0 })
    clock += NEWS_TTL.list - 1
    await news.list(LIST)
    expect(broker.newsList).toHaveBeenCalledTimes(1)
    clock += 1
    await news.list(LIST)
    expect(broker.newsList).toHaveBeenCalledTimes(2)
    await news.list({ ...LIST, force: true })
    expect(broker.newsList).toHaveBeenCalledTimes(3)
  })

  it('cache key per ticker, language and skip; rows survive a new store (IndexedDB)', async () => {
    await news.list(LIST)
    await news.list({ ...LIST, skip: 20 })
    await news.list({ ...LIST, lang: 'ru' })
    expect(broker.newsList).toHaveBeenCalledTimes(3)
    expect((await db.getKv('news:list:AAA.US:en:20')).data.list.map((x) => x.id)).toEqual([21, 22])
    const again = createNews({ broker, db, now: () => clock })
    expect((await again.peekList(LIST)).list.map((x) => x.id)).toEqual([1, 2])
    expect(await again.peekList({ ...LIST, ticker: 'ZZZ.US' })).toBeNull()
  })

  it('a malformed answer is normalised (no list -> empty page)', async () => {
    broker.newsList.mockResolvedValueOnce({ foo: 1 })
    expect((await news.list(LIST)).data).toEqual({ list: [], total: 0 })
    broker.newsList.mockResolvedValueOnce({ list: 'x', total: '7' })
    expect((await news.list({ ...LIST, skip: 20 })).data).toEqual({ list: [], total: 7 })
  })

  it('broker failure: expired cache is served as stale with the error; no cache -> throws', async () => {
    await news.list(LIST)
    clock += NEWS_TTL.list
    broker.newsList.mockRejectedValue(new BrokerError('down', { code: 1 }))
    const r = await news.list(LIST)
    expect(r.stale).toBe(true)
    expect(r.error.message).toBe('down')
    expect(r.data.list).toHaveLength(2)
    await expect(news.list({ ...LIST, skip: 20 })).rejects.toThrow('down')
  })

  it('session expiry is reported to the app', async () => {
    broker.newsList.mockRejectedValue(new SessionExpiredError())
    await expect(news.list(LIST)).rejects.toBeInstanceOf(SessionExpiredError)
    expect(onExpired).toHaveBeenCalledTimes(1)
    broker.newsDetail.mockRejectedValue(new SessionExpiredError())
    await expect(news.detail(5)).rejects.toBeInstanceOf(SessionExpiredError)
    expect(onExpired).toHaveBeenCalledTimes(2)
  })

  it('a refetched first page drops the deeper cached pages of that ticker and language', async () => {
    await news.list(LIST)
    clock += 5 * 60e3
    await news.list({ ...LIST, skip: 20 })
    await news.list({ ...LIST, lang: 'ru', skip: 20 })
    await news.list({ ...LIST, ticker: 'ZZZ.US', skip: 20 })
    clock += 5 * 60e3 // page 0 expired, page 20 still fresh by its own TTL
    await news.list(LIST)
    expect(await db.getKv('news:list:AAA.US:en:20')).toBeNull()
    expect(await db.getKv('news:list:AAA.US:ru:20')).not.toBeNull()
    expect(await db.getKv('news:list:ZZZ.US:en:20')).not.toBeNull()
    expect(Object.keys((await db.getKv('news:index')).data)).not.toContain('news:list:AAA.US:en:20')
    const calls = broker.newsList.mock.calls.length
    await news.list({ ...LIST, skip: 20 })
    expect(broker.newsList).toHaveBeenCalledTimes(calls + 1) // fetched again, not older than page 0
  })

  it('a first page served from the cache keeps the deeper pages', async () => {
    await news.list(LIST)
    await news.list({ ...LIST, skip: 20 })
    await news.list(LIST)
    expect(await db.getKv('news:list:AAA.US:en:20')).not.toBeNull()
  })

  it('one request per key at a time', async () => {
    const [a, b] = await Promise.all([news.list(LIST), news.list(LIST)])
    expect(a.data).toEqual(b.data)
    expect(broker.newsList).toHaveBeenCalledTimes(1)
  })

  it('detail: 24 h TTL, key news:detail:<id>; learns the zone of the news times', async () => {
    expect(news.learnedOffset()).toBeNull()
    const d = await news.detail(7)
    expect(d.data).toMatchObject({ id: 7, text: '<p>x</p>' })
    expect(news.learnedOffset()).toBe(10800)
    expect(await db.getKv('news:detail:7')).not.toBeNull()
    clock += NEWS_TTL.detail - 1
    await news.detail(7)
    expect(broker.newsDetail).toHaveBeenCalledTimes(1)
    clock += 1
    await news.detail(7)
    expect(broker.newsDetail).toHaveBeenCalledTimes(2)
    expect((await news.peekDetail(7)).id).toBe(7)
  })

  it('a detail answer that is not an object is an error', async () => {
    broker.newsDetail.mockResolvedValueOnce(null)
    await expect(news.detail(1)).rejects.toThrow()
    expect(await db.getKv('news:detail:1')).toBeNull()
  })

  it('evicts the oldest entries beyond the caps', async () => {
    news = createNews({ broker, db, now: () => clock, caps: { list: 2, detail: 2 } })
    for (const id of [1, 2, 3]) { clock += 1000; await news.detail(id) }
    expect(await db.getKv('news:detail:1')).toBeNull()
    expect(await db.getKv('news:detail:2')).not.toBeNull()
    expect(await db.getKv('news:detail:3')).not.toBeNull()
    for (const skip of [0, 20, 40]) { clock += 1000; await news.list({ ...LIST, skip }) }
    expect(await db.getKv('news:list:AAA.US:en:0')).toBeNull()
    expect(await db.getKv('news:list:AAA.US:en:40')).not.toBeNull()
    // a refreshed entry counts as new
    clock += NEWS_TTL.detail
    await news.detail(2)
    clock += 1000
    await news.detail(4)
    expect(await db.getKv('news:detail:2')).not.toBeNull()
    expect(await db.getKv('news:detail:3')).toBeNull()
  })

  it('logout erase (AccountDb.clear) removes every news row', async () => {
    await news.list(LIST)
    await news.detail(7)
    await db.clear()
    const fresh = createNews({ broker, db, now: () => clock })
    expect(await fresh.peekList(LIST)).toBeNull()
    expect(await fresh.peekDetail(7)).toBeNull()
    expect(await db.getKv('news:index')).toBeNull()
  })

  it('stored rows never contain the SID', async () => {
    const b = createBroker({ cabinet, sid: 'SECRET-SID', fetchImpl: vi.fn().mockResolvedValue(ok(page([1], 1))) })
    const n = createNews({ broker: b, db, now: () => clock })
    await n.list(LIST)
    expect(JSON.stringify(await db.getKv('news:list:AAA.US:en:0'))).not.toContain('SECRET-SID')
  })
})

describe('app wiring', () => {
  async function makeApp(broker) {
    const { createAppState } = await import('../src/composables/useApp.js')
    const idb = new IDBFactory()
    const opened = []
    const app = createAppState({
      createBroker: () => broker,
      openAccountDb: async (key) => { const d = await openAccountDb(key, idb); opened.push(d); return d },
      createRepo: () => ({ subscribe: (fn) => { fn({}); return () => {} }, onSessionExpired: () => () => {}, load: async () => {} }),
      createLive: () => ({ quotes: new Map(), isLive: () => false, marketsOpen: () => ({}), on: () => () => {}, start() {}, stop() {}, pause() {} }),
      sessionStore: { load: () => ({ cabinetId: 'global', sid: 's', userId: 1, loggedAt: 0 }), save() {}, clear() {} },
      prefsStore: { load: () => ({}), save() {} },
    })
    app.start()
    await vi.waitFor(() => expect(app.news()).not.toBeNull())
    return { app, idb }
  }

  it('the attached account gets a news cache; logout erases its rows and drops it', async () => {
    const broker = { newsList: vi.fn(async () => page([1], 1)), newsDetail: vi.fn() }
    const { app, idb } = await makeApp(broker)
    await app.news().list(LIST)
    const before = await openAccountDb('global:1', idb)
    expect(await before.getKv('news:list:AAA.US:en:0')).not.toBeNull()
    before.close()
    await app.logout()
    expect(app.news()).toBeNull()
    const after = await openAccountDb('global:1', idb)
    expect(await after.getKv('news:list:AAA.US:en:0')).toBeNull()
    expect(await after.getKv('news:index')).toBeNull()
    after.close()
    app.stop()
  })

  it('an expired session seen by a news call shows the login over the card', async () => {
    const broker = { newsList: vi.fn(async () => { throw new SessionExpiredError() }), newsDetail: vi.fn() }
    const { app } = await makeApp(broker)
    await expect(app.news().list(LIST)).rejects.toBeInstanceOf(SessionExpiredError)
    expect(app.expired.value).toBe(true)
    app.stop()
  })
})
