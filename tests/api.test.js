import { describe, it, expect, vi } from 'vitest'
import { callLegacy, callAnon, BrokerError, SessionExpiredError, NetworkError } from '../src/api/transport.js'
import { loginByPassword, requestPhoneCode, loginByPhoneCode } from '../src/api/auth.js'
import { createBroker } from '../src/api/broker.js'
import { CABINETS } from '../src/config.js'

const cabinet = CABINETS[0]
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const fake = (...bodies) => {
  const fn = vi.fn()
  bodies.forEach((b) => fn.mockResolvedValueOnce(typeof b === 'function' ? b() : ok(b)))
  return fn
}
const sentQ = (fn, i = 0) => JSON.parse(new URLSearchParams(fn.mock.calls[i][1].body).get('q'))

describe('transport', () => {
  it('callLegacy sends form body without custom headers', async () => {
    const f = fake({ result: 1 })
    const r = await callLegacy({ rest: 'https://x.test', cmd: 'getPositionJson', params: { a: 1 }, sid: 'S', fetchImpl: f })
    expect(r).toEqual({ result: 1 })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://x.test/api/')
    expect(init.method).toBe('POST')
    expect(init.headers).toBeUndefined()
    expect(init.body).toBeInstanceOf(URLSearchParams)
    expect(sentQ(f)).toEqual({ cmd: 'getPositionJson', SID: 'S', params: { a: 1 } })
  })

  it('omits SID when absent', async () => {
    const f = fake({})
    await callLegacy({ rest: 'https://x.test', cmd: 'c', fetchImpl: f })
    expect(sentQ(f)).toEqual({ cmd: 'c', params: {} })
  })

  it('broker error is detected by error/errMsg/errorMsg, empty error is success', async () => {
    for (const key of ['error', 'errMsg', 'errorMsg']) {
      const f = fake({ [key]: 'bad', code: 7 })
      await expect(callLegacy({ rest: 'r', cmd: 'c', fetchImpl: f })).rejects.toMatchObject({ name: 'BrokerError', code: 7, cmd: 'c', message: 'bad' })
    }
    const f = fake({ error: '', errMsg: null, result: 2 })
    await expect(callLegacy({ rest: 'r', cmd: 'c', fetchImpl: f })).resolves.toMatchObject({ result: 2 })
  })

  it('network failure and non-JSON become NetworkError', async () => {
    await expect(callLegacy({ rest: 'r', cmd: 'c', fetchImpl: vi.fn().mockRejectedValue(new TypeError('x')) })).rejects.toBeInstanceOf(NetworkError)
    const bad = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('x') } })
    await expect(callLegacy({ rest: 'r', cmd: 'c', fetchImpl: bad })).rejects.toBeInstanceOf(NetworkError)
  })

  it('callAnon uses GET with query params', async () => {
    const f = fake({ ok: 1 })
    await callAnon({ rest: 'https://x.test', cmd: 'getMarketStatus', params: { market: '*' }, fetchImpl: f })
    expect(f.mock.calls[0][0]).toBe('https://x.test/api/getMarketStatus?market=*')
    expect(f.mock.calls[0][1]?.headers).toBeUndefined()
  })

  it('every request carries a 20 s timeout signal and no headers; a timeout is a NetworkError', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const f = fake({}, {})
      await callLegacy({ rest: 'r', cmd: 'c', fetchImpl: f })
      await callAnon({ rest: 'r', cmd: 'c', fetchImpl: f })
      expect(spy.mock.calls).toEqual([[20000], [20000]])
      for (const [, init] of f.mock.calls) {
        expect(init.signal).toBeInstanceOf(AbortSignal)
        expect(init.headers).toBeUndefined()
      }
    } finally { spy.mockRestore() }
    const timedOut = vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    await expect(callLegacy({ rest: 'r', cmd: 'c', fetchImpl: timedOut })).rejects.toBeInstanceOf(NetworkError)
    await expect(callAnon({ rest: 'r', cmd: 'c', fetchImpl: timedOut })).rejects.toBeInstanceOf(NetworkError)
  })

  it('uses globalThis.fetch resolved at call time', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ a: 1 }))
    try {
      await expect(callAnon({ rest: 'r', cmd: 'c' })).resolves.toEqual({ a: 1 })
    } finally { globalThis.fetch = orig }
  })
})

