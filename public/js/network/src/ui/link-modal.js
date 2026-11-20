/**
 * Full cascade link editor (#addLinkModal) and the reconnect dialog (#reconnectModal).
 * Markup lives in views/nodes.ejs; this module only wires behaviour.
 * Node lists come from the already loaded topology, so opening is instant.
 */

import { api, isObjectId } from '../core/api.js';
import { t } from '../core/i18n.js';
import { h, icon, toast } from './dom.js';
import { nodeTitle } from './format.js';
import { suggestPort } from './create-form.js';

const $ = id => document.getElementById(id);

function splitList(value) {
    const str = String(value || '').trim();
    return str ? str.split(/[,\s]+/).filter(Boolean).slice(0, 200) : [];
}

function intOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

export function createLinkModal({ store, onSaved }) {
    const modal = $('addLinkModal');
    const form = $('addLinkForm');
    if (!modal || !form) return { openCreate() {}, openEdit() {}, close() {}, isOpen: () => false };

    const portalSel = $('selectPortal');
    const bridgeSel = $('selectBridge');
    const title = $('linkModalTitle');
    const submit = $('linkModalSubmit');
    const linkIdInput = $('linkIdInput');
    const modeInput = $('linkModeInput');
    let editingId = '';
    let submitting = false;

    // ==================== UI STATE ====================

    function fillNodeOptions(select, placeholder, selected) {
        const nodes = Array.from(store.index.nodes.values())
            .filter(n => n.type !== 'cdn')
            .sort((a, b) => String(a.label).localeCompare(String(b.label)));
        select.replaceChildren(
            h('option', { value: '' }, placeholder),
            ...nodes.map(n => h('option', { value: n.id, selected: n.id === selected }, `${nodeTitle(n)}${n.ip ? ` (${n.ip})` : ''}`)));
    }

    function setMode(mode) {
        const m = mode === 'forward' ? 'forward' : 'reverse';
        modeInput.value = m;
        const switcher = $('modeSwitcher');
        if (switcher) switcher.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
        const hint = $('modeHint');
        if (hint) hint.textContent = m === 'forward' ? t('modeForwardHint') : t('modeReverseHint');
        applyProtocolUi(m);
        updateWarnings();
    }

    function applyTransportUi() {
        const transport = form.tunnelTransport.value;
        const kcp = $('kcpSection');
        if (kcp) kcp.style.display = transport === 'kcp' ? '' : 'none';
        const sec = form.tunnelSecurity;
        const reality = sec.querySelector('option[value="reality"]');
        if (!reality) return;
        reality.disabled = transport === 'ws' || transport === 'kcp';
        if (reality.disabled && sec.value === 'reality') sec.value = 'none';
        applySecurityUi();
    }

    function applySecurityUi() {
        const rs = $('realitySection');
        if (rs) rs.style.display = form.tunnelSecurity.value === 'reality' ? '' : 'none';
    }

    /** VLESS Reverse Proxy has no VMess counterpart. */
    function applyProtocolUi(mode) {
        const vmess = form.tunnelProtocol.querySelector('option[value="vmess"]');
        if (!vmess) return;
        vmess.disabled = mode !== 'forward';
        if (vmess.disabled && form.tunnelProtocol.value === 'vmess') form.tunnelProtocol.value = 'vless';
    }

    function applyGeoUi() {
        const fields = $('geoRoutingFields');
        if (fields) fields.style.display = $('geoRoutingEnabled').checked ? '' : 'none';
    }

    function setRouteIdHint(routeId) {
        const hint = $('linkRouteIdHint');
        if (!hint) return;
        const has = routeId !== null && routeId !== undefined;
        hint.style.display = has ? '' : 'none';
        hint.textContent = has ? t('subscriptionRouteId').replace('{id}', String(routeId)) : '';
    }

    function updateWarnings() {
        const isForward = modeInput.value === 'forward';
        const section = $('linkSubscriptionSection');
        const fwdHint = $('linkSubscriptionForwardHint');
        if (section) section.style.display = isForward ? 'none' : '';
        if (fwdHint) fwdHint.style.display = isForward ? '' : 'none';

        const flow = $('modeFlowHint');
        if (flow) flow.textContent = isForward ? t('modeForwardFlow') : t('modeReverseFlow');
        const warn = $('modeWarnHint');
        if (warn) warn.textContent = isForward ? t('modeForwardWarning') : t('modeReverseWarning');
        const portHint = $('tunnelPortHint');
        if (portHint) portHint.textContent = isForward ? t('tunnelPortForwardHint') : t('tunnelPortReverseHint');

        const conflictEl = $('portConflictHint');
        if (!conflictEl) return;
        conflictEl.style.display = 'none';
        conflictEl.textContent = '';
        const listenId = isForward ? bridgeSel.value : portalSel.value;
        const port = intOr(form.tunnelPort.value, 10086);
        if (!listenId) return;
        const conflict = Array.from(store.index.links.values()).find(l => {
            if (editingId && l.id === `link-${editingId}`) return false;
            const side = isForward ? l.target : l.source;
            return side === listenId && Number(l.tunnelPort) === port;
        });
        if (conflict) {
            conflictEl.style.display = '';
            conflictEl.textContent = `${t('portConflictClientHint')} (${conflict.label || 'link'})`;
        }
    }

    function setSubmitLabel(busy) {
        submit.disabled = !!busy;
        if (busy) submit.replaceChildren(icon('loader-2', 'nm-spin'));
        else if (editingId) submit.replaceChildren(t('save'));
        else submit.replaceChildren(icon('plus'), ` ${t('createLink')}`);
    }

    function reset() {
        form.reset();
        editingId = '';
        linkIdInput.value = '';
        title.textContent = t('addLink');
        setRouteIdHint(null);
        $('geoRoutingEnabled').checked = false;
        $('geoRoutingDomains').value = '';
        $('geoRoutingGeoip').value = '';
        applyGeoUi();
        setMode('reverse');
        applyTransportUi();
        setSubmitLabel(false);
    }

    function show() {
        modal.classList.add('active');
        const first = form.querySelector('input[name="name"]');
        if (first) setTimeout(() => first.focus(), 30);
    }

    function close() {
        modal.classList.remove('active');
        reset();
    }

    // ==================== OPEN ====================

    function openCreate(prefill = {}) {
        reset();
        fillNodeOptions(portalSel, t('selectPortal'), prefill.portalNodeId || '');
        fillNodeOptions(bridgeSel, t('selectBridge'), prefill.bridgeNodeId || '');
        if (prefill.name) form.name.value = prefill.name;
        setMode(prefill.mode || 'reverse');
        const listenId = (prefill.mode === 'forward' ? prefill.bridgeNodeId : prefill.portalNodeId) || '';
        form.tunnelPort.value = String(prefill.tunnelPort || (listenId ? suggestPort(store.index, listenId) : 10086));
        if (prefill.tunnelProtocol) form.tunnelProtocol.value = prefill.tunnelProtocol;
        if (prefill.tunnelTransport) form.tunnelTransport.value = prefill.tunnelTransport;
        applyProtocolUi(modeInput.value);
        applyTransportUi();
        updateWarnings();
        show();
    }

    async function openEdit(linkId) {
        if (!isObjectId(linkId)) return;
        let link;
        try {
            link = await api.getLink(linkId);
        } catch (err) {
            toast(`${t('networkError')}: ${err.message}`, 'error');
            return;
        }
        reset();
        editingId = linkId;
        linkIdInput.value = linkId;
        title.textContent = t('map.editLink');
        setSubmitLabel(false);

        const portalId = String((link.portalNode && link.portalNode._id) || link.portalNode || '');
        const bridgeId = String((link.bridgeNode && link.bridgeNode._id) || link.bridgeNode || '');
        fillNodeOptions(portalSel, t('selectPortal'), portalId);
        fillNodeOptions(bridgeSel, t('selectBridge'), bridgeId);

        form.name.value = link.name || '';
        form.tunnelPort.value = String(link.tunnelPort || 10086);
        form.tunnelTransport.value = link.tunnelTransport === 'splithttp' ? 'xhttp' : (link.tunnelTransport || 'tcp');
        form.tunnelSecurity.value = link.tunnelSecurity || 'none';
        form.muxEnabled.checked = !!link.muxEnabled;
        form.muxConcurrency.value = String(link.muxConcurrency || 8);
        form.priority.value = String(link.priority || 100);
        form.autoDeploy.checked = false;

        form.realityDest.value = link.realityDest || '';
        form.realitySni.value = Array.isArray(link.realitySni) ? link.realitySni.join(', ') : (link.realitySni || '');
        form.realityPrivateKey.value = link.realityPrivateKey || '';
        form.realityPublicKey.value = link.realityPublicKey || '';
        form.realityShortIds.value = Array.isArray(link.realityShortIds) ? link.realityShortIds.join(', ') : (link.realityShortIds || '');
        form.realityFingerprint.value = link.realityFingerprint || 'chrome';

        if (form.kcpMtu) form.kcpMtu.value = String(link.kcpMtu || 1350);
        if (form.kcpTti) form.kcpTti.value = String(link.kcpTti || 20);
        if (form.kcpUplinkCapacity) form.kcpUplinkCapacity.value = String(link.kcpUplinkCapacity || 100);
        if (form.kcpDownlinkCapacity) form.kcpDownlinkCapacity.value = String(link.kcpDownlinkCapacity || 100);
        if (form.kcpHeader) form.kcpHeader.value = link.kcpHeader || 'none';

        const geo = link.geoRouting || {};
        $('geoRoutingEnabled').checked = !!geo.enabled;
        $('geoRoutingDomains').value = Array.isArray(geo.domains) ? geo.domains.join(', ') : '';
        $('geoRoutingGeoip').value = Array.isArray(geo.geoip) ? geo.geoip.join(', ') : '';
        applyGeoUi();

        if (form.publishInSubscription) form.publishInSubscription.checked = link.publishInSubscription !== false;
        if (form.includeInBalancer) form.includeInBalancer.checked = link.includeInBalancer !== false;
        if (form.subscriptionLabel) form.subscriptionLabel.value = link.subscriptionLabel || '';
        setRouteIdHint(link.routeId);

        setMode(link.mode || 'reverse');
        form.tunnelProtocol.value = link.tunnelProtocol || 'vless';
        applyProtocolUi(modeInput.value);
        applyTransportUi();
        updateWarnings();
        show();
    }

    // ==================== SUBMIT ====================

    async function onSubmit(e) {
        e.preventDefault();
        if (submitting) return;
        const mode = modeInput.value === 'forward' ? 'forward' : 'reverse';
        const data = {
            name: form.name.value.trim().slice(0, 100),
            mode,
            portalNodeId: portalSel.value,
            bridgeNodeId: bridgeSel.value,
            tunnelPort: intOr(form.tunnelPort.value, 10086),
            tunnelProtocol: form.tunnelProtocol.value,
            tunnelTransport: form.tunnelTransport.value,
            tunnelSecurity: form.tunnelSecurity.value,
            autoDeploy: !!form.autoDeploy.checked,
            muxEnabled: !!form.muxEnabled.checked,
            muxConcurrency: intOr(form.muxConcurrency.value, 8),
            priority: intOr(form.priority.value, 100),
        };

        if (mode !== 'forward' && form.publishInSubscription) {
            data.publishInSubscription = !!form.publishInSubscription.checked;
            data.includeInBalancer = !!(form.includeInBalancer && form.includeInBalancer.checked);
            data.subscriptionLabel = (form.subscriptionLabel.value || '').trim().slice(0, 64);
        }
        if (data.tunnelSecurity === 'reality') {
            data.realityDest = form.realityDest.value.trim();
            data.realitySni = form.realitySni.value.trim();
            data.realityPrivateKey = form.realityPrivateKey.value.trim();
            data.realityPublicKey = form.realityPublicKey.value.trim();
            data.realityShortIds = form.realityShortIds.value.trim();
            data.realityFingerprint = form.realityFingerprint.value || 'chrome';
        }
        if (data.tunnelTransport === 'kcp') {
            data.kcpMtu = intOr(form.kcpMtu.value, 1350);
            data.kcpTti = intOr(form.kcpTti.value, 20);
            data.kcpUplinkCapacity = intOr(form.kcpUplinkCapacity.value, 100);
            data.kcpDownlinkCapacity = intOr(form.kcpDownlinkCapacity.value, 100);
            data.kcpHeader = form.kcpHeader.value || 'none';
        }
        data.geoRouting = {
            enabled: !!$('geoRoutingEnabled').checked,
            domains: splitList($('geoRoutingDomains').value),
            geoip: splitList($('geoRoutingGeoip').value),
        };

        if (!data.name || !isObjectId(data.portalNodeId) || !isObjectId(data.bridgeNodeId)) {
            toast(t('fillRequired'), 'error');
            return;
        }
        if (data.portalNodeId === data.bridgeNodeId) {
            toast(t('map.create.sameNode'), 'error');
            return;
        }
        if (data.tunnelPort < 1 || data.tunnelPort > 65535) {
            toast(t('map.create.badPort'), 'error');
            return;
        }

        submitting = true;
        setSubmitLabel(true);
        const wasEditing = editingId;
        try {
            const res = wasEditing ? await api.updateLink(wasEditing, data) : await api.createLink(data);
            const id = wasEditing || (res && res._id ? String(res._id) : '');
            toast(wasEditing ? t('map.toast.saved') : t('map.toast.created', { name: data.name }), 'success');
            close();
            if (onSaved) onSaved(isObjectId(id) ? `link-${id}` : null);
        } catch (err) {
            toast(`${t('networkError')}: ${err.message}`, 'error');
        } finally {
            submitting = false;
            setSubmitLabel(false);
        }
    }

    // ==================== BINDINGS ====================

    const switcher = $('modeSwitcher');
    if (switcher) {
        switcher.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
    }
    form.tunnelSecurity.addEventListener('change', () => { applySecurityUi(); updateWarnings(); });
    form.tunnelTransport.addEventListener('change', () => { applyTransportUi(); updateWarnings(); });
    portalSel.addEventListener('change', updateWarnings);
    bridgeSel.addEventListener('change', updateWarnings);
    form.tunnelPort.addEventListener('input', updateWarnings);
    $('geoRoutingEnabled').addEventListener('change', applyGeoUi);
    $('modalClose').addEventListener('click', close);
    $('modalCancel').addEventListener('click', close);
    form.addEventListener('submit', onSubmit);
    modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });

    return { openCreate, openEdit, close, isOpen: () => modal.classList.contains('active') };
}

