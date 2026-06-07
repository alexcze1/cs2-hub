// Minimal service worker so the app installs as a PWA. We deliberately
// keep this near-passthrough — the team's data lives in Supabase and is
// always-online; aggressive precaching would risk shipping stale HTML for
// a team-data product where freshness matters more than offline.
//
// What we *do* cache: the app shell (HTML, CSS, JS) so subsequent loads
// are warm and the app can render its chrome instantly. We use a
// network-first policy with a short timeout, falling back to cache only
// if the network is dead.

const CACHE = 'midround-shell-v1'
const SHELL = [
  '/',
  '/dashboard.html',
  '/style.css',
  '/manifest.json',
  '/images/favicon.png',
  '/images/logo-lettering.png',
  '/images/logo-icon.png',
]

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL).catch(() => {}))
  )
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

function networkFirst(req) {
  return Promise.race([
    fetch(req).then(res => {
      if (res.ok && req.method === 'GET') {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {})
      }
      return res
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('net-timeout')), 3000)),
  ]).catch(() => caches.match(req))
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  // Don't intercept Supabase, Anthropic, HLTV, or any cross-origin
  // traffic — let the page own its data layer entirely.
  if (url.origin !== self.location.origin) return
  // Don't intercept Vercel API routes — those are dynamic.
  if (url.pathname.startsWith('/api/')) return

  if (e.request.method !== 'GET') return
  e.respondWith(networkFirst(e.request))
})
