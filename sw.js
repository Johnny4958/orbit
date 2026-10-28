/* Orbit service worker: offline shell + push notifications.
   Daily notifications are written here, on the phone, from the phone's own data.
   The server only sends a wake-up and never learns the cycle phase. */
const CACHE = 'orbit-v3';
const SHELL = ['./', 'index.html', 'styles.css?v=3', 'config.js?v=3', 'core.js?v=3', 'app.js?v=3', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png'];
importScripts('core.js?v=3');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // network first so updates land fast, cache as the offline fallback
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((r) => r || caches.match('index.html')))
  );
});

function idbGet(k) {
  return new Promise((resolve) => {
    const open = indexedDB.open('orbit', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('kv', 'readonly');
        const r = tx.objectStore('kv').get(k);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch (err) { resolve(null); }
    };
  });
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let data = {};
    try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'Orbit', body: e.data ? e.data.text() : '' }; }
    let title = data.title || '🪐 Orbit';
    let body = data.body || 'Something happened in your orbit.';
    let tab = data.tab || 'today';
    if (data.type === 'daily') {
      const state = await idbGet('state');
      if (state && state.profile && state.profile.notify !== false) {
        const n = self.OrbitCore.notification(state);
        title = n.title; body = n.body;
      } else {
        title = '🪐 Your daily decode is ready'; body = 'Tap to see what the cosmos says about today.';
      }
    }
    await self.registration.showNotification(title, {
      body, tag: data.type === 'ping' ? 'orbit-ping-' + Date.now() : 'orbit-' + (data.type || 'msg'),
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { tab },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || 'today';
  const target = new URL('./#' + tab, self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ type: 'open-tab', tab }); return c.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
