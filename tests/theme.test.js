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

  it('Settings has no hide-amounts switch (the eye button on the main screen owns it)', () => {
    make({})
    const w = mount(SettingsScreen)
    expect(w.find('input[role="switch"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Hide amounts')
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
// Body of the first rule whose selector is exactly `sel` (single-line or multi-line rules).
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(^|\\n)${esc} \\{([^]*?)\\n?\\}`).exec(css)
  if (!m) throw new Error(`no rule ${sel}`)
  return m[2]
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
  // Small text used on the page/card backgrounds in both themes.
  const TEXT = ['c-fg', 'c-muted', 'c-amber', 'c-accent-ink', 'c-neg-ink']
  it('light palette: every small-text token >= 4.5 on page and card; white on the primary button', () => {
    for (const f of TEXT) {
      for (const b of ['c-bg', 'c-panel']) expect(ratio(lightT[f], lightT[b]), `${f} on ${b}`).toBeGreaterThanOrEqual(SMALL)
    }
    expect(ratio(lightT['c-on-accent'], lightT['c-accent-ink'])).toBeGreaterThanOrEqual(SMALL)
  })
  it('dark palette: the same small-text tokens >= 4.5', () => {
    const dark = darkTokens()
    for (const f of TEXT) {
      for (const b of ['c-bg', 'c-panel']) expect(ratio(dark[f], dark[b]), `${f} on ${b}`).toBeGreaterThanOrEqual(SMALL)
    }
  })
  it('control boundaries (inputs, buttons, code cells) >= 3 in both themes', () => {
    for (const [name, p] of [['light', lightT], ['dark', darkTokens()]]) {
      for (const f of ['c-line-strong', 'c-neg', 'c-accent', 'c-accent-ink']) {
        for (const b of ['c-bg', 'c-panel']) expect(ratio(p[f], p[b]), `${name}: ${f} on ${b}`).toBeGreaterThanOrEqual(LARGE)
      }
    }
  })
  it('rules: gains/losses text uses the -ink tokens; borders and the primary button use AA tokens', () => {
    expect(rule('.pos')).toContain('color: var(--c-accent-ink)')
    expect(rule('.neg')).toContain('color: var(--c-neg-ink)')
    expect(rule('.lede b.pos')).toContain('color: var(--c-accent-ink)')
    expect(rule('.lede b.neg')).toContain('color: var(--c-neg-ink)')
    expect(rule('.btn--primary')).toContain('background: var(--c-accent-ink)')
    for (const sel of ['.btn', '.input', '.code__cell']) expect(rule(sel), sel).toContain('border: 1px solid var(--c-line-strong)')
    expect(rule('.btn--danger')).toContain('border-color: var(--c-neg)')
    // Text colors in the stylesheet never use the bright (graphics-only) pos/neg tokens.
    expect(css).not.toMatch(/(^|[^-])color:\s*var\(--c-(pos|neg)\)/m)
  })
  it('holdings change pills: text on the pill fill >= 4.5 in both themes, pills use the pill tokens', () => {
    for (const [name, p] of [['light', lightT], ['dark', darkTokens()]]) {
      for (const b of ['c-pill-pos', 'c-pill-neg']) {
        expect(ratio(p['c-on-pill'], p[b]), `${name}: c-on-pill on ${b}`).toBeGreaterThanOrEqual(SMALL)
      }
      expect(ratio(p['c-fg'], p['c-pill-flat']), `${name}: c-fg on c-pill-flat`).toBeGreaterThanOrEqual(SMALL)
    }
    const d = tokens(':root[data-theme="dark"]')
    for (const k of ['c-pill-pos', 'c-pill-neg', 'c-pill-flat', 'c-on-pill']) expect(d[k], k).toBeTruthy()
    expect(rule('.pill--pos')).toContain('background: var(--c-pill-pos)')
    expect(rule('.pill--neg')).toContain('background: var(--c-pill-neg)')
  })
  it('price flashes: down as strong as up', () => {
    const pct = (name) => /var\(--c-(?:pos|neg)\)\s+(\d+)%/.exec(rule(`@keyframes ${name}`))?.[1]
    expect(rule('@keyframes flash-down')).toContain('var(--c-neg)')
    expect(pct('flash-down')).toBe(pct('flash-up'))
  })
  it('meta theme-color values match the page backgrounds', () => {
    expect(lightT['c-bg']).toBe('#F1F3F2')
    expect(darkTokens()['c-bg']).toBe('#0D0F0E')
  })
})
