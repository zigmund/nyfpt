// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LoginScreen from '../src/components/LoginScreen.vue'
import App from '../src/App.vue'
import { createAppState, installApp, isUsdAccount } from '../src/composables/useApp.js'
import { BrokerError, NetworkError } from '../src/api/transport.js'
import { t } from '../src/i18n.js'

const USD_PS = { result: { ps: { acc: [{ curr: 'USD', currval: 1, s: 100 }], pos: [] } } }
const KZT_PS = { result: { ps: { acc: [{ curr: 'KZT', currval: 0.002, s: 5000 }], pos: [] } } }

// Fakes for everything useApp wires together; no network, no IndexedDB.
function makeDeps({ positions = USD_PS, userId = 7 } = {}) {
  const expiredFns = new Set()
  const repos = []
  const deps = {
    auth: {
      loginByPassword: vi.fn(async () => ({ sid: 'sid-1', userId })),
      requestPhoneCode: vi.fn(async () => ({ authCodeId: 'ac-1', codeLength: 5 })),
      loginByPhoneCode: vi.fn(async () => ({ sid: 'sid-2', userId })),
    },
    createBroker: vi.fn(({ sid }) => ({
      sid,
      positions: vi.fn(async () => positions),
      checkSession: vi.fn(async () => ({ SID: sid, user_id: 42 })),
    })),
    openAccountDb: vi.fn(async (key) => ({ key, clear: vi.fn(async () => {}), close: vi.fn() })),
    createRepo: vi.fn(({ broker, db }) => {
      const repo = {
        broker, db,
        subscribe: vi.fn((fn) => { fn({ positions: [], errors: {}, loading: [] }); return () => {} }),
        onSessionExpired: vi.fn((fn) => { expiredFns.add(fn); return () => expiredFns.delete(fn) }),
        load: vi.fn(async () => {}),
        // Rendered by the main screen once logged in.
        coreFor: vi.fn(() => null),
        ensurePrices: vi.fn(async () => {}),
        marketsStrip: vi.fn(() => null),
      }
      repos.push(repo)
      return repo
    }),
    createLive: vi.fn(() => ({
      quotes: new Map(),
      isLive: () => false,
      marketsOpen: () => ({ us: false }),
      on: vi.fn(() => () => {}),
      start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    })),
    socketFactory: vi.fn((cabinet, sid) => () => ({ sid })),
    sessionStore: { load: vi.fn(() => null), save: vi.fn(), clear: vi.fn() },
    prefsStore: { load: () => ({ hide: false }), save: vi.fn() },
  }
  return { deps, repos, expire: () => { for (const fn of [...expiredFns]) fn() } }
}

function setup(opts) {
  const f = makeDeps(opts)
  const app = installApp(createAppState(f.deps))
  app.start()
  const wrapper = mount(LoginScreen)
  return { ...f, app, wrapper }
}

beforeEach(() => { window.location.hash = '' })
afterEach(() => { installApp(null) })