describe('auth', () => {
  it('loginByPassword sends rememberMe 1 and viewOnlyMode true', async () => {
    const f = fake({ success: true, SID: 'abc', userId: 5 })
    const r = await loginByPassword({ cabinet, login: 'u', password: 'p', fetchImpl: f })
    expect(r).toEqual({ sid: 'abc', userId: 5 })
    const q = sentQ(f)
    expect(q.cmd).toBe('authByLogin')
    expect(q.SID).toBeUndefined()
    expect(q.params).toEqual({ login: 'u', password: 'p', rememberMe: 1, viewOnlyMode: true })
  })

  it('missing SID is a BrokerError', async () => {
    const f = fake({ success: false, error: 'Nope', code: 5 })
    await expect(loginByPassword({ cabinet, login: 'u', password: 'p', fetchImpl: f })).rejects.toBeInstanceOf(BrokerError)
    const g = fake({ success: false })
    await expect(loginByPassword({ cabinet, login: 'u', password: 'p', fetchImpl: g })).rejects.toMatchObject({ message: 'Login failed' })
  })

  it('requestPhoneCode uses tel param', async () => {
    const f = fake({ auth_code_id: 'id1', auth_code_length: 6 })
    const r = await requestPhoneCode({ cabinet, phone: '+123', fetchImpl: f })
    expect(r).toEqual({ authCodeId: 'id1', codeLength: 6 })
    expect(sentQ(f)).toMatchObject({ cmd: 'getAuthSms', params: { tel: '+123' } })
  })

  it('loginByPhoneCode sends authCodeId, sms, rememberMe, viewOnlyMode', async () => {
    const f = fake({ SID: 's2', userId: 9 })
    const r = await loginByPhoneCode({ cabinet, authCodeId: 'id1', code: '1234', fetchImpl: f })
    expect(r).toEqual({ sid: 's2', userId: 9 })
    expect(sentQ(f)).toMatchObject({ cmd: 'authBySms', params: { authCodeId: 'id1', sms: '1234', rememberMe: 1, viewOnlyMode: true } })
  })
})

