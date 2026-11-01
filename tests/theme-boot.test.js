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

// iOS 26 Safari / Home Screen apps tint the status-bar area with the background of the fixed/sticky
// element touching the top edge (found by hit-testing) and keep that colour after it leaves. The
// Task 36 strip (pointer-events: none) was never picked on device; instead the stuck Holdings header
// itself turns into a full-width page-coloured bar (Task 39).
describe('top edge on phones (status-bar area stays the page colour)', () => {
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

  it('the Task 36 strip and --edge-t are gone', () => {
    expect(css).not.toContain('--edge-t')
    expect(css).not.toMatch(/body::before/)
  })

  it('viewport-sticky headers stick at the very top edge again', () => {
    expect(body(mobile, '.ptable.htable thead')).toContain('top: 0;')
    expect(body(css, '.pcard__bar')).toContain('top: 0;')
  })

  it('stuck Holdings header: opaque page-coloured bar bleeding to both screen edges, content in place', () => {
    const r = body(mobile, '.ptable.htable thead.is-stuck')
    expect(r).toBeTruthy()
    for (const decl of ['background: var(--c-bg);', 'margin-inline: calc(50% - 50vw);',
      'padding-inline: calc(50vw - 50%);']) expect(r).toContain(decl)
    expect(r).not.toMatch(/opacity|pointer-events|backdrop-filter|height/)
    // header cells carry the panel colour by default: transparent while stuck, so the bar is one colour
    expect(body(mobile, '.ptable.htable thead.is-stuck th')).toContain('background: transparent;')
  })

  it('a period reload dims only the rows: the stuck header stays opaque on phones', () => {
    expect(body(css, '.is-stale')).toMatch(/opacity: \.45;/)
    expect(body(mobile, '.tablebox--rows.is-stale')).toMatch(/opacity: 1;/)
    expect(body(mobile, '.tablebox--rows.is-stale tbody')).toMatch(/opacity: \.45;/)
  })

  it('the position-card bar is page-coloured and bleeds to the screen edges on phones', () => {
    expect(body(css, '.pcard__bar')).toContain('background: var(--c-bg);')
    const r = body(mobile, '.pcard__bar')
    expect(r).toContain('margin-inline: calc(50% - 50vw);')
    expect(r).toContain('padding-inline: calc(50vw - 50%);')
  })

  it('wider layouts are unchanged: no stuck bar, no bleeding position-card bar', () => {
    // rules only: a comment may mention the class
    expect(wide.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('is-stuck')
    expect(body(css, '.pcard__bar')).not.toContain('margin-inline')
  })
})
