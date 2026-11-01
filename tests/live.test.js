import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveSocket } from '../src/api/ws.js'
import { createLive } from '../src/data/live.js'
import { SessionExpiredError } from '../src/api/transport.js'
import { BENCHMARKS, MARKET_STRIP, POLL_MS, LIVE_RECALC_MS } from '../src/config.js'

const STALE = 2 * 60e3

// Fake WebSocket: records sent frames; the test drives open/messages/close.
class FakeWS {
  static all = []
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWS.all.push(this) }
  send(s) { this.sent.push(JSON.parse(s)) }
  close() { this.closed = true }
  open() { this.onopen?.({}) }
  push(...msg) { this.onmessage?.({ data: JSON.stringify([...msg, 'wstm=x']) }) }
  drop() { this.onclose?.({}) }
}
const last = () => FakeWS.all[FakeWS.all.length - 1]
const timers = { setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (id) => clearTimeout(id) }
const socket = () => new LiveSocket({ wsUrl: 'wss://wss.example/', sid: 's1', WebSocketImpl: FakeWS, ...timers })

// Fake repo: subscribe/emit positions; applyPortfolio re-emits positions from `ps.pos`.
function fakeRepo(tickers = ['AAA.US']) {
  const fns = new Set()
  const state = (ts) => ({ positions: ts.map((t) => ({ ticker: t, kind: 'position' })).concat([{ ticker: 'USD', kind: 'cash' }]) })
  let cur = state(tickers)
  const repo = {
    subscribe(fn) { fns.add(fn); fn(cur); return () => fns.delete(fn) },
    emitTickers(ts) { cur = state(ts); for (const fn of fns) fn(cur) },
    applyPortfolio: vi.fn(async (ps) => repo.emitTickers(ps.pos.map((p) => p.i))),
    refresh: vi.fn(async () => {}),
  }
  return repo
}
function fakeBroker() {
  return {
    status: 'CLOSE',
    quotes: vi.fn(async (ts) => ({ result: { q: ts.map((c) => ({ c, ltp: 100, pp: 99, ltr: c.endsWith('.KZ') ? 'KASE' : 'FIX' })) } })),
    positions: vi.fn(async () => ({ result: { ps: { acc: [], pos: [{ i: 'AAA.US' }] } } })),
    // REST getMarketStatus uses `i` where the WS uses `mkt_id`.
    marketStatus: vi.fn(async function () { return { result: { markets: { t: 'x', m: [{ i: 1, n: 'FIX', n2: 'FIX', s: this.status }] } } } }),
  }
}
function setup({ tickers, broker = fakeBroker() } = {}) {
  const repo = fakeRepo(tickers)
  const live = createLive({ repo, broker, socketFactory: socket, now: () => Date.now(), ...timers })
  return { repo, broker, live }
}
const OPEN = { t: 'x', m: [{ mkt_id: 1, n: 'FIX', n2: 'FIX', s: 'OPEN' }, { mkt_id: 2, n: 'KASE', n2: 'KASE', s: 'CLOSE' }] }
const CLOSED = { t: 'x', m: [{ mkt_id: 1, n: 'FIX', n2: 'FIX', s: 'CLOSE' }] }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-12T15:00:00Z')); FakeWS.all = [] })
afterEach(() => { vi.useRealTimers() })

