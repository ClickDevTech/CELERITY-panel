const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const layout = fs.readFileSync(path.join(root, 'views/layout.ejs'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/js/custom-tooltip.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');

assert(layout.includes('/js/custom-tooltip.js'), 'layout should load custom tooltip enhancement');
assert(script.includes("element.removeAttribute('title')"), 'native title tooltip should be disabled');
assert(script.includes("tooltip.setAttribute('role', 'tooltip')"), 'tooltip should expose accessible semantics');
assert(script.includes("target.setAttribute('aria-describedby'"), 'focused controls should reference the tooltip');
assert(script.includes("event.key === 'Escape'"), 'escape should dismiss the tooltip');
assert(script.includes('new MutationObserver'), 'dynamic title attributes should be enhanced');
assert(script.includes('getBoundingClientRect()'), 'tooltip should be positioned relative to its target');
assert(styles.includes('.app-tooltip'), 'custom tooltip styles should be present');
assert(styles.includes('.app-tooltip.is-below'), 'tooltip should support placement below a target');
assert(styles.includes('@media (prefers-reduced-motion: reduce)'), 'motion preferences should be respected');

console.log('Custom tooltip UI tests passed');
