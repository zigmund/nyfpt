// Static check: every literal t('key') in src has an English string (a missing key renders as the key).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../src/i18n.js'

const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? files(p) : /\.(vue|js)$/.test(n) ? [p] : []
})
// t('a.b') / t("a.b") with a plain literal (template keys like t(`x.${y}`) are checked where they are built).
const CALL = /(?<![\w.$])t\(\s*(['"])([^'"`$\n]+)\1/g

describe('i18n', () => {
  it('every literal t() key used in src exists', () => {
    const used = new Map()
    for (const f of files('src')) {
      for (const m of readFileSync(f, 'utf8').matchAll(CALL)) used.set(m[2], f)
    }
    expect(used.size).toBeGreaterThan(100)
    const missing = [...used].filter(([k]) => t(k) === k).map(([k, f]) => `${k} (${f})`)
    expect(missing).toEqual([])
  })
})
