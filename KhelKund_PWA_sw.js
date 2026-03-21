// KhelKund Arena — Service Worker
// Caches the app shell for offline use.
// Version bump here forces cache refresh on next visit.
const CACHE = "khelkund-v1";

const SHELL = [
  "./index.html",
  "./sw.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

// ── Install: cache the app shell ─────────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
  // Take over immediately without waiting for old SW to die
  self.skipWaiting();
});

// ── Activate: delete old caches ──────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first for shell, network-first for API calls ────
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Always go to network for Google Apps Script sync calls
  if (url.hostname.includes("script.google.com") ||
      url.hostname.includes("googleapis.com")) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ ok: false, error: "offline" }), {
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    return;
  }

  // Cache-first for everything else (app shell)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for the same origin
        if (
          response.ok &&
          event.request.method === "GET" &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Background sync (queues failed pushes for retry) ─────────────
self.addEventListener("sync", event => {
  if (event.tag === "kk-sync") {
    event.waitUntil(retrySyncFromQueue());
  }
});

async function retrySyncFromQueue() {
  // The app stores the WEBAPP_URL in IndexedDB for the SW to use
  // This is a best-effort retry — the app handles the main sync logic
  const db = await openDB();
  const url = await dbGet(db, "webapp_url");
  const pending = await dbGet(db, "pending_bookings");
  if (!url || !pending || !pending.length) return;

  try {
    const r = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ bookings: pending }),
      headers: { "Content-Type": "application/json" },
    });
    if (r.ok) {
      await dbSet(db, "pending_bookings", []);
      // Notify open clients that sync completed
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: "SYNC_COMPLETE" }));
    }
  } catch {}
}

// Minimal IndexedDB helpers for background sync
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("kk-sw", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("kv");
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject();
  });
}
function dbGet(db, key) {
  return new Promise(resolve => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
function dbSet(db, key, value) {
  return new Promise(resolve => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = resolve;
  });
}
