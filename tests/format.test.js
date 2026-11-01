import { describe, it, expect } from 'vitest'
import { money, pct, num, dateShort, dateRange } from '../src/format.js'
import { t } from '../src/i18n.js'
import { CABINETS, DEFAULT_CABINET, TTL } from '../src/config.js'

describe('format', () => {
  it('money', () => {
    expect(money(123456.78)).toBe('$123,456.78')
    expect(money(-1234, { sign: true })).toBe('−$1,234.00')
    expect(money(5, { hide: true })).toBe('$***')
    expect(money(5, { hide: true, sign: true })).toBe('+$***')
    expect(money(-5, { hide: true, sign: true })).toBe('\u2212$***')
    expect(money(-5, { hide: true })).toBe('\u2212$***')
    expect(money(0, { hide: true, sign: true })).toBe('$***')
    expect(money(5, { sign: true })).toBe('+$5.00')
  })
  it('pct', () => {
    expect(pct(-3.456)).toBe('−3.46%')
    expect(pct(0.5)).toBe('+0.50%')
    expect(pct(0.5, { sign: false })).toBe('0.50%')
  })
  it('num', () => {
    expect(num(1234.5)).toBe('1,234.5')
  })
  it('dates', () => {
    expect(dateShort('2026-10-30')).toBe('Oct 30')
    expect(dateRange('2026-03-03', '2026-07-01')).toBe('Mar 3 – Jul 1')
  })
})

describe('i18n', () => {
  it('substitutes vars and falls back to key', () => {
    expect(t('app.name')).toBe('Portfolio')
    expect(t('status.updated', { time: '10:00' })).toBe('Updated 10:00')
    expect(t('status.updated')).toBe('Updated {time}')
    expect(t('unknown.key')).toBe('unknown.key')
  })
})

describe('config', () => {
  it('defaults', () => {
    expect(DEFAULT_CABINET).toBe('global')
    expect(CABINETS.map((c) => c.id)).toEqual(['global'])
    expect(TTL.positions).toBe(90000)
  })
})
