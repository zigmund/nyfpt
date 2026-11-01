// Position card data for one ticker: security info + candles (repo, TTL-gated), the live quote,
// the broker position and the derived price, day change, My holdings and key statistics.
import { computed, onScopeDispose, watch } from 'vue'
import { useApp } from './useApp.js'
import { n } from '../display.js'
import { keyStats, positionHolding } from '../calc/position.js'

const REFRESH_MS = 60e3
const EMPTY = { info: null, intraday: null, daily: null, max: null, sessions: null, errors: {}, loading: [] }
const posN = (v) => {
  const x = n(v)
  return x !== null && x > 0 ? x : null
}
const fmtDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** Broker 'YYYY-MM-DDTHH:mm[:ss]' (exchange wall clock, no zone) -> 'Oct 30, 2026, 7:58 PM'; null if unparsable. */
export function lastTradeTime(ltt) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(String(ltt || ''))
  if (!m) return null
  const d = new Date(`${m[1]}T00:00:00Z`)
  const h = Number(m[2])
  if (Number.isNaN(d.getTime()) || h > 23) return null
  return `${fmtDay.format(d)}, ${h % 12 || 12}:${m[3]} ${h < 12 ? 'AM' : 'PM'}`
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
    return q && n(q.ltp) !== null ? q : null
  })
  const isLive = computed(() => {
    void app.tick.value
    return !!quote.value && !!app.isLiveFor?.(ticker)
  })

  const price = computed(() => n(quote.value?.ltp) ?? posN(info.value?.ltp) ?? posN(raw.value?.mkt_price))
  // `pp`: the broker's day change (chg = ltp - pp) is measured from it.
  const prevClose = computed(() => posN(quote.value?.pp) ?? posN(info.value?.pp) ?? posN(raw.value?.close_price))
  const change = computed(() => (price.value !== null && prevClose.value !== null ? price.value - prevClose.value : null))
  const changePct = computed(() => (change.value === null ? null : (change.value / prevClose.value) * 100))

  const holding = computed(() => positionHolding(app.state.value?.rawPs, ticker, { price: price.value, prevClose: prevClose.value }))
  const stats = computed(() => keyStats({
    info: info.value, daily: sec.value.daily, intraday: sec.value.intraday, sessions: sec.value.sessions,
  }))

  const name = computed(() => raw.value?.name || info.value?.name || info.value?.short_name || ticker)
  const currency = computed(() => info.value?.x_curr || raw.value?.curr || null)
  const exchange = computed(() => info.value?.codesub_nm || info.value?.ltr || null)
  const kind = computed(() => n(info.value?.kind))
  /** 'At close' time: last trade time, else the last daily candle's date. */
  const closedAt = computed(() => {
    const at = lastTradeTime(info.value?.ltt)
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
    ticker, sec, info, raw, quote, isLive, price, prevClose, change, changePct, holding, stats,
    name, currency, exchange, kind, closedAt, load,
  }
}
