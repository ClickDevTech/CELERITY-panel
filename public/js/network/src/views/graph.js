/**
 * Graph view: free-form topology editor.
 * Cytoscape owns positions, pan/zoom, node dragging and the dagre layout;
 * cards are an HTML overlay and edges an SVG overlay so they share the look
 * of the chains view (horizontal S-curves with status pills).
 */

import cytoscape from 'cytoscape';
import cytoscapeDagre from 'cytoscape-dagre';
import model from '../core/model.js';
import { api, isObjectId } from '../core/api.js';
import { t } from '../core/i18n.js';
import { h, svg, icon, clear, toast, debounce, tip } from '../ui/dom.js';
import { ROLE_ORDER, roleName, roleTag, dot, pillContent, linkTip, nodeTip } from '../ui/format.js';

let dagreRegistered = false;
function ensureDagre() {
    if (dagreRegistered) return;
    cytoscape.use(cytoscapeDagre);
    dagreRegistered = true;
}

const CARD_W = 200;
const CARD_H = 60;
const INET = 76;
const SAVE_DELAY_MS = 800;
/** Above this many animated edges the flow animation is switched off. */
const MAX_ANIMATED = 80;
/** Pill collision avoidance is O(n^2); skip it on very large maps. */
const MAX_PILL_COLLISION = 300;
const HINT_KEY = 'celerity.networkGraphHint';
const LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 26, rankSep: 150, edgeSep: 20, padding: 60 };

const ROLE_VAR = {
    portal: 'var(--nm-portal)',
    relay: 'var(--nm-relay)',
    bridge: 'var(--nm-bridge)',
    standalone: 'var(--nm-standalone)',
    cdn: 'var(--nm-cdn)',
};

