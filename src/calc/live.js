// Live calculations: WS quote merging, Yahoo-style day change, live price rows.
// Pure functions; broker numbers may arrive as strings and fields may be missing.
import { axisAt, barSeconds, isSessionDay } from './marketTime.js'

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

// A quote value names the same session as a bar close when within this share of it AND closer to it
// than to the neighbouring session's bar close: the closing auction differs from the last trade
// before 16:00 by cents (verified 2026-11-01: 0.01-0.04%); quiet days move less than 0.5%.
const REGULAR_MATCH = 0.001
const SAME = 1e-9
const MAX_BAR_S = 3600 // regularCloses: intraday bars up to an hour (15 / 60 min); longer steps are not judged
const NO_CLOSES = new Map()

/** Day and wall minute of a broker `ltt` ('YYYY-MM-DDTHH:mm[:ss]', exchange wall clock); null if
 *  absent, unparsable or before 2000 (an index answers '1970-01-01T00:00:00'). */
export const lttWall = (ltt) => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(String(ltt || ''))
  if (!m || m[1] < '2000' || Number(m[2]) > 23) return null
  return { day: m[1], min: Number(m[2]) * 60 + Number(m[3]) }
}

/**
 * Where a quote's last trade falls against the regular session of a market that has a regular
 * close (`mc` = marketClockFor: open / regular in exchange wall minutes; the broker sends `post`
 * only for the US market FIX): {day, phase: 'pre' (before the open) | 'regular' | 'post' (from
 * the regular close on)}. null for other markets, without a trade time, on a weekend.
 */
export const tradePhase = (q, mc) => {
  if (!q || !mc || mc.open == null || mc.regular == null) return null
  const w = lttWall(q.ltt)
  if (!w || !isSessionDay(w.day)) return null
  return { day: w.day, phase: w.min < mc.open ? 'pre' : w.min < mc.regular ? 'regular' : 'post' }
}

/**
 * Regular closes per date from one ticker's intraday bars [{ts, date, close}]: the close of the
 * last bar that ends by the regular close (bar start + bar length <= mc.regular) and ends after
 * the open (a pre-market-only day has none). Any timeframe (15 or 60 minutes). Only complete
 * sessions: some bar of the date ends at or after the regular close (a running session has no
 * close yet) and, with `asOf` (ms: when the bars were fetched), had ended by then (a 15:45 bar
 * fetched at 15:50 was still forming). Weekdays only; the bar length must be known (two bars at least, an hour at most). Empty without a
 * regular close (markets other than US). Map date -> close. Half days (13:00 close) are not
 * known: their close is the last trade before 16:00.
 */
export const regularCloses = (rows, mc, asOf = null) => {
  const out = new Map()
  if (!rows || !rows.length || !mc || !Number.isFinite(mc.offset) || mc.open == null || mc.regular == null) return out
  const bar = barSeconds(rows)
  if (!bar || bar > MAX_BAR_S) return out
  // Axis seconds of the fetch time (axis + offset = wall = UTC + offset - dt); not judged without dt.
  const cut = Number.isFinite(asOf) && Number.isFinite(mc.dt) ? asOf / 1000 - mc.dt * 60 : Infinity
  const best = new Map()
  const done = new Set()
  for (const r of rows) {
    const c = posNum(r && r.close)
    if (c === null || !Number.isFinite(r.ts) || !r.date || !isSessionDay(r.date)) continue
    const end = r.ts + bar
    if (end > cut) continue
    const close = axisAt(mc.offset, r.date, mc.regular)
    if (end >= close) done.add(r.date)
    if (end > close || end <= axisAt(mc.offset, r.date, mc.open)) continue
    const b = best.get(r.date)
    if (!b || r.ts > b.ts) best.set(r.date, { ts: r.ts, close: c })
  }
  for (const [d, b] of best) if (done.has(d)) out.set(d, b.close)
  return out
}

/**
 * Regular price of a quote: ONE rule for Holdings, the card, the strip, search and news (Task 51,
 * Yahoo's "At close" price). Returns {price, prev, pct, day, ext}:
 *   price  regular price; prev  previous regular close; pct  the broker's day change % (null when
 *   the price is not the quote's ltp); day  session date of `price` (null when unknown);
 *   ext    {kind: 'post' | 'pre', price: ltp, change, pct, ltt}: the trade outside the session.
 * Markets without a regular close (all but US), quotes without a trade time and trades inside the
 * regular session: the quote itself (ltp, quotePrevClose, pcp). Outside the regular session
 * (tradePhase), with `closes` (regularCloses of the ticker's intraday bars) naming the sessions:
 *   post  the close of the trade's day; pre  the last close before the trade's day;
 *   prev  the close of the session before; an official quote value replaces a bar close of the
 *         same session when within REGULAR_MATCH of it and closer to it than to the neighbouring
 *         session's (ClosePrice for the close, ltp - chg / pp for prev; a prev equal to ClosePrice
 *         names the same session and is never the previous close).
 * Without bars: after the close, ClosePrice against quotePrevClose (verified on a day off,
 * 2026-11-01: ClosePrice = that day's regular close, ltp - chg = the one before; equal: no
 * previous close); before the open the broker's own change (which session ClosePrice / pp name
 * then is not verified). A trade at the regular price (a closing print stamped 16:00:0x) is no
 * after-hours trade: no `ext`.
 */
