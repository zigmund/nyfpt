import { describe, it, expect } from 'vitest';
import fx from './fixtures/synthetic-api.json';
import {
  parsePositions, parseTrades, parseCashflows, parsePricesForPeriod, computeCore,
} from '../src/calc/portfolio.js';
import { mergeQuote, holdingsRows, holdingsTotal, livePriceRows, dayChangePct, quotePrevClose } from '../src/calc/live.js';

// Synthetic market clock: broker server at UTC+3 (axis + 3 h = exchange wall clock, daily bar = server midnight).
const SRV3 = { offset: 10800, markets: {} };

const ps = {
  acc: [{ curr: 'USD', currval: 1, s: 1000 }, { curr: 'KZT', currval: 0.002, s: 500000 }],
  pos: [
    { i: 'AAA.US', name: 'Alpha', q: '10', mkt_price: '100', close_price: '98', market_value: '1000', curr: 'USD', currval: 1, face_val_a: 0 },
    // KZT stock: 100 sh @ 5000 KZT, fx 0.002 -> $1000
    { i: 'KZ.KZ', name: 'Kaz', q: 100, mkt_price: 5000, close_price: 4900, market_value: 1000, curr: 'KZT', currval: 0.002, face_val_a: 0 },
    // bond: 2 pcs, price 98.5 % of face 1000 -> 985 each -> $1970
    { i: 'BOND', name: 'Bond', q: 2, mkt_price: 98.5, close_price: 98, market_value: 1970, curr: 'USD', currval: 1, face_val_a: 1000 },
  ],
};
const by = (rows) => Object.fromEntries(rows.map((r) => [r.ticker, r]));

describe('mergeQuote', () => {
  it('snapshot then delta keeps unchanged fields and does not mutate', () => {
    const snap = { c: 'AAA.US', ltp: 100, pp: 98, chg: 2 };
    const m = mergeQuote(undefined, snap);
    expect(m).toEqual(snap);
    const m2 = mergeQuote(m, { c: 'AAA.US', ltp: 101 });
    expect(m2).toEqual({ c: 'AAA.US', ltp: 101, pp: 98, chg: 2 });
    expect(m).toEqual(snap);
  });
});

describe('dayChangePct (one rule for holdings, card, strip, search and news)', () => {
  it('price vs previous close wins over the broker pct; pct when they cannot be used; null otherwise', () => {
    expect(dayChangePct({ last: 102, prev: 100, pct: 9.99 })).toBeCloseTo(2, 10);
    expect(dayChangePct({ last: '102', prev: '100' })).toBeCloseTo(2, 10);
    expect(dayChangePct({ last: 102, prev: 0, pct: 1.5 })).toBe(1.5); // index pp 0
    expect(dayChangePct({ last: null, prev: 100, pct: -0.5 })).toBe(-0.5);
    expect(dayChangePct({ last: 102, prev: null, pct: '0' })).toBe(0);
    expect(dayChangePct({ last: 102 })).toBeNull();
    expect(dayChangePct({})).toBeNull();
    expect(dayChangePct()).toBeNull();
  });
});

describe('holdingsRows', () => {
  it('day change converts currency and bond face; valueUsd matches market_value', () => {
    const rows = by(holdingsRows(ps, new Map()));
    expect(rows['AAA.US'].valueUsd).toBeCloseTo(1000, 6);
    expect(rows['KZ.KZ'].valueUsd).toBeCloseTo(1000, 6);
    expect(rows.BOND.valueUsd).toBeCloseTo(1970, 6);
    // AAA: 10*(100-98)=20 ; KZ: 100*(5000-4900)*0.002=20 ; BOND: 2*(98.5-98)*10=10
    expect(rows['AAA.US'].dayChangeUsd).toBeCloseTo(20, 6);
    expect(rows['KZ.KZ'].dayChangeUsd).toBeCloseTo(20, 6);
    expect(rows.BOND.dayChangeUsd).toBeCloseTo(10, 6);
    expect(rows['AAA.US'].dayChangePct).toBeCloseTo((2 / 98) * 100, 6);
    // total = 1000+1000+1970 positions + 1000 cash + 500000*0.002=1000 cash
    expect(rows['AAA.US'].weight).toBeCloseTo(1000 / 5970, 6);
    expect(rows['KZ.KZ'].currency).toBe('KZT');
  });

  it('live quote overrides price and prevClose', () => {
    const q = new Map([['AAA.US', { c: 'AAA.US', ltp: 110, pp: 100 }]]);
    const r = by(holdingsRows(ps, q))['AAA.US'];
    expect(r.price).toBe(110);
    expect(r.prevClose).toBe(100);
    expect(r.valueUsd).toBeCloseTo(1100, 6);
    expect(r.dayChangeUsd).toBeCloseTo(100, 6);
    expect(r.dayChangePct).toBeCloseTo(10, 6);
  });

  it('missing/NaN fields never produce NaN; missing prevClose gives null', () => {
    const bad = { acc: [{ curr: 'USD', currval: 1, s: 0 }], pos: [{ i: 'X', q: 5, mkt_price: 10, market_value: 50, curr: 'USD', currval: 1 }] };
    const r = holdingsRows(bad, new Map([['X', { c: 'X', ltp: 'abc', pp: 0 }]]))[0];
    expect(r.price).toBe(10);
    expect(r.prevClose).toBeNull();
    expect(r.dayChangePct).toBeNull();
    expect(r.dayChangeUsd).toBeNull();
    expect(r.valueUsd).toBeCloseTo(50, 6);
  });
});

