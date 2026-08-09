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

    // Open history panels are refreshed far slower than the list: a probe ships
    // a report every ~15 minutes, so anything faster only redraws the same data
    // and throws away what the operator is currently reading.
    const HISTORY_REFRESH_MS = 300000;

    const $ = (id) => document.getElementById(id);

    const toast = (msg, type) => {
        if (typeof window.showToast === 'function') return window.showToast(msg, type);
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function t(key, fallback) {
        return I18N[key] || fallback || '';
    }

    function fmtBytes(n) {
        n = Number(n) || 0;
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return n.toFixed(i ? 1 : 0) + ' ' + units[i];
    }

    function fmtAgo(value) {
        if (!value) return t('never', 'never');
        const then = new Date(value).getTime();
        if (Number.isNaN(then)) return t('never', 'never');

        const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.round(seconds / 60) + 'm';
        if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
        return Math.round(seconds / 86400) + 'd';
    }

    function fmtTime(ts) {
        const date = new Date(ts);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString();
    }

    function fmtClock(ts) {
        const date = new Date(ts);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function fmtPct(value) {
        if (value === null || value === undefined) return '—';
        return (Math.round(value * 10) / 10) + '%';
    }

    function fmtMs(value) {
        return value ? Math.round(value) + ' ms' : '—';
    }

    // A capped reading ran out of bytes before it ran out of time, so the link
    // was never pushed to its limit. Printing it as a plain number would sell a
    // floor as a fact, hence the "≥".
    function fmtBps(bps, capped) {
        const bits = (Number(bps) || 0) * 8;
        if (bits <= 0) return '—';
        const value = bits >= 1e9
            ? (bits / 1e9).toFixed(2) + ' Gbit/s'
            : (bits / 1e6).toFixed(1) + ' Mbit/s';
        return capped ? '≥ ' + value : value;
    }

    function fmtCount(n) {
        return Number(n || 0).toLocaleString();
    }

    function fmtDuration(ms) {
        const minutes = Math.round((Number(ms) || 0) / 60000);
        const hourUnit = t('unitHour', 'h');
        const minuteUnit = t('unitMinute', 'm');
        if (minutes < 60) return `${minutes} ${minuteUnit}`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? `${hours} ${hourUnit} ${rest} ${minuteUnit}` : `${hours} ${hourUnit}`;
    }

    function codeLabel(code) {
        if (!code) return t('ok', 'ok');
        return t(code, code);
    }

    function statusOf(probe) {
        if (!probe.enrolledAt) return { cls: 'pending', label: t('pending', 'pending') };
        if (probe.live) return { cls: 'online', label: t('online', 'online') };
        return { cls: 'offline', label: t('offline', 'offline') };
    }

    // ── Probe row ────────────────────────────────────────────────────────────

    function renderProbeRow(probe) {
        const status = statusOf(probe);
        const location = [probe.country, probe.asn].filter(Boolean).join(' · ');
        const open = expanded.has(String(probe._id));

        return `
            <div class="probe-main">
                <span class="probe-dot probe-dot-${status.cls}"></span>
                <div>
                    <div class="probe-name">${esc(probe.name)}</div>
                    <div class="probe-meta">
                        ${location ? esc(location) + ' · ' : ''}
                        ${esc(status.label)} · ${esc(t('lastSeen', 'last report'))} ${esc(fmtAgo(probe.lastSeenAt))}
                    </div>
                </div>
            </div>
            <div class="probe-facts">
                <span title="${esc(t('traffic', 'traffic'))}">
                    <i class="ti ti-arrows-up-down"></i> ${esc(fmtBytes(probe.trafficUsedBytes))}
                </span>
                ${probe.version ? `<span><i class="ti ti-tag"></i> ${esc(probe.version)}</span>` : ''}
                ${probe.os ? `<span><i class="ti ti-device-desktop"></i> ${esc(probe.os)}/${esc(probe.arch)}</span>` : ''}
            </div>
            <div class="probe-actions">
                <button type="button" class="btn btn-sm ${open ? 'btn-active' : ''}" data-probe-history>
                    <i class="ti ti-timeline"></i> ${esc(open ? t('historyClose', 'Hide') : t('historyOpen', 'History'))}
                </button>
                <button type="button" class="btn btn-sm" data-probe-reissue>
                    <i class="ti ti-refresh"></i> ${esc(t('reinstall', 'Reinstall'))}
                </button>
                <button type="button" class="btn btn-sm btn-danger" data-probe-delete>
                    <i class="ti ti-trash"></i> ${esc(t('remove', 'Delete'))}
                </button>
            </div>`;
    }

    // ── History ──────────────────────────────────────────────────────────────
    //
    // Windows arrive already laid out on a fixed time grid, so a segment always
    // covers the same amount of time and a silent probe leaves a visible gap.
    // Everything the probe measured is reachable: the strip carries the verdict,
    // clicking a segment opens the full window.

    const expanded = new Set();
    const historyRange = new Map();
    const historyData = new Map();
    const historyLoadedAt = new Map();
    const selectedPoint = new Map();
    const nodeOpen = new Map();

    const RANGES = [
        { hours: 6, key: 'range6h' },
        { hours: 24, key: 'range24h' },
        { hours: 168, key: 'range7d' },
        { hours: 720, key: 'range30d' },
    ];

    const LEGEND = [
        { cls: 'probe-seg-ok', key: 'legendOk' },
        { cls: 'probe-seg-warn', key: 'legendWarn' },
        { cls: 'probe-seg-fail', key: 'legendFail' },
        { cls: 'probe-seg-block', key: 'legendBlocked' },
        { cls: 'probe-seg-core', key: 'legendCore' },
        { cls: 'probe-seg-none', key: 'legendNone' },
    ];

    const CODE_FIELDS = [
        { field: 'netUnreachable', code: 'net_unreachable' },
        { field: 'handshakeFailed', code: 'handshake_failed' },
        { field: 'authRejected', code: 'auth_rejected' },
        { field: 'tunnelNoData', code: 'tunnel_no_data' },
        { field: 'degraded', code: 'degraded' },
        { field: 'coreDown', code: 'core_down' },
    ];

    function rangeOf(probeId) {
        return historyRange.get(String(probeId)) || 24;
    }

    function seriesKey(nodeId, kind, id) {
        return `${kind}:${nodeId}:${id}`;
    }

    function selectionOf(probeId) {
        return selectedPoint.get(String(probeId)) || null;
    }

    function isNodeOpen(probeId, node) {
        const key = `${probeId}|${node.nodeId}`;
        if (nodeOpen.has(key)) return nodeOpen.get(key);
        // Healthy nodes start collapsed: the header already carries their
        // uptime, and a fleet of twenty would otherwise bury the broken one.
        return node.failures > 0 || !!node.worstCode;
    }

    function renderHistoryShell(probe) {
        const id = String(probe._id);
        const hours = rangeOf(id);
        const tabs = RANGES.map((r) => `
            <button type="button" class="probe-range ${r.hours === hours ? 'is-active' : ''}"
                    data-probe-range="${r.hours}">${esc(t(r.key, r.hours + 'h'))}</button>`).join('');

        return `
            <div class="probe-history" data-history-for="${esc(id)}">
                <div class="probe-history-head">
                    <div>
                        <strong>${esc(t('history', 'Check history'))}</strong>
                        <small class="hint" style="display:block;">${esc(t('historyHint', ''))}</small>
                    </div>
                    <div class="probe-ranges">${tabs}</div>
                </div>
                <div class="probe-history-body">${renderHistoryBody(probe)}</div>
            </div>`;
    }

    function renderHistoryBody(probe) {
        const id = String(probe._id);
        if (!probe.enrolledAt) {
            return `<div class="probe-empty">${esc(t('historyPending', ''))}</div>`;
        }

        const data = historyData.get(id);
        if (!data) {
            return '<div class="skeleton-row"></div><div class="skeleton-row"></div>';
        }
        if (!data.nodes || data.nodes.length === 0) {
            return `<div class="probe-empty">${esc(t('historyEmpty', ''))}</div>`;
        }

        return [
            renderHistoryMeta(data),
            renderSummary(data),
            renderCodes(data.summary),
            data.nodes.map((node) => renderHistoryNode(id, node, data)).join(''),
            renderSpeed(data),
        ].join('');
    }

    function renderHistoryMeta(data) {
        const granularity = data.bucket === 'hourly'
            ? t('granularityHourly', 'hourly rollups')
            : t('granularityRaw', 'reported windows').replace('{step}', Math.round(data.stepMs / 60000));

        return `
            <div class="probe-history-meta">
                <span class="probe-chip"><i class="ti ti-ruler-measure"></i> ${esc(granularity)}</span>
                <span class="probe-chip"><i class="ti ti-clock"></i> ${esc(fmtClock(data.since))} — ${esc(fmtClock(data.until))}</span>
                ${data.truncated ? `<span class="probe-chip probe-chip-warn"><i class="ti ti-alert-triangle"></i> ${esc(t('truncated', ''))}</span>` : ''}
                <span class="probe-legend">
                    ${LEGEND.map((item) => `
                        <span class="probe-legend-item">
                            <i class="probe-legend-dot ${item.cls}"></i>${esc(t(item.key, item.key))}
                        </span>`).join('')}
                </span>
            </div>`;
    }

    function kpi(icon, label, value, sub) {
        return `
            <div class="probe-kpi">
                <div class="probe-kpi-label"><i class="ti ti-${icon}"></i> ${esc(label)}</div>
                <div class="probe-kpi-value">${esc(value)}</div>
                ${sub ? `<div class="probe-kpi-sub">${esc(sub)}</div>` : ''}
            </div>`;
    }

    function renderSummary(data) {
        const s = data.summary;
        const cards = [
            kpi('circle-check', t('kpiUptime', 'Successful checks'), fmtPct(s.uptimePct),
                `${fmtCount(s.ok)} / ${fmtCount(s.attempts)}`),
            kpi('activity', t('kpiLatency', 'Latency'),
                `${s.latencyP50 || '—'} / ${s.latencyP95 || '—'} ms`, 'p50 / p95'),
        ];

        if (s.handshakeMs || s.ttfbMs) {
            cards.push(kpi('plug-connected', t('kpiHandshake', 'Handshake / TTFB'),
                `${s.handshakeMs || '—'} / ${s.ttfbMs || '—'} ms`,
                t('kpiHandshakeSub', 'tunnel setup / first byte')));
        }
        if (s.speedSamples > 0) {
            cards.push(kpi('gauge', t('kpiSpeed', 'Speed'), fmtBps(s.speedBps, s.speedCapped),
                `${t('kpiSpeedSub', 'median of')} ${fmtCount(s.speedSamples)} ${t('samples', 'samples')}`));
        }
        cards.push(kpi('server', t('kpiNodes', 'Nodes with problems'),
            `${fmtCount(s.nodesFailing)} / ${fmtCount(s.nodesTotal)}`,
            s.failures ? `${fmtCount(s.failures)} ${t('failedChecks', 'failed checks')}` : t('allHealthy', 'all healthy')));

        if (s.targetsTotal > 0) {
            cards.push(kpi('world-search', t('kpiTargets', 'Blocked resources'),
                `${fmtCount(s.targetsBlocked)} / ${fmtCount(s.targetsTotal)}`,
                t('kpiTargetsSub', 'geo-block or blacklisted exit')));
        }
        if (s.gapMs > 0) {
            cards.push(kpi('clock-off', t('kpiGap', 'No data'), fmtDuration(s.gapMs),
                t('kpiGapSub', 'probe reported nothing')));
        }

        return `<div class="probe-kpis">${cards.join('')}</div>`;
    }

    function renderCodes(summary) {
        const rows = CODE_FIELDS
            .map((item) => ({ ...item, count: summary.codes[item.field] || 0 }))
            .filter((item) => item.count > 0)
            .sort((a, b) => b.count - a.count);

        if (rows.length === 0) {
            return `<div class="probe-codes probe-codes-clean">
                <i class="ti ti-shield-check"></i> ${esc(t('noFailures', 'No failures in this period.'))}
            </div>`;
        }

        const total = rows.reduce((sum, row) => sum + row.count, 0);
        const bar = rows.map((row) => `
            <span class="probe-codes-seg probe-code-${row.field}"
                  style="width:${((row.count / total) * 100).toFixed(2)}%"
                  title="${esc(codeLabel(row.code))}: ${esc(fmtCount(row.count))}"></span>`).join('');

        const chips = rows.map((row) => `
            <span class="probe-code-chip">
                <i class="probe-legend-dot probe-code-${row.field}"></i>
                ${esc(codeLabel(row.code))}
                <b>${esc(fmtCount(row.count))}</b>
                <small>${((row.count / total) * 100).toFixed(0)}%</small>
            </span>`).join('');

        return `
            <div class="probe-codes">
                <div class="probe-history-sub">${esc(t('codesTitle', 'Failure breakdown'))}</div>
                <div class="probe-codes-bar">${bar}</div>
                <div class="probe-code-chips">${chips}</div>
            </div>`;
    }

    // ── Series rendering ─────────────────────────────────────────────────────

    function segmentClass(point) {
        if (!point || !point.attempts) return 'probe-seg-none';
        if (point.blocked > 0) return 'probe-seg-block';
        if (point.ok >= point.attempts) {
            return point.code === 'degraded' ? 'probe-seg-warn' : 'probe-seg-ok';
        }
        if (point.code === 'core_down') return 'probe-seg-core';
        if (point.ok > 0) return 'probe-seg-warn';
        return 'probe-seg-fail';
    }

    function transportVerdict(point) {
        if (!point || !point.attempts) return t('noData', 'no data');
        if (point.ok >= point.attempts && !point.code) return t('ok', 'ok');
        // A window can fail without the probe naming a cause. Falling through
        // to the empty-code label would read as "working" on a red segment.
        if (!point.code) return t('legendFail', 'down');
        return codeLabel(point.code);
    }

    function targetVerdict(point) {
        if (!point || !point.attempts) return t('noData', 'no data');
        if (point.blocked > 0) return t('target_blocked', 'blocked');
        if (point.ok >= point.attempts) return t('ok', 'ok');
        return point.httpStatus ? 'HTTP ' + point.httpStatus : t('target_failed', 'failed');
    }

    function renderStrip(key, points, verdict, selected) {
        return `
            <div class="probe-strip" data-strip="${esc(key)}">
                ${points.map((point, index) => {
                    const label = point
                        ? `${fmtClock(point.ts)} · ${verdict(point)} · ${point.ok}/${point.attempts}`
                        : t('noData', 'no data');
                    const active = selected === index ? ' is-selected' : '';
                    return `<span class="probe-seg ${segmentClass(point)}${active}"
                                  data-seg="${index}" title="${esc(label)}"></span>`;
                }).join('')}
            </div>`;
    }

    // Latency over the same grid as the strip. Runs of measured windows become
    // polylines; a lone measurement between gaps is drawn as a short dash so it
    // does not disappear.
    function renderSparkline(points) {
        const values = points.map((point) => (point && point.latencyP50 ? point.latencyP50 : null));
        const measured = values.filter((v) => v !== null);
        if (measured.length === 0) return '';

        const max = Math.max(...measured);
        if (!max) return '';

        const y = (value) => (100 - (value / max) * 84 - 8).toFixed(2);
        const lines = [];
        let run = [];

        const flush = () => {
            if (run.length === 1) {
                const { index, value } = run[0];
                lines.push(`${(index + 0.2).toFixed(2)},${y(value)} ${(index + 0.8).toFixed(2)},${y(value)}`);
            } else if (run.length > 1) {
                lines.push(run.map((p) => `${(p.index + 0.5).toFixed(2)},${y(p.value)}`).join(' '));
            }
            run = [];
        };

        values.forEach((value, index) => {
            if (value === null) return flush();
            run.push({ index, value });
        });
        flush();

        return `
            <svg class="probe-spark" viewBox="0 0 ${values.length} 100" preserveAspectRatio="none" aria-hidden="true">
                ${lines.map((pts) => `<polyline points="${pts}" vector-effect="non-scaling-stroke" />`).join('')}
            </svg>`;
    }

    function inboundName(inbound) {
        if (inbound.label) return inbound.label;
        if (inbound.inboundId === 'group') return t('inboundGroup', 'Balancer group');
        if (inbound.inboundId === 'main') return t('inboundMain', 'Primary inbound');
        if (inbound.inboundId.indexOf('hysteria') === 0) return 'Hysteria';
        return inbound.inboundTag || inbound.inboundId;
    }

    function inboundSubtitle(inbound) {
        const bits = [];
        if (inbound.protocol) bits.push(inbound.protocol.toUpperCase());
        if (inbound.security && inbound.security !== 'none') bits.push(inbound.security);
        if (inbound.transport) bits.push(inbound.transport);
        if (inbound.port) bits.push(':' + inbound.port);
        else if (inbound.portRange) bits.push(':' + inbound.portRange);
        if (inbound.inboundTag && inbound.label) bits.push(inbound.inboundTag);
        return bits.join(' · ');
    }

    function fact(label, value) {
        return value ? `<span><em>${esc(label)}</em> ${esc(value)}</span>` : '';
    }

    function renderHistoryNode(probeId, node, data) {
        const open = isNodeOpen(probeId, node);
        // Colour by the number itself: any failure used to paint even 99% red.
        const health = node.uptimePct === null ? ''
            : node.uptimePct >= 90 ? 'is-ok'
            : node.uptimePct >= 70 ? 'is-warn'
            : 'is-bad';

        const inbounds = node.inbounds.map((inbound) => {
            const key = seriesKey(node.nodeId, 'in', inbound.inboundId);
            const selection = selectionOf(probeId);
            const selected = selection && selection.key === key ? selection.index : -1;
            const subtitle = inboundSubtitle(inbound);

            return `
                <div class="probe-series" data-series="${esc(key)}">
                    <div class="probe-series-head">
                        <span class="probe-series-name">
                            ${esc(inboundName(inbound))}
                            ${subtitle ? `<small>${esc(subtitle)}</small>` : ''}
                        </span>
                        <span class="probe-series-facts">
                            ${fact(t('uptime', 'ok'), fmtPct(inbound.uptimePct))}
                            ${fact('p50', fmtMs(inbound.latencyP50))}
                            ${fact('p95', fmtMs(inbound.latencyP95))}
                            ${fact(t('handshakeShort', 'hs'), fmtMs(inbound.handshakeMs))}
                            ${inbound.speedSamples ? fact(t('speedShort', 'speed'), fmtBps(inbound.speedBps, inbound.speedCapped)) : ''}
                            ${fact(t('exitIp', 'exit'), inbound.exitIp)}
                        </span>
                    </div>
                    ${renderStrip(key, inbound.points, transportVerdict, selected)}
                    ${renderSparkline(inbound.points)}
                    ${selected >= 0 ? renderTransportWindow(inbound.points[selected], data) : ''}
                </div>`;
        }).join('');

        const targets = node.targets.map((target) => {
            const key = seriesKey(node.nodeId, 'tg', target.targetId);
            const selection = selectionOf(probeId);
            const selected = selection && selection.key === key ? selection.index : -1;

            return `
                <div class="probe-series" data-series="${esc(key)}">
                    <div class="probe-series-head">
                        <span class="probe-series-name">
                            ${esc(target.label || target.targetId)}
                            ${target.url ? `<small>${esc(target.url)}</small>` : ''}
                        </span>
                        <span class="probe-series-facts">
                            ${fact(t('uptime', 'ok'), fmtPct(target.uptimePct))}
                            ${target.blocked ? fact(t('blockedShort', 'blocked'), fmtCount(target.blocked)) : ''}
                            ${fact(t('latencyShort', 'time'), fmtMs(target.latencyMs))}
                            ${target.httpStatus ? fact('HTTP', String(target.httpStatus)) : ''}
                        </span>
                    </div>
                    ${renderStrip(key, target.points, targetVerdict, selected)}
                    ${target.lastError ? `<div class="probe-series-error"><i class="ti ti-alert-circle"></i> ${esc(target.lastError)}</div>` : ''}
                    ${selected >= 0 ? renderTargetWindow(target.points[selected], data) : ''}
                </div>`;
        }).join('');

        return `
            <div class="probe-history-node ${open ? 'is-open' : ''}" data-node="${esc(node.nodeId)}">
                <button type="button" class="probe-history-node-name" data-node-toggle>
                    <i class="ti ti-chevron-${open ? 'down' : 'right'}"></i>
                    <span class="probe-node-title">${esc(node.flag ? node.flag + ' ' : '')}${esc(node.nodeName)}</span>
                    <span class="probe-node-health ${health}">${esc(fmtPct(node.uptimePct))}</span>
                    ${node.worstCode ? `<span class="probe-code-badge">${esc(codeLabel(node.worstCode))}</span>` : ''}
                    ${node.exitIp ? `<span class="probe-node-exit">${esc(node.exitIp)}</span>` : ''}
                </button>
                ${open ? `
                    <div class="probe-history-node-body">
                        ${inbounds}
                        ${targets ? `<div class="probe-history-sub">${esc(t('resources', 'Resources'))}</div>${targets}` : ''}
                    </div>` : ''}
            </div>`;
    }

    // ── Window detail ────────────────────────────────────────────────────────

    function windowHead(point, data, verdict) {
        const from = new Date(point.ts).getTime();
        const to = from + (data.stepMs || 0);
        return `
            <div class="probe-window-head">
                <strong>${esc(fmtTime(from))} — ${esc(fmtClock(to))}</strong>
                <span class="probe-window-verdict">${esc(verdict)}</span>
                <button type="button" class="probe-window-close" data-window-close aria-label="close">&times;</button>
            </div>`;
    }

    function windowCell(label, value) {
        if (!value && value !== 0) return '';
        return `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    }

    function renderTransportWindow(point, data) {
        if (!point) return '';

        const codes = CODE_FIELDS
            .map((item) => ({ ...item, count: point.codes?.[item.field] || 0 }))
            .filter((item) => item.count > 0);

        return `
            <div class="probe-window">
                ${windowHead(point, data, transportVerdict(point))}
                <div class="probe-window-grid">
                    ${windowCell(t('winAttempts', 'Attempts'), fmtCount(point.attempts))}
                    ${windowCell(t('winOk', 'Successful'), fmtCount(point.ok))}
                    ${windowCell(t('winLatency', 'Latency p50 / p95'), `${point.latencyP50 || '—'} / ${point.latencyP95 || '—'} ms`)}
                    ${windowCell(t('winHandshake', 'Handshake'), fmtMs(point.handshakeMs))}
                    ${windowCell(t('winTtfb', 'Time to first byte'), fmtMs(point.ttfbMs))}
                    ${point.speedSamples ? windowCell(t('winSpeed', 'Speed'), fmtBps(point.speedBps, point.speedCapped)) : ''}
                    ${windowCell(t('winExitIp', 'Exit address'), point.exitIp)}
                    ${windowCell(t('winSelected', 'Balancer picked'), point.selectedNodeName)}
                </div>
                ${codes.length ? `
                    <div class="probe-code-chips">
                        ${codes.map((item) => `
                            <span class="probe-code-chip">
                                <i class="probe-legend-dot probe-code-${item.field}"></i>
                                ${esc(codeLabel(item.code))}<b>${esc(fmtCount(item.count))}</b>
                            </span>`).join('')}
                    </div>` : ''}
            </div>`;
    }

    function renderTargetWindow(point, data) {
        if (!point) return '';

        return `
            <div class="probe-window">
                ${windowHead(point, data, targetVerdict(point))}
                <div class="probe-window-grid">
                    ${windowCell(t('winAttempts', 'Attempts'), fmtCount(point.attempts))}
                    ${windowCell(t('winOk', 'Successful'), fmtCount(point.ok))}
                    ${point.blocked ? windowCell(t('winBlocked', 'Blocked'), fmtCount(point.blocked)) : ''}
                    ${windowCell(t('winHttpStatus', 'HTTP status'), point.httpStatus || '')}
                    ${windowCell(t('winLatency2', 'Response time'), fmtMs(point.latencyMs))}
                </div>
                ${point.lastError ? `<div class="probe-series-error"><i class="ti ti-alert-circle"></i> ${esc(point.lastError)}</div>` : ''}
            </div>`;
    }

    // ── Speed ────────────────────────────────────────────────────────────────
    //
    // Throughput is sampled round-robin inside a daily budget, so measurements
    // are sparse and irregular. A grid strip would be almost entirely empty;
    // dots placed at the time they were actually taken tell the truth.

    function renderSpeed(data) {
        const title = `<div class="probe-history-sub">${esc(t('speedTitle', 'Speed measurements'))}</div>`;

        if (!data.speedTestEnabled) {
            return `${title}<div class="probe-speed-off">
                <i class="ti ti-gauge"></i> ${esc(t('speedDisabled', 'Speed measurement is off.'))}
                <a href="/panel/settings?tab=probes">${esc(t('openSettings', 'Settings'))}</a>
            </div>`;
        }
        if (!data.speed || data.speed.length === 0) {
            return `${title}<div class="probe-speed-off">
                <i class="ti ti-gauge"></i> ${esc(t('speedEmpty', 'No measurements in this period.'))}
            </div>`;
        }

        const from = new Date(data.since).getTime();
        const to = new Date(data.until).getTime();
        const span = Math.max(to - from, 1);
        const peak = Math.max(...data.speed.map((s) => s.maxBps)) || 1;

        const rows = data.speed.map((series) => {
            const dots = series.points.map((point) => {
                const at = new Date(point.ts).getTime();
                const left = Math.min(100, Math.max(0, ((at - from) / span) * 100));
                const bottom = 6 + (point.speedBps / peak) * 82;
                return `<span class="probe-speed-dot"
                              style="left:${left.toFixed(2)}%;bottom:${bottom.toFixed(2)}%"
                              title="${esc(fmtClock(point.ts))} · ${esc(fmtBps(point.speedBps, point.capped))}"></span>`;
            }).join('');

            const name = [series.nodeName, series.label || (series.protocol || '').toUpperCase()]
                .filter(Boolean).join(' · ');

            return `
                <div class="probe-speed-row">
                    <div class="probe-series-head">
                        <span class="probe-series-name">${esc(name)}</span>
                        <span class="probe-series-facts">
                            ${fact(t('speedMedian', 'median'), fmtBps(series.medianBps, series.capped))}
                            ${fact(t('speedMax', 'max'), fmtBps(series.maxBps, series.capped))}
                            ${fact(t('samples', 'samples'), fmtCount(series.samples))}
                            ${fact(t('speedLast', 'last'), fmtAgo(series.lastAt))}
                        </span>
                    </div>
                    <div class="probe-speed-track">${dots}</div>
                </div>`;
        }).join('');

        return `${title}<div class="probe-speed">${rows}</div>`;
    }

    // ── Data loading ─────────────────────────────────────────────────────────

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
        historyLoadedAt.set(id, Date.now());
        paintHistory(id);
    }

    function paintHistory(probeId) {
        const id = String(probeId);
        const probe = probesById.get(id);
        const panel = document.querySelector(`[data-history-for="${id}"] .probe-history-body`);
        if (!probe || !panel) return;
        panel.innerHTML = renderHistoryBody(probe);
    }

    // The list is redrawn every 30 seconds. Rebuilding the whole page would
    // close an open history panel mid-read, so rows are patched in place and
    // the panels below them are left alone.
    let probesById = new Map();

    function itemOf(list, probe) {
        const id = String(probe._id);
        let item = list.querySelector(`.probe-item[data-id="${id}"]`);
        if (!item) {
            item = document.createElement('div');
            item.className = 'probe-item';
            item.dataset.id = id;
            item.innerHTML = `<div class="probe-row" data-id="${esc(id)}"></div>`;
        }
        return item;
    }

    function syncList(probes) {
        const list = $('probesList');
        if (!list) return;

        if (!probes || probes.length === 0) {
            probesById = new Map();
            list.innerHTML = `<div class="probe-empty">${esc(t('empty', 'No probes yet.'))}</div>`;
            return;
        }

        probesById = new Map(probes.map((p) => [String(p._id), p]));
        list.querySelectorAll('.probe-empty, .skeleton-row').forEach((el) => el.remove());

        const seen = new Set();
        probes.forEach((probe, index) => {
            const id = String(probe._id);
            seen.add(id);

            const item = itemOf(list, probe);
            item.querySelector('.probe-row').innerHTML = renderProbeRow(probe);

            const open = expanded.has(id);
            const panel = item.querySelector('.probe-history');
            if (open && !panel) {
                item.insertAdjacentHTML('beforeend', renderHistoryShell(probe));
            } else if (!open && panel) {
                panel.remove();
            }

            // Reposition only when the order actually changed: moving a node
            // that holds an open history panel is cheap, but doing it on every
            // poll would be pointless churn.
            if (list.children[index] !== item) {
                list.insertBefore(item, list.children[index] || null);
            }
        });

        for (const item of [...list.querySelectorAll('.probe-item')]) {
            if (!seen.has(item.dataset.id)) item.remove();
        }
    }

    /**
     * Open or close a history panel without waiting for the list request: the
     * panel is built from the probe already in hand, so the click responds
     * immediately and the fetch only fills the body in.
     */
    function setExpanded(id, open) {
        const probe = probesById.get(id);
        const item = document.querySelector(`.probe-item[data-id="${id}"]`);
        if (!probe || !item) return;

        if (open) expanded.add(id);
        else expanded.delete(id);

        item.querySelector('.probe-row').innerHTML = renderProbeRow(probe);

        const panel = item.querySelector('.probe-history');
        if (open && !panel) {
            item.insertAdjacentHTML('beforeend', renderHistoryShell(probe));
        } else if (!open && panel) {
            panel.remove();
        }
    }

    async function loadProbes() {
        try {
            const res = await fetch('/panel/probes/api/list', { credentials: 'include' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'failed to load probes');

            syncList(data.probes);
        } catch (err) {
            toast(String(err.message || err), 'error');
        }
    }

    function refreshStaleHistories() {
        for (const id of expanded) {
            // Never redraw under an open window card: the operator is reading it.
            if (selectedPoint.has(id)) continue;
            const at = historyLoadedAt.get(id) || 0;
            if (Date.now() - at < HISTORY_REFRESH_MS) continue;
            loadHistory(id);
        }
    }

    // ── Install command ──────────────────────────────────────────────────────
    //
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
        const name = window.prompt(t('namePrompt', 'Probe name'));
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
        if (!window.confirm(t('confirmRemove', 'Delete this probe?'))) return;

        try {
            const res = await fetch(`/panel/probes/api/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'failed');
            expanded.delete(String(id));
            historyData.delete(String(id));
            selectedPoint.delete(String(id));
            loadProbes();
        } catch (err) {
            toast(String(err.message || err), 'error');
        }
    }

    // ── Events ───────────────────────────────────────────────────────────────

    function probeIdOf(element) {
        const item = element.closest('.probe-item');
        return item ? item.dataset.id : null;
    }

    document.addEventListener('click', (event) => {
        const createBtn = event.target.closest('#probeCreateBtn');
        if (createBtn) return createProbe();

        const copyBtn = event.target.closest('#probeCopyCommand');
        if (copyBtn) {
            const text = $('probeInstallCommand');
            if (text && navigator.clipboard) {
                navigator.clipboard.writeText(text.textContent || '')
                    .then(() => toast(t('copied', 'Copied')));
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
            selectedPoint.delete(id);
            panel.querySelectorAll('[data-probe-range]').forEach((tab) => {
                tab.classList.toggle('is-active', tab === rangeBtn);
            });
            paintHistory(id);
            return loadHistory(id);
        }

        if (event.target.closest('[data-window-close]')) {
            const id = probeIdOf(event.target);
            if (!id) return;
            selectedPoint.delete(id);
            return paintHistory(id);
        }

        const nodeToggle = event.target.closest('[data-node-toggle]');
        if (nodeToggle) {
            const id = probeIdOf(nodeToggle);
            const nodeEl = nodeToggle.closest('[data-node]');
            if (!id || !nodeEl) return;
            const key = `${id}|${nodeEl.dataset.node}`;
            nodeOpen.set(key, !nodeEl.classList.contains('is-open'));
            return paintHistory(id);
        }

        const segment = event.target.closest('.probe-seg');
        if (segment) {
            const id = probeIdOf(segment);
            const strip = segment.closest('[data-strip]');
            if (!id || !strip) return;

            const index = Number(segment.dataset.seg);
            const key = strip.dataset.strip;
            const current = selectionOf(id);
            if (current && current.key === key && current.index === index) {
                selectedPoint.delete(id);
            } else {
                selectedPoint.set(id, { key, index });
            }
            return paintHistory(id);
        }

        const row = event.target.closest('.probe-row');
        if (!row) return;

        if (event.target.closest('[data-probe-history]')) {
            const id = row.dataset.id;
            if (expanded.has(id)) {
                historyData.delete(id);
                selectedPoint.delete(id);
                return setExpanded(id, false);
            }
            setExpanded(id, true);
            return loadHistory(id);
        }

        if (event.target.closest('[data-probe-reissue]')) return reissue(row.dataset.id);
        if (event.target.closest('[data-probe-delete]')) return removeProbe(row.dataset.id);
    });

    // Polling pauses while the tab is hidden: a background tab kept hitting the
    // panel every 30 s for a list nobody is looking at.
    let timer = null;

    function tick() {
        loadProbes();
        refreshStaleHistories();
    }

    function startPolling() {
        if (timer) return;
        timer = setInterval(tick, POLL_MS);
    }

    function stopPolling() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return stopPolling();
        tick();
        startPolling();
    });

    loadProbes();
    startPolling();
})();
