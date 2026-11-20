/**
 * Network map state: topology index, selection, filters and background refresh.
 *
 * Events:
 *   'data'      { structural: boolean } - topology changed (structural = nodes/links/roles changed)
 *   'select'    selection | null
 *   'filter'    filter state
 *   'loading'   boolean
 *   'error'     Error
 */

import model from './model.js';
import { api } from './api.js';

const POLL_INTERVAL_MS = 30000;
/** Follow-up refreshes after a mutation: background deploys finish a few seconds later. */
const POKE_DELAYS_MS = [1500, 5000, 12000, 25000];

export function createStore({ isVisible }) {
    const listeners = new Map();
    const state = {
        index: model.buildIndex({ nodes: [], edges: [] }),
        key: '',
        loaded: false,
        loading: false,
        selection: null,
        filter: { query: '', roles: new Set(), problemsOnly: false },
        lastFetch: 0,
    };

    let pollTimer = null;
    let pokeTimers = [];
    let inflight = null;
    const pending = new Map();

    function on(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, new Set());
        listeners.get(evt).add(fn);
        return () => listeners.get(evt).delete(fn);
    }

    function emit(evt, payload) {
        for (const fn of listeners.get(evt) || []) {
            try { fn(payload); } catch (err) { console.error('[network]', err); }
        }
    }

    /** Re-apply optimistic statuses until the server reports a different value. */
    function applyPending(index) {
        for (const [id, status] of pending) {
            const link = index.links.get(id);
            if (!link) { pending.delete(id); continue; }
            if (link.status !== status.from) { pending.delete(id); continue; }
            link.status = status.to;
        }
    }

    async function fetchTopology({ silent } = {}) {
        if (inflight) return inflight;
        if (!silent) { state.loading = true; emit('loading', true); }
        inflight = (async () => {
            try {
                const topo = await api.topology();
                const index = model.buildIndex(topo);
                applyPending(index);
                const key = model.structureKey(index);
                const structural = !state.loaded || key !== state.key;
                state.index = index;
                state.key = key;
                state.loaded = true;
                state.lastFetch = Date.now();
                if (state.selection && !selectionExists(state.selection)) {
                    state.selection = null;
                    emit('select', null);
                }
                emit('data', { structural });
            } catch (err) {
                emit('error', err);
            } finally {
                inflight = null;
                if (!silent) { state.loading = false; emit('loading', false); }
            }
        })();
        return inflight;
    }

    function selectionExists(sel) {
        if (sel.kind === 'node') return !!model.nodeOf(state.index, sel.id);
        return !!model.edgeOf(state.index, sel.id);
    }

    function canPoll() {
        return !document.hidden && (!isVisible || isVisible());
    }

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(() => {
            if (canPoll()) fetchTopology({ silent: true });
        }, POLL_INTERVAL_MS);
        document.addEventListener('visibilitychange', onVisibility);
    }

    function stopPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        document.removeEventListener('visibilitychange', onVisibility);
    }

    function onVisibility() {
        if (canPoll() && Date.now() - state.lastFetch > POLL_INTERVAL_MS) fetchTopology({ silent: true });
    }

    /** Called when the map tab becomes visible again. */
    function resume() {
        if (Date.now() - state.lastFetch > POLL_INTERVAL_MS) fetchTopology({ silent: true });
    }

    function pokeSoon() {
        pokeTimers.forEach(clearTimeout);
        pokeTimers = POKE_DELAYS_MS.map(ms => setTimeout(() => {
            if (canPoll()) fetchTopology({ silent: true });
        }, ms));
    }

    function select(sel) {
        const next = sel && sel.id ? { kind: sel.kind === 'link' ? 'link' : 'node', id: String(sel.id) } : null;
        const cur = state.selection;
        if (cur && next && cur.kind === next.kind && cur.id === next.id) return;
        if (!cur && !next) return;
        state.selection = next;
        emit('select', next);
    }

    function setFilter(patch) {
        Object.assign(state.filter, patch);
        emit('filter', state.filter);
    }

    function toggleRole(role) {
        const roles = state.filter.roles;
        if (roles.has(role)) roles.delete(role); else roles.add(role);
        emit('filter', state.filter);
    }

    /** True when the node passes the role filter and the search query. */
    function nodeVisible(node) {
        const f = state.filter;
        if (f.roles.size && f.roles.has(model.roleOf(node))) return false;
        return model.matchesQuery(node, f.query);
    }

    /** Optimistically show a link status while an action is running. */
    function setLinkStatus(edgeId, status) {
        const link = state.index.links.get(edgeId);
        if (!link) return null;
        const prev = link.status;
        if (prev === status) return prev;
        pending.set(edgeId, { from: prev, to: status });
        link.status = status;
        emit('data', { structural: false });
        return prev;
    }

    function clearLinkStatus(edgeId, restore) {
        pending.delete(edgeId);
        const link = state.index.links.get(edgeId);
        if (link && restore) {
            link.status = restore;
            emit('data', { structural: false });
        }
    }

    function destroy() {
        stopPolling();
        pokeTimers.forEach(clearTimeout);
        listeners.clear();
    }

    return {
        state,
        model,
        on,
        emit,
        load: () => fetchTopology(),
        refresh: () => fetchTopology({ silent: true }),
        startPolling,
        stopPolling,
        resume,
        pokeSoon,
        select,
        setFilter,
        toggleRole,
        nodeVisible,
        setLinkStatus,
        clearLinkStatus,
        destroy,
        get index() { return state.index; },
    };
}
