// Tradernet WebSocket: SID in the query, messages `[event, data, wstm]`, auto-reconnect.
// Subscriptions are remembered and re-sent on every (re)connect.

const BACKOFF_MIN = 5e3
const BACKOFF_MAX = 60e3

export class LiveSocket {
  constructor({
    wsUrl, sid, WebSocketImpl = globalThis.WebSocket,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  }) {
    const u = new URL(wsUrl)
    u.searchParams.set('SID', sid)
    this.url = u.toString()
    this.Impl = WebSocketImpl
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.handlers = new Map()
    this.tickers = null
    this.subs = new Set() // 'portfolio' | 'markets'
    this.delay = BACKOFF_MIN
    this.ws = null
    this.isOpen = false
    this.timer = null
    this.stopped = true
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event).add(fn)
    return () => this.handlers.get(event).delete(fn)
  }

  emit(event, ...args) {
    for (const fn of this.handlers.get(event) || []) fn(...args)
  }

  connect() {
    this.stopped = false
    if (!this.ws && this.timer == null) this.open()
  }

  close() {
    this.stopped = true
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = null
    const ws = this.ws
    const wasOpen = this.isOpen
    this.ws = null
    this.isOpen = false
    if (ws) {
      try { ws.close() } catch { /* already closed */ }
      if (wasOpen) this.emit('status', 'closed')
    }
  }

  setQuotes(tickers) {
    this.tickers = [...tickers]
    this.send(['quotes', this.tickers])
  }

  subscribePortfolio() { this.subscribe('portfolio') }

  subscribeMarkets() { this.subscribe('markets') }

  subscribe(name) {
    this.subs.add(name)
    this.send([name])
  }

  send(msg) {
    if (this.ws && this.isOpen) this.ws.send(JSON.stringify(msg))
  }

  open() {
    let ws
    try {
      ws = new this.Impl(this.url)
    } catch {
      this.reconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.isOpen = true
      if (this.tickers) this.send(['quotes', this.tickers])
      for (const s of this.subs) this.send([s])
      this.emit('status', 'open')
    }
    ws.onmessage = (e) => { if (this.ws === ws) this.handle(e.data) }
    ws.onclose = () => {
      if (this.ws !== ws) return
      const wasOpen = this.isOpen
      this.ws = null
      this.isOpen = false
      if (wasOpen) this.emit('status', 'closed')
      this.reconnect()
    }
    ws.onerror = () => {} // a close event follows
  }

  reconnect() {
    if (this.stopped || this.timer != null) return
    const d = this.delay
    this.delay = Math.min(d * 2, BACKOFF_MAX)
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this.stopped) this.open()
    }, d)
  }

  // A demo/unauthenticated session never recovers with the same SID: stop instead of retrying.
  authError() {
    this.close()
    this.emit('auth-error')
  }

  handle(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (!Array.isArray(msg)) return
    const [event, data] = msg
    switch (event) {
      case 'userData':
        if (data && data.mode === 'demo') this.authError()
        else this.delay = BACKOFF_MIN
        break
      case 'q': if (data) this.emit('quote', data); break
      case 'portfolio': if (data) this.emit('portfolio', data); break
      case 'markets': if (data) this.emit('markets', data); break
      case 'error':
        if (data && data.code === 'unauthenticated') this.authError()
        else this.emit('error', data)
        break
      default:
    }
  }
}