describe('LiveSocket', () => {
  it('connects with SID and sends subscriptions on open', () => {
    const s = socket()
    s.setQuotes(['AAA.US'])
    s.subscribePortfolio()
    s.subscribeMarkets()
    expect(FakeWS.all).toHaveLength(0) // nothing on construction
    s.connect()
    expect(last().url).toBe('wss://wss.example/?SID=s1')
    expect(last().sent).toEqual([])
    const status = []
    s.on('status', (v) => status.push(v))
    last().open()
    expect(last().sent).toEqual([['quotes', ['AAA.US']], ['portfolio'], ['markets']])
    s.setQuotes(['BBB.US'])
    expect(last().sent.at(-1)).toEqual(['quotes', ['BBB.US']])
    expect(status).toEqual(['open'])
  })

  it('emits events and ignores the third element', () => {
    const s = socket()
    const got = []
    s.on('quote', (q) => got.push(['quote', q]))
    s.on('portfolio', (p) => got.push(['portfolio', p]))
    s.on('markets', (m) => got.push(['markets', m]))
    s.connect()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 1 })
    last().push('portfolio', { pos: [] })
    last().push('markets', CLOSED)
    last().onmessage({ data: 'not json' })
    expect(got).toEqual([['quote', { c: 'AAA.US', ltp: 1 }], ['portfolio', { pos: [] }], ['markets', CLOSED]])
  })

  it('reconnects with backoff', () => {
    const s = socket()
    const status = []
    s.on('status', (v) => status.push(v))
    s.setQuotes(['AAA.US'])
    s.connect()
    last().open()
    let n = 1
    for (const d of [5e3, 10e3, 20e3, 40e3, 60e3, 60e3]) {
      last().drop()
      vi.advanceTimersByTime(d - 1)
      expect(FakeWS.all).toHaveLength(n)
      vi.advanceTimersByTime(1)
      expect(FakeWS.all).toHaveLength(++n)
    }
    // Resubscribes after reconnect; userData resets the backoff.
    last().open()
    expect(last().sent).toEqual([['quotes', ['AAA.US']]])
    last().push('userData', { mode: 'prod', id: 1 })
    last().drop()
    vi.advanceTimersByTime(5e3)
    expect(FakeWS.all).toHaveLength(n + 1)
    expect(status.slice(0, 3)).toEqual(['open', 'closed', 'open'])
  })

  it('close() stops reconnecting', () => {
    const s = socket()
    s.connect()
    last().open()
    last().drop()
    s.close()
    vi.advanceTimersByTime(120e3)
    expect(FakeWS.all).toHaveLength(1)
    s.connect()
    expect(FakeWS.all).toHaveLength(2)
  })

  it('demo mode emits auth-error', () => {
    const s = socket()
    const errs = vi.fn()
    s.on('auth-error', errs)
    s.connect()
    last().open()
    last().push('userData', { mode: 'demo' })
    last().push('error', { error: 'Access to portfolio subscription denied', code: 'unauthenticated' })
    expect(errs).toHaveBeenCalledTimes(1)
    expect(last().closed).toBe(true)
    vi.advanceTimersByTime(120e3)
    expect(FakeWS.all).toHaveLength(1) // a demo SID is not retried
  })

  it('unauthenticated error emits auth-error', () => {
    const s = socket()
    const errs = vi.fn()
    s.on('auth-error', errs)
    s.connect()
    last().open()
    last().push('error', { error: 'denied', code: 'unauthenticated' })
    expect(errs).toHaveBeenCalledTimes(1)
  })
})

