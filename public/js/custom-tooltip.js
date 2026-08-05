(function () {
    'use strict';

    const tooltipId = 'app-tooltip';
    const showDelay = 260;
    const focusDelay = 80;
    const hideDelay = 70;
    let tooltip = null;
    let activeTarget = null;
    let showTimer = null;
    let hideTimer = null;

    function ensureTooltip() {
        if (tooltip) return tooltip;
        tooltip = document.createElement('div');
        tooltip.id = tooltipId;
        tooltip.className = 'app-tooltip is-above';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.setAttribute('aria-hidden', 'true');
        document.body.appendChild(tooltip);
        return tooltip;
    }

    function migrateTitle(element) {
        if (!(element instanceof Element) || !element.hasAttribute('title')) return;
        const value = element.getAttribute('title');
        if (value && value.trim()) element.dataset.tooltip = value.trim();
        element.removeAttribute('title');
    }

    function migrateTree(root) {
        if (!(root instanceof Element) && root !== document) return;
        if (root instanceof Element) migrateTitle(root);
        root.querySelectorAll('[title]').forEach(migrateTitle);
    }

    function tooltipTarget(node) {
        if (!(node instanceof Element)) return null;
        const target = node.closest('[data-tooltip]');
        return target && target.dataset.tooltip && target.dataset.tooltip.trim() ? target : null;
    }

    function addDescription(target) {
        const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
        ids.add(tooltipId);
        target.setAttribute('aria-describedby', Array.from(ids).join(' '));
    }

    function removeDescription(target) {
        if (!target) return;
        const ids = (target.getAttribute('aria-describedby') || '')
            .split(/\s+/)
            .filter(id => id && id !== tooltipId);
        if (ids.length) target.setAttribute('aria-describedby', ids.join(' '));
        else target.removeAttribute('aria-describedby');
    }

    function position(target) {
        const bubble = ensureTooltip();
        const targetRect = target.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        const viewportGap = 8;
        const targetGap = 9;
        const roomAbove = targetRect.top;
        const placeBelow = roomAbove < bubbleRect.height + targetGap + viewportGap;
        const idealLeft = targetRect.left + targetRect.width / 2 - bubbleRect.width / 2;
        const left = Math.min(
            Math.max(viewportGap, idealLeft),
            window.innerWidth - bubbleRect.width - viewportGap
        );
        const top = placeBelow
            ? targetRect.bottom + targetGap
            : targetRect.top - bubbleRect.height - targetGap;
        const arrowX = Math.min(
            bubbleRect.width - 12,
            Math.max(12, targetRect.left + targetRect.width / 2 - left)
        );

        bubble.style.left = `${Math.round(left)}px`;
        bubble.style.top = `${Math.round(Math.max(viewportGap, top))}px`;
        bubble.style.setProperty('--tooltip-arrow-x', `${Math.round(arrowX)}px`);
        bubble.classList.toggle('is-above', !placeBelow);
        bubble.classList.toggle('is-below', placeBelow);
    }

    function show(target, delay) {
        window.clearTimeout(hideTimer);
        window.clearTimeout(showTimer);
        if (activeTarget && activeTarget !== target) hide(true);
        activeTarget = target;
        showTimer = window.setTimeout(() => {
            if (!activeTarget || !activeTarget.isConnected) return;
            const bubble = ensureTooltip();
            bubble.textContent = activeTarget.dataset.tooltip.trim();
            bubble.setAttribute('aria-hidden', 'false');
            addDescription(activeTarget);
            position(activeTarget);
            requestAnimationFrame(() => bubble.classList.add('is-visible'));
        }, delay);
    }

    function hide(immediate) {
        window.clearTimeout(showTimer);
        window.clearTimeout(hideTimer);
        const target = activeTarget;
        const close = () => {
            if (tooltip) {
                tooltip.classList.remove('is-visible');
                tooltip.setAttribute('aria-hidden', 'true');
            }
            removeDescription(target);
            if (activeTarget === target) activeTarget = null;
        };
        if (immediate) close();
        else hideTimer = window.setTimeout(close, hideDelay);
    }

    document.addEventListener('pointerover', event => {
        const target = tooltipTarget(event.target);
        if (!target || target === activeTarget) return;
        show(target, showDelay);
    });

    document.addEventListener('pointerout', event => {
        if (!activeTarget) return;
        const next = event.relatedTarget;
        if (next instanceof Node && activeTarget.contains(next)) return;
        if (activeTarget.contains(event.target)) hide(false);
    });

    document.addEventListener('focusin', event => {
        const target = tooltipTarget(event.target);
        if (target) show(target, focusDelay);
    });

    document.addEventListener('focusout', event => {
        if (activeTarget && activeTarget.contains(event.target)) hide(false);
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') hide(true);
    });

    window.addEventListener('scroll', () => hide(true), true);
    window.addEventListener('resize', () => {
        if (activeTarget && tooltip && tooltip.classList.contains('is-visible')) position(activeTarget);
    });

    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.type === 'attributes') migrateTitle(mutation.target);
            mutation.addedNodes.forEach(node => {
                if (node instanceof Element) migrateTree(node);
            });
        });
    });

    function initialize() {
        migrateTree(document);
        ensureTooltip();
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['title']
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
})();
