import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    // Component tests opt into happy-dom per file via `// @vitest-environment happy-dom`.
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
