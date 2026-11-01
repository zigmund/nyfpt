import { describe, it, expect } from 'vitest';
import fx from './fixtures/synthetic-api.json';
import {
  parsePositions, parseTrades, parseCashflows, parsePricesForPeriod, parseHloc,
  computeNow, computeCore,
} from '../src/calc/portfolio.js';

// Synthetic market clock: broker server at UTC+3 (axis + 3 h = exchange wall clock, daily bar = server midnight).
const SRV3 = { offset: 10800, markets: {} };

/*
 * Synthetic scenario (see tests/fixtures/synthetic-api.json), window starts 2026-10-05.
 * Formulas: docs/CALCULATIONS.md. Hand-computed expectations:
 *
 * Start (close of 10-05): AAA 10 @100, BBB 20 @50, CCC_KZ 100 @10, cash 500
 *   V0 = 1000 + 1000 + 1000 + 500 = 3500
 * Events: 10-06 card deposit +1000 (external), 10-07 dividend +20,
 *   10-09 buy AAA 5 @106 (commission_for_trades -5). 10-08 has no KASE candle (ffill).
 * Daily V_t (e_t = external flow of the day):
 *   10-06: 10*102 + 20*50 + 100*10 + 1500        = 4520, e=1000 -> r = 3520/3500
 *   10-07: 10*104 + 20*51 + 100*10.5 + 1520      = 4630         -> r = 4630/4520
 *   10-08: 10*100 + 20*52 + 100*10.5 + 1520      = 4610         -> r = 4610/4630
 *   10-09: 15*106 + 20*52 + 100*10.5 + 985       = 4665         -> r = 4665/4610
 *   10-12: 15*108 + 20*53 + 100*11 + 985         = 4765         -> r = 4765/4665
 *   10-13: 15*110 + 20*55 + 100*11 + 985         = 4835         -> r = 4835/4765
 * TWR = 3520*4835 / (3500*4520) - 1 = 17019200/15820000 - 1 = 7.58%
 * P&L = 4835 - 3500 - 1000 = 335 (positions 115+100+100 incl. commission, + dividend 20)
 * SPY 520/500 = +4.00%, QQQ 420/400 = +5.00% -> vs_spy 3.58, vs_qqq 2.58
 * Last day: day_pnl = 4835 - 4765 = 70, day_pct = 4835/4765 - 1 = 1.47%
 * AAA: qty 10 -> 15 ('докуплена'), 100 -> 110 (+10%), pnl = 1650 - 1000 - (5*106 + 5) = 115,
 *   weight = 1650/4835 = 34.13%. BBB: pnl = 1100 - 1000 = 100, weight 22.75%.
 *   CCC_KZ: pnl = 1100 - 1000 = 100, weight 22.75%.
 */

const inputs = () => ({
  positions: parsePositions({ answer: fx.getPositionJson }).rows,
  trades: parseTrades({ answer: fx.getTradesHistory }).rows,
  cashflows: parseCashflows({ answer: fx.getUserCashFlows }).rows,
  prices: parsePricesForPeriod({ answer: fx['getHloc.daily'], args: { date_from: fx._meta.windowStart } }, SRV3).rows,
});