describe('LoginScreen', () => {
  it('switches between the Email and Phone tabs', async () => {
    const { wrapper } = setup()
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
    expect(wrapper.find('input[type="tel"]').exists()).toBe(false)

    await wrapper.get('[data-test="tab-phone"]').trigger('click')
    expect(wrapper.find('input[type="tel"]').exists()).toBe(true)
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="tab-phone"]').attributes('aria-selected')).toBe('true')

    await wrapper.get('[data-test="tab-email"]').trigger('click')
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
  })

  it('"Send code" calls requestPhoneCode and shows a 6-cell code field and auto-submits', async () => {
    const { wrapper, deps } = setup()
    await wrapper.get('[data-test="tab-phone"]').trigger('click')
    expect(wrapper.find('[data-test="code"]').exists()).toBe(false)

    await wrapper.get('input[type="tel"]').setValue('+77001234567')
    await wrapper.get('[data-test="send-code"]').trigger('click')
    await flushPromises()

    expect(deps.auth.requestPhoneCode).toHaveBeenCalledTimes(1)
    const arg = deps.auth.requestPhoneCode.mock.calls[0][0]
    expect(arg.phone).toBe('+77001234567')
    expect(arg.cabinet.id).toBe('global')
    const code = wrapper.get('[data-test="code"]')
    expect(code.attributes('maxlength')).toBe('6')
    expect(code.attributes('autocomplete')).toBe('one-time-code')
    expect(wrapper.text()).toContain('The code may arrive as a push notification in the broker app')

    await code.setValue('123456')
    await flushPromises()
    expect(deps.auth.loginByPhoneCode).toHaveBeenCalledTimes(1)
    expect(deps.auth.loginByPhoneCode).toHaveBeenCalledWith(expect.objectContaining({ authCodeId: 'ac-1', code: '123456' }))
  })

  it('clears the code and flags the cells when the broker rejects it', async () => {
    const { wrapper, deps } = setup()
    deps.auth.loginByPhoneCode.mockRejectedValueOnce(new BrokerError('Wrong code', { code: 2 }))
    await wrapper.get('[data-test="tab-phone"]').trigger('click')
    await wrapper.get('input[type="tel"]').setValue('+77001234567')
    await wrapper.get('[data-test="send-code"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="code"]').setValue('111111')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Wrong code')
    expect(wrapper.get('[data-test="code"]').element.value).toBe('')
    expect(wrapper.get('.code').classes()).toContain('code--invalid')
  })

  it('shows the broker error text as is', async () => {
    const { wrapper, deps } = setup()
    deps.auth.loginByPassword.mockRejectedValueOnce(new BrokerError('Неверный логин или пароль', { code: 2 }))
    await wrapper.get('input[autocomplete="username"]').setValue('me@example.com')
    await wrapper.get('input[type="password"]').setValue('secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Неверный логин или пароль')
  })

  it('shows a readable message on a network error', async () => {
    const { wrapper, deps } = setup()
    deps.auth.loginByPassword.mockRejectedValueOnce(new NetworkError('Failed to fetch'))
    await wrapper.get('input[autocomplete="username"]').setValue('me@example.com')
    await wrapper.get('input[type="password"]').setValue('secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe(t('error.network'))
  })

  it('clears the password after every attempt and disables the button while busy', async () => {
    const { wrapper, deps } = setup()
    let release
    deps.auth.loginByPassword.mockImplementationOnce(() => new Promise((_, rej) => { release = rej }))
    await wrapper.get('input[autocomplete="username"]').setValue('me@example.com')
    await wrapper.get('input[type="password"]').setValue('secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()

    release(new BrokerError('Wrong password'))
    await flushPromises()
    expect(wrapper.get('input[type="password"]').element.value).toBe('')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()

    // A successful attempt clears it too.
    await wrapper.get('input[type="password"]').setValue('secret2')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(deps.auth.loginByPassword).toHaveBeenLastCalledWith(expect.objectContaining({ login: 'me@example.com', password: 'secret2' }))
    expect(wrapper.get('input[type="password"]').element.value).toBe('')
  })

  it('shows the trust text', () => {
    const { wrapper } = setup()
    expect(wrapper.text()).toContain('Your password goes directly from this browser to the broker. This site never receives or stores it.')
  })
})

describe('single cabinet', () => {
  it('renders no cabinet select and shows the broker host', () => {
    const { wrapper } = setup()
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.text()).toContain('tradernet.global')
  })

  it('treats a stored session of an unknown cabinet as logged out', () => {
    const f = makeDeps()
    f.deps.sessionStore.load.mockReturnValue({ cabinetId: 'kz', sid: 's', userId: 7, loggedAt: 1 })
    const app = installApp(createAppState(f.deps))
    app.start()
    expect(f.deps.sessionStore.clear).toHaveBeenCalled()
    expect(app.session.value).toBe(null)
    expect(app.route.value).toBe('/login')
    expect(f.deps.openAccountDb).not.toHaveBeenCalled()
  })
})

