// View helpers on top of format.js: null/NaN guards ("—"), hide-aware amounts, tone classes.
import { money, pct, num } from './format.js'

export const DASH = '—'
const MINUS = '\u2212'
const minus = (s) => s.replace('-', MINUS) // en-US numbers use U+2212 for negatives
export const HIDDEN = '***'

/** Finite number or null (broker fields may be null, '', strings or NaN). */
export const n = (v) => {
  if (v === null || v === undefined || v === '') return null
  const x = +v
  return Number.isFinite(x) ? x : null
}

export const fMoney = (v, { hide = false, sign = false } = {}) => {
  const x = n(v)
  if (x === null) return DASH
  return money(x, { hide, sign })
}

export const fPct = (v, opts) => {
  const x = n(v)
  return x === null ? DASH : pct(x, opts)
}

/** Percentage points: +1.20 pp. */
export const fPp = (v) => {
  const x = n(v)
  return x === null ? DASH : pct(x).replace('%', ' pp')
}

const px2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const fPrice = (v) => {
  const x = n(v)
  if (x === null) return DASH
  return minus(Math.abs(x) < 1 ? x.toFixed(4) : px2.format(x))
}

export const fQty = (v, hide = false) => {
  if (hide) return HIDDEN
  const x = n(v)
  return x === null ? DASH : num(x)
}

export const fWeight = (v) => {
  const x = n(v)
  return x === null ? DASH : minus(`${x.toFixed(1)}%`)
}

/** 'pos' | 'neg' | '' by sign; kept for hidden amounts too. */
export const tone = (v) => {
  const x = n(v)
  return x === null || x === 0 ? '' : x > 0 ? 'pos' : 'neg'
}

export const PERIOD_LABELS = { '1d': '1D', '7d': '7D', '1m': '1M', '6m': '6M', YTD: 'YTD', '1Y': '1Y', '5Y': '5Y', All: 'ALL' }
