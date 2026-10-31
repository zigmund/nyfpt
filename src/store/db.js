// IndexedDB store: one DB "nyfpt", data partitioned by accountKey.
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

export async function openAccountDb(accountKey, idb = globalThis.indexedDB) {
  const db = await openRaw(idb)

  return {
    async getKv(name) {
      const tx = db.transaction('kv', 'readonly')
      const row = await promisify(tx.objectStore('kv').get([accountKey, name]))
      return row ? { data: row.data, fetchedAt: row.fetchedAt } : null
    },

    async putKv(name, data, fetchedAt = Date.now()) {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put({ account: accountKey, name, data, fetchedAt })
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
      return rows.map((r) => ({ date: r.date, close: r.close })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    },

    async putCandles(ticker, rows) {
      const tx = db.transaction('candles', 'readwrite')
      const store = tx.objectStore('candles')
      for (const r of rows) store.put({ account: accountKey, ticker, date: r.date, close: r.close })
      await txDone(tx)
    },

    async lastCandleDate(ticker) {
      const tx = db.transaction('candles', 'readonly')
      const range = IDBKeyRange.bound([accountKey, ticker, ''], [accountKey, ticker, '￿'])
      const cursor = await promisify(tx.objectStore('candles').openCursor(range, 'prev'))
      return cursor ? cursor.value.date : null
    },

    async clear() {
      const tx = db.transaction(['kv', 'candles'], 'readwrite')
      const range = () => IDBKeyRange.bound([accountKey], [accountKey, []])
      tx.objectStore('kv').delete(range())
      tx.objectStore('candles').delete(range())
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
