// UI strings (English only). Later tasks add their keys here.
const en = {
  'app.name': 'Portfolio',
  'status.updated': 'Updated {time}',
  'error.usdOnly': 'Only USD accounts are supported for now.',
}

// t(key, vars) -> string; replaces {name}, unknown key returns the key
export function t(key, vars) {
  const s = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}
