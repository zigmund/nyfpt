// Low-level Tradernet transport. No custom headers: keeps requests CORS-simple.
export class BrokerError extends Error {
  constructor(message, { code = null, cmd = null } = {}) {
    super(message)
    this.name = 'BrokerError'
    this.code = code
    this.cmd = cmd
  }
}
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}
export class NetworkError extends Error {
  constructor(message = 'Network error') {
    super(message)
    this.name = 'NetworkError'
  }
}

/** Non-2xx HTTP status: a transport failure (rate limit, gateway, maintenance), never a broker
 *  answer. V1/V2 business errors come with HTTP 200 (docs/tradernet-api.md §4.2). */
export class HttpError extends NetworkError {
  constructor(status) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
  }
}

// A hung request would pin in-flight work (repo datasets, polling) until the browser gives up.
export const TIMEOUT_MS = 20000
// A signal is not a header: the request stays CORS-simple. Older browsers: no timeout.
const timeoutSignal = () => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
  ? AbortSignal.timeout(TIMEOUT_MS)
  : undefined)

const doFetch = (fetchImpl, url, init = {}) => {
  const f = fetchImpl || globalThis.fetch
  return f(url, { ...init, signal: timeoutSignal() })
}

async function parse(promise) {
  let res
  try {
    res = await promise
  } catch (e) {
    throw new NetworkError(e?.message || 'Network error')
  }
  // Checked before the body: a 429 / 5xx with a JSON error body must not read as a broker error.
  if (res && res.ok === false) throw new HttpError(res.status)
  try {
    return await res.json()
  } catch {
    throw new NetworkError(`Bad response${res?.status ? ` (HTTP ${res.status})` : ''}`)
  }
}

export function brokerErrorOf(data, cmd) {
  if (!data || typeof data !== 'object') return null
  const msg = [data.error, data.errMsg, data.errorMsg].find((v) => typeof v === 'string' && v.trim() !== '')
  if (!msg) return null
  return new BrokerError(msg, { code: data.code ?? null, cmd })
}

export async function callLegacy({ rest, cmd, params = {}, sid = null, fetchImpl } = {}) {
  const q = { cmd, params }
  if (sid) q.SID = sid
  const body = new URLSearchParams({ q: JSON.stringify(q) })
  const data = await parse(doFetch(fetchImpl, `${rest}/api/`, { method: 'POST', body }))
  const err = brokerErrorOf(data, cmd)
  if (err) throw err
  return data
}

export async function callAnon({ rest, cmd, params = {}, fetchImpl } = {}) {
  const qs = new URLSearchParams(params).toString()
  const data = await parse(doFetch(fetchImpl, `${rest}/api/${cmd}${qs ? `?${qs}` : ''}`))
  const err = brokerErrorOf(data, cmd)
  if (err) throw err
  return data
}
