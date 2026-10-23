// hsconsole against the mock Headscale. Run by tests/unit/shared.spec.ts while the
// Playwright global setup has the mock up (node --test, so it shares Node coverage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { run, parseDuration, table } from '../../dist/cli/hsconsole.js';

const MOCK = 'http://127.0.0.1:18281';
const KEY = 'hskey-api-TESTKEY0001-0123456789abcdefghijklmnopqrstuv';
const ENV = { HEADSCALE_URL: `${MOCK}/`, HEADSCALE_API_KEY: KEY };
const mock = (p, body) => fetch(`${MOCK}/__mock/${p}`, { method: 'POST', body: body && JSON.stringify(body) }).then((r) => r.json());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsconsole-'));

/** Runs one command; returns { code, out, err }. */
async function cli(...argv) {
  const out = [];
  const err = [];
  const code = await run(argv, ENV, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test.beforeEach(() => mock('reset'));

test('help, usage errors and configuration', async () => {
  assert.equal((await run([], ENV, { out() {}, err() {} })), 2);
  assert.match((await cli('help')).out, /manage a Headscale server/);
  assert.equal((await cli('--help')).code, 0);
  const bad = await cli('--nope');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Unknown option/);
  const err = [];
  assert.equal(await run(['machines'], {}, { out() {}, err: (s) => err.push(s) }), 2);
  assert.match(err[0], /--url and --key/);
  assert.equal(await run(['--url', MOCK, '--key', KEY, 'users'], {}, { out() {}, err() {} }), 0);
  assert.equal((await cli('frobnicate')).code, 2);
  const down = await run(['users'], { HEADSCALE_URL: 'http://127.0.0.1:9', HEADSCALE_API_KEY: KEY }, { out() {}, err: (s) => err.push(s) });
  assert.equal(down, 1);
  assert.match(err.at(-1), /^Error: /);
  assert.equal(parseDuration('2w'), 14 * 86400e3);
  assert.equal(table(['A', 'B'], [['x', '']]), 'A  B\nx');
});

test('machines: list, show, rename, tags, expire, remove', async () => {
  const list = await cli('machines');
  assert.match(list.out, /^ID\s+NAME\s+IPV4\s+OWNER\s+STATUS/);
  assert.match(list.out, /router\s+100\.64\.0\.2\s+tag:router\s+online/);
  assert.match(list.out, /server .* seen /);
  assert.equal((await cli('machines', '--search', 'ALICE')).out.split('\n').length, 2);
  assert.equal(JSON.parse((await cli('--json', 'machines')).out).length, 4);

  assert.match((await cli('machine', 'laptop')).out, /owner:\s+Alice Doe[\s\S]*key:\s+expires in/);
  const router = (await cli('machine', '2')).out;
  assert.match(router, /owner:\s+tagged device/);
  assert.match(router, /10\.0\.0\.0\/8 \(pending\), exit node \(pending\)/);
  assert.match(router, /key:\s+never expires/);
  assert.match((await cli('machine', 'old-phone')).out, /key:\s+expired/);
  assert.match((await cli('machine', 'server-host')).out, /last seen/);
  const { nodes } = await mock('state');
  await mock('set', { nodes: [{ ...nodes[0], ipAddresses: [], tags: [], approvedRoutes: ['0.0.0.0/0', '::/0'], availableRoutes: ['0.0.0.0/0', '::/0'] }] });
  assert.match((await cli('machine', 'laptop')).out, /addresses: -[\s\S]*routes:\s+exit node$/m);
  assert.match((await cli('machines')).out, /laptop\s+-/);
  await mock('reset');
  assert.equal((await cli('machine')).code, 2);
  const missing = await cli('machine', 'nope');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /No machine "nope"/);

  assert.equal((await cli('rename', 'laptop')).code, 2);
  assert.match((await cli('rename', 'laptop', 'work-laptop')).out, /Renamed laptop to work-laptop/);
  assert.match((await cli('tags', 'work-laptop', 'web,tag:db')).out, /tag:web, tag:db/);
  assert.match((await cli('tags', '1', '')).out, /: none$/);
  assert.match((await cli('expire', 'server')).out, /Expired the key of server/);
  const careful = await cli('remove', 'old-phone');
  assert.equal(careful.code, 2);
  assert.match(careful.err, /Add --yes/);
  assert.match((await cli('remove', 'old-phone', '--yes')).out, /Removed old-phone/);
  assert.equal((await mock('state')).nodes.length, 3);
});