export function mount(el, { store, actions, toolbar }) {
    ensureDagre();
    el.className = 'nmg';

    const cyEl = h('div.nmg-cy');
    const edgesSvg = svg('svg', { class: 'nmg-edges' });
    const pillsLayer = h('div.nmg-pills');
    const cardsLayer = h('div.nmg-cards');
    const dragSvg = svg('svg', { class: 'nmg-drag' });
    el.append(cyEl, edgesSvg, pillsLayer, cardsLayer, dragSvg);

    const cy = cytoscape({
        container: cyEl,
        elements: [],
        minZoom: 0.2,
        maxZoom: 2.5,
        wheelSensitivity: 0.25,
        boxSelectionEnabled: false,
        style: [
            { selector: 'node', style: { shape: 'round-rectangle', width: CARD_W, height: CARD_H, 'background-opacity': 0, 'border-width': 0, 'overlay-opacity': 0 } },
            { selector: 'node[role = "internet"]', style: { shape: 'ellipse', width: INET, height: INET } },
            { selector: '.hidden', style: { display: 'none' } },
            // Edges are drawn in the SVG overlay; cytoscape keeps them only for the layout.
            { selector: 'edge', style: { opacity: 0, events: 'no', 'curve-style': 'straight' } },
        ],
    });

    const cards = new Map();
    const edges = new Map();
    let hover = null;
    let needsFit = true;
    let destroyed = false;

    // ==================== CHROME ====================

    const chips = h('div.nm-chips', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
    toolbar.slot.append(chips);

    function renderChips() {
        const counts = {};
        for (const n of store.index.nodes.values()) {
            const r = model.roleOf(n);
            counts[r] = (counts[r] || 0) + 1;
        }
        const roles = store.state.filter.roles;
        clear(chips);
        for (const r of ROLE_ORDER) {
            if (!counts[r]) continue;
            const chip = h(`button.nm-chip${roles.has(r) ? '.off' : ''}`, {
                type: 'button',
                'aria-pressed': roles.has(r) ? 'false' : 'true',
                title: roles.has(r) ? t('map.showRole') : t('map.hideRole'),
                on: { click: () => store.toggleRole(r) },
            }, h('span.sw'), h('span.lbl', null, roleName(r)), h('span.cnt', null, String(counts[r])));
            chip.style.setProperty('--rc', ROLE_VAR[r]);
            chips.append(chip);
        }
    }

    const zoomAt = factor => cy.animate({
        zoom: { level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } },
    }, { duration: 160 });
    const fit = () => cy.animate({ fit: { eles: cy.nodes(':visible'), padding: 60 } }, { duration: 300 });

    const zoomBtn = (name, label, fn) => h('button', { type: 'button', title: label, 'aria-label': label, on: { click: fn } }, icon(name));
    el.append(h('div.nm-float.nm-zoom', null,
        zoomBtn('plus', t('map.zoomIn'), () => zoomAt(1.25)),
        zoomBtn('minus', t('map.zoomOut'), () => zoomAt(1 / 1.25)),
        h('hr'),
        zoomBtn('focus-centered', t('map.fitView'), fit),
        zoomBtn('sitemap', t('map.autoLayout'), () => runLayout(true, true))));

    el.append(h('div.nm-float.nm-legend', null,
        h('span', null, h('span.ln', { style: { borderColor: '#4ade80' } }), t('map.status.online')),
        h('span', null, h('span.ln', { style: { borderColor: '#ef4444' } }), t('map.status.error')),
        h('span', null, h('span.ln', { style: { borderColor: '#64748b', borderTopStyle: 'dashed' } }), t('map.legendInactive')),
        h('span', null, h('span.ln', { style: { borderColor: '#38bdf8', borderTopStyle: 'dashed' } }), 'CDN')));

    let hintDismissed = false;
    try { hintDismissed = localStorage.getItem(HINT_KEY) === '1'; } catch (_) { /* storage may be disabled */ }
    if (!hintDismissed) {
        const hint = h('div.nm-float.nm-hint', null,
            h('span.k', null, icon('plus')),
            h('span', null, t('map.dragHint')),
            h('button.nm-btn.ghost.sm.icon', {
                type: 'button',
                'aria-label': t('map.close'),
                on: {
                    click: () => {
                        hint.remove();
                        try { localStorage.setItem(HINT_KEY, '1'); } catch (_) { /* ignore */ }
                    },
                },
            }, icon('x')));
        el.append(hint);
    }

    // ==================== ELEMENTS ====================

    function internetEdges(index) {
        if (!index.internet) return [];
        const res = [];
        for (const n of index.nodes.values()) {
            if (n.type === 'cdn' || !model.isExitNode(n)) continue;
            res.push({
                id: `internet-${n.id}`,
                source: n.id,
                target: model.INTERNET_ID,
                status: n.status === 'online' ? 'online' : 'offline',
                isInternetEdge: true,
            });
        }
        return res;
    }

    function edgeList(index) {
        return [...index.links.values(), ...index.cdnEdges.values(), ...internetEdges(index)];
    }

    function nodeList(index) {
        const list = Array.from(index.nodes.values());
        if (index.internet) list.push(index.internet);
        return list;
    }

    /** Place a node that has no saved position next to an already placed neighbour. */
    function placeNew(node, index) {
        const neighbours = [
            ...model.inLinks(index, node.id).map(l => ({ id: l.source, dx: CARD_W + 150 })),
            ...model.outLinks(index, node.id).map(l => ({ id: l.target, dx: -(CARD_W + 150) })),
        ];
        const cdnOrigin = index.originByCdn.get(node.id);
        if (cdnOrigin) neighbours.push({ id: cdnOrigin, dx: -(CARD_W + 150) });
        for (const nb of neighbours) {
            const ele = cy.getElementById(nb.id);
            if (ele.length && ele.data('placed')) {
                const p = ele.position();
                return { x: p.x + nb.dx, y: p.y + (cy.nodes().length % 3) * 30 };
            }
        }
        const placed = cy.nodes().filter(n => n.data('placed'));
        if (!placed.length) return { x: 0, y: 0 };
        const bb = placed.boundingBox();
        return { x: bb.x1 + CARD_W / 2 + (cy.nodes().length % 4) * (CARD_W + 30), y: bb.y2 + CARD_H + 40 };
    }

    function internetPosition() {
        const exits = cy.nodes().filter(n => n.data('placed') && n.id() !== model.INTERNET_ID && n.data('exit'));
        if (!exits.length) return { x: 0, y: 0 };
        const bb = cy.nodes().filter(n => n.data('placed') && n.id() !== model.INTERNET_ID).boundingBox();
        let y = 0;
        exits.forEach(n => { y += n.position('y'); });
        return { x: bb.x2 + 260, y: y / exits.length };
    }

    function sync(structural) {
        const index = store.index;
        const nodes = nodeList(index);
        const edgeData = edgeList(index);
        const firstLoad = cy.nodes().length === 0;

        cy.batch(() => {
            const keepNodes = new Set(nodes.map(n => n.id));
            const keepEdges = new Set(edgeData.map(e => e.id));
            cy.edges().forEach(e => { if (!keepEdges.has(e.id())) e.remove(); });
            cy.nodes().forEach(n => { if (!keepNodes.has(n.id())) n.remove(); });

            for (const n of nodes) {
                const data = { id: n.id, role: model.roleOf(n), exit: n.type !== 'cdn' && model.isExitNode(n) };
                const ele = cy.getElementById(n.id);
                if (ele.length) { ele.data(data); continue; }
                const saved = n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y) ? n.position : null;
                cy.add({ group: 'nodes', data: { ...data, placed: !!saved, saved: !!saved }, position: saved ? { x: saved.x, y: saved.y } : { x: 0, y: 0 } });
            }
            for (const e of edgeData) {
                if (cy.getElementById(e.id).length) continue;
                cy.add({ group: 'edges', data: { id: e.id, source: e.source, target: e.target } });
            }
        });

        if (structural) {
            const real = cy.nodes().filter(n => n.id() !== model.INTERNET_ID);
            const saved = real.filter(n => n.data('saved')).length;
            // A full layout moves every node. Use it only when none are saved;
            // otherwise keep those coordinates and place just the new nodes.
            if (firstLoad && real.length && saved === 0) {
                runLayout(false, false);
            } else {
                cy.nodes().forEach(n => {
                    if (n.data('placed') || n.id() === model.INTERNET_ID) return;
                    n.position(placeNew(model.nodeOf(index, n.id()), index));
                    n.data('placed', true);
                });
                const inet = cy.getElementById(model.INTERNET_ID);
                if (inet.length && !inet.data('placed')) {
                    inet.position(internetPosition());
                    inet.data('placed', true);
                }
                if (firstLoad) fitNow();
            }
        }

        syncCards();
        renderChips();
        el.classList.toggle('nm-calm', index.links.size > MAX_ANIMATED);
        applyClasses();
    }

    function runLayout(animate, persist) {
        const layout = cy.layout({ ...LAYOUT, animate: !!animate, animationDuration: 350, fit: true });
        layout.one('layoutstop', () => {
            cy.nodes().forEach(n => n.data('placed', true));
            if (persist) savePositions(cy.nodes().map(n => n.id()));
            needsFit = cy.width() === 0;
            renderOverlay();
        });
        layout.run();
    }

    function fitNow() {
        if (cy.width() === 0) { needsFit = true; return; }
        cy.fit(cy.nodes(':visible'), 60);
        if (cy.zoom() > 1.2) cy.zoom({ level: 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
        needsFit = false;
    }

    // ==================== POSITIONS ====================

    const dirty = new Set();
    const flushSave = debounce(async () => {
        const ids = Array.from(dirty);
        dirty.clear();
        const positions = [];
        for (const id of ids) {
            const ele = cy.getElementById(id);
            if (!ele.length || !isObjectId(id)) continue;
            const p = ele.position();
            positions.push({ id, x: p.x, y: p.y });
            const node = store.index.nodes.get(id);
            if (node) node.position = { x: p.x, y: p.y };
        }
        if (!positions.length) return;
        try {
            await api.savePositions(positions);
        } catch (err) {
            toast(`${t('map.positionsSaveFailed')}: ${err.message}`, 'error');
        }
    }, SAVE_DELAY_MS);

    function savePositions(ids) {
        ids.forEach(id => { if (isObjectId(id)) dirty.add(id); });
        flushSave();
    }

    cy.on('dragfree', 'node', e => savePositions([e.target.id()]));

    // ==================== CARDS ====================

    function cardSig(node, role) {
        return [role, node.status, node.label, node.flag, node.onlineUsers, node.domain, node.ip].join('|');
    }

    function syncCards() {
        const index = store.index;
        const seen = new Set();
        cy.nodes().forEach(ele => {
            const id = ele.id();
            const node = model.nodeOf(index, id);
            if (!node) return;
            seen.add(id);
            const role = model.roleOf(node);
            let rec = cards.get(id);
            if (!rec) {
                rec = { el: h('div'), sig: '' };
                rec.el.dataset.id = id;
                cardsLayer.appendChild(rec.el);
                cards.set(id, rec);
            }
            const sig = cardSig(node, role);
            if (sig === rec.sig) return;
            rec.sig = sig;
            rec.el.className = `nmg-card r-${role} s-${node.status}${role === 'internet' ? ' internet' : ''}`;
            clear(rec.el);
            if (role === 'internet') {
                rec.el.append(h('div.flag', null, '🌐'), h('div.nm', null, t('map.internet')));
                return;
            }
            rec.el.append(
                h('div.flag', null, node.flag || '🖥️'),
                h('div.body', null,
                    h('div.nm', null, node.label || node.ip || ''),
                    h('div.meta', null,
                        roleTag(role),
                        node.onlineUsers ? h('span.users', null, icon('users'), String(node.onlineUsers)) : null,
                        role === 'cdn' ? h('span', null, node.domain || '') : null)),
                h('span.st', null, dot(node.status)));
            if (role !== 'cdn') {
                const handle = h('div.nmg-handle', { title: t('map.dragHint') }, icon('plus'));
                handle.addEventListener('pointerdown', e => startConnect(e, id, handle));
                rec.el.appendChild(handle);
            }
        });
        for (const [id, rec] of cards) {
            if (!seen.has(id)) { rec.el.remove(); cards.delete(id); }
        }
    }

    function positionCards() {
        const z = cy.zoom();
        cardsLayer.classList.toggle('compact', z < 0.6);
        cy.nodes().forEach(n => {
            const rec = cards.get(n.id());
            if (!rec) return;
            const p = n.renderedPosition();
            const size = n.id() === model.INTERNET_ID ? INET : null;
            const w = size || CARD_W;
            const ht = size || CARD_H;
            rec.el.style.transform = `translate(${p.x - w / 2}px,${p.y - ht / 2}px) scale(${z})`;
        });
    }

    // ==================== EDGES ====================

    function edgeInfo(id) {
        const index = store.index;
        if (id.startsWith('internet-')) {
            const node = index.nodes.get(id.slice(9));
            return node ? { id, source: node.id, status: node.status === 'online' ? 'online' : 'offline', isInternetEdge: true } : null;
        }
        return model.edgeOf(index, id);
    }

    function forwardWheel(target) {
        target.addEventListener('wheel', ev => {
            ev.preventDefault();
            const canvas = cyEl.querySelector('canvas:last-of-type') || cyEl;
            canvas.dispatchEvent(new WheelEvent('wheel', ev));
        }, { passive: false });
    }

    function bindEdge(target, id) {
        target.addEventListener('mouseenter', ev => {
            const info = edgeInfo(id);
            if (!info) return;
            hover = info.isInternetEdge ? { kind: 'node', id: info.source } : { kind: 'link', id };
            applyClasses();
            if (!info.isInternetEdge) tip.show(ev.clientX, ev.clientY, linkTip(store.index, info));
        });
        target.addEventListener('mousemove', ev => {
            const info = edgeInfo(id);
            if (info && !info.isInternetEdge) tip.show(ev.clientX, ev.clientY, linkTip(store.index, info));
        });
        target.addEventListener('mouseleave', () => {
            hover = null;
            tip.hide();
            applyClasses();
        });
        target.addEventListener('click', ev => {
            ev.stopPropagation();
            const info = edgeInfo(id);
            if (!info) return;
            const act = ev.target.closest && ev.target.closest('.act');
            if (act && !info.isInternetEdge && !info.isCdnEdge) { actions.deploy(id); return; }
            store.select(info.isInternetEdge ? { kind: 'node', id: info.source } : { kind: 'link', id });
        });
        forwardWheel(target);
    }

    function ensureEdge(id) {
        let rec = edges.get(id);
        if (rec) return rec;
        const g = svg('g');
        const path = svg('path', { class: 'nm-conn' });
        const flow = svg('path', { class: 'nm-flow' });
        const hit = svg('path', { class: 'nm-hit' });
        g.append(path, flow, hit);
        edgesSvg.appendChild(g);
        bindEdge(hit, id);
        let pill = null;
        if (!id.startsWith('internet-')) {
            pill = h('div.nm-pill', { role: 'button', tabindex: '-1' });
            pillsLayer.appendChild(pill);
            bindEdge(pill, id);
        }
        rec = { g, path, flow, hit, pill, key: '', w: 80 };
        edges.set(id, rec);
        return rec;
    }

    function halfWidth(n) {
        return ((n.id() === model.INTERNET_ID ? INET : CARD_W) / 2) * cy.zoom();
    }

    function geometry(e) {
        const s = e.source();
        const tg = e.target();
        const z = cy.zoom();
        const sp = s.renderedPosition();
        const tp = tg.renderedPosition();
        const x1 = sp.x + halfWidth(s);
        const y1 = sp.y;
        const x2 = tp.x - halfWidth(tg);
        const y2 = tp.y;
        const dx = Math.max(40 * z, Math.abs(x2 - x1) * 0.5);
        const c1 = x1 + dx;
        const c2 = x2 - dx;
        return {
            d: `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`,
            px: (x1 + 3 * c1 + 3 * c2 + x2) / 8,
            py: (y1 + y2) / 2,
        };
    }

    let classes = { nodes: new Map(), edges: new Map() };

    function drawEdges() {
        const z = cy.zoom();
        const ps = Math.min(1, Math.max(0.75, z));
        pillsLayer.classList.toggle('tiny', z < 0.45);
        const seen = new Set();
        const pills = [];
        cy.edges().forEach(e => {
            const id = e.id();
            const info = edgeInfo(id);
            if (!info) return;
            seen.add(id);
            const rec = ensureEdge(id);
            const hidden = e.hasClass('hidden');
            rec.g.classList.toggle('hidden', hidden);
            if (rec.pill) rec.pill.classList.toggle('hidden', hidden);
            if (hidden) return;

            const st = classes.edges.get(id) || '';
            const geo = geometry(e);
            const kind = info.isInternetEdge ? `inet${info.status === 'online' ? '' : ' off'}` : info.isCdnEdge ? 'cdn' : info.status;
            rec.path.setAttribute('d', geo.d);
            rec.path.setAttribute('class', `nm-conn ${kind}${st}`);
            rec.hit.setAttribute('d', geo.d);
            const flowing = info.status === 'online' && !info.isInternetEdge && !info.isCdnEdge;
            rec.flow.style.display = flowing ? '' : 'none';
            if (flowing) {
                rec.flow.setAttribute('d', geo.d);
                rec.flow.setAttribute('class', `nm-flow${st.includes('faded') ? ' faded' : ''}`);
            }
            if (rec.pill) {
                const key = `${info.status}|${info.latencyMs}|${info.mode}`;
                rec.pill.className = `nm-pill ${info.isCdnEdge ? 'cdn' : info.status}${st}`;
                if (key !== rec.key) {
                    rec.pill.replaceChildren();
                    rec.pill.append(...pillContent(info).map(c => (typeof c === 'string' ? document.createTextNode(c) : c)));
                    rec.key = key;
                    rec.w = rec.pill.offsetWidth || 80;
                }
                pills.push({ rec, x: geo.px, y: geo.py, w: rec.w * ps, h: 24 * ps });
            }
        });
        placePills(pills, ps);
        for (const [id, rec] of edges) {
            if (seen.has(id)) continue;
            rec.g.remove();
            if (rec.pill) rec.pill.remove();
            edges.delete(id);
        }
    }

    /** Push overlapping pills apart vertically so neighbouring labels stay readable. */
    function placePills(list, ps) {
        if (list.length <= MAX_PILL_COLLISION) {
            const gap = 4;
            list.sort((a, b) => a.y - b.y);
            for (let i = 0; i < list.length; i++) {
                for (let j = 0; j < i; j++) {
                    const a = list[j];
                    const b = list[i];
                    if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && b.y - a.y < (a.h + b.h) / 2 + gap) {
                        b.y = a.y + (a.h + b.h) / 2 + gap;
                    }
                }
            }
        }
        for (const p of list) {
            p.rec.pill.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-50%) scale(${ps})`;
        }
    }

    function renderOverlay() {
        if (destroyed) return;
        positionCards();
        drawEdges();
    }
    cy.on('render', renderOverlay);

    // ==================== HIGHLIGHT / FILTER ====================

    function focusSet() {
        const sel = hover || store.state.selection;
        if (!sel) return null;
        const index = store.index;
        if (sel.kind === 'node' && sel.id === model.INTERNET_ID) {
            const nodes = new Set([model.INTERNET_ID]);
            const links = new Set();
            for (const n of index.nodes.values()) {
                if (n.type !== 'cdn' && model.isExitNode(n)) { nodes.add(n.id); links.add(`internet-${n.id}`); }
            }
            return { nodes, links };
        }
        const rel = model.related(index, sel.kind, sel.id);
        for (const id of Array.from(rel.nodes)) {
            const n = index.nodes.get(id);
            if (n && n.type !== 'cdn' && model.isExitNode(n)) {
                rel.nodes.add(model.INTERNET_ID);
                rel.links.add(`internet-${id}`);
            }
        }
        return rel;
    }

    function applyClasses() {
        const index = store.index;
        const f = store.state.filter;
        const sel = store.state.selection;
        const set = focusSet();
        const matches = id => {
            const n = index.nodes.get(id);
            return !!n && model.matchesQuery(n, f.query);
        };
        const anyMatch = !!f.query && Array.from(index.nodes.keys()).some(matches);
        const anyExitVisible = Array.from(index.nodes.values()).some(n => n.type !== 'cdn' && model.isExitNode(n) && !f.roles.has(model.roleOf(n)));

        const next = { nodes: new Map(), edges: new Map() };
        cy.batch(() => {
            cy.nodes().forEach(n => {
                const id = n.id();
                const role = n.data('role');
                const hidden = id === model.INTERNET_ID ? !anyExitVisible : f.roles.has(role);
                n.toggleClass('hidden', hidden);
                let faded = false;
                if (set) faded = !set.nodes.has(id);
                else if (anyMatch) faded = !matches(id);
                next.nodes.set(id, { hidden, faded, match: anyMatch && matches(id) });
            });
            cy.edges().forEach(e => {
                const id = e.id();
                const hidden = e.source().hasClass('hidden') || e.target().hasClass('hidden');
                e.toggleClass('hidden', hidden);
                let st = '';
                if (set) st = set.links.has(id) ? ' hl' : ' faded';
                else if (anyMatch) st = ' faded';
                if (sel && sel.kind === 'link' && sel.id === id) st += ' sel';
                next.edges.set(id, st);
            });
        });
        classes = next;

        for (const [id, rec] of cards) {
            const c = next.nodes.get(id) || {};
            rec.el.classList.toggle('hidden', !!c.hidden);
            rec.el.classList.toggle('faded', !!c.faded);
            rec.el.classList.toggle('match', !!c.match);
            rec.el.classList.toggle('hover', !!hover && hover.kind === 'node' && hover.id === id);
            rec.el.classList.toggle('sel', !!sel && sel.kind === 'node' && sel.id === id);
        }
        renderOverlay();
    }

    // ==================== INTERACTION ====================

    cy.on('tap', 'node', e => store.select({ kind: 'node', id: e.target.id() }));
    cy.on('tap', e => { if (e.target === cy) store.select(null); });
    cy.on('mouseover', 'node', e => {
        hover = { kind: 'node', id: e.target.id() };
        applyClasses();
        const node = model.nodeOf(store.index, e.target.id());
        if (node && node.id !== model.INTERNET_ID && e.originalEvent) tip.show(e.originalEvent.clientX, e.originalEvent.clientY, nodeTip(node));
    });
    cy.on('mousemove', 'node', e => {
        const node = model.nodeOf(store.index, e.target.id());
        if (node && node.id !== model.INTERNET_ID && e.originalEvent && !connect) tip.show(e.originalEvent.clientX, e.originalEvent.clientY, nodeTip(node));
    });
    cy.on('mouseout', 'node', () => {
        hover = null;
        tip.hide();
        applyClasses();
    });
    cy.on('grab', 'node', () => tip.hide());

    // ==================== DRAG TO CONNECT ====================

    let connect = null;

    function nodeAt(clientX, clientY) {
        const r = cyEl.getBoundingClientRect();
        const pan = cy.pan();
        const z = cy.zoom();
        const x = (clientX - r.left - pan.x) / z;
        const y = (clientY - r.top - pan.y) / z;
        return cy.nodes().filter(n => {
            if (n.hasClass('hidden')) return false;
            const bb = n.boundingBox();
            return x >= bb.x1 && x <= bb.x2 && y >= bb.y1 && y <= bb.y2;
        })[0] || null;
    }

    function startConnect(e, sourceId, handle) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        tip.hide();
        const r = dragSvg.getBoundingClientRect();
        const hr = handle.getBoundingClientRect();
        const path = svg('path', { fill: 'none', stroke: '#818cf8', 'stroke-width': '2.5', 'stroke-dasharray': '6 5' });
        const tipDot = svg('circle', { r: '5', fill: '#818cf8' });
        clear(dragSvg);
        dragSvg.append(path, tipDot);
        connect = {
            sourceId,
            x0: hr.left + hr.width / 2 - r.left,
            y0: hr.top + hr.height / 2 - r.top,
            target: null,
            path,
            tipDot,
        };
        document.addEventListener('pointermove', moveConnect);
        document.addEventListener('pointerup', endConnect);
        document.addEventListener('pointercancel', cancelConnect);
    }

    function moveConnect(e) {
        if (!connect) return;
        const r = dragSvg.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const mx = (connect.x0 + x) / 2;
        connect.path.setAttribute('d', `M${connect.x0},${connect.y0} C${mx},${connect.y0} ${mx},${y} ${x},${y}`);
        connect.tipDot.setAttribute('cx', String(x));
        connect.tipDot.setAttribute('cy', String(y));
        const n = nodeAt(e.clientX, e.clientY);
        const role = n ? n.data('role') : null;
        const ok = n && n.id() !== connect.sourceId && role !== 'internet' && role !== 'cdn';
        connect.target = ok ? n.id() : null;
        for (const [id, rec] of cards) rec.el.classList.toggle('drop', id === connect.target);
    }

    function stopConnect() {
        document.removeEventListener('pointermove', moveConnect);
        document.removeEventListener('pointerup', endConnect);
        document.removeEventListener('pointercancel', cancelConnect);
        clear(dragSvg);
        for (const rec of cards.values()) rec.el.classList.remove('drop');
    }

    function endConnect() {
        const c = connect;
        connect = null;
        stopConnect();
        if (c && c.target) actions.createLink(c.sourceId, c.target);
    }

    function cancelConnect() {
        connect = null;
        stopConnect();
    }

    // ==================== KEYBOARD / RESIZE ====================

    function onKey(e) {
        if (!el.isConnected || el.offsetParent === null) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest && e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
        if (e.key === 'f' || e.key === 'F') fit();
    }
    document.addEventListener('keydown', onKey);

    function resize() {
        cy.resize();
        if (needsFit && cy.width() > 0 && cy.nodes().length) fitNow();
        renderOverlay();
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(el);

    function focus(sel) {
        if (!sel) return;
        let eles = cy.collection();
        if (sel.kind === 'node') {
            eles = cy.getElementById(sel.id);
        } else {
            const e = cy.getElementById(sel.id);
            if (e.length) eles = e.connectedNodes();
        }
        if (!eles.length || eles.some(n => n.hasClass('hidden'))) return;
        cy.animate({ center: { eles }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: 300 });
    }

    // ==================== VIEW API ====================

    return {
        update(change) {
            if (change.type === 'data') sync(!!change.structural);
            else if (change.type === 'filter') { renderChips(); applyClasses(); }
            else applyClasses();
        },
        focus,
        resize,
        destroy() {
            destroyed = true;
            if (connect) cancelConnect();
            if (dirty.size) flushSave.flush();
            document.removeEventListener('keydown', onKey);
            if (ro) ro.disconnect();
            tip.hide();
            cy.destroy();
            clear(el);
        },
    };
}
