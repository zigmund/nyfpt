import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openAccountDb, deleteDatabase } from '../src/store/db.js'
import { CACHE_VERSION } from '../src/config.js'
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

  it('deleteCandles drops one ticker only', async () => {
    const db = await openAccountDb('global:1', idb)
    await db.putCandles('AAA', [{ date: '2025-01-01', close: 1 }, { date: '2025-03-01', close: 2 }])
    await db.putCandles('AAB', [{ date: '2026-01-01', close: 1 }])
    await db.deleteCandles('AAA')
    expect(await db.getCandles('AAA')).toEqual([])
    expect(await db.getCandles('AAB')).toEqual([{ date: '2026-01-01', close: 1 }])
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

// Rows as the bundle before CACHE_VERSION wrote them: no `v` field.
async function putRaw(idb, store, row) {
  await openAccountDb('global:1', idb) // creates the schema
  const raw = await new Promise((resolve, reject) => {
    const req = idb.open('nyfpt')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  await new Promise((resolve, reject) => {
    const tx = raw.transaction(store, 'readwrite')
    tx.objectStore(store).put(row)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  raw.close()
}

describe('db: cache version', () => {
  let idb
  beforeEach(() => { idb = new IDBFactory() })

  it('CACHE_VERSION is an integer above 1 (rows without a version are version 1)', () => {
    expect(Number.isInteger(CACHE_VERSION)).toBe(true)
    expect(CACHE_VERSION).toBeGreaterThan(1)
  })

  it('kv rows and candles of another version read as missing', async () => {
    const old = await openAccountDb('global:1', idb, { version: CACHE_VERSION - 1 })
    await old.putKv('sparks', { tickers: ['A'] }, 5)
    await old.putCandles('AAA', [{ date: '2025-01-01', close: 1 }])
    const db = await openAccountDb('global:1', idb)
    expect(await db.getKv('sparks')).toBeNull()
    expect(await db.getCandles('AAA')).toEqual([])
    await db.putKv('sparks', { tickers: ['B'] }, 6)
    await db.putCandles('AAA', [{ date: '2025-01-02', close: 2 }])
    expect(await db.getKv('sparks')).toEqual({ data: { tickers: ['B'] }, fetchedAt: 6 })
    expect(await db.getCandles('AAA')).toEqual([{ date: '2025-01-02', close: 2 }])
  })

  it('rows without a version (previous bundle) read as missing', async () => {
    await putRaw(idb, 'kv', { account: 'global:1', name: 'positions', data: { rows: [] }, fetchedAt: 1 })
    await putRaw(idb, 'candles', { account: 'global:1', ticker: 'AAA', date: '2025-01-01', close: 1 })
    const db = await openAccountDb('global:1', idb)
    expect(await db.getKv('positions')).toBeNull()
    expect(await db.getCandles('AAA')).toEqual([])
  })

  it('purgeStale: deletes the account rows of other versions when a probed row is stale', async () => {
    const old = await openAccountDb('global:1', idb, { version: CACHE_VERSION - 1 })
    const other = await openAccountDb('global:2', idb, { version: CACHE_VERSION - 1 })
    await old.putKv('positions', 1)
    await old.putKv('news:detail:1', 2)
    await old.putCandles('AAA', [{ date: '2025-01-01', close: 1 }])
    await other.putKv('positions', 3)
    const db = await openAccountDb('global:1', idb)
    await db.putKv('marketInfo', 4)
    await db.putCandles('BBB', [{ date: '2025-01-01', close: 5 }])
    expect(await db.purgeStale(['clock'])).toBe(0) // probed row missing: nothing scanned
    expect((await old.getKv('positions')).data).toBe(1)
    expect(await db.purgeStale(['clock', 'positions'])).toBe(3)
    expect(await old.getKv('positions')).toBeNull()
    expect(await old.getKv('news:detail:1')).toBeNull()
    expect(await old.getCandles('AAA')).toEqual([])
    expect((await db.getKv('marketInfo')).data).toBe(4)
    expect(await db.getCandles('BBB')).toEqual([{ date: '2025-01-01', close: 5 }])
    expect((await other.getKv('positions')).data).toBe(3) // other account untouched
    expect(await db.purgeStale(['positions'])).toBe(0)
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
    expect(loadPrefs()).toEqual({ hide: false, period: 'YTD', vmode: 'perf', sorts: {}, theme: 'light', holdingsMode: 'day', holdingsClosedOpen: false, contribOpen: false, flowsOpen: false })
  })

  it('prefs merge with defaults', () => {
    savePrefs({ hide: true })
    expect(loadPrefs()).toEqual({ hide: true, period: 'YTD', vmode: 'perf', sorts: {}, theme: 'light', holdingsMode: 'day', holdingsClosedOpen: false, contribOpen: false, flowsOpen: false })
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
