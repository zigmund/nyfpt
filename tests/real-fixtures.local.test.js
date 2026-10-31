import { describe, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Local-only check against private account data (git-ignored folder).
// The handoff test.js holds its own asserts; here it is only imported.
const root = resolve(import.meta.dirname, '..', 'portfolio-dashboard-handoff', 'calc');
const available = existsSync(resolve(root, 'fixtures', 'week-2026-10-24_2026-10-30.json'));

describe('real fixtures (local only)', () => {
  (available ? it : it.skip)('handoff calc/test.js asserts pass', async () => {
    await import(/* @vite-ignore */ resolve(root, 'test.js'));
  });
});
