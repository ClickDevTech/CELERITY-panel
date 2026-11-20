/**
 * Quick "new link" form rendered inside the inspector.
 * Covers the common case (entry, exit, mode, port); everything else is
 * available through "Advanced settings", which opens the full link modal prefilled.
 */

import model from '../core/model.js';
import { api, isObjectId } from '../core/api.js';
import { t } from '../core/i18n.js';
import { h, icon, toast } from './dom.js';
import { nodeTitle, roleName } from './format.js';

const DEFAULT_PORT = 10086;
const TRANSPORTS = [['tcp', 'TCP'], ['ws', 'WebSocket'], ['grpc', 'gRPC'], ['xhttp', 'XHTTP'], ['kcp', 'mKCP (UDP)']];

/** Ports already taken by links touching the node (any side), to suggest a free one. */
export function usedPorts(index, nodeId) {
    const ports = new Set();
    for (const l of index.links.values()) {
        if (l.source === nodeId || l.target === nodeId) ports.add(Number(l.tunnelPort));
    }
    return ports;
}

export function suggestPort(index, nodeId) {
    const used = usedPorts(index, nodeId);
    let port = DEFAULT_PORT;
    while (used.has(port) && port < 65535) port++;
    return port;
}

export function renderCreateForm(container, { store, source, target, onCancel, onCreated, onAdvanced }) {
    const index = store.index;
    const candidates = Array.from(index.nodes.values())
        .filter(n => n.type !== 'cdn')
        .sort((a, b) => String(a.label).localeCompare(String(b.label)));

    if (candidates.length < 2) {
        container.append(
            h('div.nm-insp-head', null,
                h('div.nm-avatar.edge', null, icon('link-plus')),
                h('div.nm-insp-title', null, h('h3', null, t('map.create.title'))),
                h('button.nm-btn.ghost.icon.sm', { type: 'button', 'aria-label': t('map.close'), on: { click: onCancel } }, icon('x'))),
            h('div.nm-insp-body', null, h('div.nm-alert.muted', null, icon('info-circle'), h('div.msg', null, t('map.create.needTwo')))));
        return;
    }

    const srcId = candidates.some(n => n.id === source) ? source : candidates[0].id;
    let dstId = candidates.some(n => n.id === target && n.id !== srcId) ? target : null;
    if (!dstId) {
        const solo = candidates.find(n => n.id !== srcId && !model.isCascadeNode(index, n.id));
        dstId = (solo || candidates.find(n => n.id !== srcId)).id;
    }

    let mode = 'reverse';
    let nameTouched = false;
    let portTouched = false;

    const options = selected => candidates.map(n => h('option', { value: n.id, selected: n.id === selected },
        `${nodeTitle(n)} — ${roleName(model.roleOf(n))}`));

    const srcSel = h('select.nm-input', { name: 'source', 'aria-label': t('map.create.from') }, options(srcId));
    const dstSel = h('select.nm-input', { name: 'target', 'aria-label': t('map.create.to') }, options(dstId));
    const nameInput = h('input.nm-input', { name: 'name', maxlength: '100', autocomplete: 'off' });
    const portInput = h('input.nm-input.mono', { name: 'tunnelPort', type: 'number', min: '1', max: '65535', inputmode: 'numeric' });
    const protoSel = h('select.nm-input', { name: 'tunnelProtocol' },
        h('option', { value: 'vless' }, 'VLESS'), h('option', { value: 'vmess' }, 'VMess'));
    const transSel = h('select.nm-input', { name: 'tunnelTransport' }, TRANSPORTS.map(([v, l]) => h('option', { value: v }, l)));
    const modeHint = h('div.hint');
    const portHint = h('div.hint');
    const pathText = h('b');
    const errorBox = h('div.nm-alert.error', { hidden: true }, icon('alert-octagon'), h('div.msg'));

    const modeBtns = ['reverse', 'forward'].map(m => h('button', {
        type: 'button',
        class: m === mode ? 'active' : '',
        dataset: { mode: m },
        on: { click: () => setMode(m) },
    }, icon(m === 'forward' ? 'arrow-right' : 'arrows-exchange'), m === 'forward' ? 'Forward' : 'Reverse'));

    const submitBtn = h('button.nm-btn.primary.block', { type: 'button' }, icon('rocket'), t('map.create.submit'));

    const form = h('form.nm-insp-body', { novalidate: true, on: { submit: onSubmit, change: refresh, input: onInput } },
        h('div.nm-field', null, h('label', null, t('map.create.from')), srcSel),
        h('div', { style: { display: 'flex', justifyContent: 'center', margin: '-6px 0' } },
            h('button.nm-btn.ghost.sm', { type: 'button', on: { click: swap } }, icon('arrows-up-down'), t('swapNodes'))),
        h('div.nm-field', null, h('label', null, t('map.create.to')), dstSel),
        h('div.nm-field', null, h('label', null, t('map.create.how')), h('div.nm-seg', null, modeBtns), modeHint),
        h('details.nm-adv', null,
            h('summary', null, t('map.create.more')),
            h('div', null,
                h('div.nm-field', null, h('label', null, t('linkName')), nameInput),
                h('div.nm-field-row', null,
                    h('div.nm-field', null, h('label', null, t('tunnelPort')), portInput),
                    h('div.nm-field', null, h('label', null, t('tunnelProtocol')), protoSel)),
                portHint,
                h('div.nm-field', null, h('label', null, t('tunnelTransport')), transSel))),
        h('div.nm-alert.muted', null, icon('route'), h('div.msg', null, `${t('routePath')}: `, pathText)),
        errorBox);

    const foot = h('div.nm-insp-foot', null,
        submitBtn,
        h('div.row', null,
            onAdvanced ? h('button.nm-btn', { type: 'button', on: { click: advanced } }, icon('adjustments'), t('advancedOptions')) : null,
            h('button.nm-btn.ghost', { type: 'button', on: { click: onCancel } }, t('map.cancel'))));
    submitBtn.addEventListener('click', onSubmit);

    container.append(
        h('div.nm-insp-head', null,
            h('div.nm-avatar.edge', null, icon('link-plus')),
            h('div.nm-insp-title', null, h('h3', null, t('map.create.title')), h('div.sub', null, t('map.create.sub'))),
            h('button.nm-btn.ghost.icon.sm', { type: 'button', 'aria-label': t('map.close'), on: { click: onCancel } }, icon('x'))),
        form,
        foot);

    function listenNodeId() {
        return mode === 'forward' ? dstSel.value : srcSel.value;
    }

    function setMode(m) {
        mode = m;
        modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
        refresh();
    }

    function swap() {
        const a = srcSel.value;
        srcSel.value = dstSel.value;
        dstSel.value = a;
        refresh();
    }

    function onInput(e) {
        if (e.target === nameInput) nameTouched = nameInput.value.trim() !== '';
        if (e.target === portInput) portTouched = portInput.value.trim() !== '';
        refresh();
    }

    function refresh() {
        const s = model.nodeOf(store.index, srcSel.value);
        const d = model.nodeOf(store.index, dstSel.value);
        modeHint.textContent = mode === 'forward' ? t('map.create.forwardHint') : t('map.create.reverseHint');

        const vmess = protoSel.querySelector('option[value="vmess"]');
        vmess.disabled = mode !== 'forward';
        if (vmess.disabled && protoSel.value === 'vmess') protoSel.value = 'vless';

        if (!nameTouched) nameInput.value = s && d ? `${model.shortName(s)} → ${model.shortName(d)}` : '';
        if (!portTouched) portInput.value = String(suggestPort(store.index, listenNodeId()));

        const port = Number(portInput.value);
        const taken = usedPorts(store.index, listenNodeId()).has(port);
        const listen = model.nodeOf(store.index, listenNodeId());
        portHint.textContent = taken
            ? t('map.create.portTaken', { port })
            : t('map.listensOn', { name: listen ? listen.label : '' });
        portHint.style.color = taken ? '#fcd34d' : '';

        pathText.textContent = `${t('map.client')} → ${s ? s.label : '?'} → ${d ? d.label : '?'} → ${t('map.internet')}`;
        hideError();
    }

    function showError(msg) {
        errorBox.hidden = false;
        errorBox.querySelector('.msg').textContent = msg;
    }

    function hideError() {
        errorBox.hidden = true;
    }

    function collect() {
        return {
            name: nameInput.value.trim().slice(0, 100),
            mode,
            portalNodeId: srcSel.value,
            bridgeNodeId: dstSel.value,
            tunnelPort: parseInt(portInput.value, 10),
            tunnelProtocol: protoSel.value,
            tunnelTransport: transSel.value,
        };
    }

    function advanced() {
        if (onAdvanced) onAdvanced(collect());
    }

    async function onSubmit(e) {
        if (e) e.preventDefault();
        const body = collect();
        if (!isObjectId(body.portalNodeId) || !isObjectId(body.bridgeNodeId)) return;
        if (body.portalNodeId === body.bridgeNodeId) { showError(t('map.create.sameNode')); return; }
        if (!body.name) { showError(t('fillRequired')); return; }
        if (!Number.isInteger(body.tunnelPort) || body.tunnelPort < 1 || body.tunnelPort > 65535) {
            showError(t('map.create.badPort'));
            return;
        }
        submitBtn.disabled = true;
        submitBtn.replaceChildren(icon('loader-2', 'nm-spin'), t('map.create.creating'));
        try {
            const created = await api.createLink({ ...body, tunnelSecurity: 'none', autoDeploy: true });
            toast(t('map.toast.created', { name: body.name }), 'success');
            await store.refresh();
            store.pokeSoon();
            const edgeId = created && created._id ? `link-${created._id}` : null;
            onCreated(edgeId && store.index.links.has(edgeId) ? edgeId : null);
        } catch (err) {
            showError(err.message);
            submitBtn.disabled = false;
            submitBtn.replaceChildren(icon('rocket'), t('map.create.submit'));
        }
    }

    refresh();
}
