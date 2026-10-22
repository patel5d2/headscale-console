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

// lineDiff: minimal edit script that reproduces both sides.
const { lineDiff } = await import('../public/js/util.js');
const d = lineDiff('a\nb\nc\nd', 'a\nc\nx\nd');
assert.deepEqual(d.map((r) => r.op + r.line), [' a', '-b', ' c', '+x', ' d']);
assert.equal(d.filter((r) => r.op !== '+').map((r) => r.line).join('\n'), 'a\nb\nc\nd');
assert.equal(d.filter((r) => r.op !== '-').map((r) => r.line).join('\n'), 'a\nc\nx\nd');

// checkAccess / checkSsh: the access checker's policy evaluation.
const { checkAccess, checkSsh, cidrContains, splitDst } = await import('../public/js/pages/policy-check.js');
const alice = { user: { name: 'alice', email: 'alice@x.com' }, tags: [], ips: ['100.64.0.1'] };
const alice2 = { user: { name: 'alice', email: 'alice@x.com' }, tags: [], ips: ['100.64.0.2'] };
const bob = { user: { name: 'bob' }, tags: [], ips: ['100.64.0.3'] };
const webSrv = { user: null, tags: ['tag:web'], ips: ['100.64.0.9'] };
const pol = {
  groups: { 'group:admins': ['alice@'] },
  hosts: { tailnet: '100.64.0.0/10' },
  acls: [
    { action: 'accept', src: ['group:admins'], dst: ['*:*'] },
    { action: 'accept', src: ['autogroup:member'], dst: ['autogroup:self:*'] },
    { action: 'accept', src: ['autogroup:member'], dst: ['tag:web:80,443,8000-8100'] },
    { action: 'accept', src: ['tag:web'], proto: 'udp', dst: ['tailnet:53'] },
  ],
  ssh: [{ action: 'check', src: ['autogroup:member'], dst: ['autogroup:self'], users: ['autogroup:nonroot'] }],
};
assert.equal(checkAccess(pol, alice, bob, 22).index, 0);
assert.equal(checkAccess(pol, bob, bob, 22).index, 1); // autogroup:self
assert.equal(checkAccess(pol, bob, alice, 22).allowed, false);
assert.equal(checkAccess(pol, bob, webSrv, 443).index, 2);
assert.equal(checkAccess(pol, bob, webSrv, 8050).index, 2);
assert.equal(checkAccess(pol, bob, webSrv, 22).allowed, false);
assert.equal(checkAccess(pol, webSrv, bob, 53, 'udp').index, 3);
assert.equal(checkAccess(pol, webSrv, bob, 53, 'tcp').allowed, false);
assert.equal(checkAccess({}, bob, alice, 1).allowed, true, 'no rules = allow all');
assert.equal(checkSsh(pol, alice, alice2, 'root').allowed, false);
assert.equal(checkSsh(pol, alice, alice2, 'ubuntu').action, 'check');
assert.equal(checkSsh(pol, alice, bob, 'ubuntu').allowed, false);
assert.ok(cidrContains('100.64.0.0/10', ['100.100.1.1']) && !cidrContains('100.64.0.0/10', ['100.128.0.1']));
assert.deepEqual(splitDst('tag:web:80,443'), { alias: 'tag:web', ports: '80,443' });
assert.deepEqual(splitDst('tag:web'), { alias: 'tag:web', ports: '*' });

// upCommand: macOS uses the app's bundled CLI.
assert.equal(upCommand('mac', 'https://hs.example.com', 'hskey-auth-X', [], { acceptRoutes: true, acceptDns: true }),
  'sudo /Applications/Tailscale.app/Contents/MacOS/Tailscale up --auth-key=hskey-auth-X --login-server=https://hs.example.com --accept-routes');
assert.match(upCommand('win', 'https://hs', 'k'), /--unattended$/);
assert.doesNotMatch(upCommand('docker', 'https://hs', 'k'), /--auth-key/);

console.log('ok');
