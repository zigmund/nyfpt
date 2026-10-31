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
