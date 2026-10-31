// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsScreen from '../src/components/SettingsScreen.vue'
import { createAppState, installApp } from '../src/composables/useApp.js'

const html = document.documentElement

// matchMedia stub with a switchable `matches` and change listeners.
function stubMedia(dark) {
  const listeners = new Set()
  const mq = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_, f) => listeners.add(f),
    removeEventListener: (_, f) => listeners.delete(f),
  }
  window.matchMedia = () => mq
  return { mq, set(v) { mq.matches = v; for (const f of [...listeners]) f({ matches: v }) }, listeners }
}

function make(prefs = {}, saved = []) {
  const app = createAppState({
    prefsStore: { load: () => ({ hide: false, sorts: {}, ...prefs }), save: (p) => saved.push(p) },
    sessionStore: { load: () => null, save() {}, clear() {} },
  })
  installApp(app)
  app.start()
  return app
}

beforeEach(() => {
  html.removeAttribute('data-theme')
  document.head.innerHTML = '<meta name="theme-color" content="#F1F3F2"><meta name="color-scheme" content="light">'
})
afterEach(() => { installApp(null); delete window.matchMedia })

describe('theme', () => {
  it('defaults to light', async () => {
    stubMedia(true) // OS dark must not matter for the default
    const app = make()
    expect(app.prefs.theme).toBe('light')
    expect(html.getAttribute('data-theme')).toBe('light')
  })

  it('falls back to light for an unknown stored value', () => {
    make({ theme: 'sepia' })
    expect(html.getAttribute('data-theme')).toBe('light')
  })

  it('applies and persists the chosen theme, updating the meta tags', async () => {
    stubMedia(false)
    const saved = []
    const app = make({}, saved)
    app.prefs.theme = 'dark'
    await nextTick()
    expect(html.getAttribute('data-theme')).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]').content).toBe('#0D0F0E')
    expect(document.querySelector('meta[name="color-scheme"]').content).toBe('dark')
    expect(saved.at(-1).theme).toBe('dark')
    app.prefs.theme = 'light'
    await nextTick()
    expect(html.getAttribute('data-theme')).toBe('light')
    expect(document.querySelector('meta[name="theme-color"]').content).toBe('#F1F3F2')
    expect(document.querySelector('meta[name="color-scheme"]').content).toBe('light')
  })

  it('system follows matchMedia and reacts to changes; other themes ignore it', async () => {
    const m = stubMedia(true)
    const app = make({ theme: 'system' })
    expect(html.getAttribute('data-theme')).toBe('dark')
    m.set(false)
    expect(html.getAttribute('data-theme')).toBe('light')
    m.set(true)
    expect(html.getAttribute('data-theme')).toBe('dark')
    app.prefs.theme = 'light'
    await nextTick()
    m.set(true)
    expect(html.getAttribute('data-theme')).toBe('light')
  })

  it('stop() unsubscribes from matchMedia', () => {
    const m = stubMedia(false)
    const app = make({ theme: 'system' })
    expect(m.listeners.size).toBe(1)
    app.stop()
    expect(m.listeners.size).toBe(0)
  })

  it('works without matchMedia (system = light)', () => {
    make({ theme: 'system' })
    expect(html.getAttribute('data-theme')).toBe('light')
  })

  it('Settings segment switches the theme immediately', async () => {
    stubMedia(false)
    const saved = []
    make({}, saved)
    const w = mount(SettingsScreen)
    const btn = (v) => w.get(`[data-test="theme-${v}"]`)
    expect(btn('light').attributes('aria-pressed')).toBe('true')
    await btn('dark').trigger('click')
    expect(btn('dark').attributes('aria-pressed')).toBe('true')
    expect(html.getAttribute('data-theme')).toBe('dark')
    expect(saved.at(-1).theme).toBe('dark')
    await btn('system').trigger('click')
    expect(btn('system').attributes('aria-pressed')).toBe('true')
    w.unmount()
  })
})

// --- WCAG contrast of the real tokens in app.css ---
const css = readFileSync('src/styles/app.css', 'utf8')
const block = (sel) => {
  const i = css.indexOf(`${sel} {`)
  if (i < 0) throw new Error(`no block ${sel}`)
  return css.slice(i, css.indexOf('\n}', i))
}
const tokens = (sel) => Object.fromEntries([...block(sel).matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]))
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('contrast (WCAG AA)', () => {
  const lightT = tokens(':root')
  const darkTokens = () => ({ ...lightT, ...tokens(':root[data-theme="dark"]') })
  const SMALL = 4.5
  const LARGE = 3
  // [foreground token, background token, minimum]
  const pairs = [
    ['c-fg', 'c-bg', SMALL], ['c-fg', 'c-panel', SMALL],
    ['c-muted', 'c-bg', SMALL], ['c-muted', 'c-panel', SMALL],
    ['c-amber', 'c-bg', SMALL], ['c-amber', 'c-panel', SMALL],
    ['c-accent-ink', 'c-panel', SMALL], ['c-neg-ink', 'c-panel', SMALL],
    ['c-pos', 'c-panel', LARGE], ['c-neg', 'c-panel', LARGE],
    ['c-accent', 'c-panel', LARGE],
    ['c-series-spy', 'c-panel', LARGE], ['c-series-ndx', 'c-panel', LARGE],
    ['c-bar-pos', 'c-panel', LARGE], ['c-bar-neg', 'c-panel', LARGE],
    ['c-on-accent', 'c-accent', SMALL], ['c-on-accent', 'c-accent-ink', SMALL],
  ]
  it('dark palette: small text >= 4.5, large/graphics >= 3 (pos/neg/accent small text too)', () => {
    const dark = darkTokens()
    const rows = [...pairs, ['c-pos', 'c-panel', SMALL], ['c-neg', 'c-panel', SMALL], ['c-pos', 'c-bg', SMALL], ['c-neg', 'c-bg', SMALL]]
    for (const [f, b, min] of rows) {
      expect(dark[f], f).toBeTruthy()
      expect(ratio(dark[f], dark[b]), `${f} on ${b}`).toBeGreaterThanOrEqual(min)
    }
  })
  it('dark theme redefines every color token of the light one', () => {
    const d = tokens(':root[data-theme="dark"]')
    for (const k of ['c-bg', 'c-panel', 'c-fg', 'c-muted', 'c-line', 'c-line-strong', 'c-accent', 'c-accent-ink', 'c-amber', 'c-pos', 'c-neg', 'c-neg-ink', 'c-skel', 'c-series-spy', 'c-series-ndx', 'c-bar-pos', 'c-bar-neg', 'c-on-accent']) {
      expect(d[k], k).toBeTruthy()
    }
  })
  it('light palette keeps its text pairs at AA', () => {
    for (const [f, b] of [['c-fg', 'c-bg'], ['c-fg', 'c-panel'], ['c-muted', 'c-bg'], ['c-muted', 'c-panel'], ['c-accent-ink', 'c-panel'], ['c-neg-ink', 'c-panel']]) {
      expect(ratio(lightT[f], lightT[b]), `${f} on ${b}`).toBeGreaterThanOrEqual(SMALL)
    }
  })
  it('meta theme-color values match the page backgrounds', () => {
    expect(lightT['c-bg']).toBe('#F1F3F2')
    expect(darkTokens()['c-bg']).toBe('#0D0F0E')
  })
})
