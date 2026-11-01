// IndexedDB store: one DB "nyfpt", data partitioned by accountKey.
// Every row carries `v` = the cache format version (config CACHE_VERSION); a row of another
// version (or without `v`: written before versioning) reads as missing.
import { CACHE_VERSION } from '../config.js'

const DB_NAME = 'nyfpt'
const DB_VERSION = 1

// Open connections per factory, so deleteDatabase can close them first.
const connections = new WeakMap()

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
  })
}

function openRaw(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('kv', { keyPath: ['account', 'name'] })
      const candles = db.createObjectStore('candles', { keyPath: ['account', 'ticker', 'date'] })
      candles.createIndex('byTicker', ['account', 'ticker'])
    }
    req.onsuccess = () => {
      const db = req.result
      let set = connections.get(idb)
      if (!set) connections.set(idb, (set = new Set()))
      set.add(db)
      // Let other tabs / deleteDatabase proceed.
      db.onversionchange = () => { db.close(); set.delete(db) }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => {}
  })
}

// Delete the rows of `range` whose version is not `v`; resolves to the number deleted.
function deleteStale(store, range, v) {
  return new Promise((resolve, reject) => {
    let n = 0
    const req = store.openCursor(range)
    req.onsuccess = () => {
      const c = req.result
      if (!c) return resolve(n)
      if (c.value.v !== v) { c.delete(); n++ }
      c.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

/** `version`: tests only (a bundle with another cache format). */
export async function openAccountDb(accountKey, idb = globalThis.indexedDB, { version = CACHE_VERSION } = {}) {
  const db = await openRaw(idb)
  const accountRange = () => IDBKeyRange.bound([accountKey], [accountKey, []])
  const tickerRange = (ticker) => IDBKeyRange.bound([accountKey, ticker, ''], [accountKey, ticker, '\uffff'])
  const rawKv = async (name) => promisify(db.transaction('kv', 'readonly').objectStore('kv').get([accountKey, name]))

  return {
    async getKv(name) {
      const row = await rawKv(name)
      return row && row.v === version ? { data: row.data, fetchedAt: row.fetchedAt } : null
    },

    async putKv(name, data, fetchedAt = Date.now()) {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put({ account: accountKey, name, data, fetchedAt, v: version })
      await txDone(tx)
    },

    async deleteKv(name) {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').delete([accountKey, name])
      await txDone(tx)
    },

    async getCandles(ticker) {
      const tx = db.transaction('candles', 'readonly')
      const rows = await promisify(
        tx.objectStore('candles').index('byTicker').getAll(IDBKeyRange.only([accountKey, ticker])),
      )
      return rows.filter((r) => r.v === version).map((r) => ({ date: r.date, close: r.close })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    },

    async putCandles(ticker, rows) {
      const tx = db.transaction('candles', 'readwrite')
      const store = tx.objectStore('candles')
      for (const r of rows) store.put({ account: accountKey, ticker, date: r.date, close: r.close, v: version })
      await txDone(tx)
    },

    /** Drop a ticker's whole stored history (split / adjustment). */
    async deleteCandles(ticker) {
      const tx = db.transaction('candles', 'readwrite')
      tx.objectStore('candles').delete(tickerRange(ticker))
      await txDone(tx)
    },

    /** After a format change: when one of the `probe` kv rows is of another version, delete
     *  every row of another version in this account (kv and candles). Resolves to the count. */
    async purgeStale(probe) {
      const rows = await Promise.all(probe.map(rawKv))
      if (!rows.some((r) => r && r.v !== version)) return 0
      const tx = db.transaction(['kv', 'candles'], 'readwrite')
      // Awaited together: a failing cursor aborts the transaction, and `done` must not reject unhandled.
      const [[a, b]] = await Promise.all([
        Promise.all(['kv', 'candles'].map((s) => deleteStale(tx.objectStore(s), accountRange(), version))),
        txDone(tx),
      ])
      return a + b
    },

    async clear() {
      const tx = db.transaction(['kv', 'candles'], 'readwrite')
      tx.objectStore('kv').delete(accountRange())
      tx.objectStore('candles').delete(accountRange())
      await txDone(tx)
    },

    close() {
      db.close()
      connections.get(idb)?.delete(db)
    },
  }
}

export function deleteDatabase(idb = globalThis.indexedDB) {
  // Close our own connections first, otherwise the delete would block.
  for (const db of connections.get(idb) || []) db.close()
  connections.delete(idb)
  return new Promise((resolve, reject) => {
    const req = idb.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    // Blocked by another tab: the request completes once it closes.
    req.onblocked = () => {}
  })
}
