// Self-check for the console's pure logic. Run: node tests/check.mjs
import assert from 'node:assert/strict';

// ui.js wires a few document listeners at import time; stub just enough of the DOM.
globalThis.document = { addEventListener() {}, documentElement: { dataset: {} } };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

const { mergePolicy, SNIPPETS } = await import('../public/js/pages/policy-library.js');
const { parseEntry, pattern } = await import('../public/js/pages/logs.js');
const { upCommand } = await import('../public/js/pages/actions.js');

// mergePolicy: adds rules once, never widens existing groups/tag owners.
const base = { groups: { 'group:admins': ['boss@'] }, acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }] };
const web = SNIPPETS.find((s) => s.name === 'Shared web services').make('alice@');
const merged = mergePolicy(base, web);
assert.deepEqual(merged.groups, { 'group:admins': ['boss@'] });
assert.deepEqual(merged.tagOwners, { 'tag:web': ['group:admins'] });
assert.equal(merged.acls.length, 2);
assert.deepEqual(mergePolicy(merged, web), merged, 'adding the same snippet twice is a no-op');
assert.deepEqual(mergePolicy({}, web).groups, { 'group:admins': ['alice@'] });
for (const s of SNIPPETS) assert.ok(JSON.stringify(mergePolicy({}, s.make('a@'))), s.name);

// parseEntry: zerolog text, JSON, and journald-priority fallback.
assert.deepEqual(parseEntry({ t: 1, p: 6, m: '2025-01-01T00:00:00Z ERR boom node=1' }), { t: 1, level: 'error', msg: 'boom node=1' });
assert.deepEqual(parseEntry({ t: 1, p: 6, m: '{"level":"warn","message":"slow","ms":5}' }), { t: 1, level: 'warn', msg: 'slow ms=5' });
assert.equal(parseEntry({ t: 1, p: 3, m: 'plain failure' }).level, 'error');
assert.equal(parseEntry({ t: 1, p: 6, m: 'plain line' }).level, 'info');
assert.equal(pattern('failed node=12 ip=1.2.3.4 after 30s'), pattern('failed node=7 ip=5.6.7.8 after 31s'));

// upCommand: macOS uses the app's bundled CLI.
assert.equal(upCommand('mac', 'https://hs.example.com', 'hskey-auth-X', [], { acceptRoutes: true, acceptDns: true }),
  'sudo /Applications/Tailscale.app/Contents/MacOS/Tailscale up --auth-key=hskey-auth-X --login-server=https://hs.example.com --accept-routes');
assert.match(upCommand('win', 'https://hs', 'k'), /--unattended$/);
assert.doesNotMatch(upCommand('docker', 'https://hs', 'k'), /--auth-key/);

console.log('ok');
