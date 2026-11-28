/**
 * Shared label/format helpers (translated).
 */

import model from '../core/model.js';
import { t, plural } from '../core/i18n.js';
import { h, icon } from './dom.js';

export const ROLE_ORDER = ['portal', 'relay', 'bridge', 'standalone', 'cdn'];

export const ROLE_ICON = {
    portal: 'door-enter',
    relay: 'arrows-right',
    bridge: 'door-exit',
    standalone: 'server-2',
    cdn: 'cloud',
    internet: 'world',
};

export function roleName(role) {
    return t(`map.role.${role}`);
}

export function roleDesc(role) {
    return t(`map.roleDesc.${role}`);
}

export function statusName(status) {
    return t(`map.status.${status || 'pending'}`);
}

export function nodeTitle(node) {
    if (!node) return '';
    if (node.id === model.INTERNET_ID) return t('map.internet');
    return `${node.flag ? `${node.flag} ` : ''}${node.label || node.ip || ''}`;
}

export function ms(value) {
    return typeof value === 'number' ? t('map.ms', { n: value }) : '—';
}

export function typeName(type) {
    if (type === 'xray') return 'Xray';
    if (type === 'hysteria') return 'Hysteria 2';
    if (type === 'cdn') return 'CDN';
    return type || '—';
}

export function count(n, key) {
    return `${n} ${plural(n, key)}`;
}

let rtf = null;
/** "5 minutes ago" in the page language; '' for missing/invalid dates. */
export function ago(value) {
    if (!value) return '';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return '';
    if (!rtf) {
        try { rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' }); } catch (_) { rtf = null; }
    }
    const diff = Math.round((time - Date.now()) / 1000);
    const abs = Math.abs(diff);
    const [val, unit] = abs < 60 ? [diff, 'second']
        : abs < 3600 ? [Math.round(diff / 60), 'minute']
        : abs < 86400 ? [Math.round(diff / 3600), 'hour']
        : [Math.round(diff / 86400), 'day'];
    return rtf ? rtf.format(val, unit) : new Date(time).toLocaleString();
}

export function roleTag(role) {
    return h(`span.nm-role.${role}`, null, roleName(role));
}

export function statusPill(status) {
    return h(`span.nm-st.${status || 'pending'}`, null, statusName(status));
}

export function dot(status) {
    return h(`span.nm-dot.${status || 'pending'}`);
}

export function modeIcon(mode) {
    return mode === 'forward' ? 'arrow-right' : 'arrows-exchange';
}

/**
 * Inline link label used on connectors (chains + graph).
 * onAction(kind) is called for the embedded quick-fix button.
 */
export function pillContent(link) {
    if (link.isCdnEdge) return [icon('cloud'), ' CDN'];
    const m = modeIcon(link.mode);
    switch (link.status) {
        case 'error':
            return [icon('alert-triangle'), ` ${t('map.pill.error')} `, h('button.act', { type: 'button', dataset: { act: 'deploy' } }, t('map.pill.retry'))];
        case 'pending':
            return [icon(m), ` ${t('map.pill.pending')} `, h('button.act', { type: 'button', dataset: { act: 'deploy' } }, t('map.pill.deploy'))];
        case 'syncing':
            return [icon('loader-2', 'nm-spin'), ` ${t('map.pill.syncing')}`];
        case 'offline':
            return [icon(m), ` ${t('map.pill.offline')}`];
        default:
            return [icon(m), h('span.ms', null, ms(link.latencyMs))];
    }
}

export function linkTip(index, link) {
    if (link.isCdnEdge) {
        const origin = model.nodeOf(index, link.target);
        return [h('div.t', null, icon('cloud'), t('map.cdnEntry')), h('div.m', null, t('map.cdnEntryDesc', { name: origin ? origin.label : '' }))];
    }
    const sec = link.tunnelSecurity && link.tunnelSecurity !== 'none' ? ` / ${link.tunnelSecurity.toUpperCase()}` : '';
    return [
        h('div.t', null, dot(link.status), link.label || ''),
        h('div.m', null,
            `${link.mode === 'forward' ? 'Forward' : 'Reverse'} · ${String(link.tunnelProtocol || '').toUpperCase()} / ${String(link.tunnelTransport || '').toUpperCase()}${sec}${link.ipVersion === 6 ? ' · IPv6' : ''} · ${t('map.port')} ${link.tunnelPort || '—'}`,
            h('br'),
            typeof link.latencyMs === 'number' && link.status === 'online' ? t('map.latencyValue', { n: link.latencyMs }) : statusName(link.status),
            link.lastError ? [h('br'), h('span.err', null, link.lastError)] : null),
    ];
}

export function nodeTip(node) {
    const role = model.roleOf(node);
    return [
        h('div.t', null, nodeTitle(node)),
        h('div.m', null,
            `${roleName(role)} · ${statusName(node.status)}${node.onlineUsers ? ` · ${t('map.onlineN', { n: node.onlineUsers })}` : ''}`,
            node.ip ? [h('br'), h('span.mono', null, node.ip)] : null),
    ];
}
