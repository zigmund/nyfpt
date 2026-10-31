// Market time from the broker (Task 25). Synthetic getMarketStatus / getHloc shapes only.
// Broker facts (probed 2026-10-31): getMarketStatus `t` is the server wall clock; `o`/`c` are in
// server time; `dt` = server - exchange local, minutes. Candle axis + server offset = exchange
// wall clock (09:30 New York bar = 06:30 on the axis while the server is UTC+3).
import { describe, expect, it } from 'vitest'
import {
  serverOffset, marketClock, marketClockFor, axisDate, axisAt, wallToUtc, axisToUtc, marketDay,
  localDay, localParts, formatLocal, sessionWindow, hmsMinutes,
} from '../src/calc/marketTime.js'
import { candleZone, chartRows, keyStats, parseCandles, sessionBounds } from '../src/calc/position.js'
import { daySparks } from '../src/calc/sparks.js'
import { parseHloc, parsePricesForPeriod } from '../src/calc/portfolio.js'

const ALMATY = 'Asia/Almaty' // the viewer's zone in display tests (browser zone in the app)
const NY = 'America/New_York' // broker-supplied `mrkt.tz` in synthetic answers
const utc = (iso) => Date.parse(`${iso}Z`) / 1000

// Status snapshots as received: `at` = local Date.now() when the answer arrived.
const summer = (srvOffsetH = 3) => ({
  t: new Date(Date.parse('2026-10-30T19:28:40Z') + srvOffsetH * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
  at: Date.parse('2026-10-30T19:28:41Z'),
  m: [
    { n: 'FIX', n2: 'FIX', s: 'OPEN', o: '16:30:00', c: '03:00:00', dt: String(420 - (3 - srvOffsetH) * 60) },
    { n: 'KASE', n2: 'KASE', s: 'CLOSE', o: '09:30:00', c: '20:00:00', dt: String(-120 - (3 - srvOffsetH) * 60) },
    { n: 'EU', n2: 'EU', s: 'OPEN', o: '11:00:00', c: '21:30:00', dt: String(180 - (3 - srvOffsetH) * 60) },
  ].map((x) => ({ ...x, o: shift(x.o, srvOffsetH - 3), c: shift(x.c, srvOffsetH - 3) })),
})
// After the US clock change (first Monday): FIX opens 17:30 server time, dt 480.
const winter = () => ({
  t: '2026-11-02 12:00:00', at: Date.parse('2026-11-02T09:00:00Z'),
  m: [
    { n: 'FIX', n2: 'FIX', s: 'OPEN', o: '17:30:00', c: '04:00:00', dt: '480' },
    { n: 'KASE', n2: 'KASE', s: 'OPEN', o: '09:30:00', c: '20:00:00', dt: '-120' },
  ],
})
function shift(hms, h) {
  const m = ((hmsMinutes(hms) + h * 60) % 1440 + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`
}

// Axis value of an exchange wall-clock time for a server offset (seconds).
const axis = (offset, date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return utc(`${date}T00:00:00`) + h * 3600 + m * 60 - offset
}
// 15-min bars between two wall times (inclusive), as parsed rows of one ticker.
function bars(offset, ticker, date, from, to, mkt, close0 = 100) {
  const out = []
  for (let ts = axis(offset, date, from), i = 0; ts <= axis(offset, date, to); ts += 900, i++) {
    out.push({ ticker, mkt, ts, date, close: close0 + i, open: close0 + i, high: close0 + i, low: close0 + i, vol: 1 })
  }
  return out
}

describe('server clock', () => {
  it('offset = server wall clock - local now, rounded to 15 min', () => {
    expect(serverOffset('2026-10-31 22:28:40', Date.parse('2026-10-31T19:28:41Z'))).toBe(10800)
    expect(serverOffset('2026-10-31 19:21:40', Date.parse('2026-10-31T19:28:41Z'))).toBe(0)
    expect(serverOffset('2026-11-01 00:58:40', Date.parse('2026-10-31T19:28:41Z'))).toBe(19800)
    expect(serverOffset('garbage', Date.now())).toBeNull()
    expect(serverOffset('2026-10-31 22:28:40', undefined)).toBeNull()
  })

  it('per-market regular hours in exchange wall minutes from o/c/dt', () => {
    const c = marketClock(summer())
    expect(c.offset).toBe(10800)
    expect(marketClockFor(c, 'FIX')).toMatchObject({ offset: 10800, dt: 420, open: 9 * 60 + 30, close: 20 * 60 })
    expect(marketClockFor(c, 'kase')).toMatchObject({ dt: -120, open: 11 * 60 + 30, close: 22 * 60 })
    expect(marketClockFor(c, 'EU')).toMatchObject({ dt: 180, open: 8 * 60, close: 18 * 60 + 30 })
    // after the US clock change the exchange-local open is the same 09:30
    expect(marketClockFor(marketClock(winter()), 'FIX')).toMatchObject({ dt: 480, open: 9 * 60 + 30 })
    // unknown market: offset only
    expect(marketClockFor(c, 'NOPE')).toMatchObject({ offset: 10800, dt: null, open: null, close: null })
    expect(marketClock(null)).toBeNull()
    expect(marketClockFor(null, 'FIX')).toBeNull()
  })

  it('nothing is fixed to UTC+3: another server offset gives the same exchange hours', () => {
    for (const h of [0, 5.5]) {
      const c = marketClock(summer(h))
      expect(c.offset).toBe(h * 3600)
      expect(marketClockFor(c, 'FIX')).toMatchObject({ open: 9 * 60 + 30, close: 20 * 60 })
      expect(marketClockFor(c, 'KASE')).toMatchObject({ open: 11 * 60 + 30 })
    }
  })
})

describe('axis conversions', () => {
  const c3 = marketClock(summer())
  it('candle dates through the server offset (daily bar = server midnight)', () => {
    expect(axisDate(c3, utc('2026-10-29T21:00:00'))).toBe('2026-10-30')
    expect(axisDate(c3, axis(10800, '2026-10-30', '19:45'))).toBe('2026-10-30')
    const c0 = marketClock(summer(0))
    expect(axisDate(c0, utc('2026-10-30T00:00:00'))).toBe('2026-10-30')
    expect(axisAt(10800, '2026-10-30', 570)).toBe(utc('2026-10-30T06:30:00'))
  })

  it('axis -> UTC: broker zone when given (exact for past days), else dt', () => {
    const fix = marketClockFor(c3, 'FIX')
    expect(axisToUtc(axis(10800, '2026-10-30', '09:30'), fix)).toBe(utc('2026-10-30T13:30:00'))
    const w = marketClockFor(marketClock(winter()), 'FIX', { tz: NY })
    // Friday before the change and Monday after it, both 09:30 New York
    expect(axisToUtc(axis(10800, '2026-10-30', '09:30'), w)).toBe(utc('2026-10-30T13:30:00'))
    expect(axisToUtc(axis(10800, '2026-11-02', '09:30'), w)).toBe(utc('2026-11-02T14:30:00'))
    // dt only (no zone): current dt for every day
    const wd = marketClockFor(marketClock(winter()), 'FIX')
    expect(axisToUtc(axis(10800, '2026-11-02', '09:30'), wd)).toBe(utc('2026-11-02T14:30:00'))
    expect(wallToUtc(utc('2026-10-30T11:30:00'), marketClockFor(c3, 'KASE'))).toBe(utc('2026-10-30T06:30:00'))
    expect(wallToUtc(1, marketClockFor(c3, 'NOPE'))).toBeNull()
    // a zone the runtime does not know falls back to dt
    expect(wallToUtc(utc('2026-10-30T09:30:00'), { ...fix, tz: 'Nowhere/Nope' })).toBe(utc('2026-10-30T13:30:00'))
  })

  it('exchange calendar day now', () => {
    const fix = marketClockFor(c3, 'FIX')
    expect(marketDay(fix, Date.parse('2026-10-30T23:30:00Z'))).toBe('2026-10-30') // 19:30 NY
    expect(marketDay(fix, Date.parse('2026-10-31T03:30:00Z'))).toBe('2026-10-30') // 23:30 NY
    expect(marketDay(fix, Date.parse('2026-10-31T04:30:00Z'))).toBe('2026-10-31')
    const w = marketClockFor(marketClock(winter()), 'FIX')
    expect(marketDay(w, Date.parse('2026-11-03T04:30:00Z'))).toBe('2026-11-02') // 23:30 EST
    expect(marketDay(null, Date.parse('2026-10-30T20:00:00Z'), ALMATY)).toBe('2026-10-31')
    expect(localDay(Date.parse('2026-10-30T20:00:00Z'), ALMATY)).toBe('2026-10-31')
  })

  it('user-zone display with an explicit zone label', () => {
    expect(localParts(utc('2026-10-30T13:30:00'), ALMATY)).toEqual({ date: '2026-10-30', min: 18 * 60 + 30, zone: 'GMT+5' })
    expect(formatLocal(utc('2026-10-30T23:58:25'), ALMATY)).toBe('Oct 31, 2026, 4:58 AM GMT+5')
    expect(formatLocal(utc('2026-10-30T23:58:25'), 'UTC')).toMatch(/^Oct 30, 2026, 11:58 PM GMT/)
    expect(formatLocal(null)).toBeNull()
  })
})

describe('regular sessions', () => {
  const OFF = 10800
  // Index bars 09:30-15:45 New York: past days full, today (11-02) partial up to 11:00.
  const idx = (dates, offset = OFF) => dates.flatMap(([d, to]) => bars(offset, 'SP500.IDX', d, '09:30', to, 'FIX'))

  it('past days from index bars; today opens at o and stays open to the learned close', () => {
    const mc = marketClockFor(marketClock(winter()), 'FIX')
    const win = sessionWindow(sessionBounds(idx([['2026-10-29', '15:45'], ['2026-10-30', '15:45'], ['2026-11-02', '11:00']])), mc)
    expect(win('2026-10-30')).toEqual([axis(OFF, '2026-10-30', '09:30'), axis(OFF, '2026-10-30', '15:45')])
    expect(win('2026-11-02')).toEqual([axis(OFF, '2026-11-02', '09:30'), axis(OFF, '2026-11-02', '15:45')])
    // an older day without index bars: same wall-clock session
    expect(win('2026-10-27')).toEqual([axis(OFF, '2026-10-27', '09:30'), axis(OFF, '2026-10-27', '15:45')])
    // with today's date: an index date before it is complete, today runs to the learned close
    const s2 = sessionBounds(idx([['2026-10-29', '15:45'], ['2026-10-30', '13:00']])) // 10-30: half day
    expect(sessionWindow(s2, mc, '2026-11-02')('2026-10-30')).toEqual([axis(OFF, '2026-10-30', '09:30'), axis(OFF, '2026-10-30', '13:00')])
    expect(sessionWindow(s2, mc, '2026-10-30')('2026-10-30')).toEqual([axis(OFF, '2026-10-30', '09:30'), axis(OFF, '2026-10-30', '15:45')])
    // no complete session yet: open-ended
    expect(sessionWindow(sessionBounds(idx([['2026-11-02', '11:00']])), mc, '2026-11-02')('2026-11-02')[1]).toBe(Infinity)
    // market unknown (no o/dt): open learned from the index on complete dates
    const unknown = marketClockFor(marketClock(winter()), 'NOPE')
    expect(sessionWindow(s2, unknown, '2026-11-02')('2026-11-02')).toEqual([axis(OFF, '2026-11-02', '09:30'), axis(OFF, '2026-11-02', '15:45')])
  })

  it('no index (other markets): market hours [o, c) in exchange wall clock', () => {
    const mc = marketClockFor(marketClock(summer()), 'EU')
    const win = sessionWindow(null, mc)
    expect(win('2026-10-30')).toEqual([axis(OFF, '2026-10-30', '08:00'), axis(OFF, '2026-10-30', '18:30') - 1])
    expect(sessionWindow(null, marketClockFor(marketClock(summer()), 'NOPE'))).toBeNull()
  })
})

describe('1D / 5D across the US clock change', () => {
  // Fri 10-30 (EDT, dt 420) and Mon 11-02 (EST, dt 480); status read on Monday.
  const run = (offset) => {
    const status = winter()
    status.t = new Date(status.at + offset * 1000).toISOString().slice(0, 19).replace('T', ' ')
    status.m = status.m.map((x) => ({ ...x, dt: String(+x.dt - (10800 - offset) / 60), o: shift(x.o, (offset - 10800) / 3600), c: shift(x.c, (offset - 10800) / 3600) }))
    const clock = marketClock(status)
    const mc = marketClockFor(clock, 'FIX', { tz: NY })
    const stock = (d) => bars(offset, 'AAA.US', d, '04:00', '19:45', 'FIX')
    const sessions = sessionBounds([
      ...bars(offset, 'SP500.IDX', '2026-10-29', '09:30', '15:45', 'FIX'),
      ...bars(offset, 'SP500.IDX', '2026-10-30', '09:30', '15:45', 'FIX'),
    ])
    return { clock, mc, sessions, stock }
  }

  for (const offset of [10800, 0, 19800]) {
    it(`first pre-market after the change (server offset ${offset / 3600} h)`, () => {
      const { mc, sessions, stock } = run(offset)
      // Monday 08:00 NY: only pre-market bars, index has none yet
      const pre = stock('2026-11-02').filter((r) => r.ts < axis(offset, '2026-11-02', '08:15'))
      const intraday = [...stock('2026-10-29'), ...stock('2026-10-30'), ...pre]
      const d1 = chartRows('1D', { intraday }, { today: '2026-11-02', sessions, clock: mc, timeZone: ALMATY })
      expect(new Set(d1.map((r) => r.date))).toEqual(new Set(['2026-10-30']))
      expect(d1).toHaveLength(26)
      // Friday 09:30 EDT = 18:30 Almaty, 15:45 EDT = 00:45 next day Almaty
      expect(d1[0]).toMatchObject({ min: 18 * 60 + 30, ldate: '2026-10-30', zone: 'GMT+5' })
      expect(d1.at(-1)).toMatchObject({ min: 45, ldate: '2026-10-31' })
    })

    it(`Monday session opens at 09:30 EST = 19:30 Almaty; 5D keeps Friday at 18:30 (offset ${offset / 3600} h)`, () => {
      const { mc, sessions, stock } = run(offset)
      const mon = stock('2026-11-02').filter((r) => r.ts <= axis(offset, '2026-11-02', '10:15'))
      const intraday = [...stock('2026-10-29'), ...stock('2026-10-30'), ...mon]
      const d1 = chartRows('1D', { intraday }, { today: '2026-11-02', sessions, clock: mc, timeZone: ALMATY })
      expect(d1.map((r) => r.ts)).toEqual([0, 1, 2, 3].map((k) => axis(offset, '2026-11-02', '09:30') + k * 900))
      expect(d1[0].min).toBe(19 * 60 + 30)
      const d5 = chartRows('5D', { intraday }, { today: '2026-11-02', sessions, clock: mc, timeZone: ALMATY })
      const on = (d) => d5.filter((r) => r.date === d)
      expect(on('2026-10-29')).toHaveLength(26)
      expect(on('2026-10-30')).toHaveLength(26)
      expect(on('2026-10-30')[0].min).toBe(18 * 60 + 30)
      expect(on('2026-11-02')).toHaveLength(4)
      expect(on('2026-11-02')[0].min).toBe(19 * 60 + 30)
      // Open in key statistics: Monday's first regular bar, not the pre-market
      expect(keyStats({ intraday, sessions, clock: mc }).open).toBe(mon.find((r) => r.ts === axis(offset, '2026-11-02', '09:30')).open)
    })
  }
})

describe('holdings day sparks per market session', () => {
  const OFF = 10800
  const clock = marketClock(summer())
  const IDX = [
    ...bars(OFF, 'SP500.IDX', '2026-10-29', '09:30', '15:45', 'FIX', 1),
    ...bars(OFF, 'SP500.IDX', '2026-10-30', '09:30', '15:45', 'FIX', 1),
  ]

  it('.EU (LSE hours 08:00-16:30 London): off-session bars at 21:00 and 03:00 next day do not take the session', () => {
    // Synthetic .EU listing: regular bars, a late bar at 21:00 and a lone 03:00 bar dated the next day.
    const late = (d, hhmm, close) => ({ ticker: 'EEE.EU', mkt: 'EU', ts: axis(OFF, d, hhmm), date: d, close })
    const rows = [
      ...bars(OFF, 'EEE.EU', '2026-10-29', '08:00', '16:30', 'EU', 60), late('2026-10-29', '21:00', 61.7),
      late('2026-10-30', '03:00', 61.7),
      ...bars(OFF, 'EEE.EU', '2026-10-30', '08:00', '16:30', 'EU', 70), late('2026-10-30', '21:00', 58.9),
      late('2026-10-31', '03:00', 58.9),
    ]
    const s = daySparks(rows, IDX, clock)['EEE.EU']
    expect(s.date).toBe('2026-10-30')
    expect(s.spark).toEqual(bars(OFF, 'EEE.EU', '2026-10-30', '08:00', '16:30', 'EU', 70).map((r) => r.close))
  })

  it('KASE: own last session, the pre-open bar before o is dropped, in-session prints stay', () => {
    const rows = [
      { ticker: 'KKK_KZ.KZ', mkt: 'KASE', ts: axis(OFF, '2026-10-29', '21:15'), date: '2026-10-29', close: 52 },
      { ticker: 'KKK_KZ.KZ', mkt: 'KASE', ts: axis(OFF, '2026-10-30', '11:15'), date: '2026-10-30', close: 51 }, // pre-open
      { ticker: 'KKK_KZ.KZ', mkt: 'KASE', ts: axis(OFF, '2026-10-30', '11:30'), date: '2026-10-30', close: 50.25 },
      { ticker: 'KKK_KZ.KZ', mkt: 'KASE', ts: axis(OFF, '2026-10-30', '13:45'), date: '2026-10-30', close: 54.75 }, // thin in-session print
      { ticker: 'KKK_KZ.KZ', mkt: 'KASE', ts: axis(OFF, '2026-10-30', '21:30'), date: '2026-10-30', close: 48.5 },
    ]
    expect(daySparks(rows, IDX, clock)['KKK_KZ.KZ']).toEqual({ date: '2026-10-30', spark: [50.25, 54.75, 48.5] })
  })

  it('US: last index session; the running session is open-ended to the learned close, post-market out', () => {
    const today = [
      ...bars(OFF, 'SP500.IDX', '2026-11-02', '09:30', '10:00', 'FIX', 1), // index cache lags
    ]
    const c = marketClock(winter())
    const stock = [
      ...bars(OFF, 'AAA.US', '2026-10-30', '04:00', '19:45', 'FIX', 10),
      ...bars(OFF, 'AAA.US', '2026-11-02', '04:00', '11:00', 'FIX', 500),
    ]
    const s = daySparks(stock, [...IDX, ...today], c)['AAA.US']
    expect(s.date).toBe('2026-11-02')
    expect(s.spark).toHaveLength(7) // 09:30 .. 11:00
    // after the close: index bars complete, post-market out
    const full = [...IDX, ...bars(OFF, 'SP500.IDX', '2026-11-02', '09:30', '15:45', 'FIX', 1)]
    const after = [...bars(OFF, 'AAA.US', '2026-10-30', '04:00', '19:45', 'FIX', 10), ...bars(OFF, 'AAA.US', '2026-11-02', '04:00', '19:45', 'FIX', 500)]
    expect(daySparks(after, full, c)['AAA.US'].spark).toHaveLength(26)
  })
})

describe('parsers use the server offset', () => {
  const answer = {
    hloc: { 'X.EU': [[12, 8, 9, 10.5]] },
    xSeries: { 'X.EU': [utc('2026-10-29T21:00:00')] },
    vl: { 'X.EU': [5] },
    info: { 'X.EU': { mkt_name: 'EU', mrkt: { tz: 'Europe/London', dt: 180 } } },
  }
  it('daily dates and markets from the answer', () => {
    const c3 = marketClock(summer())
    expect(parseHloc({ answer }, c3).rows[0]).toEqual({ ticker: 'X.EU', mkt: 'EU', ts: utc('2026-10-29T21:00:00'), date: '2026-10-30', close: 10.5 })
    expect(parsePricesForPeriod({ answer, args: { date_from: '05.10.2026 00:00' } }, c3).rows[0]).toMatchObject({ date: '2026-10-30' })
    expect(parseCandles(answer, 'X.EU', c3)[0]).toMatchObject({ date: '2026-10-30', mkt: 'EU' })
    expect(candleZone(answer, 'X.EU')).toEqual({ mkt: 'EU', tz: 'Europe/London' })
    // a server at UTC: the same instant is the previous day's 21:00
    expect(parseHloc({ answer }, marketClock(summer(0))).rows[0].date).toBe('2026-10-29')
    expect(() => parseHloc({ answer }, null)).toThrow()
  })
})
