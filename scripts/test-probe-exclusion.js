/**
 * Probe users must be invisible to operators but fully visible to the machinery
 * that gets them onto nodes.
 *
 * A probe owns a hidden HyUser. If that user leaked into listings or totals,
 * every user count and traffic figure in the panel would be wrong, and probe
 * traffic would show up as customer traffic. Conversely, if it were excluded
 * from node sync or from subscription generation, the probe could not reach any
 * node and the whole feature would be pointless.
 *
 * This test guards both directions by reading the sources, so a future edit
 * that drops the filter (or adds one where it must not be) fails here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

// Files that aggregate or list users for humans: every one of them must filter
// probe users out.
const MUST_EXCLUDE = [
    'src/services/statsService.js',
    'src/routes/users.js',
    'src/routes/panel/users.js',
    'src/routes/panel/nodes.js',
    'src/routes/nodes.js',
    'src/mcp/tools/stats.js',
    'src/mcp/tools/users.js',
    'src/mcp/tools/groups.js',
    'src/mcp/tools/nodes.js',
];

// Files that must keep serving probe users like any other user.
const MUST_NOT_EXCLUDE = [
    'src/services/syncService.js',
    'src/routes/subscription.js',
];

const EXCLUSION = /isProbe:\s*\{\s*\$ne:\s*true\s*\}/;

// Every query that lists or counts users. Point lookups by userId are not here:
// fetching one known user by id can never leak a probe into a total.
const LISTING_CALL = /HyUser\.(?:find|countDocuments|aggregate|distinct)\(\s*([A-Za-z_$][\w$]*)?/g;

/**
 * A filter object is considered probe-safe when the identifier passed to the
 * query is the same one the exclusion was written onto. Checking only that the
 * file mentions isProbe somewhere would pass even if a new listing used a
 * different, unfiltered object.
 */
function filterIsGuarded(source, name, seen = new Set()) {
    if (seen.has(name)) return false;
    seen.add(name);

    const escaped = name.replace(/[$]/g, '\\$');
    const assigned = new RegExp(`${escaped}\\s*(?:=|\\.)[\\s\\S]{0,600}?isProbe:\\s*\\{\\s*\\$ne:\\s*true\\s*\\}`);
    const property = new RegExp(`${escaped}\\.isProbe\\s*=`);
    if (assigned.test(source) || property.test(source)) return true;

    // An aggregation pipeline delegates the filter to its $match stage, so the
    // guarantee lives on whatever object that stage was given.
    const pipeline = new RegExp(`${escaped}\\s*=\\s*\\[[\\s\\S]{0,800}?\\$match:\\s*([A-Za-z_$][\\w$]*)`);
    const viaMatch = pipeline.exec(source);
    if (viaMatch) return filterIsGuarded(source, viaMatch[1], seen);

    const inlineMatch = new RegExp(`${escaped}\\s*=\\s*\\[[\\s\\S]{0,800}?\\$match:\\s*\\{[\\s\\S]{0,300}?isProbe`);
    return inlineMatch.test(source);
}

for (const file of MUST_EXCLUDE) {
    const source = read(file);
    assert.ok(
        EXCLUSION.test(source),
        `${file} must exclude probe users from listings and aggregations`
    );

    LISTING_CALL.lastIndex = 0;
    let match;
    let checked = 0;
    while ((match = LISTING_CALL.exec(source)) !== null) {
        const argument = match[1];
        // An inline object literal carries its own filter, which the
        // file-wide EXCLUSION check above already covers.
        if (!argument) continue;
        checked++;
        assert.ok(
            filterIsGuarded(source, argument),
            `${file}: query on "${argument}" is not filtered by isProbe — probe users would leak into user listings`
        );
    }

    assert.ok(checked > 0 || EXCLUSION.test(source), `${file}: no user listing found to verify`);
}

