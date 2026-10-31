// Логика дашборда, вынесенная без изменений из current-dashboard/index.html.
// Чистые функции: на вход — ответы API Tradernet или строки, на выход — строки/объекты.
// Не зависят от браузера и от среды дашборда (dash.*).

const J = (a) => (typeof a === 'string' ? JSON.parse(a) : a);
const brokerError = (a) => { if (a && (a.error || a.errMsg)) throw new Error(String(a.errMsg || a.error)); };

// ---------- Разбор ответов API (были dash.loader) ----------

/** getPositionJson -> {columns, rows}: позиции (kind=position) и денежные остатки (kind=cash, в USD) */
export const parsePositions = ({ answer }) => {
    const a = J(answer); brokerError(a);
    const ps = a && ((a.result && a.result.ps) || a.ps);
    if (!ps) throw new Error('В ответе нет ps');
    const usd = +((ps.acc || []).find((c) => c.curr === 'USD') || {}).currval || 1;
    const rows = (ps.pos || []).map((p) => ({ ticker: p.i, name: p.name, kind: 'position', qty: +p.q, price: +p.mkt_price, value: +p.market_value }));
    for (const c of ps.acc || []) rows.push({ ticker: c.curr, name: c.curr, kind: 'cash', qty: +c.s, price: +c.currval / usd, value: (+c.s * +c.currval) / usd });
    return { columns: ['ticker', 'name', 'kind', 'qty', 'price', 'value'], rows };
  };

/** getTradesHistory -> {columns, rows}: id, date (YYYY-MM-DD), ticker, side (1 покупка / -1 продажа), qty, price, commission */
export const parseTrades = ({ answer }) => {
    const a = J(answer); brokerError(a);
    let t = (a && a.trades && a.trades.trade) || [];
    if (!Array.isArray(t)) t = [t];
    return {
      columns: ['id', 'date', 'ticker', 'side', 'qty', 'price', 'commission'],
      rows: t.map((x) => ({ id: String(x.id), date: String(x.date).slice(0, 10), ticker: x.instr_nm, side: String(x.type) === '1' ? 1 : -1, qty: +x.q, price: +x.p, commission: +(x.commission || 0) })),
    };
  };

/** getUserCashFlows (groupByType=1) -> {columns, rows}: date, type, name, currency, sum */
export const parseCashflows = ({ answer }) => {
    const a = J(answer); brokerError(a);
    const c = (a && a.cashflow) || [];
    return { columns: ['date', 'type', 'name', 'currency', 'sum'], rows: c.map((x) => ({ date: String(x.date).slice(0, 10), type: x.type_code, name: String(x.type_code_name || '').trim(), currency: x.currency, sum: +x.sum })) };
  };

/** getHloc дневные (для расчёта доходности) -> {columns, rows}: ticker, date, close, window_start.
 *  args.date_from — тот же 'DD.MM.YYYY HH:MM', что ушёл в запрос (начало периода). */
export const parsePricesForPeriod = ({ answer, args }) => {
    const a = J(answer); brokerError(a);
    if (!a || !a.hloc) throw new Error('В ответе нет hloc');
    const [d, m, y] = String(args.date_from).slice(0, 10).split('.');
    const ws = `${y}-${m}-${d}`;
    const rows = [];
    for (const t of Object.keys(a.hloc)) {
      const xs = (a.xSeries && a.xSeries[t]) || [];
      a.hloc[t].forEach((c, i) => rows.push({ ticker: t, date: new Date((xs[i] + 10800) * 1000).toISOString().slice(0, 10), close: +c[3], window_start: ws }));
    }
    return { columns: ['ticker', 'date', 'close', 'window_start'], rows };
  };

/** getHloc любой таймфрейм (для полосы рынков) -> {columns, rows}: ticker, ts, date, close */
export const parseHloc = ({ answer }) => {
  const a = J(answer); brokerError(a);
  if (!a || !a.hloc) throw new Error('В ответе нет hloc');
  const rows = [];
  for (const t of Object.keys(a.hloc)) {
    const xs = (a.xSeries && a.xSeries[t]) || [];
    a.hloc[t].forEach((c, i) => rows.push({ ticker: t, ts: xs[i], date: new Date((xs[i] + 14400) * 1000).toISOString().slice(0, 10), close: +c[3] }));
  }
  return { columns: ['ticker', 'ts', 'date', 'close'], rows };
};

// ---------- Расчёты (были dash.calc) ----------

/** Текущая стоимость: позиции + деньги. Вход — rows из parsePositions. */
export const computeNow = (positions) => [{ value: Math.round(positions.reduce((s, p) => s + p.value, 0) * 100) / 100 }];

/** Главный расчёт. Вход — rows из parsePositions, parseTrades, parseCashflows, parsePricesForPeriod.
 *  Выход: { series, positions, summary } — см. docs/CALCULATIONS.md. */
