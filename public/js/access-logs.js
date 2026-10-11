// Access-logs dashboard: filters, analytics overview (charts + user/top tables),
// on-demand event search, node status, purge.
//
// The whole overview comes from a single /api/analytics call (the server fans
// the aggregate queries out to ClickHouse). The raw-event search is a separate
// on-demand request. Requests are issued sequentially so the slower analytics
// response does not delay the search rows the user is usually after.
(function () {
    'use strict';

    const app = document.getElementById('accessLogsApp');
    if (!app) return;
    const enabled = app.dataset.enabled === '1';
    const I18N = window.__AL_I18N || {};
    const L = (I18N.labels) || {};
    const NODES = window.__AL_NODES || {};

    const $ = (id) => document.getElementById(id);
    const toast = (msg, type) => {
        if (typeof window.showToast === 'function') return window.showToast(msg, type);
        const t = $('toast'); if (!t) return;
        t.textContent = msg; t.className = 'toast show ' + (type || '');
        setTimeout(() => { t.className = 'toast'; }, 3000);
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function fmtNum(n) {
        n = Number(n) || 0;
        return n.toLocaleString();
    }

    function fmtBytes(n) {
        n = Number(n) || 0;
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return n.toFixed(i ? 1 : 0) + ' ' + u[i];
    }

    // Turn a server timestamp into a real Date. The access-log API returns Unix
    // epoch seconds (absolute instants, zone-safe, version-independent); we also
    // accept a couple of string shapes for robustness (e.g. Mongo ISO dates in
    // node status). Anything unrecognised returns null instead of letting
    // Date() guess — a lenient guess is exactly what turned a malformed CH
    // string ("21:July:54") into a bogus date before.
    function parseTs(v) {
        if (v == null || v === '') return null;
        if (v instanceof Date) return v;
        // Epoch (number or all-digit string). Seconds vs milliseconds is decided
        // by magnitude: epoch seconds are ~1.7e9, so anything below 1e11 is
        // seconds and gets scaled to ms.
        if (typeof v === 'number' || /^\d+$/.test(String(v))) {
            let n = Number(v);
            if (n < 1e11) n *= 1000;
            const d = new Date(n);
            return isNaN(d.getTime()) ? null : d;
        }
        const s = String(v);
        // Naive "YYYY-MM-DD HH:MM:SS" (no zone) is UTC by our convention.
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
            const d = new Date(s.replace(' ', 'T') + 'Z');
            return isNaN(d.getTime()) ? null : d;
        }
        // ISO 8601 carrying an explicit zone (e.g. Mongo dates "…Z" / "+03:00").
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
            const d = new Date(s);
            return isNaN(d.getTime()) ? null : d;
        }
        return null;
    }

    function fmtTime(v) {
        if (!v) return I18N.never || '—';
        const d = parseTs(v);
        return d ? d.toLocaleString() : String(v);
    }

    // Colored pill for an action / protocol so the tables scan at a glance.
    function actionBadge(a) {
        a = String(a || '');
        if (!a) return '';
        const cls = a === 'accepted' ? 'al-badge-accepted'
            : a === 'rejected' ? 'al-badge-rejected'
            : a === 'blocked' ? 'al-badge-blocked' : '';
        return '<span class="al-badge ' + cls + '">' + esc(a) + '</span>';
    }
    function netBadge(n) {
        n = String(n || '');
        if (!n) return '';
        return '<span class="al-badge ' + (n === 'udp' ? 'al-badge-udp' : 'al-badge-net') + '">' + esc(n) + '</span>';
    }
    function nodeName(id) {
        return NODES[id] || id || '';
    }

    // Collect filters from the form into a query string.
    function queryString() {
        const params = new URLSearchParams();
        const map = {
            from: 'alFrom', to: 'alTo', nodeId: 'alNode', email: 'alEmail',
            sourceIp: 'alSourceIp', destination: 'alDest', network: 'alNetwork', action: 'alAction',
        };
        for (const [key, id] of Object.entries(map)) {
            const el = $(id);
            if (el && el.value) {
                let v = el.value;
                if ((key === 'from' || key === 'to') && v) {
                    const d = new Date(v);
                    if (!isNaN(d.getTime())) v = d.toISOString();
                }
                params.set(key, v);
            }
        }
        return params.toString();
    }

    // ─── Busy indicator ──────────────────────────────────────────────────────
    // A reference-counted busy state drives the top progress bar and the search
    // button spinner, so any in-flight request (analytics, search, status, the
    // per-user IP drilldown) shows progress without flicker between chained calls.
    let busyCount = 0;
    function setBusy(on) {
        busyCount += on ? 1 : -1;
        if (busyCount < 0) busyCount = 0;
        const busy = busyCount > 0;
        const bar = $('alProgress');
        if (bar) bar.classList.toggle('active', busy);
        const btn = $('alSearchBtn');
        const icon = $('alSearchIcon');
        if (btn) btn.disabled = busy;
        if (icon) icon.className = busy ? 'ti ti-loader-2 al-spin' : 'ti ti-search';
    }

    async function getJson(url) {
        setBusy(true);
        try {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        } finally {
            setBusy(false);
        }
    }

    // ─── Charts (monochrome: series differ by lightness) ───────────────────
    const Cc = {
        accepted: '#fafafa', rejected: '#d4d4d8', blocked: '#a1a1aa',
        tcp: '#f4f4f5', udp: '#8e8e93', accent: '#e4e4e7', grid: '#27272a', text: '#a1a1aa',
    };
    let timelineChart = null, actionChart = null, protoChart = null;

    function ensureChartDefaults() {
        if (!window.Chart) return false;
        Chart.defaults.color = Cc.text;
        Chart.defaults.borderColor = Cc.grid;
        Chart.defaults.font.family = "'Inter', sans-serif";
        Chart.defaults.plugins.legend.labels.boxWidth = 12;
        Chart.defaults.maintainAspectRatio = false;
        return true;
    }

    function renderTimeline(series) {
        if (!ensureChartDefaults()) return;
        const ctx = $('alTimeline'); if (!ctx) return;
        // Parse UTC buckets to real instants so the time axis renders in local time.
        const labels = series.map(r => parseTs(r.bucket));
        const ds = (key, color) => ({
            label: (L[key] || key), data: series.map(r => Number(r[key] || 0)),
            borderColor: color, backgroundColor: color + '33', fill: true, tension: 0.3,
            pointRadius: 0, borderWidth: 2,
        });
        const data = {
            labels,
            datasets: [ds('accepted', Cc.accepted), ds('rejected', Cc.rejected), ds('blocked', Cc.blocked)],
        };
        const options = {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { type: 'time', time: { tooltipFormat: 'PPpp' }, grid: { display: false } },
                y: { beginAtZero: true, stacked: true, ticks: { precision: 0 } },
            },
            plugins: { legend: { position: 'bottom' } },
            elements: { line: { fill: true } },
        };
        // Stacked areas read better for accepted/rejected/blocked composition.
        options.scales.y.stacked = true;
        data.datasets.forEach(d => { d.fill = true; });
        if (timelineChart) { timelineChart.data = data; timelineChart.options = options; timelineChart.update(); }
        else timelineChart = new Chart(ctx.getContext('2d'), { type: 'line', data, options });
    }

    function renderDonut(canvasId, ref, entries) {
        if (!ensureChartDefaults()) return null;
        const ctx = $(canvasId); if (!ctx) return ref;
        const data = {
            labels: entries.map(e => e.label),
            datasets: [{ data: entries.map(e => e.value), backgroundColor: entries.map(e => e.color), borderWidth: 0 }],
        };
        const options = { responsive: true, cutout: '62%', plugins: { legend: { position: 'bottom' } } };
        if (ref) { ref.data = data; ref.update(); return ref; }
        return new Chart(ctx.getContext('2d'), { type: 'doughnut', data, options });
    }

    // ─── Tables ────────────────────────────────────────────────────────────
    // Render a table body with an inline proportion bar on a numeric column.
    function renderBarRows(tbody, rows, cols) {
        if (!tbody) return;
        rows = rows || [];
        if (!rows.length) { tbody.innerHTML = '<tr><td class="al-empty" colspan="' + cols.length + '">—</td></tr>'; return; }
        const barCol = cols.find(c => c.bar);
        const max = barCol ? Math.max(1, ...rows.map(r => Number(r[barCol.key] || 0))) : 1;
        tbody.innerHTML = rows.map(r => {
            return '<tr>' + cols.map(c => {
                let v = r[c.key];
                if (c.fmt) v = c.fmt(v, r);
                const cls = c.cls ? ' class="' + c.cls + '"' : '';
                const align = c.align ? ' style="text-align:' + c.align + ';"' : '';
                if (c.bar) {
                    const pct = Math.round((Number(r[c.key] || 0) / max) * 100);
                    return '<td class="al-bar-cell al-num"' + align + '>'
                        + '<span class="al-bar" style="width:' + pct + '%;"></span>'
                        + '<span class="al-bar-label">' + esc(v) + '</span></td>';
                }
                return '<td' + cls + align + '>' + (c.html ? v : esc(v)) + '</td>';
            }).join('') + '</tr>';
        }).join('');
    }

    function pct01(v) {
        const n = Number(v || 0);
        return Math.round(n * 100) + '%';
    }

    function renderUsers(users) {
        users = users || [];
        renderUsersByIp(users);
        // Fan-out lens: sorted by distinct destinations.
        const byFan = users.slice().sort((a, b) => (b.dests - a.dests) || (b.events - a.events));
        renderBarRows($('alUsersByFanout'), byFan, [
            { key: 'email', fmt: (v) => v || '—' },
            { key: 'dests', align: 'right', bar: true, fmt: fmtNum },
            { key: 'udp_share', align: 'right', fmt: pct01 },
            { key: 'events', align: 'right', fmt: fmtNum },
        ]);
    }

    // Sharing lens with click-to-expand: each user row reveals the full list of
    // source IPs it connected from (fetched lazily on first expand).
    function renderUsersByIp(users) {
        const tbody = $('alUsersByIp');
        if (!tbody) return;
        const byIp = users.slice().sort((a, b) => (b.ips - a.ips) || (b.events - a.events));
        if (!byIp.length) {
            tbody.innerHTML = '<tr><td class="al-empty" colspan="5">—</td></tr>';
            return;
        }
        const max = Math.max(1, ...byIp.map(u => Number(u.ips || 0)));
        tbody.innerHTML = byIp.map((u, i) => {
            const email = u.email || '—';
            const pct = Math.round((Number(u.ips || 0) / max) * 100);
            return '<tr class="al-user-row" data-idx="' + i + '" data-email="' + esc(email) + '">'
                + '<td><i class="al-caret ti ti-chevron-right"></i>' + esc(email) + '</td>'
                + '<td class="al-bar-cell al-num" style="text-align:right;">'
                +   '<span class="al-bar" style="width:' + pct + '%;"></span>'
                +   '<span class="al-bar-label">' + fmtNum(u.ips) + '</span></td>'
                + '<td class="al-num" style="text-align:right;">' + fmtNum(u.subnets) + '</td>'
                + '<td class="al-num" style="text-align:right;">' + fmtNum(u.events) + '</td>'
                + '<td class="hint" style="text-align:right;">' + esc(fmtTime(u.last_seen)) + '</td>'
                + '</tr>'
                + '<tr class="al-ip-detail" data-for="' + i + '" style="display:none;">'
                + '<td colspan="5"><div class="al-ip-wrap" data-loaded="0"></div></td></tr>';
        }).join('');
        tbody.querySelectorAll('.al-user-row').forEach(row => {
            row.addEventListener('click', () => toggleUserIps(row));
        });
    }

    async function toggleUserIps(row) {
        const idx = row.dataset.idx;
        const detail = row.parentNode.querySelector('.al-ip-detail[data-for="' + idx + '"]');
        if (!detail) return;
        const isOpen = detail.style.display !== 'none';
        if (isOpen) { detail.style.display = 'none'; row.classList.remove('open'); return; }
        detail.style.display = ''; row.classList.add('open');

        const wrap = detail.querySelector('.al-ip-wrap');
        if (wrap.dataset.loaded === '1') return;
        wrap.innerHTML = '<span class="hint">…</span>';
        try {
            const qs = new URLSearchParams(queryString());
            qs.set('email', row.dataset.email);
            const data = await getJson('/panel/access-logs/api/user-ips?' + qs.toString());
            const rows = data.rows || [];
            if (!rows.length) {
                wrap.innerHTML = '<span class="hint">' + esc(I18N.noIps || '—') + '</span>';
            } else {
                wrap.innerHTML = rows.map(r =>
                    '<span class="al-ip-chip"><span class="al-mono">' + esc(r.ip) + '</span>'
                    + '<span class="al-ip-meta">' + fmtNum(r.events) + ' · ' + fmtNum(r.dests) + ' dst · ' + esc(fmtTime(r.last_seen)) + '</span></span>'
                ).join('');
            }
            wrap.dataset.loaded = '1';
        } catch (e) {
            wrap.innerHTML = '<span class="hint">' + esc(e.message) + '</span>';
        }
    }

    function renderTops(data) {
        renderBarRows($('alTopDest'), data.topDestinations, [
            { key: 'dest', cls: 'al-mono al-trunc', fmt: (v, r) => v || r.key || '—' },
            { key: 'hits', align: 'right', bar: true, fmt: fmtNum },
        ]);
        renderBarRows($('alTopPorts'), data.topPorts, [
            { key: 'port', cls: 'al-mono', fmt: (v) => (v == null ? '—' : v) },
            { key: 'hits', align: 'right', bar: true, fmt: fmtNum },
        ]);
        renderBarRows($('alTopBlocked'), data.topBlocked, [
            { key: 'dest', cls: 'al-mono al-trunc', fmt: (v, r) => v || r.key || '—' },
            { key: 'hits', align: 'right', bar: true, fmt: fmtNum },
        ]);
    }

    // ─── Skeletons (first-load placeholders) ─────────────────────────────────
    function skelRow(cols) {
        let tds = '';
        for (let i = 0; i < cols; i++) {
            tds += '<td' + (i ? ' style="text-align:right;"' : '') + '><span class="al-skel"></span></td>';
        }
        return '<tr>' + tds + '</tr>';
    }
    function repeat(n, fn) { let s = ''; for (let i = 0; i < n; i++) s += fn(); return s; }
    function paintSkeletons() {
        ['alTotal', 'alUsers', 'alIps', 'alDests'].forEach(id => {
            const el = $(id); if (el) el.innerHTML = '<span class="al-skel"></span>';
        });
        const tables = { alUsersByIp: 5, alUsersByFanout: 4, alTopDest: 2, alTopPorts: 2, alTopBlocked: 2 };
        for (const id of Object.keys(tables)) {
            const t = $(id); if (t) t.innerHTML = repeat(5, () => skelRow(tables[id]));
        }
        const res = $('alResults'); if (res) res.innerHTML = repeat(6, () => skelRow(7));
    }

    // ─── Loaders ─────────────────────────────────────────────────────────────
    async function loadAnalytics() {
        try {
            const data = await getJson('/panel/access-logs/api/analytics?' + queryString());
            if (!data.enabled) return;
            const degraded = !!data.degraded;
            $('alDegraded').style.display = degraded ? '' : 'none';

            const totals = data.totals || {};
            $('alTotal').textContent = fmtNum(totals.total);
            $('alUsers').textContent = fmtNum(totals.users);
            $('alIps').textContent = totals.ips != null ? fmtNum(totals.ips) : '—';
            $('alDests').textContent = totals.dests != null ? fmtNum(totals.dests) : '—';

            renderTimeline(data.series || []);

            actionChart = renderDonut('alActionChart', actionChart, [
                { label: L.accepted || 'accepted', value: Number(totals.accepted || 0), color: Cc.accepted },
                { label: L.rejected || 'rejected', value: Number(totals.rejected || 0), color: Cc.rejected },
                { label: L.blocked || 'blocked', value: Number(totals.blocked || 0), color: Cc.blocked },
            ]);
            protoChart = renderDonut('alProtoChart', protoChart, [
                { label: L.tcp || 'tcp', value: Number(totals.tcp || 0), color: Cc.tcp },
                { label: L.udp || 'udp', value: Number(totals.udp || 0), color: Cc.udp },
            ]);

            renderUsers(data.users);
            renderTops(data);

            // Degraded mode (ClickHouse not configured/unreachable): widgets are
            // empty; hint why.
            if (data.chRequired) {
                const note = (span) => '<tr><td class="al-empty" colspan="' + span + '">' + esc(I18N.chRequired) + '</td></tr>';
                if (!(data.users || []).length) { $('alUsersByIp').innerHTML = note(5); $('alUsersByFanout').innerHTML = note(4); }
                if (!(data.topPorts || []).length) $('alTopPorts').innerHTML = note(2);
                if (!(data.topBlocked || []).length) $('alTopBlocked').innerHTML = note(2);
            }
        } catch (e) {
            toast('Analytics error: ' + e.message, 'error');
        }
    }

    async function loadSearch() {
        try {
            const data = await getJson('/panel/access-logs/api/search?' + queryString() + '&limit=200');
            const rows = data.rows || [];
            const tbody = $('alResults');
            $('alNoResults').style.display = rows.length ? 'none' : '';
            $('alResultCount').textContent = rows.length ? (rows.length + '') : '';
            if (data.degraded) $('alDegraded').style.display = '';
            tbody.innerHTML = rows.map(r => {
                const src = [r.source_ip, r.source_port].filter(Boolean).join(':');
                const dest = [(r.dest_host || r.dest_ip), r.dest_port].filter(Boolean).join(':');
                return `<tr>
                    <td class="hint" style="white-space:nowrap;">${esc(fmtTime(r.ts))}</td>
                    <td>${esc(nodeName(r.node_id))}</td>
                    <td>${esc(r.email || '')}</td>
                    <td class="al-mono">${esc(src)}</td>
                    <td class="al-mono al-trunc" title="${esc(dest)}">${esc(dest)}</td>
                    <td>${netBadge(r.network)}</td>
                    <td>${actionBadge(r.action)}</td>
                </tr>`;
            }).join('');
        } catch (e) {
            toast('Search error: ' + e.message, 'error');
        }
    }

    async function loadStatus() {
        try {
            const data = await getJson('/panel/access-logs/api/status');
            if (data.spool) $('alSpool').textContent = fmtBytes(data.spool.bytes) + ' (' + data.spool.count + ')';
            const tbody = $('alNodeStatus');
            const nodes = data.nodes || [];
            tbody.innerHTML = nodes.length ? nodes.map(n =>
                `<tr>
                    <td>${esc(n.name)}</td>
                    <td>${esc(n.agentVersion || '—')}</td>
                    <td>${esc(n.status)}</td>
                    <td>${esc(fmtTime(n.lastBatchAt))}</td>
                    <td class="hint">${esc(n.lastError || '')}</td>
                </tr>`
            ).join('') : '<tr><td class="hint" colspan="5">—</td></tr>';
        } catch (e) {
            // status is non-critical; keep quiet
        }
    }

    // Sequential refresh: analytics -> search -> status. Keeps the page calm and
    // avoids piling concurrent aggregate queries onto ClickHouse from one tab.
    async function refreshAll() {
        await loadAnalytics();
        await loadSearch();
        await loadStatus();
    }

    // ─── Wiring ──────────────────────────────────────────────────────────────
    const form = $('alFilters');
    if (form) {
        form.addEventListener('submit', (e) => { e.preventDefault(); refreshAll(); });
    }
    const reset = $('alReset');
    if (reset) {
        reset.addEventListener('click', () => {
            form.reset();
            setDefaultRange();
            refreshAll();
        });
    }
    const purge = $('alPurge');
    if (purge) {
        purge.addEventListener('click', async () => {
            if (!window.confirm(I18N.purgeConfirm)) return;
            try {
                const res = await fetch('/panel/access-logs/api/purge', { method: 'POST', credentials: 'include' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                toast('OK', 'success');
                refreshAll();
            } catch (e) {
                toast('Purge error: ' + e.message, 'error');
            }
        });
    }

    // Default the time range to the last 24 h so the initial load queries only
    // recent partitions instead of scanning the whole dataset.
    function setDefaultRange() {
        const from = $('alFrom');
        if (!from || from.value) return;
        const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        from.value = d.toISOString().slice(0, 16);
    }

    if (enabled) {
        setDefaultRange();
        paintSkeletons();
        refreshAll();
    } else {
        loadStatus();
    }
})();
