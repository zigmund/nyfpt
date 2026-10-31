// App state singleton: session, account partition, repo + live wiring, prefs and hash routing.
import { ref, shallowRef, reactive, watch } from 'vue'
import { CABINETS, DEFAULT_CABINET } from '../config.js'
import { t } from '../i18n.js'
import { loginByPassword, requestPhoneCode, loginByPhoneCode } from '../api/auth.js'
import { createBroker } from '../api/broker.js'
import { LiveSocket } from '../api/ws.js'
import { openAccountDb } from '../store/db.js'
import { loadSession, saveSession, clearSession, loadPrefs, savePrefs } from '../store/session.js'
import { createRepo } from '../data/repo.js'
import { createLive } from '../data/live.js'

export const ROUTES = ['/', '/login', '/compare', '/settings']

const defaultDeps = () => ({
  auth: { loginByPassword, requestPhoneCode, loginByPhoneCode },
  createBroker,
  createRepo,
  createLive,
  openAccountDb,
  socketFactory: (cabinet, sid) => () => new LiveSocket({ wsUrl: cabinet.ws, sid }),
  sessionStore: { load: loadSession, save: saveSession, clear: clearSession },
  prefsStore: { load: loadPrefs, save: savePrefs },
  now: () => Date.now(),
  mock: false,
})

export class AccountError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AccountError'
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

export const parseHash = (h) => {
  const p = String(h || '').replace(/^#/, '') || '/'
  return ROUTES.includes(p) ? p : '/'
}

/**
 * Creates the reactive app state. `overrides` replace default dependencies (tests, dev mock).
 * Public API:
 *   session      Ref<{cabinetId, sid, userId, loggedAt} | null>
 *   expired      Ref<boolean>   session expired: login shown over the cached data
 *   state        ShallowRef     latest repo state (see data/repo.js), null before an account is open
 *   tick         Ref<number>    bumped on every repo emit and live 'update'
 *   live         { isLive: Ref<boolean>, usOpen: Ref<boolean>, quotes: Map }
 *   prefs        reactive prefs (persisted)
 *   route        Ref<'/' | '/login' | '/compare' | '/settings'>
 *   liveQuotesForCalc()  quotes Map while live, else undefined (pass to repo.coreFor)
 *   coreFor(period, day) repo.coreFor with live quotes applied; null when not covered
 *   ensurePrices(period, day), refresh(opts), marketsStrip(), getRepo()
 *   login(cabinetId, {login, password} | {authCodeId, code}), requestCode(cabinetId, phone)
 *   logout(), clearCache(), go(path), start(), stop()
 */
export function createAppState(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const win = globalThis.window
  const doc = globalThis.document

  const session = shallowRef(null)
  const expired = ref(false)
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
  let unsubs = []
  let gen = 0
  let started = false

  watch(prefs, (p) => deps.prefsStore.save({ ...p }), { deep: true })

  function bump() {
    live.isLive.value = !!liveObj?.isLive()
    live.usOpen.value = !!liveObj?.marketsOpen()?.us
    tick.value++
  }

  // --- routing
  function setRoute(path, replace = false) {
    route.value = path
    if (!win) return
    const hash = `#${path}`
    if (win.location.hash === hash) return
    if (replace) win.history.replaceState(null, '', hash)
    else win.location.hash = hash
  }
  /** Navigate; login is enforced while there is no session. */
  function go(path) {
    const p = parseHash(path)
    if (!session.value) return setRoute('/login', true)
    setRoute(p === '/login' ? '/' : p)
  }
  function onHash() {
    const p = parseHash(win.location.hash)
    if (!session.value && p !== '/login') return setRoute('/login', true)
    if (session.value && p === '/login') return setRoute('/', true)
    route.value = p
  }

  function onVisibility() {
    if (!liveObj || expired.value) return
    if (doc.hidden) liveObj.pause()
    else liveObj.resume()
  }

  // --- account wiring
  function detach() {
    for (const u of unsubs.splice(0)) u()
    liveObj?.stop()
    liveObj = null
    repo = null
  }

  function closeDb() {
    db?.close()
    db = null
    accountKey = null
  }

  function onExpired() {
    expired.value = true
    liveObj?.stop() // the SID is dead: no sockets or polling until the next login
    bump()
  }

  /** Open (or reuse) the account partition and start repo + live for session `s`. */
  async function attach(s, broker) {
    const my = ++gen
    const cabinet = cabinetOf(s.cabinetId)
    const key = `${cabinet.id}:${s.userId}`
    detach()
    if (accountKey !== key) {
      closeDb()
      state.value = null
      const opened = await deps.openAccountDb(key)
      if (my !== gen) { opened.close(); return }
      db = opened
      accountKey = key
    }
    broker ||= deps.createBroker({ cabinet, sid: s.sid })
    repo = deps.createRepo({ broker, db })
    liveObj = deps.createLive({ repo, broker, socketFactory: deps.socketFactory(cabinet, s.sid) })
    expired.value = false
    unsubs.push(
      repo.subscribe((st) => { state.value = st; bump() }),
      repo.onSessionExpired(onExpired),
      liveObj.on('update', bump),
    )
    liveObj.start()
    if (doc?.hidden) liveObj.pause()
    repo.load().catch(() => {}) // repo records its own errors in state.errors
  }

  // --- public actions
  function start() {
    if (started) return
    started = true
    win?.addEventListener('hashchange', onHash)
    doc?.addEventListener('visibilitychange', onVisibility)
    const s = deps.sessionStore.load()
    if (!s) {
      setRoute('/login', true)
      return
    }
    session.value = s
    if (route.value === '/login') setRoute('/', true)
    attach(s).catch(() => {})
  }

  function stop() {
    started = false
    win?.removeEventListener('hashchange', onHash)
    doc?.removeEventListener('visibilitychange', onVisibility)
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
    // The new session is persisted only after the account check passes.
    if (!isUsdAccount(await broker.positions())) throw new AccountError(t('error.usdOnly'))
    const s = { cabinetId: cabinet.id, sid: res.sid, userId, loggedAt: deps.now() }
    deps.sessionStore.save(s)
    session.value = s
    await attach(s, broker)
    setRoute('/')
  }

  function logout() {
    gen++
    detach()
    closeDb()
    deps.sessionStore.clear()
    session.value = null
    expired.value = false
    state.value = null
    bump()
    setRoute('/login')
  }

  async function clearCache() {
    if (!db || !session.value) return
    await db.clear()
    await attach(session.value) // fresh repo: in-memory cache dropped, reloads from the broker
  }

  function liveQuotesForCalc() {
    return liveObj && liveObj.isLive() ? liveObj.quotes : undefined
  }

  return {
    session, expired, state, tick, live, prefs, route,
    mock: !!deps.mock,
    cabinets: CABINETS,
    cabinetOf,
    start, stop, go, login, requestCode, logout, clearCache,
    liveQuotesForCalc,
    getRepo: () => repo,
    coreFor: (period, day) => (repo ? repo.coreFor(period, day, liveQuotesForCalc()) : null),
    ensurePrices: (period, day) => (repo ? repo.ensurePrices(period, day) : Promise.resolve()),
    refresh: (opts) => (repo ? repo.refresh(opts) : Promise.resolve()),
    marketsStrip: () => (repo ? repo.marketsStrip() : null),
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
