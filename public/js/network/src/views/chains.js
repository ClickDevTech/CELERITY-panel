/**
 * Chains view (default): one lane per entry portal, drawn as a left-to-right
 * tree Client -> portal -> ... -> exit -> Internet, plus a grid of standalone nodes.
 * Pure DOM + one SVG per lane for connectors; no third-party dependencies.
 */

import model from '../core/model.js';
import { t } from '../core/i18n.js';
import { h, svg, icon, clear, rafThrottle, tip } from '../ui/dom.js';
import {
    statusName, nodeTitle, ms, count, roleTag, dot, pillContent, linkTip, nodeTip,
} from '../ui/format.js';

/** Lanes after this many start collapsed unless they contain problems. */
const AUTO_EXPAND_LANES = 6;
/** Hard cap on cards per lane so a pathological DAG cannot freeze the page. */
const MAX_CARDS_PER_LANE = 200;
/** Above this many animated connectors the flow animation is switched off. */
const MAX_ANIMATED = 80;

export function mount(el, { store, actions, toolbar }) {
    el.className = 'nmc';
    const side = h('div.nmc-side-list');
    const main = h('div.nmc-main');
    el.append(h('aside.nmc-side', null, side), main);

    const collapsed = new Set();
    const seenRoots = new Set();
    let lanes = [];
    let currentRoots = [];
    let hover = null;
    let animated = 0;

    // ==================== TOOLBAR ====================

    const problemsBtn = h('button.nm-btn.sm', { type: 'button', on: { click: () => store.setFilter({ problemsOnly: !store.state.filter.problemsOnly }) } },
        icon('alert-triangle'), h('span.lbl', null, t('map.problemsOnly')));
    const expandBtn = h('button.nm-btn.sm.icon', { type: 'button', title: t('map.expandAll'), 'aria-label': t('map.expandAll'), on: { click: () => setAllCollapsed(false) } }, icon('layout-navbar-expand'));
    const collapseBtn = h('button.nm-btn.sm.icon', { type: 'button', title: t('map.collapseAll'), 'aria-label': t('map.collapseAll'), on: { click: () => setAllCollapsed(true) } }, icon('layout-navbar-collapse'));
    toolbar.slot.append(problemsBtn, expandBtn, collapseBtn);

    function setAllCollapsed(value) {
        for (const lane of lanes) {
            if (lane.rootId === 'solo') continue;
            if (value) collapsed.add(lane.rootId); else collapsed.delete(lane.rootId);
            lane.el.classList.toggle('collapsed', value);
        }
        scheduleDraw();
    }

    // ==================== HELPERS ====================

    const index = () => store.index;

    function laneProblems(rel) {
        return model.problems(index()).filter(p => (p.kind === 'node' ? rel.nodes.has(p.id) : rel.links.has(p.id)));
    }

    /** Entry portals plus one representative per cyclic component that has no entry. */
    function laneRoots() {
        const idx = index();
        const res = model.roots(idx);
        const covered = new Set();
        for (const r of res) model.related(idx, 'node', r.id).nodes.forEach(id => covered.add(id));
        for (const node of idx.nodes.values()) {
            if (covered.has(node.id) || node.type === 'cdn' || !model.outLinks(idx, node.id).length) continue;
            res.push(node);
            model.related(idx, 'node', node.id).nodes.forEach(id => covered.add(id));
        }
        return res;
    }

    function lanesUsing(nodeId) {
        let n = 0;
        for (const r of currentRoots) {
            if (model.related(index(), 'node', r.id).nodes.has(nodeId)) n++;
        }
        return n;
    }

    function isMatch(node) {
        const q = store.state.filter.query;
        return !!q && model.matchesQuery(node, q);
    }

    function hoverOn(sel) {
        hover = sel;
        applyDim();
    }

    function hoverOff() {
        hover = null;
        applyDim();
        tip.hide();
    }

    // ==================== RENDER ====================

    function card(node, isRoot, lane) {
        const role = model.roleOf(node);
        const shared = !isRoot && lane.sharedCount(node.id) > 1;
        const el = h(`button.nmc-card.r-${role}.s-${node.status}`, {
            type: 'button',
            dataset: { node: node.id },
            class: isMatch(node) ? 'match' : '',
            on: {
                click: () => store.select({ kind: 'node', id: node.id }),
                mouseenter: e => { hoverOn({ kind: 'node', id: node.id }); tip.show(e.clientX, e.clientY, nodeTip(node)); },
                mousemove: e => tip.show(e.clientX, e.clientY, nodeTip(node)),
                mouseleave: hoverOff,
            },
        },
        shared ? h('span.shared', { title: t('map.sharedHint') }, t('map.shared')) : null,
        h('div.row1', null, h('span.flag', null, node.flag || '🖥️'), h('span.nm', null, node.label || node.ip || ''), dot(node.status)),
        h('div.row2', null, roleTag(role),
            node.onlineUsers ? h('span', null, icon('users'), ` ${node.onlineUsers}`) : h('span.mono', null, node.ip || '')));
        lane.cards.push(el);
        return el;
    }

    function pill(link, lane) {
        const el = h(`div.nm-pill.nmc-pill.${link.status}`, {
            dataset: { link: link.id },
            role: 'button',
            tabindex: '0',
            'aria-label': `${link.label || ''}: ${statusName(link.status)}`,
            on: {
                click: e => {
                    const act = e.target.closest('.act');
                    e.stopPropagation();
                    if (act) actions.deploy(link.id);
                    else store.select({ kind: 'link', id: link.id });
                },
                keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); store.select({ kind: 'link', id: link.id }); } },
                mouseenter: e => { hoverOn({ kind: 'link', id: link.id }); tip.show(e.clientX, e.clientY, linkTip(index(), link)); },
                mousemove: e => tip.show(e.clientX, e.clientY, linkTip(index(), link)),
                mouseleave: hoverOff,
            },
        }, pillContent(link));
        lane.pills.push(el);
        return el;
    }

    function tree(nodeId, isRoot, path, lane) {
        const node = model.nodeOf(index(), nodeId);
        if (!node) return null;
        if (lane.cardCount >= MAX_CARDS_PER_LANE) {
            lane.truncated = true;
            return null;
        }
        lane.cardCount++;
        const c = card(node, isRoot, lane);
        const wrap = h('div.nmc-tn', null, c);
        const kids = model.outLinks(index(), nodeId).filter(l => !path.includes(l.target));

        if (kids.length || isRoot) {
            const box = h('div.nmc-tkids');
            for (const l of kids) {
                const sub = tree(l.target, false, path.concat(l.target), lane);
                if (!sub) continue;
                const childCard = sub.querySelector('.nmc-card');
                lane.pairs.push({ a: c, b: childCard, link: l, pill: pill(l, lane) });
                box.appendChild(h('div.nmc-tkid', null, sub));
            }
            if (isRoot) {
                const ghost = h('button.nmc-ghost', { type: 'button', on: { click: () => actions.createLink(nodeId, null) } }, icon('plus'), t('map.addExit'));
                lane.pairs.push({ a: c, b: ghost, kind: 'ghost' });
                box.appendChild(h('div.nmc-tkid', null, ghost));
            }
            wrap.appendChild(box);
        } else {
            const ok = node.status === 'online';
            const inet = h(`div.nmc-inet${ok ? '' : '.off'}`, null, `🌐 ${t('map.internet')}`);
            lane.pairs.push({ a: c, b: inet, kind: ok ? 'inet' : 'inet off' });
            wrap.appendChild(inet);
        }
        return wrap;
    }

    function renderKpis() {
        const s = model.stats(index());
        const problemsOnly = store.state.filter.problemsOnly;
        return h('div.nmc-kpis', null,
            h('div.nmc-kcard', null, h('div.k', null, icon('server-2'), t('map.kpi.nodesOnline')), h('div.v', null, String(s.online), ' ', h('small', null, t('map.ofN', { n: s.nodes })))),
            h('div.nmc-kcard', null, h('div.k', null, icon('users'), t('map.kpi.clients')), h('div.v', null, String(s.users))),
            h('div.nmc-kcard', null, h('div.k', null, icon('route'), t('map.kpi.chainsOk')), h('div.v', null, String(s.chainsOk), ' ', h('small', null, t('map.ofN', { n: s.chains })))),
            h('div.nmc-kcard', null, h('div.k', null, icon('clock'), t('map.kpi.avgLatency')), h('div.v', null, s.avgLatency != null ? [String(s.avgLatency), ' ', h('small', null, t('map.msUnit'))] : '—')),
            h(`button.nmc-kcard${s.problems ? '.bad' : ''}${problemsOnly ? '.on' : ''}`, {
                type: 'button',
                on: { click: () => store.setFilter({ problemsOnly: !problemsOnly }) },
            }, h('div.k', null, icon('alert-triangle'), t('map.kpi.problems')),
            h('div.v', null, String(s.problems), ' ', h('small', null, s.problems ? (problemsOnly ? t('map.showAll') : t('map.show')) : t('map.allGood')))));
    }

    function renderLane(root, laneIdx) {
        const rel = model.related(index(), 'node', root.id);
        const probs = laneProblems(rel);
        const hasErr = probs.some(p => p.sev === 'error');

        if (!seenRoots.has(root.id)) {
            seenRoots.add(root.id);
            if (laneIdx >= AUTO_EXPAND_LANES && !probs.length) collapsed.add(root.id);
        }

        const lane = {
            rootId: root.id,
            rel,
            cards: [],
            pills: [],
            pairs: [],
            cardCount: 0,
            truncated: false,
            sharedCount: lanesUsingCached,
        };

        const exits = Array.from(rel.nodes).map(id => model.nodeOf(index(), id))
            .filter(n => n && n.type !== 'cdn' && model.outLinks(index(), n.id).length === 0 && n.id !== root.id);
        const cdns = model.cdnFor(index(), root.id);
        const firstLink = model.outLinks(index(), root.id)[0];

        const clients = h('div.nmc-clients', null, icon('users'), h('b', null, String(root.onlineUsers || 0)), h('small', null, t('map.clients')),
            cdns.map(c => h('button.cdn', {
                type: 'button',
                title: c.domain || c.label,
                on: { click: () => store.select({ kind: 'node', id: c.id }) },
            }, `☁️ ${t('map.viaCdn')}`)));

        const svgEl = svg('svg');
        const treeEl = tree(root.id, true, [root.id], lane);
        const rootCard = treeEl ? treeEl.querySelector('.nmc-card') : null;
        if (rootCard) lane.pairs.unshift({ a: clients, b: rootCard, kind: 'client' });

        const body = h('div.nmc-lane-body', null, svgEl,
            h('div.nmc-flow', null, clients, h('div.nmc-gap'), treeEl),
            lane.truncated ? h('div.hint', { style: { marginTop: '12px', color: 'var(--text-muted)', fontSize: '12px' } }, t('map.truncated')) : null);
        lane.pills.forEach(p => body.appendChild(p));

        const isCollapsed = collapsed.has(root.id);
        const toggle = h('button.nm-btn.ghost.icon.sm', {
            type: 'button',
            'aria-expanded': isCollapsed ? 'false' : 'true',
            'aria-label': t('map.toggleLane'),
            on: { click: () => toggleLane(lane) },
        }, icon('chevron-down', 'chev'));

        lane.el = h(`section.nmc-lane${hasErr ? '.has-err' : ''}${isCollapsed ? '.collapsed' : ''}`, { dataset: { lane: root.id } },
            h('div.nmc-lane-head', null,
                toggle,
                h('div.ttl', null, h('span', null, root.flag || ''), h('span.nm', null, root.label || ''), roleTag(model.roleOf(root))),
                h('div.meta', null,
                    h('span', null, icon('users'), t('map.onlineN', { n: root.onlineUsers || 0 })),
                    h('span', null, icon('door-exit'), count(exits.length, 'map.exitsPlural')),
                    probs.length
                        ? h('span.bad', null, icon('alert-triangle'), count(probs.length, 'map.problemsPlural'))
                        : h('span.ok', null, icon('circle-check'), t('map.allWorks'))),
                h('div.nm-spacer'),
                firstLink ? h('button.nm-btn.sm', { type: 'button', on: { click: () => actions.deployChain(firstLink.id) } }, icon('refresh'), t('map.sync')) : null,
                h('button.nm-btn.sm', { type: 'button', on: { click: () => actions.createLink(root.id, null) } }, icon('plus'), t('map.exit'))),
            body);
        lane.body = body;
        lane.svg = svgEl;
        lane.toggle = toggle;
        return lane;
    }

    let sharedCache = null;
    function lanesUsingCached(nodeId) {
        if (!sharedCache) sharedCache = new Map();
        if (!sharedCache.has(nodeId)) sharedCache.set(nodeId, lanesUsing(nodeId));
        return sharedCache.get(nodeId);
    }

    function renderSolos(list) {
        if (!list.length) return null;
        const lane = { rootId: 'solo', cards: [], pills: [], pairs: [] };
        lane.el = h('section.nmc-lane', { dataset: { lane: 'solo' } },
            h('div.nmc-lane-head', null,
                h('div.ttl', null, icon('server-2'), h('span.nm', null, t('map.noCascade'))),
                h('div.meta', null, h('span', null, `${count(list.length, 'map.nodesPlural')} · ${t('map.directExit')}`))),
            h('div.nmc-solo-grid', null, list.map(n => {
                const c = h(`div.nmc-solo.s-${n.status}`, {
                    dataset: { node: n.id },
                    role: 'button',
                    tabindex: '0',
                    class: isMatch(n) ? 'match' : '',
                    on: {
                        click: e => { if (!e.target.closest('.link-btn')) store.select({ kind: 'node', id: n.id }); },
                        keydown: e => { if (e.key === 'Enter') store.select({ kind: 'node', id: n.id }); },
                    },
                },
                h('div.row1', null, h('span.flag', null, n.flag || '🖥️'), h('span.nm', null, n.label || n.ip || ''), dot(n.status)),
                h('div.row2', null,
                    h('span', null, n.onlineUsers ? [icon('users'), ` ${n.onlineUsers} · `] : null, h('span.mono', null, n.ip || '')),
                    h('button.nm-btn.sm.icon.link-btn', {
                        type: 'button',
                        title: t('map.connectToCascade'),
                        'aria-label': t('map.connectToCascade'),
                        on: { click: e => { e.stopPropagation(); actions.createLink(n.id, null); } },
                    }, icon('link-plus'))));
                lane.cards.push(c);
                return c;
            })));
        return lane;
    }

    function renderSide(laneList, solos) {
        clear(side);
        const sel = store.state.selection;
        if (laneList.length) side.append(h('div.nmc-group', null, t('map.cascades')));
        for (const lane of laneList) {
            const root = model.nodeOf(index(), lane.rootId);
            const hasErr = laneProblems(lane.rel).some(p => p.sev === 'error');
            side.append(sideRow(lane.rootId, { kind: 'node', id: root.id }, true, 0,
                dot(hasErr ? 'error' : root.status), nodeTitle(root),
                h('span.ms', null, String(root.onlineUsers || 0), ' ', icon('users')), sel));
            const walk = (id, depth, seen) => {
                if (depth > 8) return;
                for (const l of model.outLinks(index(), id)) {
                    if (seen.includes(l.target)) continue;
                    const n = model.nodeOf(index(), l.target);
                    if (!n) continue;
                    const bad = l.status !== 'online';
                    side.append(sideRow(lane.rootId, { kind: 'link', id: l.id }, false, depth,
                        dot(bad ? l.status : n.status), nodeTitle(n),
                        h(`span.ms${l.status === 'error' ? '.bad' : ''}`, null, l.status === 'online' ? ms(l.latencyMs) : statusName(l.status)), sel));
                    walk(n.id, depth + 1, seen.concat(n.id));
                }
            };
            walk(lane.rootId, 1, [lane.rootId]);
        }
        if (solos.length) {
            side.append(h('div.nmc-group', null, t('map.noCascade')));
            for (const n of solos) {
                side.append(sideRow('solo', { kind: 'node', id: n.id }, false, 0, dot(n.status), nodeTitle(n),
                    h('span.ms', null, n.onlineUsers ? String(n.onlineUsers) : ''), sel));
            }
        }
    }

    function sideRow(laneId, target, isRoot, depth, dotEl, label, right, sel) {
        const active = sel && sel.kind === target.kind && sel.id === target.id;
        return h(`button.nmc-srow${isRoot ? '.root' : ''}${active ? '.active' : ''}`, {
            type: 'button',
            dataset: { target: `${target.kind}:${target.id}` },
            style: depth ? { paddingLeft: `${8 + depth * 14}px` } : null,
            on: {
                click: () => {
                    store.select(target);
                    reveal(laneId);
                },
                mouseenter: () => hoverOn(target),
                mouseleave: hoverOff,
            },
        }, depth ? h('span.tree', null, '└') : null, dotEl, h('span.nm', null, label), right);
    }

    function render() {
        sharedCache = null;
        const scrollTop = main.scrollTop;
        const f = store.state.filter;
        const allRoots = laneRoots();
        currentRoots = allRoots;
        const solos = model.soloNodes(index());

        let roots = allRoots;
        if (f.problemsOnly) roots = roots.filter(r => laneProblems(model.related(index(), 'node', r.id)).length);
        if (f.query) {
            roots = roots.filter(r => Array.from(model.related(index(), 'node', r.id).nodes)
                .some(id => model.matchesQuery(model.nodeOf(index(), id) || {}, f.query)));
        }
        let soloList = solos;
        if (f.problemsOnly) soloList = soloList.filter(n => n.status !== 'online');
        if (f.query) soloList = soloList.filter(n => model.matchesQuery(n, f.query));

        problemsBtn.classList.toggle('on', !!f.problemsOnly);

        lanes = roots.map(r => renderLane(r, allRoots.indexOf(r)));
        const soloLane = renderSolos(soloList);
        if (soloLane) lanes.push(soloLane);

        clear(main);
        main.append(renderKpis(), ...lanes.map(l => l.el));
        if (!lanes.length) {
            main.append(h('div.nm-alert.muted.nmc-empty', null, icon(f.problemsOnly ? 'circle-check' : 'search'),
                h('div.msg', null, f.problemsOnly ? t('map.noProblems') : f.query ? t('map.nothingFound') : t('noNodesOrLinks'))));
        }
        main.scrollTop = scrollTop;

        renderSide(lanes.filter(l => l.rootId !== 'solo'), soloList);
        applySelection();
        scheduleDraw();
    }

    // ==================== CONNECTORS ====================

    function drawLane(lane) {
        if (!lane.svg || lane.el.classList.contains('collapsed')) return;
        const body = lane.body;
        const br = body.getBoundingClientRect();
        const sl = body.scrollLeft;
        const st = body.scrollTop;
        lane.svg.setAttribute('width', String(body.scrollWidth));
        lane.svg.setAttribute('height', String(body.scrollHeight));
        clear(lane.svg);
        for (const p of lane.pairs) {
            if (!p.a || !p.b) continue;
            const ar = p.a.getBoundingClientRect();
            const bRect = p.b.getBoundingClientRect();
            const x1 = ar.right - br.left + sl;
            const y1 = ar.top + ar.height / 2 - br.top + st;
            const x2 = bRect.left - br.left + sl;
            const y2 = bRect.top + bRect.height / 2 - br.top + st;
            const dx = Math.max(40, (x2 - x1) * 0.5);
            const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
            if (p.kind === 'ghost') { lane.svg.appendChild(svg('path', { class: 'nm-conn ghost', d })); continue; }
            if (p.kind === 'inet' || p.kind === 'inet off') { lane.svg.appendChild(svg('path', { class: `nm-conn ${p.kind}`, d })); continue; }
            if (p.kind === 'client') {
                lane.svg.appendChild(svg('path', { class: 'nm-conn online', d }));
                lane.svg.appendChild(svg('path', { class: 'nm-flow', d }));
                animated++;
                continue;
            }
            const st2 = p.link.status;
            lane.svg.appendChild(svg('path', { class: `nm-conn ${st2}`, d, 'data-link': p.link.id }));
            if (st2 === 'online') {
                lane.svg.appendChild(svg('path', { class: 'nm-flow', d, 'data-link': p.link.id }));
                animated++;
            }
            const tt = 0.62;
            const mt = 1 - tt;
            const px = mt * mt * mt * x1 + 3 * mt * mt * tt * (x1 + dx) + 3 * mt * tt * tt * (x2 - dx) + tt * tt * tt * x2;
            const py = mt * mt * mt * y1 + 3 * mt * mt * tt * y1 + 3 * mt * tt * tt * y2 + tt * tt * tt * y2;
            p.pill.style.left = `${px}px`;
            p.pill.style.top = `${py}px`;
        }
    }

    const scheduleDraw = rafThrottle(() => {
        animated = 0;
        for (const lane of lanes) drawLane(lane);
        main.classList.toggle('nm-calm', animated > MAX_ANIMATED);
        applySelection();
        applyDim();
    });

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleDraw()) : null;
    if (ro) ro.observe(main);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => scheduleDraw());

    // ==================== STATE CLASSES ====================

    function applySelection() {
        const sel = store.state.selection;
        for (const lane of lanes) {
            for (const c of lane.cards) c.classList.toggle('sel', !!sel && sel.kind === 'node' && sel.id === c.dataset.node);
            for (const p of lane.pills) p.classList.toggle('sel', !!sel && sel.kind === 'link' && sel.id === p.dataset.link);
            if (lane.svg) {
                lane.svg.querySelectorAll('path.nm-conn[data-link]').forEach(pth => {
                    pth.classList.toggle('sel', !!sel && sel.kind === 'link' && sel.id === pth.getAttribute('data-link'));
                });
            }
        }
        side.querySelectorAll('.nmc-srow').forEach(r => {
            r.classList.toggle('active', !!sel && r.dataset.target === `${sel.kind}:${sel.id}`);
        });
    }

    function applyDim() {
        const rel = hover ? model.related(index(), hover.kind, hover.id) : null;
        for (const lane of lanes) {
            if (lane.rootId === 'solo') continue;
            const inLane = !!rel && rel.nodes.has(lane.rootId);
            for (const c of lane.cards) c.classList.toggle('dim', inLane && !rel.nodes.has(c.dataset.node));
            for (const p of lane.pills) p.classList.toggle('dim', inLane && !rel.links.has(p.dataset.link));
            if (lane.svg) {
                lane.svg.querySelectorAll('[data-link]').forEach(pth => pth.classList.toggle('dim', inLane && !rel.links.has(pth.getAttribute('data-link'))));
            }
        }
    }

    // ==================== NAVIGATION ====================

    function toggleLane(lane) {
        const now = !lane.el.classList.contains('collapsed');
        lane.el.classList.toggle('collapsed', now);
        lane.toggle.setAttribute('aria-expanded', now ? 'false' : 'true');
        if (now) collapsed.add(lane.rootId); else collapsed.delete(lane.rootId);
        scheduleDraw();
    }

    function reveal(laneId) {
        const lane = lanes.find(l => l.rootId === laneId);
        if (!lane) return;
        if (lane.el.classList.contains('collapsed')) toggleLane(lane);
        lane.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        lane.el.classList.add('flash');
        setTimeout(() => lane.el.classList.remove('flash'), 900);
    }

    function laneFor(sel) {
        if (sel.kind === 'node') {
            const solo = lanes.find(l => l.rootId === 'solo' && l.cards.some(c => c.dataset.node === sel.id));
            if (solo) return solo;
            const origin = index().originByCdn.get(sel.id);
            const nodeId = origin || sel.id;
            return lanes.find(l => l.rel && l.rel.nodes.has(nodeId));
        }
        return lanes.find(l => l.rel && l.rel.links.has(sel.id));
    }

    function focus(sel) {
        if (!sel) return;
        const lane = laneFor(sel);
        if (lane) reveal(lane.rootId);
    }

    /** Polls usually return identical data; skip the DOM rebuild in that case. */
    let lastSig = '';
    function dataSignature() {
        const idx = index();
        const parts = [];
        for (const n of idx.nodes.values()) parts.push(n.id, n.status, n.onlineUsers || 0, n.label, n.flag, n.lastError || '');
        for (const l of idx.links.values()) parts.push(l.id, l.status, l.latencyMs, l.label, l.mode, l.tunnelPort, l.lastError || '');
        return parts.join('|');
    }

    // ==================== VIEW API ====================

    return {
        update(change) {
            if (change.type === 'select') { applySelection(); return; }
            if (change.type === 'data') {
                const sig = dataSignature();
                if (!change.structural && sig === lastSig) return;
                lastSig = sig;
            }
            render();
        },
        focus,
        resize: () => scheduleDraw(),
        destroy() {
            if (ro) ro.disconnect();
            tip.hide();
            clear(el);
        },
    };
}
