import { createApp } from 'vue'
import App from './App.vue'
import { createAppState, installApp } from './composables/useApp.js'
import './styles/app.css'

async function boot() {
  let deps = {}
  // Dev-only fake broker; the whole branch (and the dynamic import) is dropped from production builds.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const { mockDeps } = await import('./dev/mock.js')
    deps = mockDeps()
  }
  const app = installApp(createAppState(deps))
  app.start()
  createApp(App).mount('#app')
}

boot()

// Service worker only in production builds (dev server must not be cached).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
