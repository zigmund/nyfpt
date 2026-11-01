import { callLegacy, callAnon, BrokerError, SessionExpiredError } from './transport.js'

// 'YYYY-MM-DD[ T]HH:mm' -> 'DD.MM.YYYY HH:mm'
function hlocDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s)
  if (!m) throw new Error(`Bad date: ${s}`)
  return `${m[3]}.${m[2]}.${m[1]} ${m[4] || '00:00'}`
}

const CASHFLOW_PAGE = 500
const CASHFLOW_MAX_PAGES = 200 // 100k rows: a hard stop for a broker that never ends

export function createBroker({ cabinet, sid, fetchImpl }) {
  const rest = cabinet.rest

  // Authenticated call; code 5 triggers a getSidInfo probe to tell expiry from other errors.
  async function authed(cmd, params = {}) {
    try {
      return await callLegacy({ rest, cmd, params, sid, fetchImpl })
    } catch (e) {
      if (e instanceof BrokerError && e.code === 5) {
        try {
          await callLegacy({ rest, cmd: 'getSidInfo', sid, fetchImpl })
        } catch (probe) {
          if (probe instanceof BrokerError) throw new SessionExpiredError()
          throw probe
        }
      }
      throw e
    }
  }

  // Whole cash-flow history, newest first, paged by skip/take. Stops at `total`, at a short or
  // empty page, at a page with no new rows (skip ignored) or after CASHFLOW_MAX_PAGES.
  // Returns the first answer with all rows in `cashflow` and `complete` = every row arrived.
  async function cashflows() {
    const rows = []
    const seen = new Set()
    let first = null
    let total = null
    let complete = false
    for (let page = 0; page < CASHFLOW_MAX_PAGES; page++) {
      const skip = page * CASHFLOW_PAGE
      const a = await authed('getUserCashFlows', {
        groupByType: 1, take: CASHFLOW_PAGE, skip, sort: { field: 'date', dir: 'DESC' },
      })
      first ||= a
      const t = a && a.total != null && a.total !== '' ? Number(a.total) : NaN
      if (Number.isFinite(t)) total = t
      const list = (a && Array.isArray(a.cashflow)) ? a.cashflow : []
      let added = 0
      for (const x of list) {
        const id = x && x.id
        if (id != null) {
          if (seen.has(id)) continue
          seen.add(id)
        }
        rows.push(x)
        added++
      }
      if (total != null && skip + list.length >= total) { complete = rows.length >= total; break }
      if (list.length < CASHFLOW_PAGE) { complete = total == null; break }
      if (!added) break // the broker repeats a page: incomplete
    }
    return { ...first, cashflow: rows, total, complete }
  }

  const hloc = (params) => callAnon({ rest, cmd: 'getHloc', params: { ...params, intervalMode: 'ClosedRay' }, fetchImpl })

  return {
    positions: () => authed('getPositionJson'),
    trades: (beginDate) => authed('getTradesHistory', { beginDate }),
    cashflows,
    quotes: (tickers) => authed('getStockQuotesJson', { tickers: tickers.join(',') }),
    hlocDaily: (tickers, dateFrom, count = -6) =>
      hloc({ id: tickers.join(','), count, timeframe: 1440, date_from: hlocDate(dateFrom) }),
    hlocIntraday: (tickers, dateFrom, dateTo, timeframe = 15) =>
      hloc({ id: tickers.join(','), count: -1, timeframe, date_from: hlocDate(dateFrom), date_to: hlocDate(dateTo) }),
    marketStatus: () => callAnon({ rest, cmd: 'getMarketStatus', params: { market: '*' }, fetchImpl }),
    checkSession: () => callLegacy({ rest, cmd: 'getSidInfo', sid, fetchImpl }),
  }
}
