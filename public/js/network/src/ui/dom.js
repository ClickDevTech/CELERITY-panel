/**
 * Minimal DOM helpers. All dynamic text goes through text nodes, never innerHTML,
 * so node names and error messages from the server cannot inject markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.cls1.cls2', { title, dataset: {...}, on: { click }, style: {...} }, child, ...)
 * Children: strings/numbers (text), nodes, arrays, null/false (skipped).
 */
export function h(spec, attrs, ...children) {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    applyAttrs(el, attrs);
    append(el, children);
    return el;
}

export function svg(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
        }
    }
    return el;
}

function applyAttrs(el, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style') Object.assign(el.style, v);
        else if (k === 'on') for (const [evt, fn] of Object.entries(v)) el.addEventListener(evt, fn);
        else if (k === 'text') el.textContent = String(v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
    }
}

export function append(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false || child === '') continue;
        if (Array.isArray(child)) append(el, child);
        else if (child instanceof Node) el.appendChild(child);
        else el.appendChild(document.createTextNode(String(child)));
    }
    return el;
}

export function icon(name, cls) {
    const i = document.createElement('i');
    i.className = `ti ti-${name}${cls ? ` ${cls}` : ''}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

export function toast(message, type = 'success') {
    if (typeof window.showToast === 'function') window.showToast(String(message), type);
}

/** Run fn at most once per animation frame. */
export function rafThrottle(fn) {
    let queued = false;
    let lastArgs = null;
    return (...args) => {
        lastArgs = args;
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            fn(...lastArgs);
        });
    };
}

export function debounce(fn, ms) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(timer);
    wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
    return wrapped;
}

/** Shared floating tooltip. */
let tipEl = null;
export const tip = {
    show(x, y, content) {
        if (!tipEl) {
            tipEl = h('div.nm-tip', { role: 'tooltip' });
            document.body.appendChild(tipEl);
        }
        clear(tipEl);
        append(tipEl, [content]);
        tipEl.classList.add('show');
        const w = tipEl.offsetWidth;
        const ht = tipEl.offsetHeight;
        const nx = Math.max(8, Math.min(x + 14, window.innerWidth - w - 8));
        const ny = y + 14 + ht > window.innerHeight ? Math.max(8, y - ht - 10) : y + 14;
        tipEl.style.transform = `translate(${nx}px, ${ny}px)`;
    },
    hide() {
        if (tipEl) tipEl.classList.remove('show');
    },
};
