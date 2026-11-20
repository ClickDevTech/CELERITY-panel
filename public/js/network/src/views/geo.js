/**
 * Geo overview: nodes placed on a world map by the country of their flag.
 * Read-only (selection opens the shared inspector); positions are approximate,
 * nodes of the same country are fanned out around the country point.
 */

import { geoNaturalEarth1, geoPath, geoGraticule10 } from 'd3-geo';
import { select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom';
import { feature } from 'topojson-client';
import model from '../core/model.js';
import { t } from '../core/i18n.js';
import { h, svg, icon, clear, rafThrottle, tip } from '../ui/dom.js';
import { nodeTitle, dot, linkTip, nodeTip, count } from '../ui/format.js';
import { COUNTRY_GEO } from './geo-data.js';

const WORLD_URL = '/vendor/world-110m.json';
const ANTARCTICA = '010';
const MAX_ANIMATED = 80;
const LABEL_ZOOM = 2.2;

let worldPromise = null;
function loadWorld() {
    if (!worldPromise) {
        worldPromise = fetch(WORLD_URL, { credentials: 'same-origin' })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(topo => feature(topo, topo.objects.countries).features.filter(f => f.id !== ANTARCTICA))
            .catch(err => {
                worldPromise = null;
                throw err;
            });
    }
    return worldPromise;
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mount(el, { store, toolbar }) {
    el.className = 'nmo';

    const root = svg('svg', { role: 'img', 'aria-label': t('map.viewGeo') });
    const worldG = svg('g');
    const arcsG = svg('g');
    const markersG = svg('g');
    root.append(worldG, arcsG, markersG);
    const noGeo = h('div.nm-float.nmo-nogeo', { hidden: true });
    const badge = h('div.nm-float.nmo-badge', null, icon('loader-2', 'nm-spin'), t('map.loadingMap'));
    el.append(root, noGeo, badge);

    const layers = { cascade: true, solo: true, names: false };
    let countries = [];
    let projection = null;
    let W = 0;
    let H = 0;
    let transform = zoomIdentity;
    let userMoved = false;
    let hover = null;
    let destroyed = false;
    let markers = new Map();
    let arcs = new Map();
    let base = new Map();
    let worldReady = false;

    // ==================== TOOLBAR ====================

    const layerBtn = (key, iconName, label) => {
        const btn = h('button.nm-btn.sm', {
            type: 'button',
            'aria-pressed': 'true',
            on: {
                click: () => {
                    layers[key] = !layers[key];
                    btn.classList.toggle('on', layers[key]);
                    btn.setAttribute('aria-pressed', layers[key] ? 'true' : 'false');
                    if (key === 'names') applyLabels(); else render();
                },
            },
        }, icon(iconName), h('span.lbl', null, label));
        btn.classList.toggle('on', layers[key]);
        btn.setAttribute('aria-pressed', layers[key] ? 'true' : 'false');
        return btn;
    };
    toolbar.slot.append(
        layerBtn('cascade', 'route', t('map.layerCascades')),
        layerBtn('solo', 'server-2', t('map.layerSolo')),
        layerBtn('names', 'tag', t('map.layerNames')));

    const zoomBtn = (name, label, fn) => h('button', { type: 'button', title: label, 'aria-label': label, on: { click: fn } }, icon(name));
    el.append(h('div.nm-float.nm-zoom', null,
        zoomBtn('plus', t('map.zoomIn'), () => zoomBy(1.5)),
        zoomBtn('minus', t('map.zoomOut'), () => zoomBy(1 / 1.5)),
        h('hr'),
        zoomBtn('focus-centered', t('map.fitView'), () => fitDefault(true))));

    // ==================== PROJECTION ====================

    function setupProjection() {
        W = el.clientWidth;
        H = el.clientHeight;
        if (!W || !H) return false;
        projection = geoNaturalEarth1().fitExtent([[20, 20], [W - 20, H - 20]], { type: 'Sphere' });
        const path = geoPath(projection);
        const used = new Set();
        for (const n of store.index.nodes.values()) {
            const g = geoOf(n);
            if (g && g.numeric) used.add(g.numeric);
        }
        clear(worldG);
        worldG.appendChild(svg('path', { class: 'graticule', d: path(geoGraticule10()) }));
        for (const f of countries) {
            worldG.appendChild(svg('path', { class: `land${used.has(String(f.id)) ? ' has' : ''}`, d: path(f) || '' }));
        }
        computeBase();
        return true;
    }

    function geoOf(node) {
        if (!node || node.type === 'cdn') return null;
        const iso = model.countryFromFlag(node.flag, node.country);
        return iso ? COUNTRY_GEO.get(iso) || null : null;
    }

    /** Base (untransformed) pixel position per node; same-country nodes share a point. */
    function computeBase() {
        base = new Map();
        if (!projection) return;
        for (const n of store.index.nodes.values()) {
            const g = geoOf(n);
            if (!g) continue;
            const p = projection([g.lon, g.lat]);
            if (p) base.set(n.id, p);
        }
    }

    function screenPositions() {
        const pos = new Map();
        const groups = new Map();
        for (const [id, p] of base) {
            if (!markers.has(id)) continue;
            const key = `${Math.round(p[0])}:${Math.round(p[1])}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ id, p });
        }
        const spread = 16 * Math.min(2, Math.sqrt(transform.k));
        for (const list of groups.values()) {
            list.forEach((it, i) => {
                const [x, y] = transform.apply(it.p);
                if (list.length === 1) { pos.set(it.id, [x, y]); return; }
                const a = (i / list.length) * Math.PI * 2 - Math.PI / 2;
                const r = spread * (1 + Math.floor(list.length / 9) * 0.6);
                pos.set(it.id, [x + Math.cos(a) * r, y + Math.sin(a) * r]);
            });
        }
        for (const [cdnId, originId] of store.index.originByCdn) {
            const o = pos.get(originId);
            if (o && markers.has(cdnId)) pos.set(cdnId, [o[0] - 40, o[1] + 30]);
        }
        return pos;
    }

    function arcPath(a, b) {
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const dist = Math.hypot(dx, dy) || 1;
        let nx = -dy / dist;
        let ny = dx / dist;
        if (ny > 0) { nx = -nx; ny = -ny; }
        const bend = Math.min(dist * 0.22, 90);
        return `M${a[0]},${a[1]} Q${mx + nx * bend},${my + ny * bend} ${b[0]},${b[1]}`;
    }

    // ==================== RENDER ====================

    function isSolo(n) {
        return n.type !== 'cdn' && !model.isCascadeNode(store.index, n.id);
    }

    function nodeShown(n) {
        if (n.type === 'cdn') return layers.cascade && base.has(store.index.originByCdn.get(n.id));
        if (!base.has(n.id)) return false;
        return isSolo(n) ? layers.solo : layers.cascade;
    }

    function bindHover(target, sel, tipFn) {
        target.addEventListener('mouseenter', e => { hover = sel; applyDim(); tip.show(e.clientX, e.clientY, tipFn()); });
        target.addEventListener('mousemove', e => tip.show(e.clientX, e.clientY, tipFn()));
        target.addEventListener('mouseleave', () => { hover = null; applyDim(); tip.hide(); });
        target.addEventListener('click', e => { e.stopPropagation(); store.select(sel); });
    }

    function render() {
        if (destroyed) return;
        const index = store.index;
        computeBase();
        clear(markersG);
        clear(arcsG);
        markers = new Map();
        arcs = new Map();

        for (const n of index.nodes.values()) {
            if (!nodeShown(n)) continue;
            const role = model.roleOf(n);
            const g = svg('g', { class: `mk ${role} s-${n.status}`, 'data-node': n.id });
            if (role === 'cdn') {
                g.append(svg('rect', { x: -15, y: -9, width: 30, height: 18, rx: 6, fill: 'rgba(56,189,248,.15)', stroke: '#38bdf8' }));
                const lbl = svg('text', { class: 'cnt', x: 0, y: 4, 'text-anchor': 'middle' });
                lbl.textContent = 'CDN';
                g.append(lbl);
            } else {
                const r = role === 'standalone' ? 5 : role === 'portal' ? 8 : 7;
                g.append(svg('circle', { class: 'halo', r: r + 5 }), svg('circle', { class: 'core', r }));
                const flag = svg('text', { class: 'flag', x: r + 6, y: 5 });
                flag.textContent = n.flag || '';
                const lbl = svg('text', { class: 'lbl', x: r + 26, y: 4 });
                lbl.textContent = `${n.label || n.ip || ''}${n.onlineUsers ? ` · ${n.onlineUsers}` : ''}`;
                g.append(flag, lbl);
            }
            bindHover(g, { kind: 'node', id: n.id }, () => nodeTip(n));
            markersG.appendChild(g);
            markers.set(n.id, g);
        }

        let animated = 0;
        const allEdges = [...index.links.values(), ...index.cdnEdges.values()];
        for (const l of allEdges) {
            if (!markers.has(l.source) || !markers.has(l.target)) continue;
            const g = svg('g', { 'data-link': l.id });
            const cls = l.isCdnEdge ? 'cdn' : l.status;
            const path = svg('path', { class: `arc ${cls}` });
            const hit = svg('path', { class: 'arc-hit' });
            g.append(path);
            let flow = null;
            if (l.status === 'online' && !l.isCdnEdge) {
                flow = svg('path', { class: 'arc-flow' });
                g.append(flow);
                animated++;
            }
            g.append(hit);
            bindHover(hit, { kind: 'link', id: l.id }, () => linkTip(store.index, l));
            arcsG.appendChild(g);
            arcs.set(l.id, { g, path, hit, flow, source: l.source, target: l.target });
        }
        el.classList.toggle('nm-calm', animated > MAX_ANIMATED);

        renderNoGeo();
        renderBadge();
        reposition();
        applyLabels();
        applyDim();
    }

    const reposition = rafThrottle(() => {
        if (destroyed) return;
        worldG.setAttribute('transform', transform.toString());
        const pos = screenPositions();
        for (const [id, g] of markers) {
            const p = pos.get(id);
            if (p) g.setAttribute('transform', `translate(${p[0]},${p[1]})`);
        }
        for (const a of arcs.values()) {
            const pa = pos.get(a.source);
            const pb = pos.get(a.target);
            if (!pa || !pb) continue;
            const d = arcPath(pa, pb);
            a.path.setAttribute('d', d);
            a.hit.setAttribute('d', d);
            if (a.flow) a.flow.setAttribute('d', d);
        }
        applyLabels();
    });

    function applyLabels() {
        root.classList.toggle('labels-off', !(layers.names || transform.k >= LABEL_ZOOM));
    }

    function renderNoGeo() {
        clear(noGeo);
        const list = Array.from(store.index.nodes.values()).filter(n => n.type !== 'cdn' && !geoOf(n));
        noGeo.hidden = !list.length;
        if (!list.length) return;
        noGeo.append(
            h('div.nm-sec-title', null, t('map.noGeoTitle'), ` · ${list.length}`),
            h('div.hint', null, t('map.noGeoHint')),
            ...list.slice(0, 50).map(n => h('button.nmc-srow', {
                type: 'button',
                dataset: { node: n.id },
                on: { click: () => store.select({ kind: 'node', id: n.id }) },
            }, dot(n.status), h('span.nm', null, nodeTitle(n)))));
    }

    function renderBadge() {
        if (!worldReady) return;
        const isos = new Set();
        for (const n of store.index.nodes.values()) {
            const iso = geoOf(n) ? model.countryFromFlag(n.flag, n.country) : null;
            if (iso) isos.add(iso);
        }
        clear(badge);
        badge.append(icon('world'), `${t('map.overview')} · ${count(isos.size, 'map.countriesPlural')}`);
        badge.title = t('map.geoApproxHint');
    }

    // ==================== HIGHLIGHT ====================

    function applyDim() {
        const sel = store.state.selection;
        const focusSel = hover || sel;
        const rel = focusSel ? model.related(store.index, focusSel.kind, focusSel.id) : null;
        const q = store.state.filter.query;
        for (const [id, g] of markers) {
            const n = store.index.nodes.get(id);
            const dim = rel ? !rel.nodes.has(id) : !!q && !model.matchesQuery(n, q);
            g.classList.toggle('dim', dim);
            g.classList.toggle('sel', !!sel && sel.kind === 'node' && sel.id === id);
        }
        for (const [id, a] of arcs) {
            a.g.classList.toggle('dim', rel ? !rel.links.has(id) : !!q);
            a.path.classList.toggle('sel', !!sel && sel.kind === 'link' && sel.id === id);
        }
        noGeo.querySelectorAll('.nmc-srow').forEach(r => {
            r.classList.toggle('active', !!sel && sel.kind === 'node' && sel.id === r.dataset.node);
        });
    }

    // ==================== ZOOM ====================

    const svgSel = select(root);
    const zoomBehavior = d3zoom()
        .scaleExtent([0.8, 12])
        .on('zoom', e => {
            if (e.sourceEvent) userMoved = true;
            transform = e.transform;
            reposition();
        });
    svgSel.call(zoomBehavior).on('dblclick.zoom', null);
    root.addEventListener('click', e => {
        if (e.target === root || e.target.closest('g') === worldG) store.select(null);
    });

    let animFrame = 0;
    function animateTo(target, ms = 450) {
        cancelAnimationFrame(animFrame);
        if (reducedMotion() || ms <= 0) {
            zoomBehavior.transform(svgSel, target);
            return;
        }
        const from = transform;
        const t0 = performance.now();
        const step = now => {
            const p = Math.min(1, (now - t0) / ms);
            const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
            const k = from.k + (target.k - from.k) * e;
            const x = from.x + (target.x - from.x) * e;
            const y = from.y + (target.y - from.y) * e;
            zoomBehavior.transform(svgSel, zoomIdentity.translate(x, y).scale(k));
            if (p < 1 && !destroyed) animFrame = requestAnimationFrame(step);
        };
        animFrame = requestAnimationFrame(step);
    }

    function zoomBy(factor) {
        const k = Math.max(0.8, Math.min(12, transform.k * factor));
        const cx = W / 2;
        const cy = H / 2;
        const x = cx - ((cx - transform.x) / transform.k) * k;
        const y = cy - ((cy - transform.y) / transform.k) * k;
        animateTo(zoomIdentity.translate(x, y).scale(k), 200);
    }

    function fitTo(ids, animate) {
        const pts = ids.map(id => base.get(id)).filter(Boolean);
        if (!pts.length || !W) {
            if (animate) animateTo(zoomIdentity); else zoomBehavior.transform(svgSel, zoomIdentity);
            return;
        }
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        const y0 = Math.min(...ys);
        const y1 = Math.max(...ys);
        const bw = Math.max(x1 - x0, 60);
        const bh = Math.max(y1 - y0, 60);
        const k = Math.min(8, Math.max(0.8, Math.min((W - 200) / bw, (H - 160) / bh)));
        const target = zoomIdentity.translate(W / 2 - ((x0 + x1) / 2) * k, H / 2 - ((y0 + y1) / 2) * k).scale(k);
        if (animate) animateTo(target); else zoomBehavior.transform(svgSel, target);
    }

    function fitDefault(animate) {
        const cascade = Array.from(base.keys()).filter(id => model.isCascadeNode(store.index, id));
        fitTo(cascade.length ? cascade : Array.from(base.keys()), animate);
        userMoved = false;
    }

    function focus(sel) {
        if (!sel || !W) return;
        let ids = [];
        if (sel.kind === 'node') {
            const origin = store.index.originByCdn.get(sel.id);
            ids = [origin || sel.id];
        } else {
            const e = model.edgeOf(store.index, sel.id);
            if (e) ids = [e.source, e.target].map(id => store.index.originByCdn.get(id) || id);
        }
        ids = ids.filter(id => base.has(id));
        if (!ids.length) return;
        if (ids.length === 1) {
            const p = base.get(ids[0]);
            const k = Math.max(transform.k, 3);
            animateTo(zoomIdentity.translate(W / 2 - p[0] * k, H / 2 - p[1] * k).scale(k));
        } else {
            fitTo(ids, true);
        }
        userMoved = true;
    }

    // ==================== LIFECYCLE ====================

    let fitted = false;
    function resize() {
        const w = el.clientWidth;
        const ht = el.clientHeight;
        if (!w || !ht || (w === W && ht === H && projection)) return;
        if (!setupProjection()) return;
        if (!fitted || !userMoved) { fitDefault(false); fitted = true; }
        render();
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(el);

    loadWorld().then(features => {
        if (destroyed) return;
        countries = features;
        worldReady = true;
        projection = null;
        W = 0;
        resize();
    }).catch(err => {
        if (destroyed) return;
        clear(badge);
        badge.append(icon('alert-triangle'), `${t('map.mapLoadFailed')}: ${err.message}`);
    });

    return {
        update(change) {
            if (change.type === 'select') { applyDim(); return; }
            if (change.type === 'filter') { applyDim(); return; }
            if (!projection) { resize(); return; }
            if (change.structural) setupProjection();
            render();
        },
        focus,
        resize,
        destroy() {
            destroyed = true;
            cancelAnimationFrame(animFrame);
            if (ro) ro.disconnect();
            svgSel.on('.zoom', null);
            tip.hide();
            clear(el);
        },
    };
}
