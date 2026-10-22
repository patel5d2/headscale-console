import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../../dist/shared/model.js';

test('time helpers handle absent, invalid, disabled, past and future timestamps', (t) => {
  const now = new Date('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now.getTime());
  for (const value of [undefined, null, '', 'invalid', m.ZERO_TIME]) assert.equal(m.parseTime(value), null);
  assert.deepEqual(m.parseTime(now), now);
  assert.equal(m.relTime(undefined), '—');
  assert.equal(m.relTime(new Date(now.getTime() - 1000)), 'just now');
  assert.equal(m.relTime(now), 'in a few seconds');
  assert.equal(m.relTime(now, { future: false }), 'just now');
  assert.equal(m.relTime(new Date(now.getTime() + 50_000)), 'in 1 minute');
  assert.equal(m.relTime('2026-01-01T02:00:00Z'), 'in 2 hours');
  assert.equal(m.relTime('2025-12-31T00:00:00Z'), '1 day ago');
  for (const [days, unit] of [[7, 'week'], [30, 'month'], [365, 'year']]) {
    assert.equal(m.relTime(m.isoInDays(days)), `in 1 ${unit}`);
  }
  assert.deepEqual(m.expiryState({ expiry: m.ZERO_TIME }), { disabled: true, expired: false, date: null });
  assert.equal(m.expiryState({ expiry: m.isoInDays(-1) }).expired, true);
  assert.equal(m.expiryState({ expiry: m.isoInDays(1) }).expired, false);
});

test('machine names, legacy tags, addresses and ownership have stable fallbacks', () => {
  assert.equal(m.nodeName({ id: '4', givenName: 'friendly', name: 'old' }), 'friendly');
  assert.equal(m.nodeName({ id: '4', name: 'old' }), 'old');
  assert.equal(m.nodeName({ id: '4' }), 'node-4');
  const tags = ['tag:new'];
  const result = m.nodeTags({ tags, forcedTags: ['tag:old'] });
  assert.deepEqual(result, tags); assert.notEqual(result, tags);
  assert.deepEqual(m.nodeTags({ tags: [], forcedTags: ['tag:a'], validTags: ['tag:a', 'tag:b'] }), ['tag:a', 'tag:b']);
  assert.deepEqual(m.nodeTags({}), []);
  assert.equal(m.nodeIPv4({ ipAddresses: ['fd::1', '100.64.0.1'] }), '100.64.0.1');
  assert.equal(m.nodeIPv6({ ipAddresses: ['100.64.0.1', 'fd::1'] }), 'fd::1');
  assert.equal(m.nodeIPv4({}), ''); assert.equal(m.nodeIPv6({}), '');
  assert.equal(m.ownerLabel({ tags }).tagged, true);
  assert.deepEqual(m.ownerLabel({}), { tagged: false, label: 'Unknown', sub: '' });
  assert.deepEqual(m.ownerLabel({ user: { name: 'alice' } }), { tagged: false, label: 'alice', sub: 'alice' });
  assert.deepEqual(m.ownerLabel({ user: { name: 'a', displayName: 'Alice', email: 'a@x' } }), { tagged: false, label: 'Alice', sub: 'a@x' });
  for (const [u, label] of [[null, 'Unknown'], [{ displayName: 'A' }, 'A'], [{ name: 'a' }, 'a'], [{ email: 'a@x' }, 'a@x'], [{ id: '2' }, 'user-2']]) assert.equal(m.userLabel(u), label);
  assert.equal(m.userRef({ name: 'a' }), 'a@'); assert.equal(m.userRef({ name: 'a@x' }), 'a@x');
  assert.equal(m.initials('alice.smith@example.com'), 'AS');
  assert.equal(m.initials('Alice'), 'A'); assert.equal(m.initials(null), '?'); assert.equal(m.initials('  '), '?');
  assert.equal(m.avatarHue(''), 0); assert.equal(m.avatarHue('Alice'), m.avatarHue('Alice'));
});

test('route status distinguishes advertised, approved, withdrawn and exit routes', () => {
  assert.equal(m.routeInfo({}).hasAny, false);
  const r = m.routeInfo({ availableRoutes: ['10.0.0.0/8', '192.168.0.0/24', ...m.EXIT_ROUTES], approvedRoutes: ['10.0.0.0/8', '172.16.0.0/12'], subnetRoutes: ['10.0.0.0/8'] });
  assert.deepEqual(r.subnets, ['10.0.0.0/8', '192.168.0.0/24', '172.16.0.0/12']);
  assert.deepEqual(r.pendingSubnets, ['192.168.0.0/24']); assert.equal(r.exitPending, true);
  assert.equal(m.routeInfo({ availableRoutes: m.EXIT_ROUTES, approvedRoutes: m.EXIT_ROUTES }).exitApproved, true);
  assert.equal(m.routeInfo({ availableRoutes: m.EXIT_ROUTES, approvedRoutes: [m.EXIT_ROUTES[0]] }).exitApproved, false);
  assert.equal(m.routeInfo({ approvedRoutes: m.EXIT_ROUTES }).exitApproved, true);
});

test('CIDR, label and version utilities accept their documented forms', () => {
  for (const cidr of ['0.0.0.0/0', '255.255.255.255/32', ' 10.0.0.0/8 ', 'fd7a:115c:a1e0::/48', '::/0', '::1/128']) assert.equal(m.validCIDR(cidr), true, cidr);
  for (const cidr of ['', '256.1.2.3/24', '1.2.3.4/33', '1.2.3.4', 'example/24', 'abc/32', '::/129']) assert.equal(m.validCIDR(cidr), false, cidr);
  assert.equal(m.pluralize(1, 'machine'), '1 machine'); assert.equal(m.pluralize(2, 'machine'), '2 machines'); assert.equal(m.pluralize(0, 'person', 'people'), '0 people');
  assert.equal(m.hostOf('https://hs.test:8443/path'), 'hs.test:8443'); assert.equal(m.hostOf('invalid'), 'invalid');
  assert.equal(m.semver('v0.29.5-beta'), '0.29.5'); assert.equal(m.semver(null), null); assert.equal(m.semver('bad'), null);
  assert.equal(m.cmpVersion('1.0.0', '0.9.9'), 1); assert.equal(m.cmpVersion('1.2.0', '1.3.0'), -1); assert.equal(m.cmpVersion('1.2.3', '1.2.4'), -1); assert.equal(m.cmpVersion('1.2.3', '1.2.3'), 0);
});

test('HuJSON strips only comments and structural trailing commas', () => {
  const source = '{\n// header\n"text":"https://x/a,} /* literal */ \\\" \\\\" ,\n/* multi\nline ** comment */ "list":[1,2,],\n}';
  const parsed = m.parseHuJSON(source);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.text, 'https://x/a,} /* literal */ " \\');
  assert.deepEqual(parsed.value.list, [1, 2]);
  assert.equal(m.stripHuJSON(source).split('\n').length, source.split('\n').length);
  assert.equal(m.hasComments(source), true);
  assert.equal(m.hasComments('{"url":"https://x/\\\"/*"}'), false);
  assert.equal(m.hasComments('/* comment */{}'), true);
  assert.equal(m.hasComments('{"x":1}'), false);
  assert.equal(m.parseHuJSON('"unfinished\\').ok, false);
  assert.equal(m.parseHuJSON('{\n"x": invalid\n}').ok, false);
  assert.equal(m.parseHuJSON('{').ok, false);
  assert.equal(m.parseHuJSON('/* unterminated').ok, false);
  assert.equal(m.stripHuJSON('// trailing'), '           ');
});

