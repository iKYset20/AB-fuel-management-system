/*
 * ============================================================================
 * AB Fuel — Service Worker versi GitHub Pages (Fase 8.2)
 * ----------------------------------------------------------------------------
 * Menggantikan SW blob lama (blob: tidak bisa didaftarkan sebagai SW).
 * Placeholder BUILD_VERSION, SHELL_FILES dan PRECACHE_CDN (diapit "__") diisi oleh ghpages/build.mjs.
 *
 * Strategi:
 * - Halaman (navigate)       : network-first (versi terbaru saat online), cadangan cache.
 * - File situs sendiri       : stale-while-revalidate.
 * - CDN (jsdelivr, cdnjs, …) : cache-first (URL berversi + SRI).
 * - API Apps Script (POST)   : TIDAK disentuh — cache data ditangani gas-adapter.js.
 * ============================================================================
 */
'use strict';

var VERSION = '456526183b';
var SHELL_CACHE = 'abfuel-pages-shell-' + VERSION;
var CDN_CACHE = 'abfuel-pages-cdn-v1'; // URL CDN berversi → aman dipakai lintas build
var SHELL_FILES = ["./","./index.html","./gas-adapter.js?v=456526183b","./pages-offline-ui.js?v=456526183b","./pages-install.js?v=456526183b","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./icons/apple-touch-icon.png","./icons/favicon-32.png"];   // ./, ./index.html, ./gas-adapter.js?v=…, ./pages-offline-ui.js?v=…
var PRECACHE_CDN = [
    "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.10.0/css/all.min.css",
    "https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css",
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
    "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
    "https://code.jquery.com/jquery-3.7.1.min.js",
    "https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jquery-easing/1.4.1/jquery.easing.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.29.4/moment.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"
];
var NAV_TIMEOUT_MS = 6000;

self.addEventListener('install', function (event) {
    event.waitUntil(Promise.all([
        caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL_FILES); }),
        // CDN: satu per satu & mode CORS (agar lolos cek SRI); gagal satu tidak menggagalkan instalasi
        caches.open(CDN_CACHE).then(function (c) {
            return Promise.all(PRECACHE_CDN.map(function (url) {
                return c.match(url).then(function (hit) {
                    if (hit) return;
                    return fetch(new Request(url, { mode: 'cors', credentials: 'omit' })).then(function (resp) {
                        if (resp.ok) return c.put(url, resp);
                    }).catch(function () { /* dicoba lagi saat runtime */ });
                });
            }));
        })
    ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
    event.waitUntil(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
            if (k.indexOf('abfuel-pages-') === 0 && k !== SHELL_CACHE && k !== CDN_CACHE) return caches.delete(k);
            // Cache SW blob lama (ab-fuel-cache-v*) tidak dipakai versi ini
            if (k.indexOf('ab-fuel-cache-') === 0) return caches.delete(k);
        }));
    }).then(function () { return self.clients.claim(); }));
});

function isApi(url) {
    return url.hostname === 'script.google.com' || /\.googleusercontent\.com$/.test(url.hostname);
}

// [Fase 12] Ubin peta (ribuan gambar kecil) TIDAK disimpan SW agar cache tidak membengkak
function isMapTile(url) {
    return url.hostname === 'server.arcgisonline.com' || /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);
}

function networkFirstPage(request) {
    return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
            fromCache().then(function (r) { if (r && !settled) { settled = true; resolve(r); } });
        }, NAV_TIMEOUT_MS);
        function fromCache() {
            return caches.open(SHELL_CACHE).then(function (c) {
                return c.match('./index.html').then(function (r) { return r || c.match('./'); });
            });
        }
        fetch(request).then(function (resp) {
            if (resp.ok) {
                var copy = resp.clone();
                caches.open(SHELL_CACHE).then(function (c) { c.put('./index.html', copy); });
            }
            clearTimeout(timer);
            if (!settled) { settled = true; resolve(resp); }
        }).catch(function () {
            clearTimeout(timer);
            fromCache().then(function (r) {
                if (settled) return;
                settled = true;
                resolve(r || new Response('<h1>Offline</h1><p>Halaman belum tersimpan di perangkat ini. Buka sekali saat online.</p>',
                    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
            });
        });
    });
}

function staleWhileRevalidate(request) {
    return caches.open(SHELL_CACHE).then(function (c) {
        return c.match(request).then(function (hit) {
            var net = fetch(request).then(function (resp) {
                if (resp.ok) c.put(request, resp.clone());
                return resp;
            }).catch(function () { return hit || Response.error(); });
            return hit || net;
        });
    });
}

function cacheFirst(request) {
    return caches.open(CDN_CACHE).then(function (c) {
        return c.match(request).then(function (hit) {
            if (hit) return hit;
            return fetch(request).then(function (resp) {
                // Respons opaque hanya disimpan untuk permintaan no-cors (mis. <img>), agar
                // skrip/CSS ber-SRI (mode cors) tidak pernah dilayani respons opaque.
                if (resp.ok || (resp.type === 'opaque' && request.mode === 'no-cors')) c.put(request, resp.clone());
                return resp;
            });
        });
    });
}

self.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'GET') return;
    var url = new URL(req.url);
    if (isApi(url) || isMapTile(url)) return;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

    if (req.mode === 'navigate') { event.respondWith(networkFirstPage(req)); return; }
    if (url.origin === self.location.origin) { event.respondWith(staleWhileRevalidate(req)); return; }
    event.respondWith(cacheFirst(req));
});
