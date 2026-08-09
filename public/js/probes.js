// Probes page: list of vantage points, creation with a one-time install
// command, re-issue and removal.
//
// The list is polled rather than pushed: probes report on a 15-minute cadence,
// so anything faster than a slow poll would just be wasted requests.
(function () {
    'use strict';

    const app = document.getElementById('probesApp');
    if (!app) return;

    const I18N = window.PROBES_I18N || {};
    const POLL_MS = 30000;

    const $ = (id) => document.getElementById(id);

    const toast = (msg, type) => {
        if (typeof window.showToast === 'function') return window.showToast(msg, type);
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function fmtBytes(n) {
        n = Number(n) || 0;
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return n.toFixed(i ? 1 : 0) + ' ' + units[i];
    }

    function fmtAgo(value) {
        if (!value) return I18N.never || 'never';
        const then = new Date(value).getTime();
        if (Number.isNaN(then)) return I18N.never || 'never';

        const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.round(seconds / 60) + 'm';
        if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
        return Math.round(seconds / 86400) + 'd';
    }

    function statusOf(probe) {
        if (!probe.enrolledAt) return { cls: 'pending', label: I18N.pending || 'pending' };
        if (probe.live) return { cls: 'online', label: I18N.online || 'online' };
        return { cls: 'offline', label: I18N.offline || 'offline' };
    }

    function renderProbe(probe) {
        const status = statusOf(probe);
        const location = [probe.country, probe.asn].filter(Boolean).join(' · ');
        const open = expanded.has(String(probe._id));

        return `
            <div class="probe-row" data-id="${esc(probe._id)}">
                <div class="probe-main">
                    <span class="probe-dot probe-dot-${status.cls}"></span>
                    <div>
                        <div class="probe-name">${esc(probe.name)}</div>
                        <div class="probe-meta">
                            ${location ? esc(location) + ' · ' : ''}
                            ${esc(status.label)} · ${esc(I18N.lastSeen || 'last report')} ${esc(fmtAgo(probe.lastSeenAt))}
                        </div>
                    </div>
                </div>
                <div class="probe-facts">
                    <span title="${esc(I18N.traffic || 'traffic')}">
                        <i class="ti ti-arrows-up-down"></i> ${esc(fmtBytes(probe.trafficUsedBytes))}
                    </span>
                    ${probe.version ? `<span><i class="ti ti-tag"></i> ${esc(probe.version)}</span>` : ''}
                    ${probe.os ? `<span><i class="ti ti-device-desktop"></i> ${esc(probe.os)}/${esc(probe.arch)}</span>` : ''}
                </div>
                <div class="probe-actions">
                    <button type="button" class="btn btn-sm ${open ? 'btn-active' : ''}" data-probe-history>
                        <i class="ti ti-timeline"></i> ${esc(open ? (I18N.historyClose || 'Hide') : (I18N.historyOpen || 'History'))}
                    </button>
                    <button type="button" class="btn btn-sm" data-probe-reissue>
                        <i class="ti ti-refresh"></i> ${esc(I18N.reinstall || 'Reinstall')}
                    </button>
                    <button type="button" class="btn btn-sm btn-danger" data-probe-delete>
                        <i class="ti ti-trash"></i> ${esc(I18N.remove || 'Delete')}
                    </button>
                </div>
            </div>
            ${open ? renderHistoryShell(probe) : ''}`;
    }

    // ── History ──────────────────────────────────────────────────────────────
    //
    // One segment per check window, coloured by the dominant verdict. Ranges are
    // rendered from whatever the API returns: past 12 hours it answers with
    // hourly rollups, so a month fits into the same strip as a day.

    const expanded = new Set();
    const historyRange = new Map();
    const historyData = new Map();

    const RANGES = [
        { hours: 6, key: 'range6h' },
        { hours: 24, key: 'range24h' },
        { hours: 168, key: 'range7d' },
        { hours: 720, key: 'range30d' },
    ];

    function rangeOf(probeId) {
        return historyRange.get(String(probeId)) || 24;
    }

    function renderHistoryShell(probe) {
        const id = String(probe._id);
        const hours = rangeOf(id);
        const tabs = RANGES.map((r) => `
            <button type="button" class="probe-range ${r.hours === hours ? 'is-active' : ''}"
                    data-probe-range="${r.hours}">${esc(I18N[r.key] || (r.hours + 'h'))}</button>`).join('');

        return `
            <div class="probe-history" data-history-for="${esc(id)}">
                <div class="probe-history-head">
                    <div>
                        <strong>${esc(I18N.history || 'Check history')}</strong>
                        <small class="hint" style="display:block;">${esc(I18N.historyHint || '')}</small>
                    </div>
                    <div class="probe-ranges">${tabs}</div>
                </div>
                <div class="probe-history-body">${renderHistoryBody(probe)}</div>
            </div>`;
    }

    function renderHistoryBody(probe) {
        const id = String(probe._id);
        if (!probe.enrolledAt) {
            return `<div class="probe-empty">${esc(I18N.historyPending || '')}</div>`;
        }

        const data = historyData.get(id);
        if (!data) {
            return '<div class="skeleton-row"></div><div class="skeleton-row"></div>';
        }
        if (!data.nodes || data.nodes.length === 0) {
            return `<div class="probe-empty">${esc(I18N.historyEmpty || '')}</div>`;
        }

        return data.nodes.map(renderHistoryNode).join('');
    }

    function pct(ok, attempts) {
        if (!attempts) return null;
        return Math.round((ok / attempts) * 100);
    }

    function segmentClass(point) {
        if (!point.attempts) return 'probe-seg-none';
        if (point.ok >= point.attempts) return 'probe-seg-ok';
        if (point.code === 'core_down') return 'probe-seg-core';
        if (point.ok > 0 || point.code === 'degraded') return 'probe-seg-warn';
        return 'probe-seg-fail';
    }

    function fmtTime(ts) {
        const date = new Date(ts);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString();
    }

    function renderStrip(points, describe) {
        if (!points.length) return `<div class="probe-strip is-empty"></div>`;
        return `<div class="probe-strip">${points.map((p) => `
            <span class="probe-seg ${segmentClass(p)}" title="${esc(describe(p))}"></span>`).join('')}</div>`;
    }

    function renderHistoryNode(node) {
        const inbounds = node.inbounds.map((inbound) => {
            const share = pct(inbound.ok, inbound.attempts);
            const describe = (p) => {
                const verdict = !p.attempts
                    ? (I18N.noData || 'no data')
                    : (p.ok >= p.attempts ? (I18N.ok || 'ok') : (I18N[p.code] || p.code || ''));
                return `${fmtTime(p.ts)} · ${verdict} · ${p.ok}/${p.attempts}`;
            };

            return `
                <div class="probe-series">
                    <div class="probe-series-head">
                        <span class="probe-series-name">${esc(inbound.inboundTag || inbound.inboundId)}</span>
                        <span class="probe-series-facts">
                            ${share === null ? '' : `<span>${share}% ${esc(I18N.uptime || '')}</span>`}
                            ${inbound.latencyP95 ? `<span>${esc(I18N.latencyP95 || 'p95')} ${inbound.latencyP95} ms</span>` : ''}
                        </span>
                    </div>
                    ${renderStrip(inbound.points, describe)}
                </div>`;
        }).join('');

        const targets = node.targets.map((target) => {
            const share = pct(target.ok, target.attempts);
            const describe = (p) => {
                const verdict = !p.attempts
                    ? (I18N.noData || 'no data')
                    : (p.blocked > 0
                        ? (I18N.target_blocked || 'blocked')
                        : (p.ok >= p.attempts ? (I18N.ok || 'ok') : (p.httpStatus ? 'HTTP ' + p.httpStatus : '')));
                return `${fmtTime(p.ts)} · ${verdict}`;
            };

            return `
                <div class="probe-series">
                    <div class="probe-series-head">
                        <span class="probe-series-name">${esc(target.targetId)}</span>
                        <span class="probe-series-facts">
                            ${share === null ? '' : `<span>${share}% ${esc(I18N.uptime || '')}</span>`}
                        </span>
                    </div>
                    ${renderStrip(target.points.map((p) => ({
                        ts: p.ts,
                        attempts: p.attempts,
                        ok: p.blocked > 0 ? 0 : p.ok,
                        code: p.blocked > 0 ? 'target_blocked' : '',
                        blocked: p.blocked,
                        httpStatus: p.httpStatus,
                    })), describe)}
                </div>`;
        }).join('');

        return `
            <div class="probe-history-node">
                <div class="probe-history-node-name">
                    <i class="ti ti-server"></i> ${esc(node.nodeName)}
                </div>
                ${inbounds}
                ${targets ? `<div class="probe-history-sub">${esc(I18N.resources || 'Resources')}</div>${targets}` : ''}
            </div>`;
    }

    async function loadHistory(probeId) {
        const id = String(probeId);
        try {
            const res = await fetch(`/panel/probes/api/${encodeURIComponent(id)}/history?hours=${rangeOf(id)}`, {
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'failed to load history');

            historyData.set(id, data);
        } catch (err) {
            historyData.set(id, { nodes: [] });
            toast(String(err.message || err), 'error');
        }
        loadProbes();
    }

    async function loadProbes() {
        try {
            const res = await fetch('/panel/probes/api/list', { credentials: 'include' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'failed to load probes');

            const list = $('probesList');
            if (!list) return;

            if (!data.probes || data.probes.length === 0) {
                list.innerHTML = `<div class="probe-empty">${esc(I18N.empty || 'No probes yet.')}</div>`;
                return;
            }
            list.innerHTML = data.probes.map(renderProbe).join('');
        } catch (err) {
            toast(String(err.message || err), 'error');
        }
    }

    // The same one-time token is embedded into both commands, so switching the
    // tab only changes how the host is bootstrapped.
    let installCommands = { unix: '', windows: '' };

    function paintInstall(os) {
        const target = $('probeInstallCommand');
        if (!target) return;
        target.textContent = installCommands[os] || '';
        document.querySelectorAll('[data-probe-os]').forEach((tab) => {
            tab.classList.toggle('is-active', tab.dataset.probeOs === os);
        });
    }

    function showInstall(commands) {
        const modal = $('probeInstallModal');
        if (!modal) return;
        installCommands = commands || { unix: '', windows: '' };
        paintInstall('unix');
        modal.hidden = false;
    }

    function hideInstall() {
        const modal = $('probeInstallModal');
        if (modal) modal.hidden = true;
    }

    async function createProbe() {
        const name = window.prompt(I18N.namePrompt || 'Probe name');
        if (!name || !name.trim()) return;

        try {
            const res = await fetch('/panel/probes/api/create', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'failed');

            showInstall(data.installCommands);
            loadProbes();
        } catch (err) {
            toast(String(err.message || err), 'error');
        }
    }

    async function reissue(id) {
        try {
            const res = await fetch(`/panel/probes/api/${encodeURIComponent(id)}/reissue`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'failed');
            showInstall(data.installCommands);
        } catch (err) {
            toast(String(err.message || err), 'error');
        }
    }

    async function removeProbe(id) {
        if (!window.confirm(I18N.confirmRemove || 'Delete this probe?')) return;

        try {
            const res = await fetch(`/panel/probes/api/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'failed');
            loadProbes();
        } catch (err) {
            toast(String(err.message || err), 'error');
        }
    }

    document.addEventListener('click', (event) => {
        const createBtn = event.target.closest('#probeCreateBtn');
        if (createBtn) return createProbe();

        const copyBtn = event.target.closest('#probeCopyCommand');
        if (copyBtn) {
            const text = $('probeInstallCommand');
            if (text && navigator.clipboard) {
                navigator.clipboard.writeText(text.textContent || '')
                    .then(() => toast(I18N.copied || 'Copied'));
            }
            return;
        }

        const osTab = event.target.closest('[data-probe-os]');
        if (osTab) return paintInstall(osTab.dataset.probeOs);

        if (event.target.closest('[data-probe-close]')) return hideInstall();

        const rangeBtn = event.target.closest('[data-probe-range]');
        if (rangeBtn) {
            const panel = rangeBtn.closest('[data-history-for]');
            if (!panel) return;
            const id = panel.dataset.historyFor;
            historyRange.set(id, Number(rangeBtn.dataset.probeRange) || 24);
            historyData.delete(id);
            loadProbes();
            return loadHistory(id);
        }

        const row = event.target.closest('.probe-row');
        if (!row) return;

        if (event.target.closest('[data-probe-history]')) {
            const id = row.dataset.id;
            if (expanded.has(id)) {
                expanded.delete(id);
                historyData.delete(id);
                return loadProbes();
            }
            expanded.add(id);
            loadProbes();
            return loadHistory(id);
        }

        if (event.target.closest('[data-probe-reissue]')) return reissue(row.dataset.id);
        if (event.target.closest('[data-probe-delete]')) return removeProbe(row.dataset.id);
    });

    // Polling pauses while the tab is hidden: a background tab kept hitting the
    // panel every 30 s for a list nobody is looking at.
    let timer = null;

    function startPolling() {
        if (timer) return;
        timer = setInterval(loadProbes, POLL_MS);
    }

    function stopPolling() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return stopPolling();
        loadProbes();
        startPolling();
    });

    loadProbes();
    startPolling();
})();