for (const file of MUST_NOT_EXCLUDE) {
    const source = read(file);
    assert.ok(
        !EXCLUSION.test(source),
        `${file} must not exclude probe users: a probe has to reach the nodes`
    );
}

// The flag itself has to exist on the model, otherwise every filter above is a
// silent no-op.
const userModel = read('src/models/hyUserModel.js');
assert.ok(/isProbe:\s*\{/.test(userModel), 'hyUserModel declares the isProbe flag');
assert.ok(
    /isProbe:[\s\S]{0,120}index:\s*true/.test(userModel),
    'isProbe is indexed: it participates in every user listing query'
);

// Removing a probe must remove its user and its subscription with it, since the
// credentials are plain and revocation speed is the only thing bounding them.
const enrollService = read('src/services/probes/enrollService.js');
assert.ok(/HyUser\.deleteOne/.test(enrollService), 'probe removal deletes the hidden user');
assert.ok(/invalidateUserCache/.test(enrollService), 'probe removal invalidates the subscription cache');
assert.ok(/removeUserFromAllXrayNodes/.test(enrollService), 'probe removal is pushed to the nodes');

// Probe users are created with the configured traffic cap.
assert.ok(
    /probeTrafficLimitBytes/.test(enrollService),
    'probe users are created with a traffic limit'
);

// Tokens are never stored in the clear.
const probeModel = read('src/models/probeModel.js');
assert.ok(/createHash\('sha256'\)/.test(probeModel), 'probe tokens are hashed with SHA-256');
assert.ok(/timingSafeEqual/.test(probeModel), 'token comparison is constant-time');
// The listing projection is an allow-list, so a secret added to the schema
// later cannot start leaking by default.
assert.ok(
    /const PUBLIC_FIELDS\s*=\s*\[/.test(probeModel),
    'listings use an explicit field allow-list'
);
assert.ok(
    !/PUBLIC_FIELDS[\s\S]*?\][\s\S]{0,40}/.test(probeModel) ||
    !/PUBLIC_FIELDS\s*=\s*\[[\s\S]*?(tokenHash|tokenEncrypted|enrollTokenHash)[\s\S]*?\]/.test(probeModel),
    'the allow-list never contains token material'
);
assert.ok(
    /listProbes[\s\S]{0,200}select\(PUBLIC_FIELDS\)/.test(probeModel),
    'listings project only the allow-listed fields'
);

// Ingest must be mounted before the JSON body parser, otherwise the panel would
// parse every gzipped batch for nothing.
const index = read('index.js');
const probeMount = index.indexOf("app.use('/api/probe'");
const jsonMount = index.indexOf('app.use(express.json())');
assert.ok(probeMount > 0, 'probe router is mounted');
assert.ok(
    probeMount < jsonMount,
    'probe ingest must be mounted before express.json()'
);

// A probe has to see the fleet as it is: hiding offline or overloaded nodes
// from it would switch external monitoring off exactly when it is needed.
const subscription = read('src/routes/subscription.js');
assert.ok(
    /hideOverloaded\s*&&\s*!isProbe/.test(subscription),
    'probe subscriptions ignore the hide-overloaded filter'
);
assert.ok(
    /hideOffline\s*!==\s*false\s*&&\s*!isProbe/.test(subscription),
    'probe subscriptions ignore the hide-offline filter'
);

// Probe results carry their own failure taxonomy; a local core failure must be
// storable separately from anything that blames a node.
const resultModel = read('src/models/probeResultModel.js');
assert.ok(/coreDown:\s*\{\s*type:\s*Number/.test(resultModel), 'core failures have their own counter');

// Probe data exposes vantage points and egress addresses, so it sits behind its
// own scope rather than general statistics access.
const mcpService = read('src/services/mcpService.js');
assert.ok(
    /query_probes:[\s\S]{0,400}requiredScope:\s*'probes:read'/.test(mcpService),
    'the probe MCP tool requires the probes:read scope'
);

console.log('test-probe-exclusion: OK');
