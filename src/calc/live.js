// Live calculations: WS quote merging, Yahoo-style day change, live price rows.
// Pure functions; broker numbers may arrive as strings and fields may be missing.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
};

/** WS quote: full snapshot first, then deltas with `c` plus changed fields. Returns a new object. */
export const mergeQuote = (prev, delta) => ({ ...(prev || {}), ...(delta || {}) });

/** Positions of a raw `ps` as rows in USD, with live quotes applied.
 *  fx = pos.currval / currval_USD (as in parsePositions).
 *  k: multiplier such that q * mkt_price * k * fx == market_value (USD). Derived from the
 *  position itself when all inputs are non-zero (covers bonds quoted in % of face);
 *  otherwise face_val_a/100 for bonds, 1 for others. */
export const holdingsRows = (ps, quotes) => {
  const acc = (ps && ps.acc) || [];
  const usd = num((acc.find((c) => c.curr === 'USD') || {}).currval) || 1;
  const cash = acc.reduce((s, c) => s + (num(c.s) || 0) * (num(c.currval) || 0) / usd, 0);
  const rows = ((ps && ps.pos) || []).map((p) => {
    const quote = (quotes && quotes.get(p.i)) || {};
    const q = num(p.q) || 0;
    const mkt = num(p.mkt_price);
    const fx = (num(p.currval) || 0) / usd || 1;
    const mv = num(p.market_value);
    const face = num(p.face_val_a);
    let k = mv !== null && mv !== 0 && q && mkt ? mv / (q * mkt * fx) : null;
    if (k === null || !Number.isFinite(k)) k = face ? face / 100 : 1;
    const price = num(quote.ltp) ?? mkt;
    const pp = num(quote.pp) ?? num(p.close_price);
    const prevClose = pp ? pp : null;
    const valueUsd = price === null ? (mv ?? 0) : q * price * k * fx;
    const dayChangeUsd = prevClose === null || price === null ? null : q * (price - prevClose) * k * fx;
    const dayChangePct = prevClose === null || price === null ? null : ((price - prevClose) / prevClose) * 100;
    return { ticker: p.i, name: p.name, qty: q, price, prevClose, dayChangePct, dayChangeUsd, valueUsd, weight: 0, currency: p.curr };
  });
  const total = cash + rows.reduce((s, r) => s + r.valueUsd, 0);
  for (const r of rows) r.weight = total ? r.valueUsd / total : 0;
  return rows;
};

/** Portfolio-level day change: pct = sum(change) / (sum(value) - sum(change)) * 100.
 *  null change and pct when no row has a known day change (unknown, not zero). */
export const holdingsTotal = (rows) => {
  const valueUsd = rows.reduce((s, r) => s + r.valueUsd, 0);
  if (!rows.some((r) => r.dayChangeUsd != null)) return { valueUsd, dayChangeUsd: null, dayChangePct: null };
  const dayChangeUsd = rows.reduce((s, r) => s + (r.dayChangeUsd || 0), 0);
  const base = valueUsd - dayChangeUsd;
  return { valueUsd, dayChangeUsd, dayChangePct: base ? (dayChangeUsd / base) * 100 : null };
};

/** Replace/add the `today` row per ticker with a live price (close = ltp); history untouched. */
export const livePriceRows = (priceRows, quotes, today) => {
  if (!priceRows.length || !quotes) return priceRows;
  const ws = {};
  for (const r of priceRows) if (!(r.ticker in ws)) ws[r.ticker] = r.window_start;
  const fallbackWs = priceRows[0].window_start;
  const live = new Map();
  for (const [t, q] of quotes) { const p = num(q && q.ltp); if (p !== null) live.set(t, p); }
  const out = priceRows.map((r) => (r.date === today && live.has(r.ticker) ? { ...r, close: live.get(r.ticker) } : r));
  for (const [t, p] of live) {
    if (!out.some((r) => r.ticker === t && r.date === today)) out.push({ ticker: t, date: today, close: p, window_start: ws[t] ?? fallbackWs });
  }
  return out;
};
