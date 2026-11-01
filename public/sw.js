// Service worker. The version placeholder below is stamped at build time (see vite.config.js).
const VERSION = '__APP_VERSION__'
const CACHE = `nyfpt-${VERSION}`
// Emitted hashed assets, injected at build time (JSON array inside the string).
const PRECACHE = JSON.parse('__PRECACHE__')
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...SHELL, ...PRECACHE]))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nyfpt-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.status === 200 && res.type === 'basic') await cache.put(request, res.clone())
  return res
}

const isHtml = (res) => res.status === 200 && res.type === 'basic' && (res.headers.get('content-type') || '').includes('text/html')

async function networkFirstNavigation(request, event) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    // Only a real HTML page may replace the offline shell (not /health, errors, partials).
    if (isHtml(res)) event.waitUntil(cache.put('/index.html', res.clone()))
    return res
  } catch {
    const fallback = await cache.match('/index.html')
    if (fallback) return fallback
    throw new Error('offline and no cached shell')
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  const refresh = fetch(request)
    .then(async (res) => {
      if (res.status === 200 && res.type === 'basic') await cache.put(request, res.clone())
      return res
    })
    .catch(() => hit)
  event.waitUntil(refresh)
  return hit || refresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Never intercept other origins (broker API).
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request, event))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request))
  } else if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(staleWhileRevalidate(request, event))
  }
})
