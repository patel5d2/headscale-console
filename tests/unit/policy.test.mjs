import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAccess, checkSsh, cidrContains, splitDst, machineOf } from '../../dist/shared/policy-check.js';
import { mergePolicy, SNIPPETS, TEMPLATES } from '../../dist/shared/policy-library.js';
import { parseHuJSON } from '../../dist/shared/model.js';

const alice = { user: { name: 'alice', email: 'alice@x.com' }, tags: [], ips: ['100.64.0.1', 'fd::1'] };
const alice2 = { ...alice, ips: ['100.64.0.2'] };
const bob = { user: { name: 'bob@' }, tags: [], ips: ['100.64.0.3'] };
const web = { user: null, tags: ['tag:web'], ips: ['100.64.0.9'] };
const anonymous = { user: null, tags: [], ips: [] };
const rule = (src, dst, extra = {}) => ({ action: 'accept', src: [src], dst: [dst], ...extra });

test('access checks groups, self, tags, hosts, ports and protocol', () => {
  const policy = {
    groups: { 'group:admins': ['alice@'] }, hosts: { tailnet: '100.64.0.0/10' },
    acls: [rule('group:admins', '*:*'), rule('autogroup:member', 'autogroup:self:*'), rule('autogroup:member', 'tag:web:80,443,8000-8100'), rule('tag:web', 'tailnet:53', { proto: 'udp' })],
  };
  assert.equal(checkAccess(policy, alice, bob, 22).index, 0);
  assert.equal(checkAccess(policy, bob, bob, 22).index, 1);
  assert.equal(checkAccess(policy, bob, alice, 22).allowed, false);
  for (const port of [80, 443, 8000, 8050, 8100]) assert.equal(checkAccess(policy, bob, web, port).index, 2);
  for (const port of [22, 7999, 8101]) assert.equal(checkAccess(policy, bob, web, port).allowed, false);
  assert.equal(checkAccess(policy, web, bob, 53, 'udp').index, 3);
  assert.equal(checkAccess(policy, web, bob, 53, 'tcp').allowed, false);
  assert.equal(checkAccess({}, bob, alice, 1).allowed, true);
  assert.equal(checkAccess({ acls: [rule('*', '*:1', { proto: 1 })] }, bob, alice, 22, 'icmp').allowed, true);
  assert.equal(checkAccess({ acls: [rule('*', '*:*', { proto: '' })] }, bob, alice, 22).allowed, true);
  assert.equal(checkAccess({ acls: [rule('*', '*:*', { action: 'deny' }), { dst: '*:*' }] }, bob, alice, 22).allowed, false);
  assert.equal(checkAccess({ acls: { src: '*', dst: '*:22' } }, bob, alice, 22).allowed, true);
});

test('aliases distinguish users from tagged machines and reject unsupported autogroups', () => {
  const allowed = (src, machine, dst = alice, extra = {}) => checkAccess({ ...extra, acls: [rule(src, '*:*')] }, machine, dst, 22).allowed;
  assert.equal(allowed('alice@', alice), true); assert.equal(allowed('alice@x.com', alice), true);
  assert.equal(allowed('alice@', web), false); assert.equal(allowed('bob@', bob), true);
  assert.equal(allowed('group:missing', alice), false); assert.equal(allowed('group:admins', web, alice, { groups: { 'group:admins': ['alice@'] } }), false);
  assert.equal(allowed('group:admins', anonymous, alice, { groups: { 'group:admins': 'alice@' } }), false);
  assert.equal(allowed('autogroup:tagged', web), true); assert.equal(allowed('autogroup:tagged', alice), false);
  assert.equal(allowed('autogroup:member', anonymous), false); assert.equal(allowed('autogroup:member', web), false);
  assert.equal(allowed('autogroup:self', alice, alice2), true); assert.equal(allowed('autogroup:self', alice, anonymous), false);
  assert.equal(allowed('autogroup:self', anonymous), false); assert.equal(allowed('autogroup:self', alice, web), false); assert.equal(allowed('autogroup:self', web), false);
  assert.equal(allowed('autogroup:internet', alice), false);
  assert.equal(allowed('100.64.0.1', alice), true); assert.equal(allowed('100.64.0.0/24', alice), true); assert.equal(allowed('fd::1', alice), true);
});

test('grants match sources, destinations and wildcard, protocol or numeric port specifications', () => {
  const check = (grant, port = 22, proto = 'tcp') => checkAccess({ grants: [grant] }, alice, bob, port, proto);
  assert.equal(check({ src: ['bob@'], dst: ['*'], ip: ['*'] }).allowed, false);
  assert.equal(check({ src: ['*'], dst: ['alice@'], ip: ['*'] }).allowed, false);
  assert.equal(check({ src: '*', dst: '*', ip: '*' }).section, 'grants');
  assert.equal(check({ src: ['*'], dst: ['*'], ip: ['udp:53', 'tcp:22'] }).index, 0);
  assert.equal(check({ src: ['*'], dst: ['*'], ip: ['20-23'] }).allowed, true);
  assert.equal(check({ src: ['*'], dst: ['*'], ip: ['icmp:*'] }, 0, 'icmp').allowed, true);
  assert.equal(check({ src: ['*'], dst: ['*'], ip: ['tcp:80'] }).allowed, false);
  assert.equal(check({ src: ['*'], dst: ['*'] }).allowed, false);
});

