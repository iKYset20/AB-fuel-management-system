/*
 * ============================================================================
 * AB Fuel — Adaptor google.script.run untuk versi GitHub Pages (Fase 8.1 + 8.2)
 * ----------------------------------------------------------------------------
 * Satu-satunya tempat fetch() ke API internal (CLAUDE.md §3, amandemen Fase 8).
 * Meniru API google.script.run:
 *   google.script.run
 *     .withSuccessHandler(fn).withFailureHandler(fn).withUserObject(obj)
 *     .namaFungsi(arg1, arg2, ...)
 * lalu mengirim POST {fn, args} ke router doPost di Apps Script /exec.
 *
 * - Content-Type text/plain → "simple request", tanpa preflight CORS (Apps Script
 *   tidak menjawab OPTIONS).
 * - Hanya dipasang bila google.script.run belum ada (versi Apps Script tetap asli).
 * - URL API diisi build (window.AB_FUEL_API_URL) — lihat ghpages/config.json.
 *
 * [8.2] CACHE DATA OFFLINE (IndexedDB terpisah "AB_Fuel_PagesCache"; antrean
 * transaksi "AB_Fuel_LocalVault" TIDAK disentuh):
 * - Jawaban sukses fungsi BACA tertentu disimpan. Saat jaringan gagal, jawaban
 *   tersimpan terakhir dikirim ke success handler (tampilan data terakhir).
 * - Data master Scan-to-Fill (Master QR lengkap, karyawan, lokasi) diambil di
 *   latar belakang selagi online & login → QR tetap bisa dikenali saat offline.
 * - Data yang butuh login dihapus saat logout.
 * - Event window: "abfuel:cache-served" {fn, savedAt} dan "abfuel:live" {fn}.
 * ============================================================================
 */
