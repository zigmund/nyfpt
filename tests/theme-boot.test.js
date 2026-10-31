// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { THEME_BG } from '../src/composables/useApp.js'

const html = document.documentElement
const runBoot = () => new Function(readFileSync('public/theme-boot.js', 'utf8'))()
const meta = (name) => document.querySelector(`meta[name="${name}"]`).getAttribute('content')

function stubMedia(dark) {
  window.matchMedia = (q) => ({ matches: dark && q === '(prefers-color-scheme: dark)', media: q })
}

beforeEach(() => {
  html.removeAttribute('data-theme')
  document.head.innerHTML = '<meta name="theme-color" content="#F1F3F2"><meta name="color-scheme" content="light">'
  localStorage.clear()
})
afterEach(() => {
  delete window.matchMedia
  vi.restoreAllMocks()
})

describe('theme boot script (runs before the first paint)', () => {
  const prefs = (v) => localStorage.setItem('nyfpt.prefs', JSON.stringify(v))

  it('applies a saved dark theme to <html> and the meta tags', () => {
    prefs({ theme: 'dark', period: 'YTD' })
    runBoot()
    expect(html.getAttribute('data-theme')).toBe('dark')
    expect(meta('theme-color')).toBe(THEME_BG.dark)
    expect(meta('color-scheme')).toBe('dark')
  })

  it('applies a saved light theme', () => {
    prefs({ theme: 'light' })
    stubMedia(true)
    runBoot()
    expect(html.getAttribute('data-theme')).toBe('light')
    expect(meta('theme-color')).toBe(THEME_BG.light)
    expect(meta('color-scheme')).toBe('light')
  })

  it("'system' follows prefers-color-scheme", () => {
    prefs({ theme: 'system' })
    stubMedia(true)
    runBoot()
    expect(html.getAttribute('data-theme')).toBe('dark')
    expect(meta('theme-color')).toBe(THEME_BG.dark)

    stubMedia(false)
    runBoot()
    expect(html.getAttribute('data-theme')).toBe('light')
    expect(meta('theme-color')).toBe(THEME_BG.light)
  })

  it("'system' without matchMedia falls back to light", () => {
    prefs({ theme: 'system' })
    // happy-dom has matchMedia on the prototype; shadow it (afterEach deletes the own property).
    window.matchMedia = undefined
    runBoot()
    expect(html.getAttribute('data-theme')).toBe('light')
    expect(meta('theme-color')).toBe(THEME_BG.light)
  })

  it('no prefs, an unknown theme or broken JSON -> light (the app default), no exception', () => {
    stubMedia(true)
    expect(runBoot).not.toThrow()
    expect(html.getAttribute('data-theme')).toBe('light')

    prefs({ theme: 'sepia' })
    expect(runBoot).not.toThrow()
    expect(html.getAttribute('data-theme')).toBe('light')

    localStorage.setItem('nyfpt.prefs', '{not json')
    expect(runBoot).not.toThrow()
    expect(html.getAttribute('data-theme')).toBe('light')
    expect(meta('theme-color')).toBe(THEME_BG.light)
  })

  it('storage that throws (private mode) -> light, no exception', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(runBoot).not.toThrow()
    expect(html.getAttribute('data-theme')).toBe('light')
  })

  it('missing meta tags do not throw', () => {
    prefs({ theme: 'dark' })
    document.head.innerHTML = ''
    expect(runBoot).not.toThrow()
    expect(html.getAttribute('data-theme')).toBe('dark')
  })
})

