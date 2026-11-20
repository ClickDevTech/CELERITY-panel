#!/usr/bin/env node
/**
 * Copies static vendor assets used by the network map into public/vendor.
 *
 * - world-atlas countries-110m TopoJSON (geo overview), stripped of unused
 *   properties to keep the payload small.
 * - Twemoji Country Flags font (renders flag emoji on Windows, which has no
 *   native flag glyphs).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'public/vendor');
const fontsDir = path.join(vendorDir, 'fonts');

function resolvePackageFile(pkg, rel) {
    const file = path.join(root, 'node_modules', pkg, rel);
    if (!fs.existsSync(file)) {
        throw new Error(`${pkg}/${rel} not found; run "npm install" first`);
    }
    return file;
}

function copyWorld() {
    const src = resolvePackageFile('world-atlas', 'countries-110m.json');
    const topo = JSON.parse(fs.readFileSync(src, 'utf8'));
    delete topo.objects.land;
    for (const geom of topo.objects.countries.geometries) {
        geom.properties = {};
    }
    const dest = path.join(vendorDir, 'world-110m.json');
    fs.writeFileSync(dest, JSON.stringify(topo));
    return dest;
}

function copyFlagsFont() {
    const src = resolvePackageFile('country-flag-emoji-polyfill', 'dist/TwemojiCountryFlags.woff2');
    const dest = path.join(fontsDir, 'TwemojiCountryFlags.woff2');
    fs.copyFileSync(src, dest);
    return dest;
}

function main() {
    fs.mkdirSync(fontsDir, { recursive: true });
    const files = [copyWorld(), copyFlagsFont()];
    for (const file of files) {
        const size = (fs.statSync(file).size / 1024).toFixed(1);
        console.log(`  ${path.relative(root, file).replace(/\\/g, '/')}  ${size} KB`);
    }
}

main();
