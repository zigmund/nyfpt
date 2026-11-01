const MINUS = '−'
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const md = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function parts(v) {
  const neg = v < 0 && usd.format(Math.abs(v)) !== '0.00'
  return { neg, abs: Math.abs(v) }
}

export function money(v, { hide = false, sign = false } = {}) {
  const { neg, abs } = parts(v)
  const s = hide ? '$***' : '$' + usd.format(abs)
  if (neg) return MINUS + s
  return sign && abs > 0 ? '+' + s : s
}

export function pct(v, { sign = true } = {}) {
  const { neg, abs } = parts(v)
  const s = usd.format(abs) + '%'
  if (neg) return MINUS + s
  return sign && s !== '0.00%' ? '+' + s : s
}

export function num(v) {
  return plain.format(v).replace('-', MINUS)
}

// 'YYYY-MM-DD' -> 'Oct 30' (UTC, no timezone shift)
export function dateShort(d) {
  return md.format(new Date(d + 'T00:00:00Z'))
}

export function dateRange(a, b) {
  return `${dateShort(a)} – ${dateShort(b)}`
}