describe('computeCore on the synthetic scenario', () => {
  const { positions, trades, cashflows, prices } = inputs();
  const res = computeCore(positions, trades, cashflows, prices);
  const s = res.summary;

  it('summary: dates and values', () => {
    expect(s.base_close).toBe('2026-10-05');
    expect(s.end).toBe('2026-10-13');
    expect(s.value_start).toBe(3500);
    expect(s.value_end).toBe(4835);
    expect(s.value_change).toBe(1335);
    expect(s.value_change_pct).toBe(38.14);
  });

  it('summary: returns and P&L', () => {
    expect(s.twr).toBe(7.58);
    expect(s.spy).toBe(4);
    expect(s.qqq).toBe(5);
    expect(s.vs_spy).toBe(3.58);
    expect(s.vs_qqq).toBe(2.58);
    expect(s.pnl).toBe(335);
    expect(s.day_pnl).toBe(70);
    expect(s.day_pct).toBe(1.47);
    expect(s.day_date).toBe('2026-10-13');
  });

  it('summary: cash movements and counters', () => {
    expect(s.deposits).toBe(1000);
    expect(s.income).toBe(20);
    expect(s.commissions).toBe(-5);
    expect(s.taxes).toBe(0);
    expect(s.trades).toBe(1); // the 2026-09-20 trade is before the window
    expect(s.missing).toBe('');
  });

  it('series: base row plus 6 trading days', () => {
    expect(res.series).toHaveLength(7);
    expect(res.series.map((r) => r.date)).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13',
    ]);
    expect(res.series.map((r) => r.value)).toEqual([3500, 4520, 4630, 4610, 4665, 4765, 4835]);
    expect(res.series.map((r) => r.pnl)).toEqual([0, 20, 130, 110, 165, 265, 335]);
    expect(res.series[1].portfolio).toBe(0.57); // 3520/3500 - 1
    expect(res.series[6].portfolio).toBe(7.58);
    expect(res.series.map((r) => r.spy)).toEqual([0, 1, 0, 2, 2, 3, 4]);
  });

  it('positions: qty, pnl, weight; KASE price is forward-filled', () => {
    const by = Object.fromEntries(res.positions.map((p) => [p.ticker, p]));
    expect(Object.keys(by).sort()).toEqual(['AAA.US', 'BBB.US', 'CCC_KZ.KZ']);
    expect(by['AAA.US']).toMatchObject({ qty_start: 10, qty_end: 15, status: 'докуплена', price_start: 100, price_end: 110, change_pct: 10, pnl: 115, value: 1650, weight: 34.13 });
    expect(by['BBB.US']).toMatchObject({ qty_start: 20, qty_end: 20, status: '', pnl: 100, value: 1100, weight: 22.75 });
    expect(by['CCC_KZ.KZ']).toMatchObject({ qty_start: 100, qty_end: 100, price_start: 10, price_end: 11, pnl: 100, weight: 22.75 });
  });

  it('computeNow sums positions and cash', () => {
    expect(computeNow(positions)).toEqual([{ value: 4835 }]);
  });
});

describe('computeCore: round-trip inside the period', () => {
  // Synthetic: ZZZ bought 3 @10 on 10-07 and sold 3 @12 on 10-12, commission 1 each (also in cashflows).
  const base = inputs();
  const ws = base.prices[0].window_start;
  const closes = { '2026-10-05': 9, '2026-10-07': 10, '2026-10-12': 12, '2026-10-13': 13 };
  const prices = [...base.prices, ...Object.entries(closes).map(([date, close]) => ({ ticker: 'ZZZ.US', date, close, window_start: ws }))];
  const trades = [
    ...base.trades,
    { id: 'rt1', date: '2026-10-07', ticker: 'ZZZ.US', side: 1, qty: 3, price: 10, commission: 1 },
    { id: 'rt2', date: '2026-10-12', ticker: 'ZZZ.US', side: -1, qty: 3, price: 12, commission: 1 },
  ];
  const cashflows = [
    ...base.cashflows,
    { date: '2026-10-07', type: 'commission_for_trades', name: 'Commission', currency: 'USD', sum: -1 },
    { date: '2026-10-12', type: 'commission_for_trades', name: 'Commission', currency: 'USD', sum: -1 },
  ];
  const before = computeCore(base.positions, base.trades, base.cashflows, base.prices);
  const res = computeCore(base.positions, trades, cashflows, prices);
  const rowsPnl = (r) => Math.round(r.positions.reduce((s, p) => s + p.pnl, 0) * 100) / 100;

  it('keeps the round-trip as a closed row with zero value and its realized P&L', () => {
    const zzz = res.positions.find((p) => p.ticker === 'ZZZ.US');
    // pnl = sells - buys = (36 - 1) - (30 + 1) = 4
    expect(zzz).toMatchObject({ qty_start: 0, qty_end: 0, status: 'закрыта', value: 0, weight: 0, pnl: 4 });
  });

  it('other rows unchanged; row P&L + income = summary P&L (no double counting)', () => {
    const others = res.positions.filter((p) => p.ticker !== 'ZZZ.US')
    expect(others).toEqual(before.positions);
    expect(rowsPnl(before) + before.summary.income).toBe(before.summary.pnl); // 315 + 20 = 335
    expect(res.summary.pnl).toBe(339); // + the round-trip's 4
    expect(rowsPnl(res) + res.summary.income).toBe(res.summary.pnl);
    expect(res.summary.value_end).toBe(before.summary.value_end);
  });
});

