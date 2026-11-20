/**
 * Network map entry point (loaded as an ES module the first time the
 * "Network map" tab is opened on the nodes page).
 *
 * Views share one store and one inspector and implement:
 *   mount(el, ctx) -> { update(change), focus(sel), resize(), destroy() }
 * Chains is bundled into the entry; Graph and Geo are lazy chunks.
 */

import { createStore } from './core/store.js';
import { createActions } from './core/actions.js';
import { t } from './core/i18n.js';
import { h, icon, clear, toast } from './ui/dom.js';
import { createToolbar } from './ui/toolbar.js';
import { createInspector } from './ui/inspector.js';
import { createLinkModal, createReconnectModal } from './ui/link-modal.js';
import * as chainsView from './views/chains.js';

const VIEW_KEY = 'celerity.networkView';
const VIEWS = {
    chains: () => Promise.resolve(chainsView),
    graph: () => import('./views/graph.js'),
    geo: () => import('./views/geo.js'),
};

function readView() {
    try {
        const v = localStorage.getItem(VIEW_KEY);
        return Object.prototype.hasOwnProperty.call(VIEWS, v) ? v : 'chains';
    } catch (_) {
        return 'chains';
    }
}

function saveView(name) {
    try { localStorage.setItem(VIEW_KEY, name); } catch (_) { /* storage may be disabled */ }
}

function boot() {
    const viewRoot = document.getElementById('viewNetwork');
    const root = document.getElementById('networkRoot');
    if (!root || root.dataset.ready) return;
    root.dataset.ready = '1';

    const isVisible = () => viewRoot && viewRoot.style.display !== 'none';
    const store = createStore({ isVisible });

    const barEl = root.querySelector('.nm-bar');
    const stageEl = root.querySelector('.nm-stage');
    const inspEl = root.querySelector('.nm-insp');
    const stateEl = root.querySelector('.nm-state');

    let view = null;
    let viewName = null;
    let switchToken = 0;

    const focusInView = sel => { if (view && view.focus) view.focus(sel); };

    const linkModal = createLinkModal({
        store,
        onSaved: async edgeId => {
            await store.refresh();
            store.pokeSoon();
            if (edgeId && store.index.links.has(edgeId)) {
                store.select({ kind: 'link', id: edgeId });
                focusInView({ kind: 'link', id: edgeId });
            }
        },
    });
    const reconnectModal = createReconnectModal({
        store,
        onSaved: async () => {
            await store.refresh();
            store.pokeSoon();
        },
    });

    let inspector = null;
    const actions = createActions(store, {
        editLink: id => linkModal.openEdit(id),
        reconnect: (id, edgeId, side) => reconnectModal.open(id, edgeId, side),
        createLink: (sourceId, targetId) => inspector.openCreate(sourceId, targetId),
    });

    const toolbar = createToolbar(barEl, { store, onGoto: focusInView });
    inspector = createInspector(inspEl, {
        store,
        actions,
        onGoto: focusInView,
        openAdvanced: prefill => linkModal.openCreate(prefill),
    });

    // ==================== STATE OVERLAY ====================

    function showState(kind, err) {
        clear(stateEl);
        if (!kind) { stateEl.hidden = true; return; }
        stateEl.hidden = false;
        if (kind === 'loading') {
            stateEl.append(icon('loader-2', 'nm-spin'), h('p', null, t('loadingTopology')));
        } else if (kind === 'error') {
            stateEl.append(icon('cloud-off'), h('p', null, `${t('networkError')}: ${err ? err.message : ''}`),
                h('button.nm-btn', { type: 'button', on: { click: () => store.load() } }, icon('refresh'), t('refresh')));
        } else if (kind === 'empty') {
            stateEl.append(icon('topology-star-3'), h('p', null, t('noNodesOrLinks')),
                h('a.nm-btn.primary', { href: '/panel/nodes/add' }, icon('server-2'), t('map.addNode')));
        }
    }

    // ==================== VIEWS ====================

    function setHeaderActive(name) {
        document.querySelectorAll('#networkToolbar [data-nm-view]').forEach(btn => {
            const on = btn.dataset.nmView === name;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    async function switchView(name) {
        if (!Object.prototype.hasOwnProperty.call(VIEWS, name)) name = 'chains';
        if (name === viewName && view) return;
        const token = ++switchToken;
        setHeaderActive(name);
        saveView(name);

        let mod;
        try {
            mod = await VIEWS[name]();
        } catch (err) {
            if (token !== switchToken) return;
            toast(`${t('networkError')}: ${err.message}`, 'error');
            if (name !== 'chains') switchView('chains');
            return;
        }
        if (token !== switchToken) return;

        if (view) {
            try { view.destroy(); } catch (err) { console.error('[network]', err); }
        }
        clear(stageEl);
        clear(toolbar.slot);
        view = null;
        viewName = name;
        toolbar.setStatsVisible(name !== 'chains');

        const el = h('div');
        stageEl.appendChild(el);
        view = mod.mount(el, { store, actions, toolbar, inspector });
        if (store.state.loaded) view.update({ type: 'data', structural: true });
        const sel = store.state.selection;
        if (sel) focusInView(sel);
    }

    // ==================== STORE EVENTS ====================

    store.on('loading', loading => {
        if (loading && !store.state.loaded) showState('loading');
    });
    store.on('error', err => {
        if (!store.state.loaded) showState('error', err);
        else console.warn('[network] refresh failed:', err.message);
    });
    store.on('data', change => {
        showState(store.index.nodes.size ? null : 'empty');
        toolbar.update();
        if (view) view.update({ type: 'data', structural: change.structural });
        inspector.render();
    });
    store.on('select', () => {
        if (view) view.update({ type: 'select' });
        inspector.render();
    });
    store.on('filter', () => {
        if (view) view.update({ type: 'filter' });
    });

    // ==================== GLOBAL CONTROLS ====================

    document.querySelectorAll('#networkToolbar [data-nm-view]').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.nmView));
    });
    const refreshBtn = document.getElementById('btnNetworkRefresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            await store.refresh();
            refreshBtn.disabled = false;
        });
    }
    const addBtn = document.getElementById('btnAddLink');
    if (addBtn) addBtn.addEventListener('click', () => inspector.openCreate(null, null));

    document.addEventListener('keydown', e => {
        if (!isVisible()) return;
        if (linkModal.isOpen() || reconnectModal.isOpen()) {
            if (e.key === 'Escape') { linkModal.close(); reconnectModal.close(); }
            return;
        }
        const typing = e.target.closest && e.target.closest('input, select, textarea, [contenteditable="true"]');
        if (e.key === 'Escape') {
            toolbar.closePopover();
            if (typing) return;
            if (inspector.isCreating()) inspector.close();
            else store.select(null);
            return;
        }
        if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === '/') {
            e.preventDefault();
            toolbar.focusSearch();
        }
    });

    window._networkResize = () => {
        if (view && view.resize) view.resize();
        store.resume();
    };

    switchView(readView());
    store.load();
    store.startPolling();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