describe('createLive', () => {
  it('does not connect before start()', () => {
    setup()
    expect(FakeWS.all).toHaveLength(0)
  })

  it('subscribes positions ∪ benchmarks ∪ market strip', () => {
    const { live } = setup({ tickers: ['ZZZ.US', 'SPY.US'] })
    live.start()
    last().open()
    const want = [...new Set(['ZZZ.US', 'SPY.US', ...BENCHMARKS, ...MARKET_STRIP.map((m) => m.ticker)])].sort()
    expect(last().sent).toContainEqual(['quotes', want])
    expect(last().sent).toContainEqual(['portfolio'])
    expect(last().sent).toContainEqual(['markets'])
  })

  it('merges quote snapshot and deltas', () => {
    const { live } = setup()
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 10, pp: 9, chg: 1, ltr: 'FIX', name: 'Aaa' })
    last().push('q', { c: 'AAA.US', ltp: 11, chg: 2, pp: null })
    expect(live.quotes.get('AAA.US')).toEqual({ c: 'AAA.US', ltp: 11, pp: 9, chg: 2, ltr: 'FIX', name: 'Aaa' })
  })

  it('resubscribes on portfolio change', async () => {
    const { live, repo } = setup()
    live.start()
    last().open()
    const ps = { acc: [], pos: [{ i: 'AAA.US' }, { i: 'NEW.US' }] }
    last().push('portfolio', ps)
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.applyPortfolio).toHaveBeenCalledWith(ps)
    const quotes = last().sent.filter((m) => m[0] === 'quotes')
    expect(quotes).toHaveLength(2)
    expect(quotes[1][1]).toContain('NEW.US')
    // Same set again: nothing re-sent.
    repo.emitTickers(['NEW.US', 'AAA.US'])
    expect(last().sent.filter((m) => m[0] === 'quotes')).toHaveLength(2)
  })

  it('is live only when a market of its instruments is open', () => {
    const { live } = setup()
    live.start()
    last().open()
    expect(live.isLive()).toBe(false)
    last().push('q', { c: 'AAA.US', ltp: 10, ltr: 'FIX' })
    expect(live.isLive()).toBe(false) // markets unknown
    last().push('markets', { t: 'x', m: [{ mkt_id: 2, n: 'KASE', n2: 'KASE', s: 'OPEN' }] })
    expect(live.isLive()).toBe(false)
    expect(live.marketsOpen()).toEqual({ us: false })
    last().push('markets', OPEN)
    expect(live.isLive()).toBe(true)
    expect(live.marketsOpen()).toEqual({ us: true })
    // Partial entries merge into the known market.
    last().push('markets', { t: 'y', m: [{ mkt_id: 1, s: 'CLOSE' }] })
    expect(live.isLive()).toBe(false)
    last().push('markets', { t: 'z', m: [{ mkt_id: 1, s: 'OPEN' }] })
    expect(live.isLive()).toBe(true)
  })

  it('seeds quotes over REST when markets open but no market codes are known', async () => {
    const { live, broker } = setup()
    live.start()
    last().open()
    last().push('markets', OPEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(broker.quotes).toHaveBeenCalledTimes(1)
    expect(live.quotes.get('AAA.US').ltr).toBe('FIX')
    expect(live.isLive()).toBe(true)
  })

  it('falls back to polling', async () => {
    const { live, broker, repo } = setup()
    broker.status = 'OPEN'
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 10, ltr: 'FIX' })
    last().push('markets', OPEN)
    await vi.advanceTimersByTimeAsync(STALE - 1)
    expect(broker.quotes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1) // 2 min without a tick
    expect(broker.quotes).toHaveBeenCalledTimes(1)
    expect(broker.positions).toHaveBeenCalledTimes(1)
    expect(repo.applyPortfolio).toHaveBeenCalledWith({ acc: [], pos: [{ i: 'AAA.US' }] })
    expect(live.quotes.get('SPY.US').ltp).toBe(100)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(broker.quotes).toHaveBeenCalledTimes(2)
    // A WS tick revives live mode: polling stops.
    last().push('q', { c: 'AAA.US', ltp: 12 })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(broker.quotes).toHaveBeenCalledTimes(2)
    // WS closed while live: polling starts at once and survives a reconnect without ticks.
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(broker.quotes).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5e3)
    last().open()
    await vi.advanceTimersByTimeAsync(POLL_MS - 5e3)
    expect(broker.quotes).toHaveBeenCalledTimes(4)
    // Markets close: polling stops.
    last().push('markets', CLOSED)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(broker.quotes).toHaveBeenCalledTimes(4)
  })

  it('does not poll when not live', async () => {
    const { live, broker } = setup()
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 10, ltr: 'FIX' })
    last().push('markets', CLOSED)
    last().drop()
    await vi.advanceTimersByTimeAsync(STALE + POLL_MS * 2)
    expect(broker.quotes).not.toHaveBeenCalled()
  })

  it('routes session expiry during polling to the repo', async () => {
    const broker = fakeBroker()
    broker.positions.mockRejectedValue(new SessionExpiredError())
    const { live, repo } = setup({ broker })
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 10, ltr: 'FIX' })
    last().push('markets', OPEN)
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.refresh).toHaveBeenCalledWith({ force: true, only: ['positions'] })
  })

  it('throttles updates', async () => {
    const { live } = setup()
    const upd = vi.fn()
    live.on('update', upd)
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 1 })
    expect(upd).toHaveBeenCalledTimes(1) // leading
    for (let i = 2; i <= 10; i++) {
      vi.advanceTimersByTime(200)
      last().push('q', { c: 'AAA.US', ltp: i })
    }
    expect(upd).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(LIVE_RECALC_MS - 1800)
    expect(upd).toHaveBeenCalledTimes(2) // trailing, carries the last tick
    expect(live.quotes.get('AAA.US').ltp).toBe(10)
    vi.advanceTimersByTime(LIVE_RECALC_MS * 2)
    expect(upd).toHaveBeenCalledTimes(2)
  })

  it('auth-error from the socket asks the repo to verify the session', () => {
    const { live, repo } = setup()
    const errs = vi.fn()
    live.on('auth-error', errs)
    live.start()
    last().open()
    last().push('userData', { mode: 'demo' })
    expect(errs).toHaveBeenCalledTimes(1)
    expect(repo.refresh).toHaveBeenCalledWith({ force: true, only: ['positions'] })
  })

  it('pause closes the socket and stops polling; resume reconnects and refreshes', async () => {
    const { live, broker, repo } = setup()
    broker.status = 'OPEN'
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 10, ltr: 'FIX' })
    last().push('markets', OPEN)
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(broker.quotes).toHaveBeenCalledTimes(1)
    live.pause()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(broker.quotes).toHaveBeenCalledTimes(1)
    expect(FakeWS.all).toHaveLength(1) // no reconnect while paused
    live.resume()
    expect(repo.refresh).toHaveBeenCalled()
    expect(FakeWS.all).toHaveLength(2)
    live.stop()
    expect(last().closed).toBe(true)
    await vi.advanceTimersByTimeAsync(STALE * 2)
    expect(FakeWS.all).toHaveLength(2)
  })

  it('auth-error kills live mode: no polling, no reconnect on resume', async () => {
    const { live, broker } = setup()
    broker.status = 'OPEN'
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 10, ltr: 'FIX' })
    last().push('markets', OPEN)
    expect(live.isLive()).toBe(true)
    last().push('error', { error: 'Access to portfolio subscription denied', code: 'unauthenticated' })
    expect(live.isLive()).toBe(false)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(broker.quotes).not.toHaveBeenCalled()
    expect(broker.positions).not.toHaveBeenCalled()
    expect(broker.marketStatus).not.toHaveBeenCalled()
    live.pause()
    live.resume()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(FakeWS.all).toHaveLength(1)
    expect(broker.quotes).not.toHaveBeenCalled()
  })

  it('session expiry while polling stops polling', async () => {
    const broker = fakeBroker()
    broker.status = 'OPEN'
    broker.positions.mockRejectedValue(new SessionExpiredError())
    const { live } = setup({ broker })
    live.start()
    last().open()
    last().push('q', { c: 'AAA.US', ltp: 10, ltr: 'FIX' })
    last().push('markets', OPEN)
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(broker.quotes).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(broker.quotes).toHaveBeenCalledTimes(1)
    expect(broker.marketStatus).not.toHaveBeenCalled()
    expect(FakeWS.all).toHaveLength(1) // socket not reconnected for a dead session
    expect(live.isLive()).toBe(false)
  })

  it('uses REST market status when the WS sends no markets', async () => {
    const { live, broker } = setup()
    broker.status = 'OPEN'
    live.start() // socket does not open (blocked wss)
    await vi.advanceTimersByTimeAsync(15e3 - 1)
    expect(broker.marketStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(broker.marketStatus).toHaveBeenCalledTimes(1)
    expect(live.isLive()).toBe(true) // REST quotes seeded `ltr`
    expect(live.marketsOpen()).toEqual({ us: true })
    expect(broker.positions).toHaveBeenCalledTimes(1) // polling
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(broker.marketStatus).toHaveBeenCalledTimes(2)
    expect(broker.positions).toHaveBeenCalledTimes(2)
    // WS comes up: REST status keeps going until WS markets arrive, then stops.
    last().open()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(broker.marketStatus).toHaveBeenCalledTimes(3)
    last().push('markets', OPEN)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(broker.marketStatus).toHaveBeenCalledTimes(3)
  })

  it('uses REST market status while the socket is down', async () => {
    const { live, broker } = setup()
    live.start()
    last().open()
    last().push('markets', CLOSED)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(broker.marketStatus).not.toHaveBeenCalled()
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(broker.marketStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5e3)
    last().open()
    last().push('markets', CLOSED)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(broker.marketStatus).toHaveBeenCalledTimes(1)
  })

  it('throttles portfolio frames', async () => {
    const { live, repo } = setup()
    live.start()
    last().open()
    const frame = (n) => ({ acc: [], pos: [{ i: 'AAA.US', q: n }] })
    for (let i = 1; i <= 10; i++) {
      last().push('portfolio', frame(i))
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(repo.applyPortfolio).toHaveBeenCalledTimes(1)
    expect(repo.applyPortfolio).toHaveBeenLastCalledWith(frame(1))
    await vi.advanceTimersByTimeAsync(LIVE_RECALC_MS)
    expect(repo.applyPortfolio).toHaveBeenCalledTimes(2)
    expect(repo.applyPortfolio).toHaveBeenLastCalledWith(frame(10))
    await vi.advanceTimersByTimeAsync(LIVE_RECALC_MS * 3)
    expect(repo.applyPortfolio).toHaveBeenCalledTimes(2)
  })
})
