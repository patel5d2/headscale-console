import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { shq, psq, upFlags, joinCommand, joinScript } from '../../dist/shared/join.js';
import { buildBackup, parseBackup, restorePlan } from '../../dist/shared/backup.js';
import { parseEntry, pattern, analyze } from '../../dist/shared/logparse.js';

test('shell quoting preserves literal values without running expansions or splitting words', () => {
  for (const value of ['', 'safe-word@example:123', "quote'with space", '$(printf UNSAFE); `printf UNSAFE` $HOME', 'line\nvalue']) {
    assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${shq(value)}`], { encoding: 'utf8' }), value);
  }
  assert.equal(psq('plain-key'), 'plain-key');
  assert.equal(psq("has 'quotes' $HOME"), "'has ''quotes'' $HOME'");
});

test('native join commands provide installation, options, status and safe single-command forms', () => {
  const opts = { acceptRoutes: true, acceptDns: false, exitNode: true, routes: ['10.0.0.0/8'], hostname: 'my laptop', ssh: true, useExitNode: '100.64.0.1', exitLan: true, shieldsUp: true, operator: "a'b", forceReauth: true, qr: true, reset: true };
  const flags = upFlags('https://hs', 'key', ['tag:web'], opts);
  for (const flag of ['--accept-routes', '--accept-dns=false', '--advertise-exit-node', '--advertise-routes=10.0.0.0/8', '--advertise-tags=tag:web', '--ssh', '--exit-node-allow-lan-access', '--shields-up', '--force-reauth', '--qr', '--reset']) assert.ok(flags.includes(flag), flag);
  assert.deepEqual(upFlags('https://hs', undefined, [], { useExitNode: 'router', exitLan: false }), ['--login-server=https://hs', '--exit-node=router']);
  assert.equal(joinCommand('mac', 'https://hs.example.com', 'hskey-auth-X', [], { acceptRoutes: true, acceptDns: true, install: false, verify: false }), 'sudo /Applications/Tailscale.app/Contents/MacOS/Tailscale up --auth-key=hskey-auth-X --login-server=https://hs.example.com --accept-routes');
  for (const os of ['linux', 'mac', 'win']) {
    const cmd = joinCommand(os, 'https://hs', 'key', ['tag:x'], opts);
    assert.match(cmd, /status$/); assert.equal(cmd.split('\n').length, 3);
  }
  assert.match(joinCommand('win', 'https://hs', 'k', [], { install: false, verify: false }), /--unattended$/);
  const hostile = 'https://hs/\nprintf INJECTED\r\n#';
  const script = joinScript('linux', hostile, "key'$(printf INJECTED)", [], { install: false, verify: false });
  const output = execFileSync('/bin/sh', ['-c', `sudo() { printf '%s\\n' "$@"; }\n${script}`], { encoding: 'utf8' });
  assert.equal(output, `tailscale\nup\n--auth-key=key'$(printf INJECTED)\n--login-server=${hostile}\n`);
  assert.match(joinScript('mac', 'https://hs', undefined), /^#!\/bin\/sh\n#.*\nset -eu\n/);
});

test('Docker and Compose keep secrets in environment and persist Tailscale state', () => {
  const docker = joinCommand('docker', 'https://hs', "secret' $HOME", [], { hostname: 'node', verify: false });
  assert.doesNotMatch(docker, /--auth-key/); assert.match(docker, /TS_AUTHKEY=/); assert.doesNotMatch(docker, /docker exec/);
  assert.match(joinCommand('docker', 'https://hs'), /docker exec tailscaled tailscale status$/);
  const compose = joinCommand('compose', 'https://hs', 'line\n"secret"');
  assert.match(compose, /TS_AUTHKEY: "line\\n\\"secret\\""/);
  assert.match(compose, /tailscale-state:\/var\/lib\/tailscale/);
  assert.doesNotMatch(joinCommand('compose', 'https://hs'), /TS_AUTHKEY/);
});

test('backups retain metadata, omit secrets, validate uploads and compare restore changes', () => {
  const input = { server: 'https://hs', headscaleVersion: 'v0.29.5', users: [{ id: '1', name: 'alice', displayName: 'Alice', email: 'a@x', provider: 'oidc', createdAt: 'date', password: 'secret' }], nodes: [{ id: '1', givenName: 'friendly', name: 'legacy', user: { name: 'alice' }, tags: ['tag:x'], ipAddresses: ['100.64.0.1'], approvedRoutes: ['10.0.0.0/8'], expiry: 'later', createdAt: 'earlier', nodeKey: 'secret' }, { id: '2', name: 'legacy' }, { id: '3' }], preAuthKeys: [{ id: '1', key: 'secret', user: { name: 'alice' }, reusable: true, ephemeral: true, used: true, expiration: 'later', aclTags: ['tag:x'] }, {}], apiKeys: [{ prefix: 'prefix', secret: 'secret', expiration: 'later', createdAt: 'earlier' }, { prefix: 'other' }], policy: '{}', now: new Date('2026-01-01Z') };
  const backup = buildBackup(input);
  assert.equal(backup.exportedAt, input.now.toISOString()); assert.equal(backup.nodes[0].name, 'friendly'); assert.equal(backup.nodes[1].name, 'legacy'); assert.equal(backup.nodes[2].name, '');
  assert.doesNotMatch(JSON.stringify(backup), /secret|nodeKey|password/);
  assert.equal(backup.preAuthKeys[1].id, null); assert.deepEqual(backup.nodes[2].tags, []);
  assert.deepEqual(parseBackup(JSON.stringify(backup)), backup);
  assert.deepEqual(restorePlan(backup, [], '[]'), { createUsers: backup.users, policyChanged: true });
  assert.deepEqual(restorePlan(backup, backup.users, ' {} '), { createUsers: [], policyChanged: false });
  assert.ok(Date.parse(buildBackup({ ...input, now: undefined }).exportedAt));
  for (const [value, message] of [['bad', /not JSON/], ['null', /not a Headscale/], ['{}', /not a Headscale/], [JSON.stringify({ ...backup, version: 999 }), /newer version/], [JSON.stringify({ ...backup, version: '1' }), /newer version/], [JSON.stringify({ ...backup, users: null }), /incomplete/], [JSON.stringify({ ...backup, policy: null }), /incomplete/]]) assert.throws(() => parseBackup(value), message);
});

test('logs parse zerolog, JSON and priority fallbacks while grouping repeated warnings', () => {
  assert.deepEqual(parseEntry({ t: 1, p: 6, m: '2025-01-01T00:00:00Z ERR boom node=1' }), { t: 1, level: 'error', msg: 'boom node=1' });
  assert.deepEqual(parseEntry({ t: 1, p: 6, m: '{"level":"warn","time":"ignored","message":"slow","ms":5,"name":"node","nested":{"x":1}}' }), { t: 1, level: 'warn', msg: 'slow ms=5 name=node nested={"x":1}' });
  assert.deepEqual(parseEntry({ t: 1, p: 4, m: '{"unknown":true}' }), { t: 1, level: 'warn', msg: 'unknown=true' });
  assert.equal(parseEntry({ t: 1, p: 3, m: '{bad json' }).msg, '{bad json');
  for (const [p, level] of [[3, 'error'], [4, 'warn'], [7, 'debug'], [6, 'info']]) assert.equal(parseEntry({ t: 1, p, m: 'plain line' }).level, level);
  for (const [m, level] of [['DBG debug', 'debug'], ['INF info', 'info'], ['WRN warn', 'warn'], ['FTL fatal', 'error'], ['TRC trace', 'debug'], ['PNC panic', 'error']]) assert.equal(parseEntry({ t: 1, p: 6, m }).level, level);
  assert.equal(pattern('failed node=12 ip=1.2.3.4 after 30s'), pattern('failed node=7 ip=5.6.7.8 after 31s'));
  assert.equal(pattern('id abcdefabcdef x="hello world"'), 'id … x=…'); assert.equal(pattern('x'.repeat(300)).length, 240);
  const entries = [{ t: 1, level: 'warn', msg: 'slow 1' }, { t: 2, level: 'error', msg: 'failed 2' }, { t: 3, level: 'error', msg: 'failed 3' }, { t: 4, level: 'debug', msg: 'debug' }, { t: 5, level: 'info', msg: 'info' }];
  const result = analyze(entries);
  assert.deepEqual(result.counts, { error: 2, warn: 1, info: 1, debug: 1 }); assert.equal(result.groups[0].n, 2); assert.equal(result.groups[0].last.t, 3);
  assert.equal(analyze(entries, 1).groups.length, 1); assert.deepEqual(analyze([]).groups, []);
});
