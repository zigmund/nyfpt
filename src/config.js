// Password/SMS login works only on tradernet.global; add cabinets here to re-enable the selector.
export const CABINETS = [
  { id: 'global', label: 'tradernet.global', rest: 'https://tradernet.global', ws: 'wss://wss.tradernet.global/' },
]
export const DEFAULT_CABINET = 'global'
export const BENCHMARKS = ['SPY.US', 'QQQ.US']
export const MARKET_STRIP = [
  { ticker: 'SP500.IDX', label: 'S&P 500' },
  { ticker: 'NASDAQ.IDX', label: 'Nasdaq 100' },
  { ticker: 'USO.US', label: 'Crude Oil', note: 'USO' },
  { ticker: 'GLD.US', label: 'Gold', note: 'GLD' },
  { ticker: 'SLV.US', label: 'Silver', note: 'SLV' },
]
// Cache TTLs in ms
export const TTL = {
  positions: 90e3,
  trades: 7 * 60e3,
  cashflows: 10 * 60e3,
  quotes: 60e3,
  markets: 60e3,
  intraday: 60e3,
  sparks: 5 * 60e3, // holdings sparklines: 15-min candles
}
export const POLL_MS = 60e3
export const LIVE_RECALC_MS = 3000