describe('theme colours: one source of truth', () => {
  const css = readFileSync('src/styles/app.css', 'utf8')
  const bgIn = (sel) => {
    const i = css.indexOf(`${sel} {`)
    return /--c-bg:\s*(#[0-9a-fA-F]{6})/.exec(css.slice(i, css.indexOf('\n}', i)))[1]
  }

  it('THEME_BG == app.css --c-bg == boot script colours', () => {
    expect(THEME_BG.light.toLowerCase()).toBe(bgIn(':root').toLowerCase())
    expect(THEME_BG.dark.toLowerCase()).toBe(bgIn(':root[data-theme="dark"]').toLowerCase())
    for (const t of ['light', 'dark']) {
      localStorage.setItem('nyfpt.prefs', JSON.stringify({ theme: t }))
      runBoot()
      expect(meta('theme-color')).toBe(THEME_BG[t])
    }
  })

  it('html (the root canvas) carries the page background, not only body', () => {
    const m = /(^|\n)html \{([^}]*)\}/.exec(css)
    expect(m[2]).toMatch(/background(-color)?:\s*var\(--c-bg\)/)
  })

  it('manifest colours are the dark page background (no white splash), never #ffffff', () => {
    const man = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'))
    expect(JSON.stringify(man).toLowerCase()).not.toMatch(/#fff(fff)?\b/)
    expect(man.background_color).toBe(THEME_BG.dark)
    expect(man.theme_color).toBe(THEME_BG.dark)
  })
})

describe('index.html wiring (CSP script-src self: no inline scripts)', () => {
  const src = readFileSync('index.html', 'utf8')
  const head = src.slice(0, src.indexOf('</head>'))
  const at = (re) => head.search(re)

  it('loads /theme-boot.js as a classic blocking script in <head>, after the meta tags it rewrites', () => {
    const tag = /<script src="\/theme-boot\.js"><\/script>/
    expect(at(tag)).toBeGreaterThan(-1)
    expect(at(tag)).toBeGreaterThan(at(/<meta name="theme-color"/))
    expect(at(tag)).toBeGreaterThan(at(/<meta name="color-scheme"/))
    // The first script in <head>, classic and blocking (no type/async/defer). Ordering against the
    // injected stylesheet and module entry is checked on dist in tests/build.test.js.
    expect(at(/<script\b/)).toBe(at(tag))
    expect(head.match(/<script\b[^>]*>/g)).toEqual(['<script src="/theme-boot.js">'])
  })

  it('has no inline scripts', () => {
    expect(src).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i)
  })

  it('keeps the default status-bar style (standalone already blends; black-translucent forces white text)', () => {
    expect(src).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="default" \/>/)
  })
})

describe('boot script delivery', () => {
  it('the service worker precaches and serves it (offline start)', () => {
    const sw = readFileSync('public/sw.js', 'utf8')
    expect(/const SHELL = \[([^\]]*)\]/.exec(sw)[1]).toContain("'/theme-boot.js'")
    expect(sw).toMatch(/url\.pathname === '\/theme-boot\.js'/)
  })

  it('nginx serves it with no-cache and the security headers', () => {
    const conf = readFileSync('nginx/default.conf', 'utf8')
    const m = /location = \/theme-boot\.js \{([^}]*)\}/.exec(conf)
    expect(m).toBeTruthy()
    expect(m[1]).toContain('include /etc/nginx/conf.d/security-headers.inc;')
    expect(m[1]).toMatch(/add_header Cache-Control "no-cache" always;/)
  })
})

// iOS 26 Safari / Home Screen apps tint the bar under the status bar with the fixed/sticky element
// touching the top edge and keep that colour after it leaves; a page-coloured strip is always that element.
describe('top edge guard (bar under the status bar stays the page colour)', () => {
  const css = readFileSync('src/styles/app.css', 'utf8')
  const blocks = []
  for (let i = 0; (i = css.indexOf('@media (max-width: 47.99rem) {', i)) > -1;) {
    const end = css.indexOf('\n}', i) // a media block ends at the first "}" in column 0
    blocks.push(css.slice(i, end))
    i = end
  }
  const mobile = blocks.join('\n')
  const wide = blocks.reduce((c, b) => c.replace(b, ''), css)
  const body = (src, sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`(^|\\n)\\s*${esc} \\{([^}]*)\\}`).exec(src)
    return m ? m[2] : null
  }
  const z = (src, sel) => Number(/z-index:\s*(\d+)/.exec(body(src, sel))[1])

  it('--edge-t is 0 by default and a sampled strip height on phones', () => {
    expect(body(css, ':root')).toMatch(/--edge-t:\s*0(px)?;/)
    expect(body(mobile, ':root')).toMatch(/--edge-t:\s*calc\(var\(--safe-t\) \+ \.75rem\);/)
  })

  it('phones get a fixed full-width page-coloured strip at the top edge, above sticky headers, below overlays', () => {
    const r = body(mobile, 'body::before')
    expect(r).toBeTruthy()
    for (const decl of ['position: fixed;', 'top: 0;', 'left: 0;', 'right: 0;', 'height: var(--edge-t);',
      'background: var(--c-bg);', 'pointer-events: none;']) expect(r).toContain(decl)
    expect(z(mobile, 'body::before')).toBeGreaterThan(z(mobile, '.ptable.htable thead'))
    expect(z(mobile, 'body::before')).toBeGreaterThan(z(css, '.pcard__bar'))
    expect(z(mobile, 'body::before')).toBeLessThan(z(css, '.login--overlay'))
  })

  it('viewport-sticky headers stick below the strip', () => {
    expect(body(mobile, '.ptable.htable thead')).toContain('top: var(--edge-t);')
    expect(body(css, '.pcard__bar')).toContain('top: var(--edge-t);')
  })

  it('wider layouts keep no strip', () => {
    expect(body(wide, 'body::before')).toBeNull()
    expect(body(wide, ':root')).not.toMatch(/--edge-t:\s*calc/)
  })
})
