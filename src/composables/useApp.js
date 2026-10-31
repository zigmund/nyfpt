// App state singleton: session, account partition, repo + live wiring, prefs and hash routing.
import { ref, shallowRef, reactive, watch, computed } from 'vue'
import { CABINETS, DEFAULT_CABINET, MARKET_STRIP, MARKET_STRIP_MAX, POLL_MS } from '../config.js'
import { PERIODS } from '../calc/periods.js'
import { t } from '../i18n.js'
import { loginByPassword, requestPhoneCode, loginByPhoneCode } from '../api/auth.js'
import { createBroker } from '../api/broker.js'
import { LiveSocket } from '../api/ws.js'
import { openAccountDb } from '../store/db.js'
import {
  loadSession, saveSession, clearSession, loadPrefs, savePrefs, marketStripOf, validStrip, stripCardOf,
  loadRecent, saveRecent, pushRecent,
} from '../store/session.js'
import { createRepo } from '../data/repo.js'
import { localDay } from '../calc/marketTime.js'
import { createLive } from '../data/live.js'
import { createNews } from '../data/news.js'

export const THEMES = ['system', 'light', 'dark']
// Page background per resolved theme, mirrored into <meta name="theme-color">.
// Same values in app.css --c-bg and public/theme-boot.js (tests/theme-boot.test.js keeps them in sync).
export const THEME_BG = { light: '#F1F3F2', dark: '#0D0F0E' }

export const ROUTES = ['/', '/login', '/compare', '/settings']

const defaultDeps = () => ({
  auth: { loginByPassword, requestPhoneCode, loginByPhoneCode },
  createBroker,
  createRepo,
  createLive,
  createNews,
  openAccountDb,
  socketFactory: (cabinet, sid) => () => new LiveSocket({ wsUrl: cabinet.ws, sid }),
  sessionStore: { load: loadSession, save: saveSession, clear: clearSession },
  prefsStore: { load: loadPrefs, save: savePrefs },
  recentStore: { load: loadRecent, save: saveRecent },
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id),
  mock: false,
})

export class AccountError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AccountError'
  }
}

/** Local storage (IndexedDB) could not be opened, e.g. in some private browsing modes. */
export class StorageError extends Error {
  constructor(message = t('error.storage')) {
    super(message)
    this.name = 'StorageError'
  }
}

export const cabinetOf = (id) => CABINETS.find((c) => c.id === id) || CABINETS.find((c) => c.id === DEFAULT_CABINET)

const psOf = (a) => (a && a.result && a.result.ps) || (a && a.ps) || null

/** Supported unless `acc[]` has no USD row while holding a non-zero non-USD balance. */
export function isUsdAccount(answer) {
  const acc = psOf(answer)?.acc || []
  if (acc.some((c) => c.curr === 'USD')) return true
  return !acc.some((c) => Number(c.s) !== 0)
}

/** Selected period from prefs; unknown values fall back to YTD. */
export const periodOf = (prefs) => (PERIODS.includes(prefs.period) ? prefs.period : 'YTD')

// Position card: '/position/<URL-encoded ticker>[/<tab>[/<item>]]' (item: a news article id).
const POSITION_RE = /^\/position\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/

/** {ticker, tab[, item]} of a position card path, or null. Tab defaults to 'summary'. */
export function positionRoute(path) {
  const m = POSITION_RE.exec(String(path || ''))
  if (!m) return null
  let ticker
  let item
  try {
    ticker = decodeURIComponent(m[1]).trim()
    item = m[3] ? decodeURIComponent(m[3]).trim() : ''
  } catch { return null }
  if (!ticker) return null
  return item ? { ticker, tab: m[2], item } : { ticker, tab: m[2] || 'summary' }
}

/** Path of a position card tab (and item); Summary is the bare card path. */
export const positionPath = (ticker, tab = 'summary', item = null) => {
  const base = `/position/${encodeURIComponent(ticker)}`
  if (item !== null && item !== undefined && item !== '') return `${base}/${tab}/${encodeURIComponent(item)}`
  return `${base}${tab && tab !== 'summary' ? `/${tab}` : ''}`
}

