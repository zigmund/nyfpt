// Period boundaries (ported from the legacy dashboard). Pure date-string helpers, UTC.

export const PERIODS = ['1d', '7d', '1m', '6m', 'YTD', '1Y', '5Y', 'All'];

const ymd = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(`${s}T00:00:00Z`);

/** Unclamped start of a period relative to `today`; null for 'All'. */
const rawStart = (period, today) => {
  const b = utc(today);
  if (period === '1d') b.setUTCDate(b.getUTCDate() - 1);
  else if (period === '7d') b.setUTCDate(b.getUTCDate() - 7);
  else if (period === '1m') b.setUTCMonth(b.getUTCMonth() - 1);
  else if (period === '6m') b.setUTCMonth(b.getUTCMonth() - 6);
  else if (period === 'YTD') return `${b.getUTCFullYear() - 1}-12-31`;
  else if (period === '1Y') b.setUTCFullYear(b.getUTCFullYear() - 1);
  else if (period === '5Y') b.setUTCFullYear(b.getUTCFullYear() - 5);
  else return null;
  return ymd(b);
};

/** Start date of the period, clamped to the account inception (null = unknown). */
export const periodStart = (period, today, inception) => {
  const s = rawStart(period, today);
  if (inception && (s == null || s < inception)) return inception;
  return s;
};

/** Date from which trades must be requested: 1d reaches 4 days back so the last session is covered. */
export const tradesFrom = (period, start) => {
  if (period !== '1d') return start;
  const d = utc(start);
  d.setUTCDate(d.getUTCDate() - 4);
  return ymd(d);
};

/** Account inception = earliest cashflow date minus one day; null for no rows. */
export const inceptionFromCashflows = (rows) => {
  if (!rows || !rows.length) return null;
  const min = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);
  const d = utc(min);
  d.setUTCDate(d.getUTCDate() - 1);
  return ymd(d);
};

/** 'YYYY-MM-DD' -> 'DD.MM.YYYY 00:00' (getHloc date format). */
export const toHlocDate = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} 00:00`;