export const computeCore = (positions, trades, cashflows, prices) => {
    const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
    if (!prices.length) return { series: [], positions: [], summary: null };
    let base = prices[0].window_start;
    const EXT = /intercompany|card|deposit|withdraw|transfer|cash_?in|cash_?out|payout/i;
    const px = {};
    for (const r of prices) (px[r.ticker] = px[r.ticker] || []).push([r.date, r.close]);
    for (const k in px) px[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const at = (t, d) => { let v = null; for (const [dd, c] of px[t] || []) { if (dd <= d) v = c; else break; } return v; };
    const spyDates = (px['SPY.US'] || []).map((x) => x[0]);
    let days = spyDates.filter((d) => d > base);
    if (!days.length && spyDates.length > 1) { base = spyDates[spyDates.length - 2]; days = [spyDates[spyDates.length - 1]]; }
    const baseClose = spyDates.filter((d) => d <= base).pop() || base;
    const wk = trades.filter((t) => t.date > base && !String(t.ticker).includes('/'));
    const flows = cashflows.filter((c) => c.date > base);
    const endQ = {}, names = {};
    let cashEnd = 0;
    for (const p of positions) {
      if (p.kind === 'cash') cashEnd += p.value;
      else { endQ[p.ticker] = (endQ[p.ticker] || 0) + p.qty; names[p.ticker] = p.name; }
    }
    const startQ = { ...endQ };
    for (const t of wk) { startQ[t.ticker] = (startQ[t.ticker] || 0) - t.side * t.qty; if (!(t.ticker in endQ)) endQ[t.ticker] = 0; }
    const tickers = Object.keys(startQ);
    const missing = tickers.filter((t) => !px[t]);
    let cash = cashEnd - wk.reduce((s, t) => s - t.side * t.qty * t.price, 0) - flows.reduce((s, c) => s + c.sum, 0);
    const q = { ...startQ };
    const val = (d) => tickers.reduce((s, t) => s + (q[t] ? q[t] * (at(t, d) || 0) : 0), 0) + cash;
    const dayOf = (d) => days.find((x) => x >= d) || days[days.length - 1];
    const s0 = at('SPY.US', base), n0 = at('QQQ.US', base);
    const V0 = val(base);
    let prev = V0, idx = 1, ext = 0, dayPnl = null, dayPct = null, dayDate = null;
    const series = [{ date: baseClose, pnl: 0, portfolio: 0, spy: 0, qqq: 0, value: Math.round(V0) }];
    for (const d of days) {
      let e = 0;
      for (const t of wk) if (dayOf(t.date) === d) { q[t.ticker] += t.side * t.qty; cash -= t.side * t.qty * t.price; }
      for (const c of flows) if (dayOf(c.date) === d) { cash += c.sum; if (EXT.test(c.type)) e += c.sum; }
      const V = val(d);
      dayPnl = V - e - prev; dayPct = ((V - e) / prev - 1) * 100; dayDate = d;
      idx *= (V - e) / prev; prev = V; ext += e;
      series.push({ date: d, pnl: r2(V - V0 - ext), portfolio: r2((idx - 1) * 100), spy: r2((at('SPY.US', d) / s0 - 1) * 100), qqq: r2((at('QQQ.US', d) / n0 - 1) * 100), value: Math.round(V) });
    }
    const end = days.length ? days[days.length - 1] : baseClose;
    const Vend = prev;
    const rows = tickers.map((t) => {
      const tt = wk.filter((x) => x.ticker === t);
      const buys = tt.filter((x) => x.side > 0).reduce((s, x) => s + x.qty * x.price + x.commission, 0);
      const sells = tt.filter((x) => x.side < 0).reduce((s, x) => s + x.qty * x.price - x.commission, 0);
      const p0 = at(t, base), p1 = at(t, end);
      const v1 = endQ[t] * (p1 || 0);
      const status = endQ[t] === 0 ? 'закрыта' : startQ[t] === 0 ? 'новая' : endQ[t] > startQ[t] ? 'докуплена' : endQ[t] < startQ[t] ? 'сокращена' : '';
      return { ticker: t, name: names[t] || t, status, qty_start: startQ[t], qty_end: endQ[t], price_start: p0, price_end: p1, change_pct: p0 ? r2((p1 / p0 - 1) * 100) : null, pnl: r2(v1 - startQ[t] * (p0 || 0) - buys + sells), value: r2(v1), weight: r2((v1 / Vend) * 100) };
    }).filter((r) => r.qty_start || r.qty_end);
    const sum = (re) => r2(flows.filter((c) => re.test(c.type)).reduce((s, c) => s + c.sum, 0));
    const last = series[series.length - 1];
    const twr = r2((idx - 1) * 100);
    return {
      series,
      positions: rows,
      summary: { base_close: baseClose, end, value_start: r2(V0), value_end: r2(Vend), twr, spy: last.spy, qqq: last.qqq, vs_spy: r2(twr - last.spy), vs_qqq: r2(twr - last.qqq), pnl: r2(Vend - V0 - ext), deposits: r2(ext), income: sum(/dividend|coupon/), taxes: sum(/tax/), commissions: sum(/commission/), trades: wk.length, missing: missing.join(', '), value_change: r2(Vend - V0), value_change_pct: r2((Vend / V0 - 1) * 100), day_pnl: r2(dayPnl), day_pct: r2(dayPct), day_date: dayDate },
    };
  };

/** Полоса рынков. Вход — rows из parseHloc для дневных и 15-минутных свечей. */
export const computeMarkets = (mkt_daily, mkt_intraday) => {
    const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
    const order = ['SP500.IDX', 'NASDAQ.IDX', 'USO.US', 'GLD.US', 'SLV.US'];
    const by = (rows, t) => rows.filter((r) => r.ticker === t).sort((a, b) => a.ts - b.ts);
    const idx = by(mkt_intraday, 'SP500.IDX');
    return order.map((t) => {
      const d = by(mkt_daily, t);
      if (d.length < 2) return { ticker: t, date: null, last: null, prev: null, change_pct: null, spark: [] };
      const last = d[d.length - 1], prev = d[d.length - 2];
      const sess = idx.filter((r) => r.date === last.date);
      const lo = sess.length ? sess[0].ts : -Infinity, hi = sess.length ? sess[sess.length - 1].ts : Infinity;
      const spark = by(mkt_intraday, t).filter((r) => r.date === last.date && r.ts >= lo && r.ts <= hi).map((r) => r.close);
      return { ticker: t, date: last.date, last: last.close, prev: prev.close, change_pct: r2((last.close / prev.close - 1) * 100), spark };
    });
  };