export const regularQuote = (q, mc, closes = null) => {
  const ltp = quotePrice(q)
  const plain = { price: ltp, prev: quotePrevClose(q), pct: ltp === null ? null : num(q.pcp), day: null, ext: null }
  const ph = ltp === null ? null : tradePhase(q, mc)
  if (!ph) return plain
  if (ph.phase === 'regular') return { ...plain, day: ph.day }
  const cl = closes || NO_CLOSES
  const dates = [...cl.keys()].sort()
  const before = (d) => dates.filter((x) => x < d).pop() ?? null
  // v is the close `b` names: within REGULAR_MATCH and nearer to b than to the other session's `o`.
  const names = (v, b, o) => v !== null && b != null && Math.abs(v - b) <= REGULAR_MATCH * b
    && (o == null || Math.abs(v - b) < Math.abs(v - o))
  const day = ph.phase === 'post' ? ph.day : before(ph.day)
  const bar = day ? cl.get(day) ?? null : null
  const cp = posNum(q.ClosePrice)
  let pq = plain.prev
  if (pq !== null && cp !== null && Math.abs(pq - cp) < SAME) pq = null // both name one session
  let price
  let prev
  if (bar !== null) {
    const pbar = cl.get(before(day)) ?? null
    price = names(cp, bar, pbar) ? cp : bar
    // No bar of the session before: after the close the official prev, unless it names the
    // price's session too (within REGULAR_MATCH of the price).
    const same = pq !== null && Math.abs(pq - price) <= REGULAR_MATCH * price
    prev = pbar !== null ? (names(pq, pbar, bar) ? pq : pbar) : ph.phase === 'post' && !same ? pq : null
  } else if (ph.phase === 'post' && cp !== null) {
    price = cp
    prev = pq
  } else {
    return plain
  }
  const ext = Math.abs(ltp - price) < SAME ? null : { kind: ph.phase, price: ltp, change: ltp - price, pct: (ltp / price - 1) * 100, ltt: q.ltt }
  return { price, prev, pct: null, day, ext }
}

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

// The quote as it is: ltp and quotePrevClose (resolve default of holdingsRows / livePriceRows).
const plainQuote = (t, q) => ({ price: quotePrice(q), prev: quotePrevClose(q), day: null })

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
 *  get(ticker), e.g. the live quotes Map, the REST quote snapshot or both). `resolve(ticker,
 *  quote)` -> {price, prev}: the regular price rule (regularQuote with the ticker's market and
 *  bars; default: the quote's ltp and quotePrevClose). Price: the resolved price, else mkt_price;
 *  previous close: the resolved one, else close_price (the broker rolls it to mkt_price on days
 *  off, so it is only the last fallback).
 *  fx = pos.currval / currval_USD (as in parsePositions).
 *  k: multiplier such that q * mkt_price * k * fx == market_value (USD). Derived from the
 *  position itself when all inputs are non-zero (covers bonds quoted in % of face);
 *  otherwise face_val_a/100 for bonds, 1 for others. */
export const holdingsRows = (ps, quotes, resolve = plainQuote) => {
  const acc = (ps && ps.acc) || [];
  const usd = num((acc.find((c) => c.curr === 'USD') || {}).currval) || 1;
  const cash = acc.reduce((s, c) => s + (num(c.s) || 0) * (num(c.currval) || 0) / usd, 0);
  const rows = ((ps && ps.pos) || []).map((p) => {
    const quote = (quotes && quotes.get(p.i)) || null;
    const q = num(p.q) || 0;
    const mv = num(p.market_value);
    const { k, fx } = positionFactor(p, usd);
    const mkt = num(p.mkt_price);
    const reg = resolve(p.i, quote) || {};
    const price = reg.price ?? mkt;
    const prevClose = reg.prev ?? posNum(p.close_price);
    const valueUsd = price === null ? (mv ?? 0) : q * price * k * fx;
    const dayChangeUsd = prevClose === null || price === null ? null : q * (price - prevClose) * k * fx;
    return {
      ticker: p.i, name: p.name, qty: q, price, prevClose, priceDay: reg.day ?? null, dayChangePct: dayChangePct({ last: price, prev: prevClose }),
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

/** Replace/add the `today` row per ticker with a live price; history untouched. `resolve(ticker,
 *  quote)` -> {price, day} (regularQuote; default: ltp): a price of another session (`day` set and
 *  not today: a pre-market quote's last regular close) adds no row for today. */
export const livePriceRows = (priceRows, quotes, today, resolve = plainQuote) => {
  if (!priceRows.length || !quotes) return priceRows;
  const ws = {};
  for (const r of priceRows) if (!(r.ticker in ws)) ws[r.ticker] = r.window_start;
  const fallbackWs = priceRows[0].window_start;
  const live = new Map();
  for (const [t, q] of quotes) {
    const r = resolve(t, q) || {};
    if (r.price != null && (!r.day || r.day === today)) live.set(t, r.price);
  }
  const out = priceRows.map((r) => (r.date === today && live.has(r.ticker) ? { ...r, close: live.get(r.ticker) } : r));
  for (const [t, p] of live) {
    if (!out.some((r) => r.ticker === t && r.date === today)) out.push({ ticker: t, date: today, close: p, window_start: ws[t] ?? fallbackWs });
  }
  return out;
};