describe('broker', () => {
  it('positions/trades/cashflows/quotes commands', async () => {
    const f = fake({}, {}, {}, {})
    const b = createBroker({ cabinet, sid: 'S', fetchImpl: f })
    await b.positions(); await b.trades('2024-01-01'); await b.cashflows(); await b.quotes(['A.US', 'B.US'])
    expect(sentQ(f, 0)).toEqual({ cmd: 'getPositionJson', SID: 'S', params: {} })
    expect(sentQ(f, 1).params).toEqual({ beginDate: '2024-01-01' })
    expect(sentQ(f, 2).params).toEqual({ groupByType: 1, take: 500, skip: 0, sort: { field: 'date', dir: 'DESC' } })
    expect(sentQ(f, 3).params).toEqual({ tickers: 'A.US,B.US' })
  })

  // Synthetic cash-flow rows, newest first.
  const flows = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `cf${from + i}`, type_code: 'card', date: '2026-01-01', currency: 'USD', sum: '1' }))
  // Answers getUserCashFlows by skip/take from `rows`; `total` as given (undefined: omitted).
  const pager = (rows, total, { ignoreSkip = false } = {}) => vi.fn(async (url, init) => {
    const { params } = JSON.parse(new URLSearchParams(init.body).get('q'))
    const skip = ignoreSkip ? 0 : params.skip
    const body = { cashflow: rows.slice(skip, skip + params.take) }
    if (total !== undefined) body.total = total
    return ok(body)
  })

  it('cashflows pages with skip/take until total', async () => {
    const f = pager(flows(0, 1200), 1200)
    const a = await createBroker({ cabinet, sid: 'S', fetchImpl: f }).cashflows()
    expect(f.mock.calls.map((_, i) => [sentQ(f, i).params.skip, sentQ(f, i).params.take])).toEqual([[0, 500], [500, 500], [1000, 500]])
    expect(a.cashflow).toHaveLength(1200)
    expect(a.cashflow.at(-1).id).toBe('cf1199')
    expect(a.total).toBe(1200)
    expect(a.complete).toBe(true)
  })

  it('cashflows: an exact multiple of the page needs no extra call', async () => {
    const f = pager(flows(0, 1000), '1000')
    const a = await createBroker({ cabinet, sid: 'S', fetchImpl: f }).cashflows()
    expect(f).toHaveBeenCalledTimes(2)
    expect(a.complete).toBe(true)
  })

  it('cashflows: an empty page before total stops and reports incomplete', async () => {
    const f = pager(flows(0, 600), 900)
    const a = await createBroker({ cabinet, sid: 'S', fetchImpl: f }).cashflows()
    expect(f).toHaveBeenCalledTimes(2)
    expect(a.cashflow).toHaveLength(600)
    expect(a.complete).toBe(false)
  })

  it('cashflows: without total a short page ends the history', async () => {
    const f = pager(flows(0, 700))
    const a = await createBroker({ cabinet, sid: 'S', fetchImpl: f }).cashflows()
    expect(f).toHaveBeenCalledTimes(2)
    expect(a.cashflow).toHaveLength(700)
    expect(a.complete).toBe(true)
  })

  it('cashflows: a broker ignoring skip cannot loop; reported incomplete', async () => {
    const f = pager(flows(0, 5000), undefined, { ignoreSkip: true })
    const a = await createBroker({ cabinet, sid: 'S', fetchImpl: f }).cashflows()
    expect(f).toHaveBeenCalledTimes(2)
    expect(a.cashflow).toHaveLength(500)
    expect(a.complete).toBe(false)
  })

  it('session expiry: code 5 and getSidInfo fails -> SessionExpiredError', async () => {
    const f = fake({ error: 'x', code: 5 }, { error: 'y', code: 5 })
    const b = createBroker({ cabinet, sid: 'S', fetchImpl: f })
    await expect(b.positions()).rejects.toBeInstanceOf(SessionExpiredError)
    expect(sentQ(f, 1).cmd).toBe('getSidInfo')
  })

  it('session expiry: code 5 but getSidInfo ok -> original BrokerError', async () => {
    const f = fake({ error: 'x', code: 5 }, { SID: 'S', user_id: 1 })
    const b = createBroker({ cabinet, sid: 'S', fetchImpl: f })
    await expect(b.positions()).rejects.toMatchObject({ name: 'BrokerError', code: 5, message: 'x' })
  })

  it('other broker errors pass through without probing', async () => {
    const f = fake({ error: 'x', code: 9 })
    const b = createBroker({ cabinet, sid: 'S', fetchImpl: f })
    await expect(b.positions()).rejects.toBeInstanceOf(BrokerError)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('checkSession calls getSidInfo', async () => {
    const f = fake({ SID: 'S', user_id: 1 })
    const r = await createBroker({ cabinet, sid: 'S', fetchImpl: f }).checkSession()
    expect(r.user_id).toBe(1)
    expect(sentQ(f).cmd).toBe('getSidInfo')
  })

  it('hloc uses anonymous GET with DD.MM.YYYY dates', async () => {
    const f = fake({}, {}, {})
    const b = createBroker({ cabinet, sid: 'S', fetchImpl: f })
    await b.hlocDaily(['SPY.US', 'QQQ.US'], '2026-03-05')
    await b.hlocIntraday(['SPY.US'], '2026-03-05', '2026-03-06')
    await b.marketStatus()
    const u = new URL(f.mock.calls[0][0])
    expect(u.pathname).toBe('/api/getHloc')
    expect(f.mock.calls[0][1]?.method).toBeUndefined()
    expect(Object.fromEntries(u.searchParams)).toEqual({
      id: 'SPY.US,QQQ.US', count: '-6', timeframe: '1440', date_from: '05.03.2026 00:00', intervalMode: 'ClosedRay',
    })
    const v = new URL(f.mock.calls[1][0])
    expect(Object.fromEntries(v.searchParams)).toMatchObject({ timeframe: '15', date_from: '05.03.2026 00:00', date_to: '06.03.2026 00:00' })
    expect(f.mock.calls[2][0]).toBe('https://tradernet.global/api/getMarketStatus?market=*')
  })
})
