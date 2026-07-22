const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const languages = ['ru', 'en', 'zh-CN'];
const locales = languages.map(language => JSON.parse(
    fs.readFileSync(path.join(root, 'src/locales', `${language}.json`), 'utf8')
));
const expectedKeys = Object.keys(locales[0].wgPanels).sort();

locales.forEach((locale, index) => {
    assert(locale.wgPanels, `${languages[index]} should define wgPanels translations`);
    assert.deepStrictEqual(
        Object.keys(locale.wgPanels).sort(),
        expectedKeys,
        `${languages[index]} should contain the complete wgPanels translation set`
    );
    Object.entries(locale.wgPanels).forEach(([key, value]) => {
        assert.strictEqual(typeof value, 'string', `${languages[index]}.wgPanels.${key} should be a string`);
        assert(value.trim(), `${languages[index]}.wgPanels.${key} should not be empty`);
    });
});

['views/wg-panels.ejs', 'views/wg-panel-form.ejs', 'views/user-detail.ejs'].forEach(file => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotThrow(() => ejs.compile(source, { filename: path.join(root, file) }), `${file} should compile`);
});

const listView = fs.readFileSync(path.join(root, 'views/wg-panels.ejs'), 'utf8');
const formView = fs.readFileSync(path.join(root, 'views/wg-panel-form.ejs'), 'utf8');
const userView = fs.readFileSync(path.join(root, 'views/user-detail.ejs'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/routes/panel/wgPanels.js'), 'utf8');

assert(listView.includes("t('wgPanels.deleteConfirm')"), 'delete confirmation should be localized');
assert(formView.includes("t('wgPanels.usernameHint')"), 'form helper text should be localized');
assert(formView.includes("t('wgPanels.showPassword')"), 'password toggle should be localized');
assert(userView.includes("t('wgPanels.noUserProfiles')"), 'user profile empty state should be localized');
assert(route.includes("translate(res, 'wgPanels.connectionSuccess'"), 'connection result should be localized');
assert(route.includes("translate(res, 'wgPanels.syncResult'"), 'sync result should be localized');

console.log('WireGuard panel i18n tests passed');
