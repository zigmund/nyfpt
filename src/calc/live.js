// Live calculations: WS quote merging, Yahoo-style day change, live price rows.
// Pure functions; broker numbers may arrive as strings and fields may be missing.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
};

const posNum = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

/** Price of a broker quote: ltp > 0, else null. An index quote may carry ltp 0 (REST all zeros
 *  on a day off, a WS snapshot or delta): 0 is no price, never a price. Every ltp reader uses it. */
export const quotePrice = (q) => posNum(q && q.ltp);

/**
 * Previous close of a broker quote (getStockQuotesJson, WS `quotes`, getSecurityInfo): ONE rule
 * for every caller. `chg` is the broker's day change and `pcp` its percent; `pp` is not trusted
 * first: on a day off a .EU quote carries a `pp` that is not its previous close while chg / pcp
 * are right (verified 2026-11-01).
 *   1. ltp - chg (ltp > 0 and chg known, result > 0);
 *   2. else pp (> 0);
 *   3. else from pcp: ltp / (1 + pcp / 100);
 *   4. else null (an index quote of zeros): callers fall back to their snapshot.
 */
export const quotePrevClose = (q) => {
  if (!q) return null;
  const ltp = quotePrice(q);
  const chg = num(q.chg);
  if (ltp !== null && chg !== null && ltp - chg > 0) return ltp - chg;
  const pp = posNum(q.pp);
  if (pp !== null) return pp;
  const pcp = num(q.pcp);
  if (ltp === null || pcp === null || pcp <= -100) return null;
  return ltp / (1 + pcp / 100);
};

/**
 * Day change % of a security: ONE rule for every view (Holdings, the card header, the markets
 * strip, search rows, news tickers). Callers resolve `last` and `prev` field by field, the live
 * quote first (ltp / quotePrevClose), then their snapshot (Holdings: the REST quote snapshot;
 * security info, position mkt_price / close_price, strip daily closes); `pct` likewise (quote
 * pcp, cached quote, strip change_pct).
 *   1. last vs prev when both are known and prev > 0 (an index quote may carry pp 0);
 *   2. else the broker's own day change % (`pct`);
 *   3. else null (unknown, not zero).
 */
export const dayChangePct = ({ last = null, prev = null, pct = null } = {}) => {
  const l = num(last);
  const p = num(prev);
  if (l !== null && p !== null && p > 0) return ((l - p) / p) * 100;
  return num(pct);
};

/** WS quote: full snapshot first, then deltas with `c` plus changed fields. Returns a new object.
 *  A delta with `ltp` but no `chg` (not seen, not ruled out) must not move the previous close
 *  (quotePrevClose = ltp - chg): chg and pcp are re-derived from the old previous close; without
 *  a usable one the stale chg / pcp are dropped. A delta whose ltp is no price (0, not a number)
 *  keeps the previous ltp, chg and pcp (its other fields still merge). */
export const mergeQuote = (prev, delta) => {
  if (prev && delta && delta.ltp != null && quotePrice(delta) === null) {
    delta = { ...delta };
    delete delta.ltp; delete delta.chg; delete delta.pcp;
  }
  const out = { ...(prev || {}), ...(delta || {}) };
  if (!prev || !delta || num(delta.ltp) === null || delta.chg != null) return out;
  const pl = quotePrice(prev);
  const pc = num(prev.chg);
  const base = pl !== null && pc !== null ? pl - pc : null;
  if (base !== null && base > 0) {
    out.chg = num(delta.ltp) - base;
    if (delta.pcp == null) out.pcp = (out.chg / base) * 100;
  } else {
    delete out.chg;
    if (delta.pcp == null) delete out.pcp;
  }
  return out;
};

/** Price multiplier `k` and USD rate `fx` of a raw position (see holdingsRows); usd = USD currval. */
export const positionFactor = (p, usd = 1) => {
  const q = num(p.q) || 0;
  const mkt = num(p.mkt_price);
  const fx = (num(p.currval) || 0) / usd || 1;
  const mv = num(p.market_value);
  const face = num(p.face_val_a);
  let k = mv !== null && mv !== 0 && q && mkt ? mv / (q * mkt * fx) : null;
  if (k === null || !Number.isFinite(k)) k = face ? face / 100 : 1;
  return { k, fx };
};

/** Positions of a raw `ps` as rows in USD, with quotes applied (`quotes`: anything with
 *  get(ticker), e.g. the live quotes Map, the REST quote snapshot or both). Price: the quote's
 *  ltp (> 0), else mkt_price; previous close: quotePrevClose, else close_price (the broker rolls it
 *  to mkt_price on days off, so it is only the last fallback).
 *  fx = pos.currval / currval_USD (as in parsePositions).
 *  k: multiplier such that q * mkt_price * k * fx == market_value (USD). Derived from the
 *  position itself when all inputs are non-zero (covers bonds quoted in % of face);
 *  otherwise face_val_a/100 for bonds, 1 for others. */
export const holdingsRows = (ps, quotes) => {
  const acc = (ps && ps.acc) || [];
  const usd = num((acc.find((c) => c.curr === 'USD') || {}).currval) || 1;
  const cash = acc.reduce((s, c) => s + (num(c.s) || 0) * (num(c.currval) || 0) / usd, 0);
  const rows = ((ps && ps.pos) || []).map((p) => {
    const quote = (quotes && quotes.get(p.i)) || null;
    const q = num(p.q) || 0;
    const mv = num(p.market_value);
    const { k, fx } = positionFactor(p, usd);
    const mkt = num(p.mkt_price);
    const price = quotePrice(quote) ?? mkt;
    const prevClose = quotePrevClose(quote) ?? posNum(p.close_price);
    const valueUsd = price === null ? (mv ?? 0) : q * price * k * fx;
    const dayChangeUsd = prevClose === null || price === null ? null : q * (price - prevClose) * k * fx;
    return {
      ticker: p.i, name: p.name, qty: q, price, prevClose, dayChangePct: dayChangePct({ last: price, prev: prevClose }),
      dayChangeUsd, valueUsd, weight: 0, currency: p.curr,
    };
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
  for (const [t, q] of quotes) { const p = quotePrice(q); if (p !== null) live.set(t, p); }
  const out = priceRows.map((r) => (r.date === today && live.has(r.ticker) ? { ...r, close: live.get(r.ticker) } : r));
  for (const [t, p] of live) {
    if (!out.some((r) => r.ticker === t && r.date === today)) out.push({ ticker: t, date: today, close: p, window_start: ws[t] ?? fallbackWs });
  }
  return out;
};