export const parseHash = (h) => {
  const p = String(h || '').replace(/^#/, '') || '/'
  return ROUTES.includes(p) || positionRoute(p) ? p : '/'
}

/**
 * Creates the reactive app state. `overrides` replace default dependencies (tests, dev mock).
 * Public API:
 *   session      Ref<{cabinetId, sid, userId, loggedAt} | null>
 *   expired      Ref<boolean>   session expired: login shown over the cached data
 *   fatal        Ref<string>    account could not be opened (storage failure); '' when fine
 *   state        ShallowRef     latest repo state (see data/repo.js), null before an account is open
 *   tick         Ref<number>    bumped on every repo emit and live 'update'
 *   live         { isLive: Ref<boolean>, usOpen: Ref<boolean>, quotes: Map }
 *   prefs        reactive prefs (persisted); prefs.theme 'system'|'light'|'dark' is applied to <html data-theme>
 *   marketStrip  ComputedRef<[{ticker, label, note?}]> cards of the markets strip (prefs.marketStrip or the default)
 *   setMarketStrip(list | null)  save the strip (null / the default list: back to the default); false when invalid
 *   inStrip(ticker), stripFull  ComputedRef<boolean>: the strip has MARKET_STRIP_MAX cards
 *   addToStrip({ticker, name, code})  a card at the end (label = name, note = code); false when full or shown
 *   removeFromStrip(ticker)
 *   findTickers(text)  broker instrument search (repo.findTickers)
 *   searchQuotes(tickers)  {ticker: {last, change}} for search rows (repo.searchQuotes; never rejects)
 *   recent       Ref<[{ticker, name, code, type, market, currency}]> securities opened from the search
 *   addRecent(row), clearRecent()
 *   route        Ref<'/' | '/login' | '/compare' | '/settings' | '/position/<ticker>[/<tab>]'>
 *   liveQuotesForCalc()  quotes Map while live, else undefined (pass to repo.coreFor)
 *   isLiveFor(ticker)    live and this security's own market is open (position card)
 *   marketOpen(ltr)      that market is open (market status), for a card without a streamed quote
 *   coreFor(period, day) repo.coreFor with live quotes applied; null when not covered
 *   ensurePrices(period, day), refresh(opts), marketsStrip(), getRepo()
 *   security(ticker), loadSecurity(ticker, parts, opts)  position card data (data/repo.js)
 *   news()       the account's news cache (data/news.js), null without an attached account
 *   login(cabinetId, {login, password} | {authCodeId, code}), requestCode(cabinetId, phone)
 *   logout() (erases the account cache and Recent; returns a promise), clearCache(), retry(), go(path, {replace}), start(), stop()
 *   back(fallback = '/')  previous app history entry, or `fallback` replacing the first entry (deep link)
 */
export function createAppState(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const win = globalThis.window
  const doc = globalThis.document

  const session = shallowRef(null)
  const expired = ref(false)
  const fatal = ref('')
  const state = shallowRef(null)
  const tick = ref(0)
  const route = ref(parseHash(win?.location?.hash))
  const prefs = reactive(deps.prefsStore.load())
  const EMPTY = new Map()
  const live = { isLive: ref(false), usOpen: ref(false), get quotes() { return liveObj ? liveObj.quotes : EMPTY } }

  let db = null
  let accountKey = null
  let repo = null
  let liveObj = null
  let news = null
  let unsubs = []
  let gen = 0
  let started = false
  let visible = !doc?.hidden
  let refreshTimer = null

  watch(prefs, (p) => deps.prefsStore.save({ ...p }), { deep: true })

  // --- markets strip: prefs.marketStrip absent / null = MARKET_STRIP (a new default reaches everyone
  // who never customised it); the repo fetches and live subscribes the card tickers.
  const marketStrip = computed(() => marketStripOf(prefs.marketStrip))
  const stripTickers = () => marketStrip.value.map((m) => m.ticker)
  function setMarketStrip(list) {
    if (list === null) { prefs.marketStrip = null; return true }
    const v = validStrip(list)
    if (!v) return false
    prefs.marketStrip = JSON.stringify(v) === JSON.stringify(MARKET_STRIP) ? null : v
    return true
  }
  watch(() => stripTickers().join(','), () => { repo?.setStrip?.(stripTickers())?.catch?.(() => {}) })
  const inStrip = (ticker) => marketStrip.value.some((m) => m.ticker === ticker)
  const stripFull = computed(() => marketStrip.value.length >= MARKET_STRIP_MAX)
  function addToStrip(r) {
    if (stripFull.value || inStrip(r.ticker)) return false
    return setMarketStrip([...marketStrip.value, stripCardOf(r)])
  }
  function removeFromStrip(ticker) {
    return setMarketStrip(marketStrip.value.filter((m) => m.ticker !== ticker))
  }

  // --- recent searches (localStorage, no prices)
  const recent = ref(deps.recentStore.load())
  function setRecent(list) {
    recent.value = list
    deps.recentStore.save(list)
  }
  const addRecent = (r) => setRecent(pushRecent(recent.value, r))
  const clearRecent = () => setRecent([])

  // --- theme: prefs.theme -> <html data-theme>, meta tags; 'system' follows prefers-color-scheme
  if (!THEMES.includes(prefs.theme)) prefs.theme = 'light'
  const media = win?.matchMedia ? win.matchMedia('(prefers-color-scheme: dark)') : null
  function applyTheme() {
    if (!doc) return
    const resolved = prefs.theme === 'system' ? (media?.matches ? 'dark' : 'light') : prefs.theme
    doc.documentElement.setAttribute('data-theme', resolved)
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BG[resolved])
    doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved)
  }
  watch(() => prefs.theme, applyTheme, { flush: 'sync' })
  applyTheme()

  function bump() {
    const on = !!liveObj && !expired.value
    const wasLive = live.isLive.value
    live.isLive.value = on && !!liveObj.isLive()
    live.usOpen.value = on && !!liveObj.marketsOpen()?.us
    // Session over: today's close replaces the partial candle cached during it (spec §9).
    if (on && wasLive && !live.isLive.value) ensureCurrent()
    tick.value++
  }

  // --- scheduled refresh (spec §10): one timer, only while visible with a live account.
  /** Closes for the selected period (incremental from the last cached date). */
  function ensureCurrent() {
    const r = repo
    if (!r || expired.value) return Promise.resolve()
    return Promise.resolve().then(() => r.ensurePrices(periodOf(prefs))).catch(() => {})
  }

  // TTL-gated REST datasets, then closes; while live, quotes stand in for today's close.
  async function scheduledRefresh() {
    const r = repo
    if (!r || expired.value) return
    try { await r.refresh() } catch { /* repo records its own errors */ }
    if (r !== repo || expired.value || liveQuotesForCalc()) return
    await ensureCurrent()
  }

  function syncTimer() {
    const want = !!repo && !expired.value && visible
    if (want && refreshTimer == null) {
      refreshTimer = deps.setTimer(() => {
        refreshTimer = null
        syncTimer()
        scheduledRefresh()
      }, POLL_MS)
    } else if (!want && refreshTimer != null) {
      deps.clearTimer(refreshTimer)
      refreshTimer = null
    }
  }

  // --- routing
  // In-app history depth, kept in each entry's history.state: 0 = the first entry of the app (a deep
  // link), each push (go() or a followed link) adds 1. back() uses the history only above 0.
  let depth = 0
  function markDepth(d, hash) {
    depth = d
    const st = { ...(win.history.state || {}), depth: d }
    try {
      if (hash === undefined) win.history.replaceState(st, '')
      else win.history.replaceState(st, '', hash)
    } catch { /* no history */ }
  }
  const depthOf = (st) => (Number.isInteger(st?.depth) && st.depth >= 0 ? st.depth : null)

  function setRoute(path, replace = false) {
    route.value = path
    if (!win) return
    const hash = `#${path}`
    if (win.location.hash === hash) return
    if (replace) markDepth(depth, hash)
    else {
      const d = depth + 1
      win.location.hash = hash
      markDepth(d, hash)
    }
  }
  /** Navigate; login is enforced while there is no session. `replace`: no new history entry. */
  function go(path, { replace = false } = {}) {
    const p = parseHash(path)
    if (!session.value) return setRoute('/login', true)
    setRoute(p === '/login' ? '/' : p, replace)
  }
  function onHash() {
    // An entry of ours (back / forward) carries its depth; a new one (link, typed URL) is a push.
    const d = depthOf(win.history.state)
    if (d === null) markDepth(depth + 1)
    else depth = d
    const p = parseHash(win.location.hash)
    if (!session.value && p !== '/login') return setRoute('/login', true)
    if (session.value && p === '/login') return setRoute('/', true)
    route.value = p
  }

  function onVisibility() {
    const was = visible
    visible = !doc.hidden
    syncTimer()
    if (!liveObj || expired.value) return
    if (!visible) liveObj.pause()
    else {
      liveObj.resume() // also refreshes the REST datasets
      if (!was) ensureCurrent()
    }
  }

  // --- account wiring
  function detach() {
    for (const u of unsubs.splice(0)) u()
    liveObj?.stop()
    liveObj = null
    repo = null
    news = null
    syncTimer()
  }

  function closeDb() {
    try { db?.close() } catch { /* already closed */ }
    db = null
    accountKey = null
  }

  function onExpired() {
    expired.value = true
    // The SID is dead: no sockets or polling, and no live state until the next login.
    liveObj?.stop()
    liveObj = null
    syncTimer()
    bump()
  }

  /** Open (or reuse) the account partition and start repo + live for session `s`.
   *  Throws StorageError when the partition cannot be opened. */
  async function attach(s, broker) {
    const my = ++gen
    const cabinet = cabinetOf(s.cabinetId)
    const key = `${cabinet.id}:${s.userId}`
    detach()
    if (accountKey !== key) {
      closeDb()
      state.value = null
      let opened
      try {
        opened = await deps.openAccountDb(key)
      } catch {
        throw new StorageError()
      }
      if (my !== gen) { opened.close(); return }
      db = opened
      accountKey = key
    }
    broker ||= deps.createBroker({ cabinet, sid: s.sid })
    repo = deps.createRepo({ broker, db, strip: stripTickers() })
    liveObj = deps.createLive({ repo, broker, socketFactory: deps.socketFactory(cabinet, s.sid) })
    news = deps.createNews({ broker, db, onExpired: () => { if (my === gen && !expired.value) onExpired() } })
    expired.value = false
    unsubs.push(
      repo.subscribe((st) => { state.value = st; bump() }),
      repo.onSessionExpired(onExpired),
      liveObj.on('update', bump),
    )
    liveObj.start()
    if (doc?.hidden) liveObj.pause()
    syncTimer()
    repo.load().catch(() => {}) // repo records its own errors in state.errors
  }

  // --- public actions
  function start() {
    if (started) return
    started = true
    if (win) markDepth(depthOf(win.history.state) ?? 0)
    win?.addEventListener('hashchange', onHash)
    doc?.addEventListener('visibilitychange', onVisibility)
    media?.addEventListener('change', applyTheme)
    let s = deps.sessionStore.load()
    // A session from a removed cabinet (older builds) is unusable.
    if (s && !CABINETS.some((c) => c.id === s.cabinetId)) {
      deps.sessionStore.clear()
      s = null
    }
    if (!s) {
      setRoute('/login', true)
      return
    }
    session.value = s
    if (route.value === '/login') setRoute('/', true)
    open(s)
  }

  // Attach for an already persisted session; failures surface through `fatal`.
  async function open(s) {
    fatal.value = ''
    try {
      await attach(s)
    } catch (e) {
      fatal.value = (e && e.message) || t('error.storage')
    }
  }

  function retry() {
    return session.value ? open(session.value) : Promise.resolve()
  }

  function stop() {
    started = false
    win?.removeEventListener('hashchange', onHash)
    doc?.removeEventListener('visibilitychange', onVisibility)
    media?.removeEventListener('change', applyTheme)
    detach()
  }

  function requestCode(cabinetId, phone) {
    return deps.auth.requestPhoneCode({ cabinet: cabinetOf(cabinetId), phone })
  }

  /** Throws BrokerError / NetworkError / AccountError; credentials are never kept. */
  async function login(cabinetId, creds) {
    const cabinet = cabinetOf(cabinetId)
    const res = creds.authCodeId != null
      ? await deps.auth.loginByPhoneCode({ cabinet, authCodeId: creds.authCodeId, code: creds.code })
      : await deps.auth.loginByPassword({ cabinet, login: creds.login, password: creds.password })
    const broker = deps.createBroker({ cabinet, sid: res.sid })
    let userId = res.userId
    if (userId == null) userId = (await broker.checkSession())?.user_id ?? null
    if (userId == null) throw new AccountError(t('error.noUser'))
    if (!isUsdAccount(await broker.positions())) throw new AccountError(t('error.usdOnly'))
    const s = { cabinetId: cabinet.id, sid: res.sid, userId, loggedAt: deps.now() }
    // The previous session (kept over an expiry): Recent lists its activity, not another account's.
    const prev = session.value || deps.sessionStore.load()
    // Persist only after the account check passed and its storage opened.
    await attach(s, broker)
    if (prev && `${prev.cabinetId}:${prev.userId}` !== `${s.cabinetId}:${s.userId}`) clearRecent()
    deps.sessionStore.save(s)
    session.value = s
    fatal.value = ''
    setRoute('/')
  }

  /** Forget the SID and erase this account's cache (spec §8). Resolves when the erase is done;
   *  storage errors are swallowed. Expiry never gets here: it keeps the cache. */
  function logout() {
    gen++
    detach()
    const d = db
    let erased = Promise.resolve()
    if (d) {
      // clear() opens its transaction synchronously, so it is queued before close().
      try { erased = Promise.resolve(d.clear()) } catch (e) { erased = Promise.reject(e) }
      erased = erased.catch(() => {})
    }
    closeDb()
    deps.sessionStore.clear()
    clearRecent() // built from this account's activity (held tickers): not left for the next user
    session.value = null
    expired.value = false
    fatal.value = ''
    state.value = null
    bump()
    setRoute('/login')
    return erased.then(() => {})
  }

  async function clearCache() {
    if (!db || !session.value) return
    await db.clear()
    await open(session.value) // fresh repo: in-memory cache dropped, reloads from the broker
  }

  /** Back from a screen: the previous app entry when there is one, else `fallback` (deep link) in
   *  place of this entry, so system Back does not bounce between the two. */
  function back(fallback = '/') {
    if (depth > 0 && win?.history) win.history.back()
    else go(fallback, { replace: true })
  }

  /** Market `name` (getSecurityInfo / quote `ltr`) is open, per the live controller's market status. */
  function marketOpen(name) {
    return !!liveObj && !expired.value && !!liveObj.isMarketOpen?.(name)
  }

  /** Live for one security: live mode and its own market open (a KASE card is not live
   *  because the US session is). */
  function isLiveFor(ticker) {
    return !!liveQuotesForCalc() && !!liveObj.isOpenFor?.(ticker)
  }

  function liveQuotesForCalc() {
    return liveObj && !expired.value && liveObj.isLive() ? liveObj.quotes : undefined
  }

  return {
    session, expired, fatal, state, tick, live, prefs, route,
    marketStrip, setMarketStrip, inStrip, stripFull, addToStrip, removeFromStrip,
    recent, addRecent, clearRecent,
    findTickers: (text) => (repo?.findTickers ? repo.findTickers(text) : Promise.resolve([])),
    searchQuotes: (tickers) => (repo?.searchQuotes ? repo.searchQuotes(tickers) : Promise.resolve({})),
    mock: !!deps.mock,
    cabinets: CABINETS,
    cabinetOf,
    start, stop, go, back, login, requestCode, logout, clearCache, retry,
    liveQuotesForCalc,
    isLiveFor,
    marketOpen,
    getRepo: () => repo,
    coreFor: (period, day) => (repo ? repo.coreFor(period, day, liveQuotesForCalc()) : null),
    ensurePrices: (period, day) => (repo ? repo.ensurePrices(period, day) : Promise.resolve()),
    refresh: (opts) => (repo ? repo.refresh(opts) : Promise.resolve()),
    marketsStrip: () => (repo ? repo.marketsStrip() : null),
    today: (ms = Date.now()) => (repo?.today ? repo.today(ms) : localDay(ms)),
    security: (ticker) => (repo ? repo.security(ticker) : null),
    loadSecurity: (ticker, parts, opts) => (repo ? repo.loadSecurity(ticker, parts, opts) : Promise.resolve()),
    news: () => news,
  }
}

let instance = null

/** Singleton accessor used by components. */
export function useApp() {
  return (instance ||= createAppState())
}

/** Install a prepared instance (main.js with dev-mock deps, tests). `null` resets. */
export function installApp(app) {
  instance?.stop?.()
  instance = app
  return app
}
