// VamPanel - shared frontend utilities (v2)
(function () {
    'use strict';

    // ---------- Helpers ----------
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatBytes(bytes, decimals) {
        if (decimals === undefined) decimals = 2;
        if (!bytes) return '0 B';
        var k = 1024;
        var dm = decimals < 0 ? 0 : decimals;
        var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    // ---------- Toast stack (multi) + legacy #toast compat ----------
    var TOAST_ICONS = { success: 'ti-check', error: 'ti-alert-circle', info: 'ti-info-circle' };

    function showToast(message, type, duration) {
        type = type || 'success';
        duration = duration == null ? 3500 : duration;
        var stack = document.getElementById('toastStack');
        if (stack) {
            var item = document.createElement('div');
            item.className = 'toast-item ' + type;
            item.setAttribute('role', 'status');
            var icon = TOAST_ICONS[type] || TOAST_ICONS.info;
            item.innerHTML = '<i class="ti ' + icon + '"></i><span></span>';
            item.querySelector('span').textContent = message;
            stack.appendChild(item);
            while (stack.children.length > 4) stack.removeChild(stack.firstChild);
            setTimeout(function () {
                item.classList.add('toast-out');
                setTimeout(function () { item.remove(); }, 200);
            }, duration);
            return;
        }
        // Legacy fallback: single #toast element
        var toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = message;
        toast.className = 'toast show ' + type;
        clearTimeout(showToast._t);
        showToast._t = setTimeout(function () { toast.className = 'toast'; }, duration);
    }

    // ---------- Confirm modal (replaces native confirm for [data-confirm]) ----------
    function confirmModal(message, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'c3-modal-overlay';
            overlay.innerHTML =
                '<div class="c3-modal" role="dialog" aria-modal="true" aria-label="' + escapeHtml(opts.title || 'Confirm') + '">' +
                '<div class="c3-modal-header">' + escapeHtml(opts.title || 'Confirm') + '</div>' +
                '<div class="c3-modal-body"></div>' +
                '<div class="c3-modal-footer">' +
                '<button class="btn" data-x="cancel"></button>' +
                '<button class="btn btn-primary" data-x="ok"></button>' +
                '</div></div>';
            overlay.querySelector('.c3-modal-body').textContent = message;
            var cancelBtn = overlay.querySelector('[data-x="cancel"]');
            var okBtn = overlay.querySelector('[data-x="ok"]');
            cancelBtn.textContent = opts.cancel || 'Cancel';
            okBtn.textContent = opts.ok || 'Confirm';
            if (opts.danger) { okBtn.classList.remove('btn-primary'); okBtn.style.background = 'var(--danger)'; }
            function done(val) {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve(val);
            }
            function onKey(e) { if (e.key === 'Escape') done(false); }
            document.addEventListener('keydown', onKey);
            overlay.addEventListener('click', function (e) { if (e.target === overlay) done(false); });
            cancelBtn.addEventListener('click', function () { done(false); });
            okBtn.addEventListener('click', function () { done(true); });
            document.body.appendChild(overlay);
            okBtn.focus();
        });
    }

    // Delegated handler so dynamically added [data-confirm] also works
    document.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('[data-confirm]') : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        confirmModal(el.getAttribute('data-confirm'), { title: el.getAttribute('data-confirm-title') || 'Confirm', danger: true })
            .then(function (ok) {
                if (!ok) return;
                if (el.tagName === 'A' && el.href) window.location.href = el.href;
                else if (el.form) el.form.submit();
                else el.click();
            });
    });

    // ---------- Fetch wrapper: 401 -> login, API errors -> toast ----------
    function celerityFetch(url, options) {
        options = options || {};
        options.credentials = options.credentials || 'include';
        options.headers = options.headers || {};
        if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
            options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
            options.body = JSON.stringify(options.body);
        }
        return fetch(url, options).then(function (res) {
            if (res.status === 401 && !url.match(/\/panel\/login/)) {
                window.location.href = '/panel/login';
                throw new Error('unauthorized');
            }
            return res;
        });
    }

    // ---------- Sidebar: mobile drawer + desktop collapse (persisted) ----------
    function setMobileMenu(open) {
        var sidebar = document.getElementById('sidebar');
        var overlay = document.getElementById('mobileOverlay');
        if (!sidebar || !overlay) return;
        sidebar.classList.toggle('active', open);
        overlay.classList.toggle('active', open);
        document.body.style.overflow = open ? 'hidden' : '';
    }
    function toggleMobileMenu(force) {
        var sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        setMobileMenu(typeof force === 'boolean' ? force : !sidebar.classList.contains('active'));
    }
    function toggleSidebarCollapse() {
        var collapsed = document.body.classList.toggle('sidebar-collapsed');
        try { localStorage.setItem('c3-sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
    }

    document.addEventListener('DOMContentLoaded', function () {
        try {
            if (localStorage.getItem('c3-sidebar-collapsed') === '1' && window.innerWidth > 768) {
                document.body.classList.add('sidebar-collapsed');
            }
        } catch (e) { /* ignore */ }

        var menuBtn = document.getElementById('mobileMenuBtn');
        if (menuBtn) menuBtn.addEventListener('click', function () { toggleMobileMenu(); });
        var overlay = document.getElementById('mobileOverlay');
        if (overlay) overlay.addEventListener('click', function () { setMobileMenu(false); });
        var collapseBtn = document.getElementById('sidebarCollapseBtn');
        if (collapseBtn) collapseBtn.addEventListener('click', toggleSidebarCollapse);

        document.querySelectorAll('.nav-menu a').forEach(function (link) {
            link.addEventListener('click', function (e) {
                if (window.innerWidth <= 768) setMobileMenu(false);
                // Smooth page-leave: fade/slide/blur out, then navigate.
                var href = link.getAttribute('href');
                if (href && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.defaultPrevented) {
                    e.preventDefault();
                    document.body.classList.add('page-leave');
                    setTimeout(function () { window.location.href = href; }, 150);
                }
            });
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') setMobileMenu(false);
        });

        initTilt();
        initIsland();
        initFog();
    });

    // Re-run tilt binding for dynamically added cards
    window.VamTilt = initTilt;

    // ---------- Parallax tilt for [data-tilt] + .stat-card ----------
    // Lerped (damped) motion: pointer sets a target, a rAF loop eases the
    // card towards it — no jitter, no transition fighting. Disabled on touch,
    // coarse pointers and prefers-reduced-motion.
    function initTilt() {
        var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
        var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!fine || calm) return;
        var MAX = 6; // degrees — visible but tasteful
        var EASE = 0.12;
        document.querySelectorAll('.stat-card, [data-tilt]').forEach(function (el) {
            if (el.hasAttribute('data-tilt-init')) return;
            el.setAttribute('data-tilt-init', '1');
            var st = { tx: 0, ty: 0, cx: 0, cy: 0, running: false };
            function frame() {
                st.cx += (st.tx - st.cx) * EASE;
                st.cy += (st.ty - st.cy) * EASE;
                if (Math.abs(st.tx - st.cx) < 0.02 && Math.abs(st.ty - st.cy) < 0.02) {
                    st.cx = st.tx; st.cy = st.ty;
                    st.running = false;
                    if (st.tx === 0 && st.ty === 0) { el.style.transform = ''; return; }
                } else {
                    requestAnimationFrame(frame);
                }
                el.style.transform =
                    'perspective(900px) rotateX(' + (-st.cy * MAX).toFixed(3) +
                    'deg) rotateY(' + (st.cx * MAX).toFixed(3) + 'deg) translateY(-2px)';
            }
            function kick() {
                if (!st.running) { st.running = true; requestAnimationFrame(frame); }
            }
            el.addEventListener('pointermove', function (e) {
                if (e.pointerType && e.pointerType !== 'mouse') return;
                var r = el.getBoundingClientRect();
                st.tx = (e.clientX - r.left) / r.width - 0.5;
                st.ty = (e.clientY - r.top) / r.height - 0.5;
                el.style.setProperty('--mx', ((st.tx + 0.5) * 100).toFixed(1) + '%');
                el.style.setProperty('--my', ((st.ty + 0.5) * 100).toFixed(1) + '%');
                kick();
            });
            el.addEventListener('pointerleave', function () {
                st.tx = 0; st.ty = 0;
                kick();
            });
        });
    }

    // ---------- Dynamic Island: whole pill toggles (hover handled by CSS) ----------
    function initIsland() {
        var island = document.getElementById('island');
        if (!island) return;
        function setOpen(open) {
            island.classList.toggle('open', open);
            island.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        island.addEventListener('click', function (e) {
            if (e.target.closest && e.target.closest('a')) return; // let links navigate
            setOpen(!island.classList.contains('open'));
        });
        island.addEventListener('keydown', function (e) {
            if (e.target.closest && e.target.closest('a')) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen(!island.classList.contains('open'));
            }
        });
        document.addEventListener('click', function (e) {
            if (!island.classList.contains('open')) return;
            if (!island.contains(e.target)) setOpen(false);
        });
        island.querySelectorAll('.island-link').forEach(function (link) {
            link.addEventListener('click', function () { setOpen(false); });
        });
        window.VamIsland = { setOpen: setOpen };
    }

    // ---------- Fog parallax: background drifts against the cursor ----------
    function initFog() {
        var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
        var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!fine || calm) return;
        var tx = 0, ty = 0, cx = 0, cy = 0, running = false;
        function frame() {
            cx += (tx - cx) * 0.07;
            cy += (ty - cy) * 0.07;
            document.documentElement.style.setProperty('--fx', cx.toFixed(2) + 'px');
            document.documentElement.style.setProperty('--fy', cy.toFixed(2) + 'px');
            if (Math.abs(tx - cx) < 0.05 && Math.abs(ty - cy) < 0.05) { running = false; return; }
            requestAnimationFrame(frame);
        }
        document.addEventListener('pointermove', function (e) {
            if (e.pointerType && e.pointerType !== 'mouse') return;
            var px = e.clientX / window.innerWidth - 0.5;
            var py = e.clientY / window.innerHeight - 0.5;
            tx = -px * 22;
            ty = -py * 22;
            if (!running) { running = true; requestAnimationFrame(frame); }
        }, { passive: true });
    }

    // ---------- Public API (backwards compatible) ----------
    window.formatBytes = formatBytes;
    window.escapeHtml = escapeHtml;
    window.showToast = showToast;
    window.confirmModal = confirmModal;
    window.celerityFetch = celerityFetch;
    window.toggleMobileMenu = toggleMobileMenu;
    window.toggleSidebarCollapse = toggleSidebarCollapse;

    console.log('VamPanel loaded');
})();
