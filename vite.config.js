import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Stamps the build version into dist/sw.js so each release gets its own cache.
function swVersion() {
  let outDir = 'dist';
  return {
    name: 'sw-version',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle: {
      order: 'post',
      handler() {
        const file = join(outDir, 'sw.js');
        if (!existsSync(file)) return;
        const version = process.env.VITE_APP_VERSION || 'dev';
        writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__APP_VERSION__', version));
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
