import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist')
// A dist predating the PWA files (no sw.js) is stale; treat it as not built.
const built = existsSync(join(dist, 'sw.js'))

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

// Only meaningful after `npm run build`; skipped otherwise.
describe.skipIf(!built)('production build', () => {
  it('replaces the version placeholder in sw.js', () => {
    expect(readFileSync(join(dist, 'sw.js'), 'utf8')).not.toContain('__APP_VERSION__')
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

  it('index.html has no inline styles or scripts (CSP without unsafe-inline)', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<style|\sstyle=/i)
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i)
  })
})
