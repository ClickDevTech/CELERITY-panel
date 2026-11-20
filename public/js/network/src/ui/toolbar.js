/**
 * Map toolbar: search, a slot for view-specific controls, network summary
 * and the problems popover.
 */

import model from '../core/model.js';
import { t, plural } from '../core/i18n.js';
import { h, icon, clear, debounce } from './dom.js';
import { nodeTitle } from './format.js';

export function createToolbar(el, { store, onGoto }) {
    const searchInput = h('input.nm-input', {
        type: 'search',
        placeholder: t('map.searchPlaceholder'),
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': t('map.searchPlaceholder'),
        maxlength: '100',
    });
    const slot = h('div.nm-bar-slot');
    const stats = h('div.nm-stats');
    const probBtn = h('button.nm-btn.nm-problems.ok', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
    const pop = h('div.nm-pop', { hidden: true, role: 'menu' });

    const applyQuery = debounce(() => store.setFilter({ query: searchInput.value.trim().slice(0, 100) }), 120);
    searchInput.addEventListener('input', applyQuery);
    searchInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            applyQuery.flush();
            searchInput.blur();
        } else if (e.key === 'Enter') {
            const q = searchInput.value.trim();
            const hit = q && Array.from(store.index.nodes.values()).find(n => model.matchesQuery(n, q));
            if (hit) {
                searchInput.blur();
                store.select({ kind: 'node', id: hit.id });
                if (onGoto) onGoto({ kind: 'node', id: hit.id });
            }
        }
    });

    probBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (!model.problems(store.index).length) return;
        setPop(pop.hidden);
    });
    document.addEventListener('click', e => {
        if (!pop.hidden && !pop.contains(e.target)) setPop(false);
    });

    el.append(
        h('div.nm-search', null, icon('search'), searchInput, h('span.nm-kbd', null, '/')),
        slot,
        h('div.nm-spacer'),
        stats,
        probBtn,
        pop);

    function setPop(open) {
        pop.hidden = !open;
        probBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) renderPop();
    }

    function problemTitle(p) {
        const index = store.index;
        if (p.kind === 'node') return nodeTitle(model.nodeOf(index, p.id));
        const l = index.links.get(p.id);
        return l ? l.label || '' : '';
    }

    function renderPop() {
        const list = model.problems(store.index);
        clear(pop);
        pop.append(...list.slice(0, 100).map(p => h(`button.nm-prob.${p.sev}`, {
            type: 'button',
            role: 'menuitem',
            on: {
                click: () => {
                    setPop(false);
                    store.select({ kind: p.kind, id: p.id });
                    if (onGoto) onGoto({ kind: p.kind, id: p.id });
                },
            },
        }, icon(p.sev === 'error' ? 'alert-octagon' : 'alert-triangle'),
        h('div', null, h('div.t', null, problemTitle(p)), h('div.d', null, p.detail || t(`map.problem.${p.code}`))))));
    }

    function update() {
        const s = model.stats(store.index);
        clear(stats);
        stats.append(
            h('span', { title: t('map.kpi.nodesOnline') }, icon('server-2'), h('b', null, String(s.online)), `/${s.nodes}`),
            h('span', { title: t('map.kpi.clients') }, icon('users'), h('b', null, String(s.users))),
            h('span.opt', { title: t('map.kpi.chainsOk') }, icon('route'), h('b', null, String(s.chainsOk)), `/${s.chains}`),
            s.avgLatency != null ? h('span.opt', { title: t('map.kpi.avgLatency') }, icon('clock'), h('b', null, String(s.avgLatency)), ` ${t('map.msUnit')}`) : null);

        const n = s.problems;
        probBtn.classList.toggle('ok', n === 0);
        probBtn.replaceChildren(...(n
            ? [h('span.nm-dot.error'), ` ${n} ${plural(n, 'map.problemsPlural')} `, icon('chevron-down')]
            : [icon('circle-check'), ` ${t('map.allGood')}`]));
        if (!n) setPop(false);
        else if (!pop.hidden) renderPop();
    }

    return {
        slot,
        update,
        focusSearch: () => { searchInput.focus(); searchInput.select(); },
        setStatsVisible: visible => { stats.style.display = visible ? '' : 'none'; },
        closePopover: () => setPop(false),
    };
}