// Task 42: the broker's previous close of a quote (getStockQuotesJson / WS / getSecurityInfo).
// Verified 2026-11-01 (Sunday): chg / pcp are right for every market, `pp` of a .EU quote is not.
describe('quotePrevClose (one rule for every caller)', () => {
  it('ltp - chg first: a .EU quote with a wrong pp', () => {
    expect(quotePrevClose({ ltp: 100.5, chg: -2.5, pcp: -2.43, pp: 97.1 })).toBeCloseTo(103, 9);
    expect(quotePrevClose({ ltp: '100.5', chg: '-2.5', pp: '97.1' })).toBeCloseTo(103, 9);
    expect(quotePrevClose({ ltp: 50, chg: 0, pp: 49 })).toBe(50); // no trade yet: unchanged
  });

  it('then pp (> 0), then from pcp: ltp / (1 + pcp / 100)', () => {
    expect(quotePrevClose({ ltp: 110, pp: 100 })).toBe(100);
    expect(quotePrevClose({ ltp: 110, pp: 0, pcp: 10 })).toBeCloseTo(100, 9);
    expect(quotePrevClose({ ltp: 110, pcp: '10' })).toBeCloseTo(100, 9);
    expect(quotePrevClose({ pp: 100 })).toBe(100); // no ltp: pp still
  });

  it('unknown is null: an index quote of zeros, empty or broken quotes', () => {
    expect(quotePrevClose({ c: 'IDX.IDX', ltp: 0, pp: 0, chg: 0, pcp: 0 })).toBeNull();
    expect(quotePrevClose({ ltp: 'abc', chg: 1 })).toBeNull();
    expect(quotePrevClose({ ltp: 1, chg: 1 })).toBeNull(); // prev 0 is not a close
    expect(quotePrevClose({ ltp: 10, pcp: -100 })).toBeNull();
    expect(quotePrevClose({})).toBeNull();
    expect(quotePrevClose(null)).toBeNull();
    expect(quotePrevClose(undefined)).toBeNull();
  });
});

describe('holdingsRows on a market day off (Task 42)', () => {
  // Like getPositionJson on a Sunday: .EU / KASE close_price rolled to mkt_price; .US close_price =
  // the Friday regular close and mkt_price = the last post-market trade.
  const sunday = {
    acc: [{ curr: 'USD', currval: 1, s: 0 }],
    pos: [
      { i: 'EEE.EU', q: 10, mkt_price: 100.5, close_price: 100.5, market_value: 1005, curr: 'USD', currval: 1 },
      { i: 'KKK_KZ.KZ', q: 4, mkt_price: 20, close_price: 20, market_value: 80, curr: 'USD', currval: 1 },
      { i: 'UUU.US', q: 2, mkt_price: 51, close_price: 50, market_value: 102, curr: 'USD', currval: 1 },
    ],
  };
  // getStockQuotesJson the same day: chg vs the previous session close; .EU pp wrong.
  const quotes = new Map([
    ['EEE.EU', { c: 'EEE.EU', ltp: 100.5, chg: -2.5, pcp: -2.43, pp: 97.1 }],
    ['KKK_KZ.KZ', { c: 'KKK_KZ.KZ', ltp: 20, chg: 0.5, pcp: 2.56, pp: 19.5 }],
    ['UUU.US', { c: 'UUU.US', ltp: 51, chg: -1, pcp: -1.92, pp: 52 }],
  ]);

  it('Day = the last session change from the quote, not 0 (rolled close) and not the post-market move', () => {
    const r = by(holdingsRows(sunday, quotes));
    expect(r['EEE.EU'].prevClose).toBeCloseTo(103, 9);
    expect(r['EEE.EU'].dayChangeUsd).toBeCloseTo(-25, 6);
    expect(r['EEE.EU'].dayChangePct).toBeCloseTo((-2.5 / 103) * 100, 6);
    expect(r['KKK_KZ.KZ'].dayChangeUsd).toBeCloseTo(2, 6);
    expect(r['UUU.US'].prevClose).toBe(52);
    expect(r['UUU.US'].dayChangeUsd).toBeCloseTo(-2, 6);
    expect(holdingsTotal(Object.values(r)).dayChangeUsd).toBeCloseTo(-25, 6);
    // without quotes: the old snapshot rule (close_price) is the last fallback
    expect(by(holdingsRows(sunday, new Map()))['EEE.EU'].dayChangeUsd).toBe(0);
  });

  it('a quote price of 0 (no trades, e.g. a bond) keeps the position price', () => {
    const r = holdingsRows(sunday, new Map([['EEE.EU', { c: 'EEE.EU', ltp: 0, chg: 0, pp: 0, pcp: 0 }]]))[0];
    expect(r.price).toBe(100.5);
    expect(r.valueUsd).toBeCloseTo(1005, 6);
    expect(r.prevClose).toBe(100.5); // close_price fallback
  });

  it('quotes may be any {get}: the live quote first, then the snapshot', () => {
    const live = new Map([['UUU.US', { c: 'UUU.US', ltp: 53, chg: 1, pp: 52 }]]);
    const r = by(holdingsRows(sunday, { get: (t) => live.get(t) ?? quotes.get(t) }));
    expect(r['UUU.US'].price).toBe(53);
    expect(r['EEE.EU'].prevClose).toBeCloseTo(103, 9);
  });
});

