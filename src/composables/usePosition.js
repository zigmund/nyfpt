// Security card data for one ticker (held or not): security info + candles (repo, TTL-gated), the
// live quote (held / strip / benchmark tickers only), the broker position and the derived price, day
// change, My holdings and key statistics.
import { computed, onScopeDispose, watch } from 'vue'
import { useApp } from './useApp.js'
import { n } from '../display.js'
import { keyStats, positionHolding } from '../calc/position.js'
import { dayChangePct, quotePrice, regularCloses, regularQuote } from '../calc/live.js'
import { formatLocal, wallToUtc } from '../calc/marketTime.js'

const REFRESH_MS = 60e3
const EMPTY = { info: null, intraday: null, daily: null, max: null, sessions: null, clock: null, today: null, errors: {}, loading: [] }
const posN = (v) => {
  const x = n(v)
  return x !== null && x > 0 ? x : null
}
const fmtDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/**
 * Broker `ltt` 'YYYY-MM-DDTHH:mm[:ss]' (exchange wall clock, no zone) -> 'Oct 31, 2026, 4:58 AM GMT+5'
 * in the user's zone (or `timeZone`); `mc`: the security market's clock (marketClockFor).
 * null if unparsable or the market's offset is unknown.
 */
export function lastTradeTime(ltt, mc, timeZone) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(ltt || ''))
  // Before 2000: no trade time (an index answers '1970-01-01T00:00:00' with zero prices).
  if (!m || Number(m[2]) > 23 || m[1] < '2000') return null
  const wall = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}Z`) / 1000
  return Number.isFinite(wall) ? formatLocal(wallToUtc(wall, mc), timeZone) : null
}

/**
 * @param {string} ticker
 * @param {{parts: () => string[]}} opts repo parts the current view needs besides 'info', 'daily', 'intraday'
 */
export function usePosition(ticker, { parts = () => [] } = {}) {
  const app = useApp()

  const sec = computed(() => {
    void app.tick.value
    return app.security?.(ticker) || EMPTY
  })
  const info = computed(() => sec.value.info)
  const raw = computed(() => (app.state.value?.rawPs?.pos || []).find((p) => p.i === ticker) || null)
  // Streamed quote (latest price even when its market is closed); live only when this
  // security's own market is open.
  const quote = computed(() => {
    void app.tick.value
    const q = app.liveQuotesForCalc()?.get(ticker)
    return quotePrice(q) !== null ? q : null
  })
  const isLive = computed(() => {
    void app.tick.value
    return !!quote.value && !!app.isLiveFor?.(ticker)
  })

  // Close of the daily candle `back` candles before the last (an index's security info has zero prices).
  const dailyClose = (back) => {
    const d = sec.value.daily
    return d && d.length > back ? posN(d[d.length - 1 - back].close) : null
  }
  const infoPrice = computed(() => posN(info.value?.ltp))
  // calc/live regularQuote (Task 51): US on the regular close, sessions named by the card's own
  // intraday bars; other markets: ltp and quotePrevClose (ltp - chg, then pp, then pcp).
  const closes = computed(() => regularCloses(sec.value.intraday, sec.value.clock))
  const regQuote = computed(() => (quote.value ? regularQuote(quote.value, sec.value.clock, closes.value) : null))
  const regInfo = computed(() => regularQuote(info.value, sec.value.clock, closes.value))
  const reg = computed(() => regQuote.value || regInfo.value)
  const price = computed(() => regQuote.value?.price ?? regInfo.value.price ?? posN(raw.value?.mkt_price) ?? dailyClose(0))
  const prevClose = computed(() => regQuote.value?.prev ?? regInfo.value.prev ?? posN(raw.value?.close_price) ?? dailyClose(1))
  /** Session date of the price when known (US: the regular close's day; null otherwise). */
  const priceDay = computed(() => reg.value.day)
  /** The trade outside the regular session (US): {kind: 'post' | 'pre', price, change, pct, ltt}. */
  const ext = computed(() => reg.value.ext)
  const extAt = computed(() => (ext.value ? lastTradeTime(ext.value.ltt, sec.value.clock) : null))
  const change = computed(() => (price.value !== null && prevClose.value !== null ? price.value - prevClose.value : null))
  const changePct = computed(() => dayChangePct({ last: price.value, prev: prevClose.value }))

  const holding = computed(() => positionHolding(app.state.value?.rawPs, ticker, { price: price.value, prevClose: prevClose.value }))
  const stats = computed(() => keyStats({
    ticker, info: info.value, daily: sec.value.daily, intraday: sec.value.intraday, sessions: sec.value.sessions, clock: sec.value.clock, today: sec.value.today,
    prevClose: regInfo.value.prev,
  }))

  // A ticker without a position or security info (an index): its strip card label or search name.
  const known = computed(() => app.marketStrip?.value?.find((m) => m.ticker === ticker)?.label
    || (app.recent?.value || []).find((r) => r.ticker === ticker)?.name || null)
  const name = computed(() => raw.value?.name || info.value?.name || info.value?.short_name || known.value || ticker)
  const currency = computed(() => info.value?.x_curr || raw.value?.curr || null)
  const exchange = computed(() => info.value?.codesub_nm || info.value?.ltr || null)
  const kind = computed(() => n(info.value?.kind))
  /** This security's market is open (no streamed quote needed: a ticker the app does not track). */
  const marketOpen = computed(() => {
    void app.tick.value
    return isLive.value || !!app.marketOpen?.(info.value?.ltr || quote.value?.ltr)
  })
  /** 'At close' / 'As of' time: last trade time in the user's zone, else the last daily candle's date.
   *  US with a trade outside the session: the regular close of the price's day (16:00 New York). */
  const closedAt = computed(() => {
    const mc = sec.value.clock
    if (ext.value && priceDay.value && mc && mc.regular != null) {
      const wall = Date.parse(`${priceDay.value}T00:00:00Z`) / 1000 + mc.regular * 60
      const at = formatLocal(wallToUtc(wall, mc))
      if (at) return at
    }
    // A trade time without a price is not one.
    const at = infoPrice.value === null ? null : lastTradeTime(info.value?.ltt, sec.value.clock)
    if (at) return at
    const d = sec.value.daily
    return d && d.length ? fmtDay.format(new Date(`${d[d.length - 1].date}T00:00:00Z`)) : null
  })

  function load(force = false) {
    // intraday: the regular-session Open in Key statistics, whatever the chart period
    const want = ['info', 'daily', 'intraday', ...parts()]
    return Promise.resolve(app.loadSecurity?.(ticker, [...new Set(want)], { force })).catch(() => {})
  }
  // A repo without this ticker's data (account attached after the card opened, cache cleared): load.
  watch(() => !!app.state.value && !sec.value.info && !sec.value.loading.length && !Object.keys(sec.value.errors).length,
    (need) => { if (need) load() })
  // TTL-gated in the repo: the timer only re-checks; nothing is fetched while hidden.
  const doc = globalThis.document
  const timer = setInterval(() => { if (!doc?.hidden) load() }, REFRESH_MS)
  onScopeDispose(() => clearInterval(timer))

  return {
    ticker, sec, info, raw, quote, isLive, price, prevClose, priceDay, ext, extAt, change, changePct, holding, stats,
    name, currency, exchange, kind, marketOpen, closedAt, load,
  }
}
