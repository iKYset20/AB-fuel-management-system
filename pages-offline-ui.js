/*
 * ============================================================================
 * AB Fuel — Pemberitahuan mode offline (versi GitHub Pages, Fase 8.2)
 * ----------------------------------------------------------------------------
 * Elemen BARU khusus Pages (#pagesOfflineNotice) — tidak mengubah ID/markup lama.
 * Mendengar event dari gas-adapter.js:
 *   abfuel:cache-served {fn, savedAt} → "Menampilkan data tersimpan · <waktu>"
 *   abfuel:live         {fn}          → data segar diterima → pemberitahuan ditutup
 * serta online/offline browser. Warna memakai token tema (palet.md); tidak ikut cetak.
 * ============================================================================
 */
(function () {
    'use strict';

    var LABELS = {
        getDashboardNativeData: 'Dashboard',
        getLaporanHarianData: 'Laporan Harian',
        getMasterLokasiList: 'Master Lokasi',
        getMasterKaryawanList: 'Master Karyawan',
        getMasterQRData: 'Master QR',
        getLastOperatorByUnit: 'Riwayat Unit',
        getMasterQRFullList: 'Master QR'
    };

    var CSS = '' +
        '#pagesOfflineNotice{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));z-index:1039;' +
        'transform:translate(-50%,16px);opacity:0;visibility:hidden;display:flex;align-items:center;gap:10px;' +
        'max-width:min(560px,calc(100vw - 32px));padding:10px 10px 10px 14px;border-radius:var(--radius-pill,999px);' +
        'background:var(--modal-solid,#E4ECE8);color:var(--text-primary,#111A15);' +
        'border:1px solid var(--status-warning-bg,rgba(214,150,46,.2));box-shadow:0 12px 32px rgba(5,46,34,.22);' +
        'font-size:.82rem;font-weight:600;line-height:1.3;' +
        'transition:opacity .25s ease,transform .35s var(--ease-spring,cubic-bezier(.34,1.56,.64,1)),visibility 0s .35s}' +
        '#pagesOfflineNotice.is-shown{opacity:1;visibility:visible;transform:translate(-50%,0);' +
        'transition:opacity .25s ease,transform .35s var(--ease-spring,cubic-bezier(.34,1.56,.64,1)),visibility 0s}' +
        '#pagesOfflineNotice .pon-dot{flex:0 0 auto;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;' +
        'background:var(--status-warning-bg,rgba(214,150,46,.2));color:var(--status-warning,#A9640F);font-size:.8rem}' +
        '#pagesOfflineNotice.is-online .pon-dot{background:rgba(31,199,150,.18);color:var(--brand-500,#1FC796)}' +
        '#pagesOfflineNotice .pon-text{flex:1 1 auto;min-width:0}' +
        '#pagesOfflineNotice .pon-sub{display:block;font-weight:500;font-size:.74rem;color:var(--text-secondary,#3F4C46)}' +
        '#pagesOfflineNotice .pon-close{flex:0 0 auto;width:28px;height:28px;border-radius:50%;border:0;cursor:pointer;' +
        'background:transparent;color:var(--text-secondary,#3F4C46);font-size:1rem;line-height:1}' +
        '#pagesOfflineNotice .pon-close:hover{background:var(--surface-secondary,rgba(0,0,0,.06))}' +
        '#pagesOfflineNotice .pon-close:focus-visible{outline:2px solid var(--brand-500,#1FC796);outline-offset:2px}' +
        '#pagesOfflineNotice{width:max-content}' +
        /* HP/tablet: selebar layar (gutter 16px), di atas bottom-nav; left:50% membuat lebar menyusut separuh */
        '@media (max-width:991.98px){#pagesOfflineNotice{left:16px;right:16px;width:auto;max-width:none;' +
        'bottom:calc(92px + env(safe-area-inset-bottom));border-radius:18px;transform:translateY(16px)}' +
        '#pagesOfflineNotice.is-shown{transform:translateY(0)}}' +
        '@media (prefers-reduced-motion:reduce){#pagesOfflineNotice,#pagesOfflineNotice.is-shown{transition:none}}' +
        '@media print{#pagesOfflineNotice{display:none!important}}';

    var el, textEl, subEl, dotEl, hideTimer = null, dismissedUntilChange = false, servedFns = {};

    function fmtTime(ts) {
        var d = new Date(ts);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var today = new Date();
        var sameDay = d.toDateString() === today.toDateString();
        return (sameDay ? 'hari ini' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear()) +
            ' ' + pad(d.getHours()) + '.' + pad(d.getMinutes());
    }

    function build() {
        if (el) return;
        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        el = document.createElement('div');
        el.id = 'pagesOfflineNotice';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML = '<span class="pon-dot" aria-hidden="true"><i class="fa fa-wifi"></i></span>' +
            '<span class="pon-text"><span class="pon-main"></span><span class="pon-sub"></span></span>' +
            '<button type="button" class="pon-close" aria-label="Tutup pemberitahuan">&times;</button>';
        textEl = el.querySelector('.pon-main');
        subEl = el.querySelector('.pon-sub');
        dotEl = el.querySelector('.pon-dot i');
        el.querySelector('.pon-close').addEventListener('click', function () {
            dismissedUntilChange = true;
            hide();
        });
        document.body.appendChild(el);
    }

    function show(main, sub, online) {
        build();
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        textEl.textContent = main;
        subEl.textContent = sub || '';
        subEl.style.display = sub ? '' : 'none';
        el.classList.toggle('is-online', !!online);
        dotEl.className = online ? 'fa fa-check' : 'fa fa-wifi';
        el.classList.add('is-shown');
    }

    function hide(delay) {
        if (!el) return;
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { el.classList.remove('is-shown'); hideTimer = null; }, delay || 0);
    }

    function showOffline() {
        if (dismissedUntilChange) return;
        var names = Object.keys(servedFns);
        if (names.length) {
            var newest = 0;
            names.forEach(function (k) { if (servedFns[k].savedAt > newest) newest = servedFns[k].savedAt; });
            var labels = names.map(function (k) { return LABELS[k] || k; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
            show((navigator.onLine ? 'Server belum terjangkau' : 'Offline') + ' — menampilkan data tersimpan (' + fmtTime(newest) + ')',
                labels.join(', ') + '. Scan-to-Fill tetap bisa dipakai; transaksi masuk antrean.');
        } else {
            show('Anda sedang offline',
                'Scan-to-Fill tetap bisa dipakai; transaksi disimpan di antrean dan dikirim otomatis saat online.');
        }
    }

    window.addEventListener('abfuel:cache-served', function (e) {
        var d = e.detail || {};
        servedFns[d.fn] = { savedAt: d.savedAt || Date.now() };
        showOffline();
    });

    window.addEventListener('abfuel:live', function (e) {
        var d = e.detail || {};
        if (servedFns[d.fn]) delete servedFns[d.fn];
        if (!Object.keys(servedFns).length && el && el.classList.contains('is-shown') && navigator.onLine) {
            show('Kembali online', 'Data terbaru sudah dimuat dari server.', true);
            hide(3500);
        }
    });

    window.addEventListener('offline', function () {
        dismissedUntilChange = false;
        showOffline();
    });

    window.addEventListener('online', function () {
        dismissedUntilChange = false;
        show('Kembali online', 'Menyinkronkan antrean & memuat data terbaru…', true);
        servedFns = {};
        hide(4000);
        // Muat ulang data tampilan dari server (fungsi lama, tidak diubah)
        try { if (typeof window.loadLiveDashboardData === 'function') window.loadLiveDashboardData(); } catch (err) { /* abaikan */ }
    });

    function init() { if (!navigator.onLine) showOffline(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