describe('holdingsTotal', () => {
  it('sums and computes pct over previous value', () => {
    const t = holdingsTotal([
      { valueUsd: 1020, dayChangeUsd: 20 }, { valueUsd: 500, dayChangeUsd: null }, { valueUsd: 480, dayChangeUsd: -30 },
    ]);
    expect(t.valueUsd).toBe(2000);
    expect(t.dayChangeUsd).toBe(-10);
    expect(t.dayChangePct).toBeCloseTo((-10 / 2010) * 100, 9);
  });
});

describe('holdingsTotal without any known day change', () => {
  it('reports null day change and pct (UI: dash), not zero', () => {
    const t = holdingsTotal([{ valueUsd: 1000, dayChangeUsd: null }, { valueUsd: 500, dayChangeUsd: null }]);
    expect(t.valueUsd).toBe(1500);
    expect(t.dayChangeUsd).toBe(null);
    expect(t.dayChangePct).toBe(null);
    expect(holdingsTotal([])).toEqual({ valueUsd: 0, dayChangeUsd: null, dayChangePct: null });
  });
});

describe('livePriceRows', () => {
  const rows = [
    { ticker: 'A', date: '2026-10-12', close: 1, window_start: '2026-10-05' },
    { ticker: 'A', date: '2026-10-13', close: 2, window_start: '2026-10-05' },
    { ticker: 'B', date: '2026-10-12', close: 5, window_start: '2026-10-05' },
  ];
  it('replaces today row, adds missing one, keeps history', () => {
    const q = new Map([['A', { ltp: 3 }], ['B', { ltp: 6 }], ['Z', { ltp: 'x' }]]);
    const out = livePriceRows(rows, q, '2026-10-13');
    expect(out.filter((r) => r.ticker === 'A')).toEqual([
      { ticker: 'A', date: '2026-10-12', close: 1, window_start: '2026-10-05' },
      { ticker: 'A', date: '2026-10-13', close: 3, window_start: '2026-10-05' },
    ]);
    expect(out.find((r) => r.ticker === 'B' && r.date === '2026-10-13')).toEqual({ ticker: 'B', date: '2026-10-13', close: 6, window_start: '2026-10-05' });
    expect(out).toHaveLength(4);
    expect(rows).toHaveLength(3);
  });
});

describe('computeCore with a live price', () => {
  /*
   * Synthetic scenario (see calc.portfolio.test.js): previous day V = 4765.
   * Live AAA.US 112 on 2026-10-13: V = 15*112 + 20*55 + 100*11 + 985
   *   = 1680 + 1100 + 1100 + 985 = 4865 -> day_pnl 100, day_pct = 4865/4765 - 1 = 2.10%
   */
  it('day_pct follows the live price', () => {
    const positions = parsePositions({ answer: fx.getPositionJson }).rows;
    const trades = parseTrades({ answer: fx.getTradesHistory }).rows;
    const cashflows = parseCashflows({ answer: fx.getUserCashFlows }).rows;
    const prices = parsePricesForPeriod({ answer: fx['getHloc.daily'], args: { date_from: fx._meta.windowStart } }, SRV3).rows;
    const live = livePriceRows(prices, new Map([['AAA.US', { ltp: 112 }]]), '2026-10-13');
    const res = computeCore(positions, trades, cashflows, live);
    expect(res.summary.day_pnl).toBe(100);
    expect(res.summary.day_pct).toBe(2.1);
  });
});