describe('parsers', () => {
  it('getPositionJson with and without the result wrapper gives the same rows', () => {
    const a = parsePositions({ answer: fx.getPositionJson });
    const b = parsePositions({ answer: fx.getPositionJson.result });
    expect(a).toEqual(b);
    expect(a.rows.find((r) => r.kind === 'cash')).toMatchObject({ ticker: 'USD', value: 985 });
  });

  it('accepts the answer as a JSON string', () => {
    const a = parsePositions({ answer: JSON.stringify(fx.getPositionJson) });
    expect(a).toEqual(parsePositions({ answer: fx.getPositionJson }));
  });

  it('trade as an object instead of an array', () => {
    const one = { trades: { trade: fx.getTradesHistory.trades.trade[1] } };
    const { rows } = parseTrades({ answer: one });
    expect(rows).toEqual([{ id: '9002', date: '2026-10-09', ticker: 'AAA.US', side: 1, qty: 5, price: 106, commission: 5 }]);
  });

  it('candle [H, L, O, C]: close is the 4th element', () => {
    const answer = { hloc: { 'X.US': [[12, 8, 9, 10.5]] }, xSeries: { 'X.US': [1791158400] } };
    expect(parseHloc({ answer }, SRV3).rows[0]).toMatchObject({ ticker: 'X.US', close: 10.5 });
    expect(parsePricesForPeriod({ answer, args: { date_from: '05.10.2026 00:00' } }, SRV3).rows[0])
      .toMatchObject({ close: 10.5, window_start: '2026-10-05' });
  });

  it('cashflows: trims names, keeps type codes', () => {
    const { rows } = parseCashflows({ answer: fx.getUserCashFlows });
    expect(rows[1]).toEqual({ date: '2026-10-06', type: 'card', name: 'Card deposit', currency: 'USD', sum: 1000 });
  });

  it('broker error in the answer throws', () => {
    expect(() => parsePositions({ answer: { errMsg: 'boom' } })).toThrow('boom');
  });
});