describe('useApp login flow', () => {
  it('rejects non-USD accounts, keeps no session and stays on login', async () => {
    const { wrapper, deps, app } = setup({ positions: KZT_PS })
    await wrapper.get('input[autocomplete="username"]').setValue('me')
    await wrapper.get('input[type="password"]').setValue('pw')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Only USD accounts are supported for now.')
    expect(deps.sessionStore.save).not.toHaveBeenCalled()
    expect(deps.openAccountDb).not.toHaveBeenCalled()
    expect(app.session.value).toBe(null)
    expect(app.route.value).toBe('/login')
  })

  it('saves the session and opens the account partition on success', async () => {
    const { deps, app } = setup()
    await app.login('global', { login: 'me', password: 'pw' })
    expect(deps.sessionStore.save).toHaveBeenCalledWith(expect.objectContaining({ cabinetId: 'global', sid: 'sid-1', userId: 7 }))
    expect(deps.sessionStore.save.mock.calls[0][0]).not.toHaveProperty('password')
    expect(deps.openAccountDb).toHaveBeenCalledWith('global:7')
    expect(app.route.value).toBe('/')
  })

  it('falls back to getSidInfo when the login answer has no userId', async () => {
    const { deps, app } = setup({ userId: null })
    await app.login('global', { login: 'me', password: 'pw' })
    expect(deps.openAccountDb).toHaveBeenCalledWith('global:42')
  })

  it('keeps the cache on session expiry and reuses the partition for the same user', async () => {
    const { deps, app, expire, repos } = setup()
    await app.login('global', { login: 'me', password: 'pw' })
    const db = await deps.openAccountDb.mock.results[0].value
    const live1 = deps.createLive.mock.results[0].value
    expire()
    expect(app.expired.value).toBe(true)
    expect(app.session.value).not.toBe(null)
    expect(live1.stop).toHaveBeenCalled()
    expect(db.clear).not.toHaveBeenCalled()

    deps.auth.loginByPassword.mockResolvedValueOnce({ sid: 'sid-new', userId: 7 })
    await app.login('global', { login: 'me', password: 'pw' })
    expect(app.expired.value).toBe(false)
    // Fresh broker, live controller and socket factory bound to the new SID.
    expect(deps.createLive).toHaveBeenCalledTimes(2)
    expect(deps.createLive.mock.calls[1][0].broker.sid).toBe('sid-new')
    expect(deps.createLive.mock.calls[1][0].socketFactory().sid).toBe('sid-new')
    expect(deps.createLive.mock.results[1].value.start).toHaveBeenCalled()
    expect(deps.openAccountDb).toHaveBeenCalledTimes(1)
    expect(repos.at(-1).db).toBe(db)
    expect(db.close).not.toHaveBeenCalled()
  })

  it('logout erases the account cache, then closes it; the session is gone', async () => {
    const { deps, app } = setup()
    await app.login('global', { login: 'me', password: 'pw' })
    const db = await deps.openAccountDb.mock.results[0].value
    await app.logout()
    expect(db.clear).toHaveBeenCalledTimes(1)
    expect(db.close).toHaveBeenCalled()
    // The clear is queued before the connection closes.
    expect(db.clear.mock.invocationCallOrder[0]).toBeLessThan(db.close.mock.invocationCallOrder[0])
    expect(deps.sessionStore.clear).toHaveBeenCalled()
    expect(app.session.value).toBe(null)
    expect(app.route.value).toBe('/login')
  })

  it('logout swallows storage errors while erasing the cache', async () => {
    const { deps, app } = setup()
    deps.openAccountDb.mockImplementationOnce(async (key) => ({
      key, clear: vi.fn(async () => { throw new Error('QuotaExceededError') }), close: vi.fn(),
    }))
    await app.login('global', { login: 'me', password: 'pw' })
    const db = await deps.openAccountDb.mock.results[0].value
    await expect(app.logout()).resolves.toBeUndefined()
    expect(db.clear).toHaveBeenCalled()
    expect(db.close).toHaveBeenCalled()
    expect(app.session.value).toBe(null)
  })

  it('uses a different partition for a different user', async () => {
    const { deps, app } = setup()
    await app.login('global', { login: 'me', password: 'pw' })
    deps.auth.loginByPassword.mockResolvedValueOnce({ sid: 'sid-9', userId: 99 })
    await app.login('global', { login: 'other', password: 'pw' })
    expect(deps.openAccountDb.mock.calls.map((c) => c[0])).toEqual(['global:7', 'global:99'])
    const first = await deps.openAccountDb.mock.results[0].value
    expect(first.close).toHaveBeenCalled()
  })

  it('pauses and resumes live mode on page visibility', async () => {
    const { deps, app } = setup()
    await app.login('global', { login: 'me', password: 'pw' })
    const live = deps.createLive.mock.results.at(-1).value
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(live.pause).toHaveBeenCalled()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(live.resume).toHaveBeenCalled()
    hidden.mockRestore()
  })

  it('exposes live quotes for calculations only while live', async () => {
    const { deps, app } = setup()
    let live = false
    const quotes = new Map([['AAA.US', { ltp: 1 }]])
    deps.createLive.mockImplementationOnce(() => ({
      quotes, isLive: () => live, marketsOpen: () => ({ us: live }),
      on: () => () => {}, start() {}, stop() {}, pause() {}, resume() {},
    }))
    await app.login('global', { login: 'me', password: 'pw' })
    expect(app.liveQuotesForCalc()).toBeUndefined()
    live = true
    expect(app.liveQuotesForCalc()).toBe(quotes)
  })
})

