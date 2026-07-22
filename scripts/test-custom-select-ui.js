const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const layout = fs.readFileSync(path.join(root, 'views/layout.ejs'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/js/custom-select.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
const wgPanelForm = fs.readFileSync(path.join(root, 'views/wg-panel-form.ejs'), 'utf8');
const nodeBasicForm = fs.readFileSync(path.join(root, 'views/partials/node-form/basic.ejs'), 'utf8');

assert(layout.includes('/js/custom-select.js'), 'layout should load custom select enhancement');
assert(layout.indexOf('/js/custom-select.js') < layout.indexOf('/js/app.js'), 'custom select should initialize before app helpers');
assert(script.includes("setAttribute('role', 'combobox')"), 'trigger should expose combobox semantics');
assert(script.includes("setAttribute('role', 'listbox')"), 'menu should expose listbox semantics');
assert(script.includes("event.key === 'Escape'"), 'keyboard escape handling should be present');
assert(script.includes("event.key === 'ArrowDown'"), 'keyboard arrow handling should be present');
assert(script.includes("new Event('change', { bubbles: true })"), 'native change handlers should still run');
assert(script.includes('new MutationObserver'), 'dynamically inserted selects should be enhanced');
assert(script.includes('searchThreshold'), 'large option lists should support search');
assert(styles.includes('.custom-select-menu'), 'custom menu styles should be present');
assert(styles.includes('.custom-select-filter'), 'filter-specific select styles should be present');
assert(styles.includes('@media (prefers-reduced-motion: reduce)'), 'motion preferences should be respected');
assert(/\.wg-panel-form-card\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/s.test(styles), 'WireGuard form card should use the full content width');
assert(wgPanelForm.includes('country.name'), 'WireGuard country choices should show localized names');
assert(nodeBasicForm.includes('<select id="country" name="country">'), 'node country should use the searchable country select');
assert(nodeBasicForm.includes('countryOption.name'), 'node country choices should show localized names');
assert(nodeBasicForm.indexOf('<select id="country" name="country">') < nodeBasicForm.indexOf('id="cascadeRoleSection"'), 'node country should remain available for every protocol');

console.log('Custom select UI tests passed');
