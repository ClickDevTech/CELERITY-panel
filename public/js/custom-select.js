(function () {
    'use strict';

    const states = new WeakMap();
    const liveStates = new Set();
    const searchThreshold = 12;
    let openState = null;
    let sequence = 0;

    function escapeSelector(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
    }

    const text = document.documentElement.lang === 'ru'
        ? { search: 'Поиск…', empty: 'Ничего не найдено' }
        : document.documentElement.lang === 'zh-CN'
            ? { search: '搜索…', empty: '未找到结果' }
            : { search: 'Search…', empty: 'No results found' };

    function selectedOption(select) {
        return select.options[select.selectedIndex] || null;
    }

    function accessibleName(select) {
        if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
        if (select.id) {
            const label = document.querySelector(`label[for="${escapeSelector(select.id)}"]`);
            if (label) return label.textContent.replace(/\s+/g, ' ').trim();
        }
        const option = selectedOption(select);
        return select.title || select.name || (option && option.textContent.trim()) || 'Select';
    }

    function close(state, restoreFocus) {
        if (!state || !state.open) return;
        state.open = false;
        state.wrapper.classList.remove('is-open');
        state.trigger.setAttribute('aria-expanded', 'false');
        state.trigger.removeAttribute('aria-activedescendant');
        state.menu.classList.remove('is-open');
        window.setTimeout(() => {
            if (!state.open) state.menu.hidden = true;
        }, 140);
        if (state.search) {
            state.search.value = '';
            filterOptions(state, '');
        }
        if (openState === state) openState = null;
        if (restoreFocus) state.trigger.focus();
    }

    function positionMenu(state) {
        if (!state.open || !state.select.isConnected) return;
        const rect = state.trigger.getBoundingClientRect();
        const viewportGap = 8;
        const desiredWidth = state.search
            ? Math.max(rect.width, 320)
            : Math.max(rect.width, 220);
        const width = Math.min(desiredWidth, window.innerWidth - viewportGap * 2);
        const left = Math.min(
            Math.max(viewportGap, rect.left),
            window.innerWidth - width - viewportGap
        );

        state.menu.style.width = `${Math.round(width)}px`;
        state.menu.style.left = `${Math.round(left)}px`;
        state.menu.style.top = `${Math.round(rect.bottom + 6)}px`;
        state.menu.classList.remove('opens-up');

        const menuHeight = state.menu.offsetHeight;
        const roomBelow = window.innerHeight - rect.bottom - viewportGap;
        const roomAbove = rect.top - viewportGap;
        if (menuHeight > roomBelow && roomAbove > roomBelow) {
            state.menu.style.top = `${Math.max(viewportGap, Math.round(rect.top - menuHeight - 6))}px`;
            state.menu.classList.add('opens-up');
        }
    }

    function visibleItems(state) {
        return state.items.filter(item => !item.hidden && !item.classList.contains('is-disabled'));
    }

    function setActive(state, item, scroll) {
        state.items.forEach(node => node.classList.toggle('is-active', node === item));
        state.activeItem = item || null;
        if (item && state.open) {
            state.trigger.setAttribute('aria-activedescendant', item.id);
            if (scroll) item.scrollIntoView({ block: 'nearest' });
        } else {
            state.trigger.removeAttribute('aria-activedescendant');
        }
    }

    function moveActive(state, direction) {
        const items = visibleItems(state);
        if (!items.length) return;
        const current = items.indexOf(state.activeItem);
        const next = current < 0
            ? (direction > 0 ? 0 : items.length - 1)
            : (current + direction + items.length) % items.length;
        setActive(state, items[next], true);
    }

    function choose(state, option) {
        if (!option || option.disabled) return;
        const changed = state.select.value !== option.value;
        state.select.value = option.value;
        sync(state, false);
        close(state, true);
        if (changed) {
            state.select.dispatchEvent(new Event('input', { bubbles: true }));
            state.select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function filterOptions(state, query) {
        const normalized = query.trim().toLocaleLowerCase();
        let matches = 0;
        state.items.forEach(item => {
            const show = !normalized || item.dataset.search.includes(normalized);
            item.hidden = !show;
            if (show) matches += 1;
        });
        state.groupLabels.forEach(group => {
            const groupName = group.dataset.group;
            group.hidden = !state.items.some(item => item.dataset.group === groupName && !item.hidden);
        });
        state.empty.hidden = matches > 0;
        const selected = state.items.find(item => item.classList.contains('is-selected') && !item.hidden);
        setActive(state, selected || visibleItems(state)[0] || null, false);
        if (state.open) positionMenu(state);
    }

    function renderOptions(state) {
        state.options.replaceChildren();
        state.items = [];
        state.groupLabels = [];
        let groupSequence = 0;

        Array.from(state.select.children).forEach(child => {
            let options = [];
            let groupKey = '';
            if (child.tagName === 'OPTGROUP') {
                groupKey = `group-${state.id}-${groupSequence++}`;
                const label = document.createElement('div');
                label.className = 'custom-select-group';
                label.textContent = child.label;
                label.dataset.group = groupKey;
                state.options.appendChild(label);
                state.groupLabels.push(label);
                options = Array.from(child.children);
            } else if (child.tagName === 'OPTION') {
                options = [child];
            }

            options.forEach(option => {
                const item = document.createElement('div');
                item.id = `custom-select-option-${state.id}-${state.items.length}`;
                item.className = 'custom-select-option';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(option.selected));
                item.dataset.search = option.textContent.trim().toLocaleLowerCase();
                item.dataset.group = groupKey;
                item._nativeOption = option;
                if (option.disabled || child.disabled) item.classList.add('is-disabled');
                if (option.selected) item.classList.add('is-selected');

                const label = document.createElement('span');
                label.className = 'custom-select-option-label';
                label.textContent = option.textContent;
                const check = document.createElement('i');
                check.className = 'ti ti-check custom-select-check';
                check.setAttribute('aria-hidden', 'true');
                item.append(label, check);
                item.addEventListener('pointerdown', event => event.preventDefault());
                item.addEventListener('click', () => choose(state, option));
                state.options.appendChild(item);
                state.items.push(item);
            });
        });

        const shouldSearch = state.select.dataset.selectSearch !== 'false'
            && (state.select.dataset.selectSearch === 'true' || state.select.options.length >= searchThreshold);
        state.searchWrap.hidden = !shouldSearch;
        state.search = shouldSearch ? state.searchInput : null;
        state.menu.classList.toggle('has-search', shouldSearch);
        filterOptions(state, shouldSearch ? state.searchInput.value : '');
    }

    function sync(state, rebuild) {
        if (!state.select.isConnected) {
            if (openState === state) close(state, false);
            state.menu.remove();
            liveStates.delete(state);
            return;
        }
        if (rebuild) renderOptions(state);
        const option = selectedOption(state.select);
        const optionText = option ? option.textContent : '';
        if (state.value.textContent !== optionText) state.value.textContent = optionText;
        if (state.trigger.title !== optionText) state.trigger.title = optionText;
        state.trigger.disabled = state.select.disabled;
        state.trigger.setAttribute('aria-disabled', String(state.select.disabled));
        state.wrapper.classList.toggle('is-disabled', state.select.disabled);
        state.wrapper.classList.toggle('is-placeholder', !state.select.value);
        state.items.forEach(item => {
            const selected = item._nativeOption === option;
            item.classList.toggle('is-selected', selected);
            item.setAttribute('aria-selected', String(selected));
        });
        if (state.open) {
            setActive(state, state.items.find(item => item._nativeOption === option) || null, false);
            positionMenu(state);
        }
    }

    function open(state) {
        if (state.select.disabled) return;
        if (openState && openState !== state) close(openState, false);
        sync(state, true);
        state.open = true;
        openState = state;
        state.menu.hidden = false;
        state.wrapper.classList.add('is-open');
        state.trigger.setAttribute('aria-expanded', 'true');
        positionMenu(state);
        requestAnimationFrame(() => {
            state.menu.classList.add('is-open');
            positionMenu(state);
        });
        const selected = state.items.find(item => item.classList.contains('is-selected'));
        setActive(state, selected || visibleItems(state)[0] || null, true);
        if (state.search) {
            state.search.value = '';
            filterOptions(state, '');
            state.search.focus();
        }
    }

    function handleKeydown(state, event) {
        if (!state.open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            open(state);
            if (event.key === 'ArrowUp') moveActive(state, -1);
            return;
        }
        if (!state.open) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveActive(state, 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveActive(state, -1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            setActive(state, visibleItems(state)[0] || null, true);
        } else if (event.key === 'End') {
            event.preventDefault();
            const items = visibleItems(state);
            setActive(state, items[items.length - 1] || null, true);
        } else if (event.key === 'Enter' || (event.key === ' ' && !state.search)) {
            event.preventDefault();
            if (state.activeItem) choose(state, state.activeItem._nativeOption);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close(state, true);
        } else if (event.key === 'Tab') {
            close(state, false);
        }
    }

    function init(select) {
        if (!(select instanceof HTMLSelectElement)
            || select.dataset.customSelectReady
            || select.dataset.nativeSelect !== undefined
            || select.multiple
            || select.size > 1) return;

        const id = ++sequence;
        const originalWidth = select.getBoundingClientRect().width;
        const wrapper = document.createElement('span');
        wrapper.className = 'custom-select';
        if (select.closest('.filters-bar') || select.classList.contains('filter-select')) {
            wrapper.classList.add('custom-select-filter');
        }
        if (select.closest('.form-group') || select.classList.contains('form-input') || select.classList.contains('form-control')) {
            wrapper.classList.add('custom-select-form');
        }
        if (select.style.width) wrapper.style.width = select.style.width;
        if (select.style.minWidth) wrapper.style.minWidth = select.style.minWidth;
        if (select.style.maxWidth) wrapper.style.maxWidth = select.style.maxWidth;
        if (!wrapper.classList.contains('custom-select-form') && !wrapper.classList.contains('custom-select-filter') && originalWidth) {
            wrapper.style.setProperty('--custom-select-width', `${Math.ceil(originalWidth)}px`);
        }

        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(select);
        select.dataset.customSelectReady = 'true';
        select.classList.add('custom-select-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'custom-select-trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', accessibleName(select));
        if (select.required) trigger.setAttribute('aria-required', 'true');

        const value = document.createElement('span');
        value.className = 'custom-select-value';
        const chevron = document.createElement('i');
        chevron.className = 'ti ti-chevron-down custom-select-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        trigger.append(value, chevron);
        wrapper.appendChild(trigger);

        const menu = document.createElement('div');
        menu.id = `custom-select-menu-${id}`;
        menu.className = 'custom-select-menu';
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        trigger.setAttribute('aria-controls', menu.id);

        const searchWrap = document.createElement('div');
        searchWrap.className = 'custom-select-search-wrap';
        const searchIcon = document.createElement('i');
        searchIcon.className = 'ti ti-search';
        searchIcon.setAttribute('aria-hidden', 'true');
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'custom-select-search';
        searchInput.placeholder = text.search;
        searchInput.setAttribute('aria-label', text.search);
        searchInput.setAttribute('autocomplete', 'off');
        searchWrap.append(searchIcon, searchInput);

        const options = document.createElement('div');
        options.className = 'custom-select-options';
        const empty = document.createElement('div');
        empty.className = 'custom-select-empty';
        empty.textContent = text.empty;
        empty.hidden = true;
        menu.append(searchWrap, options, empty);
        document.body.appendChild(menu);

        const state = {
            id, select, wrapper, trigger, value, menu, searchWrap, searchInput,
            search: null, options, empty, items: [], groupLabels: [], activeItem: null, open: false,
        };
        states.set(select, state);
        liveStates.add(state);

        trigger.addEventListener('click', () => state.open ? close(state, false) : open(state));
        trigger.addEventListener('keydown', event => handleKeydown(state, event));
        menu.addEventListener('keydown', event => handleKeydown(state, event));
        searchInput.addEventListener('input', () => filterOptions(state, searchInput.value));
        select.addEventListener('change', () => sync(state, false));
        select.addEventListener('invalid', () => {
            wrapper.classList.add('is-invalid');
            trigger.focus();
        });
        trigger.addEventListener('focus', () => wrapper.classList.remove('is-invalid'));

        if (select.id) {
            document.querySelectorAll(`label[for="${escapeSelector(select.id)}"]`).forEach(label => {
                label.addEventListener('click', event => {
                    event.preventDefault();
                    trigger.focus();
                });
            });
        }

        const selectObserver = new MutationObserver(() => sync(state, true));
        selectObserver.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
        state.observer = selectObserver;
        sync(state, true);
    }

    function initWithin(root) {
        if (root instanceof HTMLSelectElement) init(root);
        if (root.querySelectorAll) root.querySelectorAll('select').forEach(init);
    }

    function syncAll() {
        liveStates.forEach(state => sync(state, false));
    }

    function boot() {
        initWithin(document);
        const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) initWithin(node);
            }));
            queueMicrotask(syncAll);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    document.addEventListener('pointerdown', event => {
        if (openState && !openState.wrapper.contains(event.target) && !openState.menu.contains(event.target)) {
            close(openState, false);
        }
    });
    document.addEventListener('click', () => queueMicrotask(syncAll));
    document.addEventListener('change', event => {
        const state = event.target instanceof HTMLSelectElement ? states.get(event.target) : null;
        if (state) sync(state, false);
    }, true);
    document.addEventListener('reset', () => window.setTimeout(syncAll, 0), true);
    window.addEventListener('resize', () => openState && positionMenu(openState));
    window.addEventListener('scroll', () => openState && positionMenu(openState), true);

    window.CeleritySelect = {
        refresh(target) {
            if (!target) return syncAll();
            if (target instanceof HTMLSelectElement) {
                const state = states.get(target);
                if (state) sync(state, true);
                else init(target);
            } else {
                initWithin(target);
                syncAll();
            }
        },
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
}());
