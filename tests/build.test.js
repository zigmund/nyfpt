import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist')
// A dist predating the PWA files (no sw.js) is stale; treat it as not built.
const built = existsSync(join(dist, 'sw.js'))
const required = Boolean(process.env.CI || process.env.REQUIRE_DIST === '1')

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

// Needs `npm run build`; skipped unless CI/REQUIRE_DIST is set, in which case a missing dist fails.
describe.skipIf(!built && !required)('production build', () => {
  it('dist was built (sw.js present)', () => {
    expect(built).toBe(true)
  })

  it('replaces the build placeholders in sw.js', () => {
    const sw = readFileSync(join(dist, 'sw.js'), 'utf8')
    expect(sw).not.toContain('__APP_VERSION__')
    expect(sw).not.toContain('__PRECACHE__')
  })

  it('sw.js precache list is non-empty and every file exists', () => {
    const sw = readFileSync(join(dist, 'sw.js'), 'utf8')
    const list = JSON.parse(/JSON\.parse\('(.*?)'\)/.exec(sw)[1])
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((f) => f.endsWith('.js'))).toBe(true)
    for (const f of list) {
      expect(f.startsWith('/assets/')).toBe(true)
      expect(existsSync(join(dist, f)), f).toBe(true)
    }
  })

  it('ships no mock code', () => {
    const text = (f) => (/\.(js|css|html|json|webmanifest|svg)$/.test(f) ? readFileSync(f, 'utf8') : '')
    for (const f of walk(dist)) {
      const t = text(f)
      expect(t, f).not.toContain('synthetic-api')
      expect(t, f).not.toContain('dev/mock')
    }
  })

  it('index.html has no external URLs', () => {
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).not.toMatch(/(https?:)?\/\/[a-z0-9-]+\.[a-z]/i)
  })

  it('bundled CSS keeps the 48rem / 64rem layout breakpoints', () => {
    const cssText = walk(dist).filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(cssText).toMatch(/min-width:\s*48rem|width\s*>=\s*48rem/)
    expect(cssText).toMatch(/min-width:\s*64rem|width\s*>=\s*64rem/)
  })

  it('index.html has no inline styles or scripts (CSP without unsafe-inline)', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<style|\sstyle=/i)
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i)
  })

  it('ships the theme boot script and runs it before the stylesheet and the app entry', () => {
    expect(existsSync(join(dist, 'theme-boot.js'))).toBe(true)
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    const boot = html.indexOf('<script src="/theme-boot.js"></script>')
    expect(boot).toBeGreaterThan(-1)
    expect(boot).toBeLessThan(html.search(/<link rel="stylesheet"/))
    expect(boot).toBeLessThan(html.search(/<script type="module"/))
  })
})