test('SSH checks ownership, source, destination, local username and reauthentication', () => {
  const policy = { ssh: [{ action: 'check', src: ['autogroup:member'], dst: ['autogroup:self'], users: ['autogroup:nonroot'] }] };
  assert.equal(checkSsh(policy, alice, alice2, 'root').allowed, false);
  assert.equal(checkSsh(policy, alice, alice2, 'ubuntu').action, 'check');
  assert.equal(checkSsh(policy, alice, bob, 'ubuntu').allowed, false);
  assert.equal(checkSsh(policy, web, alice, 'ubuntu').allowed, false);
  assert.equal(checkSsh({}, alice, bob, 'root').allowed, false);
  const local = { ssh: [{ action: 'accept', src: ['*'], dst: ['*'], users: ['localpart:*@*'] }] };
  assert.equal(checkSsh(local, alice, bob, 'alice').action, 'accept');
  assert.equal(checkSsh(local, alice, bob, 'other').allowed, false);
  assert.equal(checkSsh(local, bob, alice, 'bob').allowed, false);
  assert.equal(checkSsh(local, anonymous, alice, 'root').allowed, false);
  assert.equal(checkSsh({ ssh: [{ src: '*', dst: '*', users: 'root' }] }, alice, bob, 'root').allowed, true);
});

test('CIDR containment and destination splitting cover exact IPv4 and IPv6 behavior', () => {
  assert.equal(cidrContains('100.64.0.0/10', ['100.100.1.1']), true);
  assert.equal(cidrContains('100.64.0.0/10', ['100.128.0.1']), false);
  assert.equal(cidrContains('0.0.0.0/0', ['::1', '1.2.3.4']), true);
  assert.equal(cidrContains('1.2.3.4', ['1.2.3.4']), true);
  assert.equal(cidrContains('1.2.3.4', ['1.2.3.5']), false);
  assert.equal(cidrContains('256.1.2.3', ['1.2.3.4']), false);
  assert.equal(cidrContains('fd::1/128', ['fd::1']), true);
  assert.equal(cidrContains('fd::1/64', ['fd::1']), false);
  assert.deepEqual(splitDst('tag:web:80,443'), { alias: 'tag:web', ports: '80,443' });
  assert.deepEqual(splitDst('tag:web'), { alias: 'tag:web', ports: '*' });
  assert.deepEqual(splitDst('*:*'), { alias: '*', ports: '*' });
  assert.deepEqual(splitDst('host'), { alias: 'host', ports: '*' });
  assert.deepEqual(machineOf({ user: { name: 'alice', email: 'a@x' }, ipAddresses: ['1.2.3.4'], tags: ['tag:x'] }), { user: { name: 'alice', email: 'a@x' }, ips: ['1.2.3.4'], tags: ['tag:x'] });
  assert.deepEqual(machineOf({ user: { name: 'bob' } }), { user: { name: 'bob' }, ips: [], tags: [] });
  assert.deepEqual(machineOf({}), { user: null, ips: [], tags: [] });
});

test('every policy template and snippet parses, merges once, and preserves access ownership', () => {
  for (const template of Object.values(TEMPLATES)) assert.equal(parseHuJSON(template.text).ok, true, template.name);
  const base = { groups: { 'group:admins': ['boss@'] }, tagOwners: { 'tag:web': ['boss@'] }, hosts: { web: '1.2.3.4' }, acls: [rule('*', '*:*')] };
  const snippet = SNIPPETS.find((s) => s.name === 'Shared web services').make('alice@');
  const result = mergePolicy(base, { ...snippet, hosts: { web: '0.0.0.0/0', dns: '1.1.1.1' } });
  assert.deepEqual(result.groups, base.groups); assert.deepEqual(result.tagOwners, base.tagOwners);
  assert.equal(result.hosts.web, '1.2.3.4'); assert.equal(result.hosts.dns, '1.1.1.1');
  assert.equal(result.acls.length, 2); assert.equal(base.acls.length, 1);
  assert.deepEqual(mergePolicy(result, snippet), result);
  assert.deepEqual(mergePolicy({}, snippet).groups, { 'group:admins': ['alice@'] });
  for (const s of SNIPPETS) { const p = mergePolicy({}, s.make('a@')); assert.deepEqual(mergePolicy(p, s.make('a@')), p, s.name); }
  assert.deepEqual(mergePolicy({ custom: { scalar: 1, missing: undefined, nil: null, list: [] } }, { custom: { scalar: 2, missing: 3, nil: 'replacement', list: 5 } }), { custom: { scalar: 1, missing: 3, nil: null, list: [] } });
});