(function (global) {
    'use strict';

    if (global.google && global.google.script && global.google.script.run) return; // di Apps Script: pakai yang asli

    var API_URL = global.AB_FUEL_API_URL || '';
    var TIMEOUT_MS = 60000; // batas eksekusi Apps Script ±6 menit, tapi UI butuh umpan balik lebih cepat
    var TOKEN_KEY = 'darkpan_jwt_token';
    var TOKEN_MARK = '__AUTH_TOKEN__';

    /* Fungsi baca yang boleh dilayani dari cache saat offline.
       auth = butuh login → dihapus saat logout. latest = boleh pakai jawaban terakhir
       walau argumennya berbeda (mis. tanggal Dashboard/Laporan sudah berganti hari). */
    var CACHEABLE = {
        getDashboardNativeData: { auth: false, latest: true },
        getLaporanHarianData:   { auth: false, latest: true },
        getMasterLokasiList:    { auth: false, latest: true },
        getMasterKaryawanList:  { auth: true,  latest: true },
        getMasterQRData:        { auth: true,  latest: false },
        getLastOperatorByUnit:  { auth: true,  latest: false },
        getMasterQRFullList:    { auth: true,  latest: true }
    };
    /* Selain fungsi baca, fungsi ini aman diulang sekali saat jaringan baru pulih:
       handleIdempotentSync menolak transaction_id ganda di server; sisanya hanya memperbarui sesi/kehadiran. */
    var RETRY_SAFE = { handleIdempotentSync: true, keepAliveSession: true, getOnlineUsers: true };
    var MAX_PER_FN = 12;
    var PREFETCH_EVERY_MS = 15 * 60 * 1000;

    function makeError(message, name) {
        var err = new Error(message);
        err.name = name || 'ScriptError';
        return err;
    }

    function emit(type, detail) {
        try { global.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (e) { /* abaikan */ }
    }

    function currentToken() {
        try { return global.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
    }

    /* ------------------------------------------------------------------ */
    /* IndexedDB kecil: store "responses" {key, fn, auth, savedAt, result} */
    /* ------------------------------------------------------------------ */
    var dbPromise = null;
    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB tidak tersedia')); return; }
            var req = global.indexedDB.open('AB_Fuel_PagesCache', 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains('responses')) {
                    var st = db.createObjectStore('responses', { keyPath: 'key' });
                    st.createIndex('fn', 'fn', { unique: false });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        }).catch(function (e) { dbPromise = null; throw e; });
        return dbPromise;
    }

    function withStore(mode, work) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('responses', mode);
                var out = work(tx.objectStore('responses'));
                tx.oncomplete = function () { resolve(out && out.req ? out.req.result : out); };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error); };
            });
        });
    }

    function allForFn(fn) {
        return withStore('readonly', function (st) { return { req: st.index('fn').getAll(fn) }; })
            .then(function (rows) { return rows || []; });
    }

    function cacheKey(fn, args) {
        var tok = currentToken();
        var norm = args.map(function (a) { return (tok && a === tok) ? TOKEN_MARK : a; });
        try { return fn + '|' + JSON.stringify(norm); } catch (e) { return null; }
    }

    function isStorable(result) {
        if (result === null || result === undefined) return false;
        if (typeof result === 'object' && (result.success === false || result.sessionExpired || result.mustChangePassword)) return false;
        return true;
    }

    function cachePut(fn, args, result) {
        var meta = CACHEABLE[fn];
        var key = cacheKey(fn, args);
        if (!meta || !key || !isStorable(result)) return Promise.resolve();
        var row = { key: key, fn: fn, auth: meta.auth, savedAt: Date.now(), result: result };
        return withStore('readwrite', function (st) { st.put(row); })
            .then(function () { return allForFn(fn); })
            .then(function (rows) {
                if (rows.length <= MAX_PER_FN) return;
                rows.sort(function (a, b) { return b.savedAt - a.savedAt; });
                var old = rows.slice(MAX_PER_FN);
                return withStore('readwrite', function (st) { old.forEach(function (r) { st.delete(r.key); }); });
            })
            .catch(function () { /* cache bersifat bantuan — gagal simpan tidak boleh mengganggu */ });
    }

    function cacheGet(fn, args) {
        var meta = CACHEABLE[fn];
        if (!meta) return Promise.resolve(null);
        var key = cacheKey(fn, args);
        return allForFn(fn).then(function (rows) {
            if (meta.auth && !currentToken()) return null; // data login tidak dilayani ke tamu
            var exact = null, latest = null;
            rows.forEach(function (r) {
                if (r.key === key) exact = r;
                if (!latest || r.savedAt > latest.savedAt) latest = r;
            });
            return exact || (meta.latest ? latest : null);
        }).catch(function () { return null; });
    }

    function purgeAuthCache() {
        return withStore('readwrite', function (st) {
            var req = st.openCursor();
            req.onsuccess = function () {
                var cur = req.result;
                if (!cur) return;
                if (cur.value.auth) cur.delete();
                cur.continue();
            };
        }).catch(function () { /* abaikan */ });
    }

    /* Scan-to-Fill offline: kenali QR dari snapshot Master QR (logika sama dengan getMasterQRData di server) */
    function resolveQrOffline(args) {
        if (!currentToken()) return Promise.resolve(null);
        var target = String(args[0] === undefined || args[0] === null ? '' : args[0]).trim();
        return allForFn('getMasterQRFullList').then(function (rows) {
            if (!rows.length) return null;
            rows.sort(function (a, b) { return b.savedAt - a.savedAt; });
            var snap = rows[0], list = (snap.result && snap.result.data) || [];
            var result;
            if (!target) {
                result = { success: false, message: 'ID QR kosong.' };
            } else {
                var hit = null;
                for (var i = 0; i < list.length; i++) {
                    if (String(list[i].qrId || '').trim() === target) { hit = list[i]; break; }
                }
                if (!hit) {
                    result = { success: false, message: 'ID QR tidak ditemukan di data master tersimpan (offline).' };
                } else {
                    var status = String(hit.status || 'Aktif').trim();
                    result = status.toUpperCase() !== 'AKTIF'
                        ? { success: false, inactive: true, message: "Stiker QR '" + target + "' berstatus " + status + ' (tidak aktif).' }
                        : { success: true, data: { qrId: hit.qrId, kodeUnit: hit.kodeUnit, lokasi: hit.lokasi, kapasitas: parseFloat(hit.kapasitas) || 0, status: status } };
                }
            }
            return { savedAt: snap.savedAt, result: result };
        }).catch(function () { return null; });
    }

    function offlineFallback(fn, args) {
        if (!CACHEABLE[fn]) return Promise.resolve(null);
        if (fn === 'getMasterQRData') {
            return resolveQrOffline(args).then(function (hit) { return hit || cacheGet(fn, args); });
        }
        return cacheGet(fn, args);
    }

    /* ------------------------------------------------------------------ */
    /* Transport                                                           */
    /* ------------------------------------------------------------------ */
    function postToServer(fnName, args) {
        if (!API_URL) {
            return Promise.reject(makeError('URL API belum dikonfigurasi (AB_FUEL_API_URL).', 'ConfigError'));
        }
        var body;
        try {
            body = JSON.stringify({ fn: fnName, args: args });
        } catch (e) {
            return Promise.reject(makeError('Argumen tidak bisa dikirim: ' + e.message));
        }
        if (global.navigator && global.navigator.onLine === false) {
            return Promise.reject(makeError('Connection failure due to HTTP 0', 'NetworkError'));
        }
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;

        return fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: body,
            redirect: 'follow',          // /exec menjawab 302 → script.googleusercontent.com
            credentials: 'omit',         // autentikasi lewat authToken di argumen, bukan cookie
            cache: 'no-store',
            signal: ctrl ? ctrl.signal : undefined
        }).then(function (resp) {
            if (!resp.ok) throw makeError('Server menjawab HTTP ' + resp.status + '.', 'NetworkError');
            return resp.text();
        }, function (e) {
            // Sama seperti google.script.run saat offline: "NetworkError: Connection failure..."
            throw makeError(e && e.name === 'AbortError'
                ? 'Koneksi ke server habis waktu.'
                : 'Connection failure due to HTTP 0', 'NetworkError');
        }).then(function (text) {
            var data;
            try { data = JSON.parse(text); } catch (e) {
                throw makeError('Respons server tidak valid.');
            }
            if (!data || data.ok !== true) throw makeError((data && data.error) || 'Terjadi kesalahan di server.');
            return data.result;
        }).finally(function () {
            if (timer) clearTimeout(timer);
        });
    }

    function callServer(fnName, args) {
        // Logout: hapus data master yang butuh login dari perangkat ini
        if (fnName === 'logoutSession' || fnName === 'logoutAllSessions') purgeAuthCache();

        // Fungsi BACA & RETRY_SAFE: bila jaringan gagal padahal browser "online" (mis. tepat setelah
        // tersambung kembali / sinyal lemah), coba sekali lagi setelah 1,5 dtk. Fungsi tulis lain TIDAK diulang.
        var attempt = postToServer(fnName, args);
        if (CACHEABLE[fnName] || RETRY_SAFE[fnName]) {
            attempt = attempt.catch(function (err) {
                if (err.name !== 'NetworkError' || !(global.navigator && global.navigator.onLine)) throw err;
                return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return postToServer(fnName, args); });
            });
        }

        return attempt.then(function (result) {
            if (CACHEABLE[fnName]) {
                cachePut(fnName, args, result);
                emit('abfuel:live', { fn: fnName });
            }
            if (fnName === 'checkProfilUserLogin' && result && result.success) setTimeout(prefetchMaster, 1500);
            if (result && typeof result === 'object' && result.sessionExpired) purgeAuthCache();
            return result;
        }, function (err) {
            if (err.name !== 'NetworkError') throw err;
            return offlineFallback(fnName, args).then(function (hit) {
                if (!hit) throw err;
                emit('abfuel:cache-served', { fn: fnName, savedAt: hit.savedAt });
                return hit.result;
            });
        });
    }

    /* Ambil data master Scan-to-Fill di latar belakang selagi online & login */
    var lastPrefetch = 0;
    function prefetchMaster() {
        var tok = currentToken();
        if (!tok || !API_URL || (global.navigator && global.navigator.onLine === false)) return;
        if (Date.now() - lastPrefetch < 60000) return;
        lastPrefetch = Date.now();
        [['getMasterQRFullList', [tok]], ['getMasterKaryawanList', [tok]], ['getMasterLokasiList', []]].forEach(function (c) {
            postToServer(c[0], c[1]).then(function (res) { cachePut(c[0], c[1], res); }, function () { /* coba lagi nanti */ });
        });
    }

    function makeRunner(state) {
        var base = {
            withSuccessHandler: function (fn) { return makeRunner(assign(state, { success: fn })); },
            withFailureHandler: function (fn) { return makeRunner(assign(state, { failure: fn })); },
            withUserObject: function (obj) { return makeRunner(assign(state, { userObject: obj })); }
        };
        return new Proxy(base, {
            get: function (target, prop) {
                if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
                // Jangan dianggap Promise / jangan bocorkan properti bawaan
                if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON' || prop.charAt(0) === '_') return undefined;
                return function () {
                    var args = Array.prototype.slice.call(arguments);
                    callServer(prop, args).then(function (result) {
                        if (typeof state.success === 'function') state.success(result, state.userObject);
                    }, function (err) {
                        if (typeof state.failure === 'function') state.failure(err, state.userObject);
                        else if (global.console) {
                            // Offline tanpa failure handler = hal biasa → peringatan, bukan error
                            (err && err.name === 'NetworkError' ? console.warn : console.error)
                                .call(console, 'google.script.run.' + prop + ' gagal: ' + (err && err.message));
                        }
                    });
                    // google.script.run asli mengembalikan undefined
                };
            }
        });
    }

    function assign(a, b) {
        var out = {}, k;
        for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
        for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
        return out;
    }

    global.google = global.google || {};
    global.google.script = global.google.script || {};
    // Getter: setiap akses google.script.run memberi runner baru (handler tidak bocor antar-panggilan)
    Object.defineProperty(global.google.script, 'run', {
        configurable: true,
        enumerable: true,
        get: function () { return makeRunner({}); }
    });
    global.AB_FUEL_IS_PAGES = true;

    // Siklus prefetch master: saat dimuat, saat kembali online, dan berkala selagi tab terlihat
    if (global.addEventListener) {
        global.addEventListener('load', function () {
            if (!currentToken()) purgeAuthCache(); // sisa data login dari sesi lama
            else setTimeout(prefetchMaster, 3000);
        });
        global.addEventListener('online', function () { setTimeout(prefetchMaster, 2000); });
        setInterval(function () {
            if (!global.document || !global.document.hidden) prefetchMaster();
        }, PREFETCH_EVERY_MS);
    }

    // Untuk uji otomatis (tidak dipakai kode aplikasi)
    global.__abFuelPagesCache = { put: cachePut, get: cacheGet, purgeAuth: purgeAuthCache, prefetch: prefetchMaster, resolveQr: resolveQrOffline };
})(window);
