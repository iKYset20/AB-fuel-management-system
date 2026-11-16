/*
 * ============================================================================
 * AB Fuel — Ajakan "Pasang Aplikasi" (versi GitHub Pages, Fase 10 / PWA)
 * ----------------------------------------------------------------------------
 * Elemen BARU khusus Pages (#pagesInstallPrompt) — tidak mengubah ID/markup lama.
 * - Chrome/Edge (Android & desktop): tangkap `beforeinstallprompt` → tombol "Pasang".
 * - iPhone/iPad (Safari tidak punya prompt otomatis): petunjuk Bagikan → Tambah ke Layar Utama.
 * - Tidak tampil bila sudah berjalan sebagai aplikasi, saat offline, atau 14 hari setelah ditutup.
 * - window.abFuelInstall() bisa dipanggil untuk membuka ajakan secara manual.
 * Warna memakai token tema (palet.md); teks di atas tombol mint = --brand-950 #052E22 (CLAUDE.md §3).
 * ============================================================================
 */
(function () {
    'use strict';

    var DISMISS_KEY = 'ab_fuel_install_dismissed_at';
    var DISMISS_DAYS = 14;
    var SHOW_DELAY_MS = 5000;

    var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    var ua = navigator.userAgent || '';
    var isIos = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

    var CSS = '' +
        '#pagesInstallPrompt{position:fixed;right:24px;bottom:calc(24px + env(safe-area-inset-bottom));z-index:1038;' +
        'width:min(380px,calc(100vw - 32px));display:flex;gap:12px;align-items:flex-start;padding:14px 14px 14px 14px;' +
        'border-radius:20px;background:var(--modal-solid,#E4ECE8);color:var(--text-primary,#111A15);' +
        'border:1px solid var(--border-subtle,rgba(0,0,0,.08));box-shadow:0 18px 40px rgba(5,46,34,.26);' +
        'opacity:0;visibility:hidden;transform:translateY(16px);' +
        'transition:opacity .25s ease,transform .35s var(--ease-spring,cubic-bezier(.34,1.56,.64,1)),visibility 0s .35s}' +
        '#pagesInstallPrompt.is-shown{opacity:1;visibility:visible;transform:none;' +
        'transition:opacity .25s ease,transform .35s var(--ease-spring,cubic-bezier(.34,1.56,.64,1)),visibility 0s}' +
        '#pagesInstallPrompt .pip-icon{flex:0 0 auto;width:44px;height:44px;border-radius:12px;background:#fff;' +
        'box-shadow:0 2px 8px rgba(5,46,34,.18);object-fit:contain}' +
        '#pagesInstallPrompt .pip-body{flex:1 1 auto;min-width:0}' +
        '#pagesInstallPrompt .pip-title{font-weight:700;font-size:.9rem;line-height:1.25}' +
        '#pagesInstallPrompt .pip-text{font-size:.78rem;color:var(--text-secondary,#3F4C46);margin-top:2px;line-height:1.35}' +
        '#pagesInstallPrompt .pip-actions{display:flex;gap:8px;margin-top:10px}' +
        '#pagesInstallPrompt .pip-btn{border:0;border-radius:999px;padding:7px 16px;font-weight:700;font-size:.8rem;cursor:pointer}' +
        /* Teks gelap di atas mint (CLAUDE.md §3). --on-brand-primary di tema terang = putih (untuk CTA tinta), jadi tidak dipakai. */
        '#pagesInstallPrompt .pip-primary{background:var(--brand-500,#1FC796);color:var(--brand-950,#052E22)}' +
        '#pagesInstallPrompt .pip-secondary{background:transparent;color:var(--text-secondary,#3F4C46)}' +
        '#pagesInstallPrompt .pip-secondary:hover{background:var(--surface-secondary,rgba(0,0,0,.06))}' +
        '#pagesInstallPrompt .pip-btn:focus-visible{outline:2px solid var(--brand-500,#1FC796);outline-offset:2px}' +
        '#pagesInstallPrompt .pip-ios-share{display:inline-block;vertical-align:-3px;width:16px;height:16px}' +
        '@media (max-width:991.98px){#pagesInstallPrompt{left:16px;right:16px;width:auto;bottom:calc(92px + env(safe-area-inset-bottom))}}' +
        '@media (prefers-reduced-motion:reduce){#pagesInstallPrompt,#pagesInstallPrompt.is-shown{transition:none}}' +
        '@media print{#pagesInstallPrompt{display:none!important}}';

    var SHARE_SVG = '<svg class="pip-ios-share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/>' +
        '<path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

    var deferred = null, el = null, showTimer = null;

    function recentlyDismissed() {
        try {
            var t = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
            return t && (Date.now() - t) < DISMISS_DAYS * 86400000;
        } catch (e) { return false; }
    }
    function rememberDismiss() {
        try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) { /* storage diblokir */ }
    }

    function build(mode) {
        if (!el) {
            var style = document.createElement('style');
            style.textContent = CSS;
            document.head.appendChild(style);
            el = document.createElement('div');
            el.id = 'pagesInstallPrompt';
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-labelledby', 'pagesInstallTitle');
            document.body.appendChild(el);
        }
        var text = mode === 'ios'
            ? 'Ketuk ' + SHARE_SVG + ' <b>Bagikan</b>, lalu pilih <b>Tambah ke Layar Utama</b>.'
            : 'Buka langsung dari layar utama, layar penuh tanpa bilah browser, dan tetap jalan saat offline.';
        el.innerHTML =
            '<img class="pip-icon" src="icons/icon-192.png" alt="">' +
            '<div class="pip-body">' +
            '<div class="pip-title" id="pagesInstallTitle">Pasang AB-Fuel di perangkat ini</div>' +
            '<div class="pip-text">' + text + '</div>' +
            '<div class="pip-actions">' +
            (mode === 'ios' ? '' : '<button type="button" class="pip-btn pip-primary" data-act="install">Pasang</button>') +
            '<button type="button" class="pip-btn pip-secondary" data-act="later">' + (mode === 'ios' ? 'Mengerti' : 'Nanti saja') + '</button>' +
            '</div></div>';
        el.querySelector('[data-act="later"]').addEventListener('click', function () { rememberDismiss(); hide(); });
        var btn = el.querySelector('[data-act="install"]');
        if (btn) btn.addEventListener('click', doInstall);
    }

    function show(mode, force) {
        if (isStandalone || (!force && (recentlyDismissed() || !navigator.onLine))) return false;
        build(mode);
        requestAnimationFrame(function () { el.classList.add('is-shown'); });
        return true;
    }
    function hide() { if (el) el.classList.remove('is-shown'); }

    function doInstall() {
        if (!deferred) { hide(); return; }
        var p = deferred;
        deferred = null;
        hide();
        p.prompt();
        p.userChoice.then(function (choice) {
            if (choice && choice.outcome !== 'accepted') rememberDismiss();
        }).catch(function () { /* abaikan */ });
    }

    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault(); // tahan banner bawaan → tampilkan ajakan bergaya aplikasi
        deferred = e;
        if (showTimer) clearTimeout(showTimer);
        showTimer = setTimeout(function () { show('prompt'); }, SHOW_DELAY_MS);
    });

    window.addEventListener('appinstalled', function () {
        deferred = null;
        hide();
        rememberDismiss();
        if (typeof window.showToast === 'function') window.showToast('AB-Fuel terpasang di perangkat ini.', 'success');
    });

    window.addEventListener('offline', hide);

    // Buka ajakan secara manual (mis. dari konsol / tautan bantuan)
    window.abFuelInstall = function () {
        if (isStandalone) return false;
        if (deferred) return show('prompt', true);
        if (isIos) return show('ios', true);
        return false;
    };

    if (isIos && !isStandalone) {
        var start = function () { showTimer = setTimeout(function () { show('ios'); }, SHOW_DELAY_MS); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    }

    if (isStandalone) document.documentElement.classList.add('is-pwa-standalone');
})();
