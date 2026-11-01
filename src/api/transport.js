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

const doFetch = (fetchImpl, url, init) => {
  const f = fetchImpl || globalThis.fetch
  return f(url, init)
}

async function parse(promise) {
  let res
  try {
    res = await promise
  } catch (e) {
    throw new NetworkError(e?.message || 'Network error')
  }
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
