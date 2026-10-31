import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Stamps the build version and the emitted asset list into dist/sw.js.
function swVersion() {
  let outDir = 'dist';
  let assets = [];
  return {
    name: 'sw-version',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    generateBundle(_, bundle) {
      // Hashed build output, precached by the service worker for offline start.
      assets = Object.keys(bundle)
        .filter((n) => n.startsWith('assets/'))
        .map((n) => '/' + n);
    },
    closeBundle: {
      order: 'post',
      handler() {
        const file = join(outDir, 'sw.js');
        if (!existsSync(file)) return;
        const version = process.env.VITE_APP_VERSION || 'dev';
        const src = readFileSync(file, 'utf8')
          .replaceAll('__APP_VERSION__', version)
          .replaceAll('__PRECACHE__', JSON.stringify(assets));
        writeFileSync(file, src);
      },
    },
  };
}

export default defineConfig({
  plugins: [vue(), swVersion()],
  test: {
    // Component tests opt into happy-dom per file via `// @vitest-environment happy-dom`.
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
