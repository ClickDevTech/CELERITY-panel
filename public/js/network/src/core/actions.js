/**
 * Cascade link actions shared by all views and the inspector.
 * Each action confirms destructive steps, shows an optimistic status,
 * reports the outcome with a toast and schedules follow-up refreshes.
 */

import { api, linkIdOf } from './api.js';
import { t } from './i18n.js';
import { toast } from '../ui/dom.js';

export function createActions(store, hooks = {}) {
    const busy = new Set();

    function linkOf(edgeId) {
        return store.index.links.get(edgeId) || null;
    }

    async function run(edgeId, { confirmText, optimistic, call, success, failure, affected }) {
        const link = linkOf(edgeId);
        const id = linkIdOf(edgeId);
        if (!link || !id) return false;
        if (busy.has(edgeId)) return false;
        if (confirmText && !window.confirm(confirmText)) return false;

        busy.add(edgeId);
        const targets = affected || [edgeId];
        const prev = new Map();
        if (optimistic) {
            for (const e of targets) prev.set(e, store.setLinkStatus(e, optimistic));
        }
        try {
            const res = await call(id, link);
            if (success) {
                const msg = typeof success === 'function' ? success(res) : success;
                toast(msg, res && res.healthy === false ? 'warning' : 'success');
            }
            for (const e of targets) store.clearLinkStatus(e, null);
            await store.refresh();
            store.pokeSoon();
            return true;
        } catch (err) {
            for (const e of targets) store.clearLinkStatus(e, prev.get(e));
            toast(`${failure || t('networkError')}: ${err.message}`, 'error');
            store.refresh();
            return false;
        } finally {
            busy.delete(edgeId);
        }
    }

    return {
        isBusy: edgeId => busy.has(edgeId),

        deploy: edgeId => run(edgeId, {
            confirmText: t('confirmDeploy'),
            optimistic: 'syncing',
            call: id => api.deployLink(id),
            success: t('deploySuccess'),
            failure: t('deployFailed'),
        }),

        deployChain: edgeId => run(edgeId, {
            confirmText: t('confirmDeployChain'),
            optimistic: 'syncing',
            affected: Array.from(store.model.related(store.index, 'link', edgeId).links)
                .filter(e => store.index.links.has(e)),
            call: id => api.deployChain(id),
            success: res => `${t('chainDeploySuccess')}: ${Number(res && res.deployed) || 0} ${t('nodes')}`,
            failure: t('chainDeployFailed'),
        }),

        undeploy: edgeId => run(edgeId, {
            confirmText: t('confirmUndeploy'),
            optimistic: 'syncing',
            call: id => api.undeployLink(id),
            success: t('undeploySuccess'),
            failure: t('networkError'),
        }),

        remove: async edgeId => {
            const ok = await run(edgeId, {
                confirmText: t('confirmDeleteLink'),
                optimistic: 'syncing',
                call: id => api.deleteLink(id),
                success: t('deleteSuccess'),
                failure: t('networkError'),
            });
            if (ok && store.state.selection && store.state.selection.id === edgeId) store.select(null);
            return ok;
        },

        check: edgeId => run(edgeId, {
            call: id => api.checkHealth(id),
            success: res => (res && res.healthy
                ? t('map.toast.healthOk', { ms: res.latencyMs != null ? res.latencyMs : '—' })
                : t('map.toast.healthFail')),
            failure: t('networkError'),
        }),

        edit: edgeId => {
            const id = linkIdOf(edgeId);
            if (id && hooks.editLink) hooks.editLink(id);
        },

        reconnect: (edgeId, side) => {
            const id = linkIdOf(edgeId);
            if (id && hooks.reconnect) hooks.reconnect(id, edgeId, side === 'portal' ? 'portal' : 'bridge');
        },

        createLink: (sourceId, targetId) => {
            if (hooks.createLink) hooks.createLink(sourceId || null, targetId || null);
        },
    };
}