test('HuJSON error positions support both browser and Node error formats', (t) => {
  for (const [message, expected] of [['bad at line 2 column 3', [2, 3]], ['bad at position 4', [2, 2]], ['bad input', [null, null]]]) {
    const mock = t.mock.method(JSON, 'parse', () => { throw new SyntaxError(message); });
    const r = m.parseHuJSON('{}\nxx');
    assert.equal(r.ok, false); assert.deepEqual([r.line, r.col], expected);
    mock.mock.restore();
  }
});

test('line diffs reconstruct both inputs including additions, deletions and limits', () => {
  const d = m.lineDiff('a\nb\nc\nd', 'a\nc\nx\nd');
  assert.deepEqual(d.map((r) => r.op + r.line), [' a', '-b', ' c', '+x', ' d']);
  for (const [a, b] of [['a\nb', 'b'], ['a', 'a\nb'], ['a\nb', 'a'], ['b', 'a\nb'], ['', 'a'], ['same', 'same']]) {
    const diff = m.lineDiff(a, b);
    assert.equal(diff.filter((r) => r.op !== '+').map((r) => r.line).join('\n'), a);
    assert.equal(diff.filter((r) => r.op !== '-').map((r) => r.line).join('\n'), b);
  }
  assert.equal(m.lineDiff('a\n'.repeat(2001), 'b\n'.repeat(2001)), null);
});