describe('session expiry and storage failures', () => {
  it('drops live state on session expiry', async () => {
    const { deps, app, expire } = setup()
    const quotes = new Map([['AAA.US', { ltp: 1 }]])
    let onUpdate = null
    deps.createLive.mockImplementationOnce(() => ({
      quotes, isLive: () => true, marketsOpen: () => ({ us: true }),
      on: (e, fn) => { if (e === 'update') onUpdate = fn; return () => {} },
      start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    }))
    await app.login('global', { login: 'me', password: 'pw' })
    expect(app.live.isLive.value).toBe(true)
    expect(app.liveQuotesForCalc()).toBe(quotes)

    expire()
    expect(deps.createLive.mock.results[0].value.stop).toHaveBeenCalled()
    expect(app.live.isLive.value).toBe(false)
    expect(app.live.usOpen.value).toBe(false)
    expect(app.liveQuotesForCalc()).toBeUndefined()
    onUpdate() // a late update must not bring it back
    expect(app.live.isLive.value).toBe(false)
    expect(app.liveQuotesForCalc()).toBeUndefined()
  })

  it('shows a retryable error instead of endless loading when storage fails on start', async () => {
    const f = makeDeps()
    f.deps.sessionStore.load.mockReturnValue({ cabinetId: 'global', sid: 's', userId: 7, loggedAt: 1 })
    f.deps.openAccountDb.mockRejectedValueOnce(new Error('InvalidStateError'))
    const app = installApp(createAppState(f.deps))
    app.start()
    const wrapper = mount(App)
    await flushPromises()
    expect(app.fatal.value).toBe(t('error.storage'))
    expect(wrapper.get('[data-test="fatal"]').text()).toContain(t('error.storage'))
    expect(wrapper.text()).not.toContain(t('main.loading'))

    await wrapper.get('[data-test="fatal"] .btn--primary').trigger('click')
    await flushPromises()
    expect(f.deps.openAccountDb).toHaveBeenCalledTimes(2)
    expect(app.fatal.value).toBe('')
    expect(wrapper.find('[data-test="fatal"]').exists()).toBe(false)
  })

  it('offers log out from the storage error', async () => {
    const f = makeDeps()
    f.deps.sessionStore.load.mockReturnValue({ cabinetId: 'global', sid: 's', userId: 7, loggedAt: 1 })
    f.deps.openAccountDb.mockRejectedValueOnce(new Error('InvalidStateError'))
    const app = installApp(createAppState(f.deps))
    app.start()
    const wrapper = mount(App)
    await flushPromises()
    const out = wrapper.findAll('[data-test="fatal"] button').find((b) => b.text() === t('settings.logout'))
    await out.trigger('click')
    expect(f.deps.sessionStore.clear).toHaveBeenCalled()
    expect(app.session.value).toBe(null)
    expect(app.fatal.value).toBe('')
  })

  it('persists nothing and shows the error on the login screen when storage fails during login', async () => {
    const { wrapper, deps, app } = setup()
    deps.openAccountDb.mockRejectedValueOnce(new Error('InvalidStateError'))
    await wrapper.get('input[autocomplete="username"]').setValue('me')
    await wrapper.get('input[type="password"]').setValue('pw')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe(t('error.storage'))
    expect(deps.sessionStore.save).not.toHaveBeenCalled()
    expect(app.session.value).toBe(null)
    expect(app.route.value).toBe('/login')
    expect(wrapper.get('input[type="password"]').element.value).toBe('')
  })
})

describe('isUsdAccount', () => {
  it('accepts a USD row, an empty account and zero non-USD balances', () => {
    expect(isUsdAccount(USD_PS)).toBe(true)
    expect(isUsdAccount({ result: { ps: { acc: [], pos: [] } } })).toBe(true)
    expect(isUsdAccount({ ps: { acc: [{ curr: 'KZT', s: 0 }] } })).toBe(true)
    expect(isUsdAccount({ ps: { acc: [{ curr: 'USD', s: 0 }, { curr: 'KZT', s: 10 }] } })).toBe(true)
  })
  it('rejects a non-zero non-USD account without a USD row', () => {
    expect(isUsdAccount(KZT_PS)).toBe(false)
  })
})
