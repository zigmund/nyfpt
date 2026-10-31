import { describe, it, expect } from 'vitest';
import { PERIODS, periodStart, tradesFrom, inceptionFromCashflows, toHlocDate } from '../src/calc/periods.js';

describe('periods', () => {
  const T = '2026-10-31';
  const INC = '2026-03-15';

  it('lists periods in UI order', () => {
    expect(PERIODS).toEqual(['1d', '7d', '1m', '6m', 'YTD', '1Y', '5Y', 'All']);
  });

  it('periods longer than the account life are clamped to inception', () => {
    expect(periodStart('YTD', T, INC)).toBe('2026-03-15');
    expect(periodStart('All', T, INC)).toBe('2026-03-15');
    expect(periodStart('1Y', T, INC)).toBe('2026-03-15');
    expect(periodStart('5Y', T, INC)).toBe('2026-03-15');
  });

  it('short periods are counted back from today', () => {
    expect(periodStart('1d', T, INC)).toBe('2026-10-30');
    expect(periodStart('7d', T, INC)).toBe('2026-10-24');
    expect(periodStart('1m', T, INC)).toBe('2026-10-01');
    expect(periodStart('6m', T, INC)).toBe('2026-05-01'); // Oct 31 minus 6 months overflows Apr 31 -> May 1
  });

  it('YTD for an old account starts at the previous year end; All without inception is null-safe', () => {
    expect(periodStart('YTD', T, '2020-01-01')).toBe('2025-12-31');
    expect(periodStart('1Y', T, '2020-01-01')).toBe('2025-10-31');
    expect(periodStart('All', T, null)).toBeNull();
    expect(periodStart('7d', T, null)).toBe('2026-10-24');
  });

  it('tradesFrom widens only the 1d window', () => {
    expect(tradesFrom('1d', '2026-10-30')).toBe('2026-10-26');
    expect(tradesFrom('7d', '2026-10-24')).toBe('2026-10-24');
  });

  it('inceptionFromCashflows is the earliest date minus one day', () => {
    const rows = [{ date: '2026-07-01' }, { date: '2026-03-16' }, { date: '2026-09-01' }];
    expect(inceptionFromCashflows(rows)).toBe('2026-03-15');
    expect(inceptionFromCashflows([{ date: '2026-03-01' }])).toBe('2026-02-28');
    expect(inceptionFromCashflows([])).toBeNull();
  });

  it('toHlocDate formats DD.MM.YYYY 00:00', () => {
    expect(toHlocDate('2026-03-15')).toBe('15.03.2026 00:00');
  });
});
