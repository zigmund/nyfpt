import { callLegacy, callAnon, BrokerError, SessionExpiredError } from './transport.js'

// 'YYYY-MM-DD[ T]HH:mm' -> 'DD.MM.YYYY HH:mm'
function hlocDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s)
  if (!m) throw new Error(`Bad date: ${s}`)
  return `${m[3]}.${m[2]}.${m[1]} ${m[4] || '00:00'}`
}

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

  const hloc = (params) => callAnon({ rest, cmd: 'getHloc', params: { ...params, intervalMode: 'ClosedRay' }, fetchImpl })

  return {
    positions: () => authed('getPositionJson'),
    trades: (beginDate) => authed('getTradesHistory', { beginDate }),
    cashflows: () => authed('getUserCashFlows', { groupByType: 1, take: 500, sort: { field: 'date', dir: 'DESC' } }),
    quotes: (tickers) => authed('getStockQuotesJson', { tickers: tickers.join(',') }),
    hlocDaily: (tickers, dateFrom, count = -6) =>
      hloc({ id: tickers.join(','), count, timeframe: 1440, date_from: hlocDate(dateFrom) }),
    hlocIntraday: (tickers, dateFrom, dateTo, timeframe = 15) =>
      hloc({ id: tickers.join(','), count: -1, timeframe, date_from: hlocDate(dateFrom), date_to: hlocDate(dateTo) }),
    marketStatus: () => callAnon({ rest, cmd: 'getMarketStatus', params: { market: '*' }, fetchImpl }),
    checkSession: () => callLegacy({ rest, cmd: 'getSidInfo', sid, fetchImpl }),
  }
}
