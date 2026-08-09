// External checks block on the node card.
//
// Results are grouped per probe on purpose: a verdict is only meaningful
// together with the vantage point it was measured from, and a single probe
// cannot distinguish a dead node from its own broken uplink.
(function () {
    'use strict';

    const card = document.getElementById('nodeProbesCard');
    if (!card) return;

    const nodeId = card.dataset.nodeId;
    const I18N = window.NODE_PROBES_I18N || {};
    const block = document.getElementById('nodeProbesBlock');

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function codeLabel(code) {
        if (!code) return I18N.ok || 'ok';
        return I18N[code] || code;
    }

    function renderInbound(inbound) {
        const failed = inbound.ok === 0 && inbound.attempts > 0;
        const code = failed ? (inbound.lastCode || 'tunnel_no_data') : inbound.lastCode;

        // A partially healthy window is neither green nor red: it carries a
        // code while still passing some attempts.
        let cls = 'probe-code-badge probe-code-ok';
        if (failed) cls = 'probe-code-badge';
        else if (code) cls = 'probe-code-badge probe-code-warn';
        const latency = inbound.latencyP50 ? ` · ${inbound.latencyP50} ms` : '';
        const speed = inbound.speedBps
            ? ` · ${(inbound.speedBps * 8 / 1e6).toFixed(1)} Mbit/s`
            : '';

        return `
            <div class="probe-check">
                <span>${esc(inbound.inboundTag || inbound.inboundId)}${esc(latency)}${esc(speed)}</span>
                <span class="${cls}">${esc(codeLabel(code))}</span>
            </div>`;
    }

    function renderTarget(target) {
        const blocked = target.blocked > 0;
        const cls = blocked ? 'probe-code-badge' : 'probe-code-badge probe-code-ok';
        const label = blocked
            ? `${I18N.target_blocked || 'blocked'}${target.httpStatus ? ' (' + target.httpStatus + ')' : ''}`
            : (I18N.ok || 'ok');

        return `
            <div class="probe-check">
                <span>${esc(target.targetId)}</span>
                <span class="${cls}">${esc(label)}</span>
            </div>`;
    }

    function renderProbe(probe) {
        const location = [probe.country, probe.asn].filter(Boolean).join(' · ');
        return `
            <div class="probe-node-probe">
                <div class="probe-node-head">
                    <i class="ti ti-radar"></i>
                    ${esc(probe.name)}
                    ${location ? `<span class="probe-meta">${esc(location)}</span>` : ''}
                </div>
                ${probe.sameHost ? `<div class="probe-warn"><i class="ti ti-alert-triangle"></i> ${esc(I18N.sameHost || '')}</div>` : ''}
                ${probe.inbounds.map(renderInbound).join('')}
                ${probe.targets.map(renderTarget).join('')}
            </div>`;
    }

    async function load() {
        try {
            const res = await fetch(`/panel/nodes/${encodeURIComponent(nodeId)}/probe-status`, {
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'probe status unavailable');

            if (!data.enabled || !data.probes || data.probes.length === 0) {
                block.innerHTML = `<div class="probe-empty">${esc(I18N.empty || 'No probe data yet.')}</div>`;
                return;
            }
            block.innerHTML = data.probes.map(renderProbe).join('');
        } catch (err) {
            block.innerHTML = `<div class="probe-empty">${esc(String(err.message || err))}</div>`;
        }
    }

    // Probes report every ~15 minutes, so a slow refresh is enough, and there
    // is no point refreshing at all while the tab is in the background.
    let timer = null;

    function start() {
        if (!timer) timer = setInterval(load, 60000);
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return stop();
        load();
        start();
    });

    load();
    start();
})();