// Task 47: position values in USD with the price multiplier k and fx (positionFactor), and session
// days only for daily closes. Synthetic tickers and numbers.
describe('computeCore: price factor k, fx and session days (Task 47)', () => {
  const px = (ticker, rows, ws) => rows.map(([date, close]) => ({ ticker, date, close, window_start: ws }));
  const bench = (dates, ws) => [...px('SPY.US', dates.map((d) => [d, 500]), ws), ...px('QQQ.US', dates.map((d) => [d, 400]), ws)];
  // Bond quoted in % of face 1000 (k = 10): 10 @ 98.5 = $9,850.
  const BOND_PS = {
    acc: [{ curr: 'USD', currval: 1, s: 100 }],
    pos: [{ i: 'ZBND.0130.AIX.KZ', name: 'Synthetic bond', q: 10, mkt_price: 98.5, market_value: 9850, face_val_a: 1000, currval: 1, curr: 'USD' }],
  };

  it('parsePositions keeps positionFactor k and fx on position rows', () => {
    const [row] = parsePositions({ answer: { ps: BOND_PS } }).rows;
    expect(row).toMatchObject({ ticker: 'ZBND.0130.AIX.KZ', k: 10, fx: 1 });
  });

  it('bond in % of face: q × close × k, trades valued the same way', () => {
    const ws = '2026-10-29';
    const prices = [...bench(['2026-10-29', '2026-10-30'], ws), ...px('ZBND.0130.AIX.KZ', [['2026-10-29', 97], ['2026-10-30', 98.5]], ws)];
    // Bought 2 @ 98.0 on 10-30: start qty 8, cash at the start 100 + 2 × 980 = 2060.
    const trades = [{ id: '1', date: '2026-10-30', ticker: 'ZBND.0130.AIX.KZ', side: 1, qty: 2, price: 98, commission: 0 }];
    const positions = parsePositions({ answer: { ps: BOND_PS } }).rows;
    const res = computeCore(positions, trades, [], prices);
    // V0 = 8 × 97 × 10 + 2060 = 9820; V1 = 10 × 98.5 × 10 + 100 = 9950.
    expect(res.summary.value_start).toBe(9820);
    expect(res.summary.value_end).toBe(9950);
    expect(res.summary.value_end).toBe(computeNow(positions)[0].value);
    expect(res.summary.pnl).toBe(130);
    expect(res.summary.day_pnl).toBe(130);
    const [b] = res.positions;
    expect(b).toMatchObject({ price_start: 97, price_end: 98.5, value: 9850, pnl: 130, change_pct: 1.55 });
    // Rows cached before Task 47 (no k / fx): the same factor from value / (qty × price).
    const old = positions.map(({ k, fx: _fx, ...r }) => r);
    expect(computeCore(old, trades, [], prices)).toEqual(res);
  });

  it('non-USD quote: q × close × fx (the snapshot rate)', () => {
    const ps = {
      acc: [{ curr: 'USD', currval: 1, s: 100 }],
      pos: [{ i: 'ZEU.EU', name: 'Synthetic EUR', q: 10, mkt_price: 50, market_value: 550, currval: 1.1, curr: 'EUR' }],
    };
    const ws = '2026-10-29';
    const prices = [...bench(['2026-10-29', '2026-10-30'], ws), ...px('ZEU.EU', [['2026-10-29', 48], ['2026-10-30', 50]], ws)];
    const positions = parsePositions({ answer: { ps } }).rows;
    const res = computeCore(positions, [], [], prices);
    // V0 = 10 × 48 × 1.1 + 100 = 628; V1 = 550 + 100 = 650.
    expect(res.summary.value_start).toBe(628);
    expect(res.summary.value_end).toBe(650);
    expect(res.summary.pnl).toBe(22);
    expect(res.positions[0]).toMatchObject({ value: 550, pnl: 22, weight: 84.62 });
  });

  it('a position closed in the period (no snapshot): factor 1 (USD quote, price per unit)', () => {
    const ws = '2026-10-29';
    const prices = [...bench(['2026-10-29', '2026-10-30'], ws), ...px('ZOLD.US', [['2026-10-29', 20], ['2026-10-30', 21]], ws)];
    const trades = [{ id: '1', date: '2026-10-30', ticker: 'ZOLD.US', side: -1, qty: 5, price: 22, commission: 0 }];
    const positions = [{ ticker: 'USD', name: 'USD', kind: 'cash', qty: 210, price: 1, value: 210 }];
    const res = computeCore(positions, trades, [], prices);
    expect(res.summary.value_start).toBe(200); // 5 × 20 + (210 − 110)
    expect(res.positions[0]).toMatchObject({ ticker: 'ZOLD.US', qty_end: 0, pnl: 10 });
  });

  // A .EU-like ticker: the broker sends flat Saturday / Sunday daily bars that need not equal
  // Friday's close (here 51 vs Friday 50). They are no session.
  const EU_PS = {
    acc: [{ curr: 'USD', currval: 1, s: 0 }],
    pos: [{ i: 'ZEU.EU', name: 'Synthetic EU', q: 10, mkt_price: 52, market_value: 520, currval: 1, curr: 'USD' }],
  };

  it('weekend bar is never the period base (1D on Monday: base on Sunday)', () => {
    const ws = '2026-11-01';
    const prices = [
      ...bench(['2026-10-29', '2026-10-30', '2026-11-02'], ws),
      ...px('ZEU.EU', [['2026-10-30', 50], ['2026-10-31', 51], ['2026-11-01', 51], ['2026-11-02', 52]], ws),
    ];
    const res = computeCore(parsePositions({ answer: { ps: EU_PS } }).rows, [], [], prices);
    expect(res.summary.base_close).toBe('2026-10-30');
    expect(res.positions[0]).toMatchObject({ price_start: 50, price_end: 52, pnl: 20 });
    expect(res.summary.value_start).toBe(500);
    expect(res.summary.day_pnl).toBe(20);
  });

  it('weekend bar is never forward-filled into a weekday without a bar', () => {
    const ws = '2026-10-29';
    // No ZEU bar on Monday 11-02 (holiday of its market): Monday's price is Friday's 50, not Sunday's 51.
    const prices = [
      ...bench(['2026-10-29', '2026-10-30', '2026-11-02'], ws),
      ...px('ZEU.EU', [['2026-10-29', 49], ['2026-10-30', 50], ['2026-10-31', 51], ['2026-11-01', 51]], ws),
    ];
    const res = computeCore(parsePositions({ answer: { ps: EU_PS } }).rows, [], [], prices);
    expect(res.series.map((r) => r.value)).toEqual([490, 500, 500]);
    expect(res.positions[0]).toMatchObject({ price_start: 49, price_end: 50, pnl: 10 });
    expect(res.summary.day_pnl).toBe(0);
  });
});