test('routes and approval', async () => {
  const all = await cli('routes');
  assert.match(all.out, /router\s+192\.168\.1\.0\/24\s+approved, primary/);
  assert.match(all.out, /router\s+exit node\s+pending/);
  assert.doesNotMatch((await cli('routes', '--pending')).out, /192\.168\.1\.0/);
  assert.match((await cli('approve', 'router', 'exit')).out, /0\.0\.0\.0\/0, ::\/0/);
  assert.match((await cli('approve', 'router')).out, /Approved on router: 192\.168\.1\.0\/24, 10\.0\.0\.0\/8/);
  assert.match((await cli('routes')).out, /exit node\s+approved/);
  const none = await cli('approve', 'laptop');
  assert.equal(none.code, 1);
  assert.match(none.err, /isn't advertising any routes/);
});

test('users', async () => {
  assert.match((await cli('users')).out, /alice\s+Alice Doe\s+1/);
  assert.equal((await cli('user', 'add')).code, 2);
  assert.match((await cli('user', 'add', 'carol', '--display-name', 'Carol', '--email', 'c@example.com')).out, /Created user carol/);
  assert.match((await cli('user', 'add', 'dave')).out, /Created user dave/);
  assert.equal((await cli('user', 'rm', 'carol')).code, 2);
  assert.match((await cli('user', 'rm', 'c@example.com', '--yes')).out, /Deleted user carol/);
  assert.match((await cli('user', 'rm', '100', '--yes')).err, /No user "100"/);
  assert.equal((await cli('user', 'rm')).code, 2);
  assert.equal((await cli('user', 'frob')).code, 2);
  const busy = await cli('user', 'rm', 'bob', '--yes');
  assert.equal(busy.code, 1);
  assert.match(busy.err, /user has nodes/);
});

test('keys and join commands', async () => {
  const keys = await cli('keys');
  assert.match(keys.out, /alice\s+reusable,used/);
  assert.match(keys.out, /-\s+one-off\s+tag:router/);
  assert.equal((await cli('key')).code, 2);
  assert.equal((await cli('key', 'add')).code, 2);
  assert.equal((await cli('key', 'add', '--user', 'alice', '--expires', 'soon')).code, 2);
  assert.match((await cli('key', 'add', '--user', 'alice', '--reusable', '--ephemeral', '--expires', '2h')).out, /^hskey-auth-/);
  assert.match((await cli('key', 'add', '--tags', 'web')).out, /^hskey-auth-/);
  const st = await mock('state');
  assert.deepEqual(st.keys.at(-1).aclTags, ['tag:web']);
  assert.equal(st.keys.at(-2).reusable, true);

  const mac = await cli('join', '--user', 'alice', '--os', 'mac');
  assert.match(mac.out, /sudo \/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale up --auth-key=hskey-auth-\S+ --login-server=http:\/\/127\.0\.0\.1:18281 --accept-routes/);
  assert.match((await cli('join', '--tags', 'tag:web', '--os', 'docker')).out, /docker run/);
  assert.match((await cli('join', '--user', 'bob')).out, /install\.sh/);
  assert.equal(JSON.parse((await cli('--json', 'join', '--user', 'bob', '--os', 'win')).out).command.includes('tailscale.exe'), true);
  assert.equal((await cli('join', '--user', 'bob', '--os', 'beos')).code, 2);
});

test('policy get, check and set', async () => {
  assert.match((await cli('policy', 'get')).out, /group:admins/);
  const out = path.join(tmp, 'policy.hujson');
  assert.match((await cli('policy', 'get', '--out', out)).out, /Saved the policy/);
  const saved = fs.readFileSync(out, 'utf8');
  assert.match(saved, /Admins reach everything/);

  assert.equal((await cli('policy', 'check')).code, 2);
  assert.match((await cli('policy', 'check', out)).out, /The policy is valid/);
  const broken = path.join(tmp, 'broken.hujson');
  fs.writeFileSync(broken, '{\n "a": 1 2\n}');
  assert.match((await cli('policy', 'check', broken)).err, /syntax error on line 2/);
  fs.writeFileSync(broken, '{\n "a": [\n}');
  assert.doesNotMatch((await cli('policy', 'check', broken)).err, /on line/);
  const rejected = path.join(tmp, 'rejected.hujson');
  fs.writeFileSync(rejected, '{"INVALID": 1}');
  assert.match((await cli('policy', 'check', rejected)).err, /Headscale rejected the policy/);
  await mock('fail', { path: '/policy/check$', status: 404, message: 'not found' });
  assert.match((await cli('policy', 'check', out)).out, /can't validate without saving/);
  assert.equal((await cli('policy', 'frob', out)).code, 2);

  assert.match((await cli('policy', 'set', out)).out, /unchanged/);
  const next = path.join(tmp, 'next.hujson');
  fs.writeFileSync(next, saved.replace('Admins reach everything', 'Admins reach it all'));
  const dry = await cli('policy', 'set', next);
  assert.equal(dry.code, 2);
  assert.match(dry.out, /^- {3}\/\/ Admins reach everything\n\+ {3}\/\/ Admins reach it all$/);
  assert.match((await cli('policy', 'set', next, '--yes')).out, /Policy saved and applied/);
  assert.match((await mock('state')).policy, /Admins reach it all/);
  const huge = path.join(tmp, 'huge.hujson');
  fs.writeFileSync(huge, `${'// x\n'.repeat(300000)}{}`);
  assert.match((await cli('policy', 'set', huge)).out, /too large to diff/);

  await mock('set', { policy: null });
  assert.equal((await cli('policy', 'get')).out, '');
});

test('access check', async () => {
  const ok = await cli('check', 'laptop', 'router');
  assert.equal(ok.code, 0);
  assert.match(ok.out, /laptop → router tcp\/22: ALLOWED/);
  assert.match(ok.out, /SSH as root: NOT ALLOWED/);
  const blocked = await cli('check', 'server', 'router', '--port', '443');
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /BLOCKED[\s\S]*Network policy blocks TCP port 22/);
  assert.match((await cli('check', 'laptop', 'laptop', '--proto', 'icmp', '--ssh-user', 'alice')).out, /tcp|icmp: ALLOWED[\s\S]*SSH as alice: ALLOWED/);
  assert.equal((await cli('check', 'laptop', 'router', '--proto', 'sctp')).code, 2);
  await mock('set', { policy: 'not json' });
  assert.match((await cli('check', 'laptop', 'router')).err, /doesn't parse/);
  await mock('set', { policy: null });
  assert.equal((await cli('check', 'laptop', 'router')).code, 0); // no policy: everything allowed
});

test('status and backup', async () => {
  const s = await cli('status');
  assert.match(s.out, /Headscale .* at http:\/\/127\.0\.0\.1:18281 — database ok/);
  assert.match(s.out, /2 users, 4 machines \(2 online\)/);
  assert.match(s.out, /Routes awaiting approval on: router/);
  assert.match(s.out, /Expired keys: old-phone/);
  await mock('set', { nodes: [] });
  const quiet = await cli('status');
  assert.match(quiet.out, /No routes awaiting approval\nNo expired machine keys/);

  await mock('reset');
  const file = path.join(tmp, 'backup.json');
  assert.match((await cli('backup', '--out', file)).out, /Saved 2 users, 4 machines and the policy/);
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(b.format, 'headscale-console-backup');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /hskey-auth-/);
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    assert.match((await cli('backup')).out, /headscale-backup-\d{4}-\d{2}-\d{2}\.json/);
  } finally { process.chdir(cwd); }
});

test('runs as a program', async () => {
  const bin = new URL('../../dist/cli/hsconsole.js', import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [bin, 'users'], { env: { ...process.env, ...ENV } });
  assert.match(stdout, /alice/);
  await assert.rejects(promisify(execFile)(process.execPath, [bin, 'nope'], { env: { ...process.env, ...ENV } }), (e) => e.code === 2);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