export function createReconnectModal({ store, onSaved }) {
    const modal = $('reconnectModal');
    if (!modal) return { open() {}, close() {}, isOpen: () => false };
    const select = $('reconnectNodeSelect');
    const submit = $('reconnectModalSubmit');
    let current = null;

    function close() {
        modal.classList.remove('active');
        current = null;
    }

    function open(linkId, edgeId, side) {
        const link = store.index.links.get(edgeId);
        if (!link || !isObjectId(linkId)) return;
        current = { linkId, edgeId, side };
        $('reconnectLinkId').value = linkId;
        $('reconnectMode').value = side;
        $('reconnectModalTitle').textContent = `${t('reconnectModal')}: ${link.label || ''}`;
        $('reconnectNodeLabel').textContent = side === 'bridge' ? t('newBridgeNode') : t('newPortalNode');
        const exclude = new Set([link.source, link.target]);
        const nodes = Array.from(store.index.nodes.values())
            .filter(n => n.type !== 'cdn' && !exclude.has(n.id))
            .sort((a, b) => String(a.label).localeCompare(String(b.label)));
        select.replaceChildren(...nodes.map(n => h('option', { value: n.id }, `${nodeTitle(n)}${n.ip ? ` (${n.ip})` : ''}`)));
        submit.disabled = nodes.length === 0;
        modal.classList.add('active');
    }

    async function onSubmit() {
        if (!current || !isObjectId(select.value)) return;
        const { linkId, edgeId, side } = current;
        submit.disabled = true;
        const prev = store.setLinkStatus(edgeId, 'syncing');
        try {
            await api.reconnect(linkId, side, select.value);
            store.clearLinkStatus(edgeId, null);
            toast(t('reconnectSuccess'), 'success');
            close();
            if (onSaved) onSaved(edgeId);
        } catch (err) {
            store.clearLinkStatus(edgeId, prev);
            toast(`${t('reconnectFailed')}: ${err.message}`, 'error');
        } finally {
            submit.disabled = false;
        }
    }

    $('reconnectModalClose').addEventListener('click', close);
    $('reconnectModalCancel').addEventListener('click', close);
    submit.addEventListener('click', onSubmit);
    modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });

    return { open, close, isOpen: () => modal.classList.contains('active') };
}
