const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function createResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        ended: false,
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        removeHeader(name) {
            delete this.headers[name.toLowerCase()];
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(value) {
            this.body = value;
            this.ended = true;
            return this;
        },
        end() {
            this.ended = true;
            return this;
        },
    };
}

async function withHomepageService(settings, run) {
    const originalLoad = Module._load;
    const updates = [];

    Module._load = function patchedLoad(request, parent, isMain) {
        if (parent?.filename?.endsWith('/src/services/homepageService.js')) {
            if (request === '../models/settingsModel') {
                return {
                    get: async () => settings,
                    update: async (update) => {
                        updates.push(update);
                        return settings;
                    },
                };
            }
            if (request === '../utils/logger') {
                return { info() {}, warn() {}, error() {}, debug() {} };
            }
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../src/services/homepageService')];
        const homepageService = require('../src/services/homepageService');
        return await run(homepageService, updates);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/homepageService')];
    }
}

function writeTemplate(root, slug, html = '<!doctype html><h1>template</h1>') {
    const dir = path.join(root, slug);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("asset");');
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'celerity-sni-templates-'));
    process.env.SNI_TEMPLATES_DIR = tempRoot;

    try {
        writeTemplate(tempRoot, 'alpha', '<!doctype html><h1>alpha masking</h1>');
        writeTemplate(tempRoot, 'beta', '<!doctype html><h1>beta masking</h1>');
        fs.mkdirSync(path.join(tempRoot, 'no-index'), { recursive: true });
        writeTemplate(tempRoot, '.hidden', '<!doctype html><h1>hidden</h1>');

        await withHomepageService({ homepage: { mode: 'nginx' } }, async (homepageService) => {
            assert.deepStrictEqual(
                homepageService.listTemplates().map(template => template.slug),
                ['alpha', 'beta'],
                'only non-hidden template directories with index.html should be listed'
            );
            assert.strictEqual(homepageService.isValidTemplateSlug('alpha'), true);
            assert.strictEqual(homepageService.isValidTemplateSlug('../alpha'), false);
            assert.strictEqual(homepageService.isValidTemplateSlug('.hidden'), false);
            assert.strictEqual(homepageService.isValidTemplateSlug('no-index'), false);
        });

        await withHomepageService(
            { homepage: { mode: 'template', templateSlug: 'alpha' } },
            async (homepageService) => {
                await homepageService.init();
                const res = createResponse();
                homepageService.respond({ method: 'GET', headers: {} }, res);

                assert.strictEqual(homepageService.getMode(), 'template');
                assert.strictEqual(homepageService.getTemplateSlug(), 'alpha');
                assert.match(String(res.body), /alpha masking/);
                assert.strictEqual(
                    homepageService.resolveTemplateAssetPath('/assets/app.js'),
                    path.join(tempRoot, 'alpha', 'assets', 'app.js')
                );
                assert.strictEqual(homepageService.resolveTemplateAssetPath('/assets/../index.html'), null);
                assert.strictEqual(homepageService.resolveTemplateAssetPath('/panel'), null);
            }
        );

        await withHomepageService(
            { homepage: { mode: 'template', templateSlug: 'missing' } },
            async (homepageService, updates) => {
                await homepageService.init();

                assert.strictEqual(homepageService.getMode(), 'nginx');
                assert.deepStrictEqual(updates[0], {
                    'homepage.mode': 'nginx',
                    'homepage.templateSlug': '',
                });
            }
        );
    } finally {
        delete process.env.SNI_TEMPLATES_DIR;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    console.log('homepage template tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
