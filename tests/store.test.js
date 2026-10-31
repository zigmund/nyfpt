import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openAccountDb, deleteDatabase } from '../src/store/db.js'
import {
  loadSession, saveSession, clearSession, loadPrefs, savePrefs,
} from '../src/store/session.js'

function fakeStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  }
}

describe('db', () => {
  let idb
  beforeEach(() => { idb = new IDBFactory() })

  it('kv put/get', async () => {
    const db = await openAccountDb('global:1', idb)
    expect(await db.getKv('x')).toBeNull()
    await db.putKv('x', { a: 1 }, 123)
    expect(await db.getKv('x')).toEqual({ data: { a: 1 }, fetchedAt: 123 })
    db.close?.()
  })

  it('candles upsert and sort', async () => {
    const db = await openAccountDb('global:1', idb)
    await db.putCandles('AAA', [
      { date: '2025-01-03', close: 3 },
      { date: '2025-01-01', close: 1 },
    ])
    await db.putCandles('AAA', [{ date: '2025-01-03', close: 33 }, { date: '2025-01-02', close: 2 }])
    await db.putCandles('BBB', [{ date: '2025-02-01', close: 9 }])
    expect(await db.getCandles('AAA')).toEqual([
      { date: '2025-01-01', close: 1 },
      { date: '2025-01-02', close: 2 },
      { date: '2025-01-03', close: 33 },
    ])
    expect(await db.getCandles('ZZZ')).toEqual([])
  })

  it('lastCandleDate', async () => {
    const db = await openAccountDb('global:1', idb)
    expect(await db.lastCandleDate('AAA')).toBeNull()
    await db.putCandles('AAA', [{ date: '2025-01-01', close: 1 }, { date: '2025-03-01', close: 2 }])
    await db.putCandles('AAB', [{ date: '2026-01-01', close: 1 }])
    expect(await db.lastCandleDate('AAA')).toBe('2025-03-01')
  })

  it('clear only affects own account', async () => {
    const a = await openAccountDb('global:1', idb)
    const b = await openAccountDb('global:2', idb)
    await a.putKv('k', 1); await b.putKv('k', 2)
    await a.putCandles('T', [{ date: '2025-01-01', close: 1 }])
    await b.putCandles('T', [{ date: '2025-01-01', close: 5 }])
    await a.clear()
    expect(await a.getKv('k')).toBeNull()
    expect(await a.getCandles('T')).toEqual([])
    expect((await b.getKv('k')).data).toBe(2)
    expect(await b.getCandles('T')).toEqual([{ date: '2025-01-01', close: 5 }])
  })

  it('deleteDatabase resolves even with open connections', async () => {
    const a = await openAccountDb('global:1', idb)
    await a.putKv('k', 1)
    await deleteDatabase(idb)
    const again = await openAccountDb('global:1', idb)
    expect(await again.getKv('k')).toBeNull()
  })
})

describe('session and prefs', () => {
  beforeEach(() => { globalThis.localStorage = fakeStorage() })

  it('round-trips and strips extra fields', () => {
    expect(loadSession()).toBeNull()
    saveSession({ cabinetId: 'tradernet.global', sid: 's', userId: 7, loggedAt: 5, password: 'x' })
    expect(localStorage.getItem('nyfpt.session')).not.toContain('password')
    expect(loadSession()).toEqual({ cabinetId: 'tradernet.global', sid: 's', userId: 7, loggedAt: 5 })
    clearSession()
    expect(loadSession()).toBeNull()
  })

  it('corrupt JSON gives null/defaults', () => {
    localStorage.setItem('nyfpt.session', '{bad')
    localStorage.setItem('nyfpt.prefs', '{bad')
    expect(loadSession()).toBeNull()
    expect(loadPrefs()).toEqual({ hide: false, period: 'YTD', vmode: 'perf', sorts: {}, theme: 'light' })
  })

  it('prefs merge with defaults', () => {
    savePrefs({ hide: true })
    expect(loadPrefs()).toEqual({ hide: true, period: 'YTD', vmode: 'perf', sorts: {}, theme: 'light' })
  })

  it('survives throwing localStorage', () => {
    const boom = () => { throw new Error('denied') }
    globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom }
    expect(loadSession()).toBeNull()
    expect(() => saveSession({ sid: 'a' })).not.toThrow()
    expect(() => clearSession()).not.toThrow()
    expect(loadPrefs().period).toBe('YTD')
    expect(() => savePrefs({})).not.toThrow()
  })
})
