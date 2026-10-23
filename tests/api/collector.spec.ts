// Automatic log collection without a browser: turning it on and off, network activity
// from polling, device log intake (plain and zstd) and the request to allow device logs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { APIRequestContext } from '@playwright/test';
import { SERVERS, url } from '../support/env.js';
import { expect, test } from '../support/fixtures.js';
import { API_KEY } from '../support/mock-headscale.js';

const AUTH = { Authorization: `Bearer ${API_KEY}` };
const FULL = url('full');

async function turnOn(request: APIRequestContext): Promise<{ ingestPath: string }> {
  const key = (await (await request.post(`${FULL}/proxy/api/v1/apikey`, { headers: AUTH, data: { expiration: '2099-01-01T00:00:00Z' } })).json()).apiKey;
  const r = await request.post(`${FULL}/console/collector`, { headers: AUTH, data: { key } });
  expect(r.status()).toBe(200);
  return r.json();
}

test.describe.serial('automatic log collection', () => {
  test.afterAll(async ({ request }) => { await request.delete(`${FULL}/console/collector`, { headers: AUTH }); });

  test('resumes after a restart, needs an API key, a valid key and a locked server', async ({ request, mock }) => {
    await mock('reset');
    // global-setup saved a configuration before the server started: it resumed polling.
    // (Only true once per server start, so not on --repeat-each runs.)
    if (test.info().repeatEachIndex === 0) {
      const resumed = await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json();
      expect(resumed).toMatchObject({ enabled: true, ok: false, ingestPath: 'ingest/restart-token-0123456789' });
      expect(resumed.error).toContain('API key was rejected');
    }
    await request.delete(`${FULL}/console/collector`, { headers: AUTH });
    expect((await request.get(`${FULL}/console/collector`)).status()).toBe(401);
    const off = await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json();
    expect(off).toMatchObject({ enabled: false, ingestPath: null, hostActions: true, headscaleLogtail: 'unknown' });
    expect((await request.post(`${FULL}/console/collector`, { headers: AUTH, data: {} })).status()).toBe(400);
    const bad = await request.post(`${FULL}/console/collector`, { headers: AUTH, data: { key: 'hskey-api-WRONG-0000000000' } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).message).toContain('rejected that API key');
    expect((await request.put(`${FULL}/console/collector`, { headers: AUTH })).status()).toBe(405);
    expect((await request.get(`${url('open')}/console/collector`, { headers: AUTH })).status()).toBe(404);
    expect((await request.get(`${url('open')}/console/device-logs`, { headers: AUTH })).status()).toBe(404);
  });

  test('records network activity from polling', async ({ request, mock }) => {
    await mock('reset');
    for (const f of ['activity.jsonl', 'activity.jsonl.1', 'activity-state.json']) fs.rmSync(path.join(SERVERS.full.dir, 'data', f), { force: true });
    const st = await turnOn(request);
    expect(st).toMatchObject({ enabled: true, ok: true });
    expect(st.ingestPath).toMatch(/^ingest\/[A-Za-z0-9_-]{20,}$/);
    const { nodes, users } = await mock('state');
    const changed = [
      { ...nodes[0], givenName: 'laptop-2', online: false, tags: ['tag:web'], ipAddresses: ['100.64.0.1'], user: users[1] },
      { ...nodes[1], availableRoutes: ['10.0.0.0/8'], approvedRoutes: ['10.0.0.0/8'] },
      { ...nodes[2], expiry: new Date(Date.now() - 1000).toISOString(), online: true },
      { ...nodes[0], id: '50', givenName: 'newcomer' },
    ];
    await mock('set', { nodes: changed });
    let entries: Array<{ kind: string; name: string; detail: string }> = [];
    await expect.poll(async () => {
      entries = (await (await request.get(`${FULL}/console/activity`, { headers: AUTH })).json()).entries;
      return entries.map((e) => e.name);
    }, { timeout: 5000 }).toContain('newcomer');
    const kinds = entries.map((e) => `${e.kind}:${e.name}`);
    for (const k of ['renamed:laptop-2', 'offline:laptop-2', 'owner:laptop-2', 'tags:laptop-2', 'addresses:laptop-2', 'routes:router',
      'key-expired:server', 'online:server', 'joined:newcomer', 'removed:old-phone']) expect(kinds).toContain(k);
    const q = (await (await request.get(`${FULL}/console/activity?q=newcomer&limit=5`, { headers: AUTH })).json()).entries;
    expect(q).toHaveLength(1);
    expect(q[0].detail).toContain('Joined as Alice Doe');
  });

  test('reports a rejected key or an unreachable server', async ({ request, mock }) => {
    await mock('fail', { path: '^/api/v1/node$', status: 401, message: 'nope', times: 3 });
    await expect.poll(async () => (await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json()).error, { timeout: 5000 })
      .toContain('API key was rejected');
    await mock('fail', { path: '^/api/v1/node$', status: 500, message: 'down', times: 3 });
    await expect.poll(async () => (await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json()).error, { timeout: 5000 })
      .toContain('Headscale answered 500');
    await mock('fail', { path: '^/api/v1/node$', status: 0, message: 'drop', times: 3 });
    await expect.poll(async () => (await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json()).error, { timeout: 5000 })
      .toContain('unreachable');
    await mock('set', { fail: [] });
    await expect.poll(async () => (await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json()).ok, { timeout: 5000 }).toBe(true);
    // A disk problem while saving is reported too, and polling carries on.
    const blocker = path.join(SERVERS.full.dir, 'data', 'activity-state.json.tmp');
    fs.mkdirSync(blocker);
    await expect.poll(async () => (await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json()).error, { timeout: 5000 }).toMatch(/EISDIR|illegal operation/);
    fs.rmdirSync(blocker);
    await expect.poll(async () => (await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json()).ok, { timeout: 5000 }).toBe(true);
  });

  test('takes device logs, plain or zstd, and lists them', async ({ request }) => {
    fs.rmSync(path.join(SERVERS.full.dir, 'data', 'device-logs'), { recursive: true, force: true });
    const { ingestPath } = await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json();
    const post = (rest: string, data: Buffer | string, headers: Record<string, string> = {}) => request.post(`${FULL}/${ingestPath}${rest}`, { data, headers });
    const t = '2026-10-01T10:00:00Z';
    const r1 = await post('/n1/c/tailnode.log.tailscale.io/0123456789abcdef', JSON.stringify([
      { logtail: { client_time: t }, text: 'Program starting\n' }, { logtail: {}, v: 1, magic: 42 }, 'bare string',
    ]));
    expect(r1.status()).toBe(200);
    const zipped = zlib.zstdCompressSync(Buffer.from(JSON.stringify([{ text: 'compressed line' }])));
    expect((await post('/k10/c/tailnode.log.tailscale.io/fedcba9876543210', zipped, { 'Content-Encoding': 'zstd' })).status()).toBe(200);
    expect((await post('/k10/c/x/fedcba9876543210', JSON.stringify({ text: 'single object' }))).status()).toBe(200);

    expect((await post('/k10/c/x/fedcba9876543210', Buffer.from('not zstd'), { 'Content-Encoding': 'zstd' })).status()).toBe(400);
    expect((await post('/k10/c/x/fedcba9876543210', 'x', { 'Content-Encoding': 'br' })).status()).toBe(415);
    expect((await post('/k10/c/x/fedcba9876543210', 'not json')).status()).toBe(400);
    expect((await post('/k10/c/x/fedcba9876543210', 'x'.repeat(600 * 1024))).status()).toBe(413);
    expect((await post('/bad/c/x/fedcba9876543210', '[]')).status()).toBe(404);
    expect((await request.post(`${FULL}/ingest/WRONG-TOKEN-0123456789/n1/c/x/0123456789abcdef`, { data: '[]' })).status()).toBe(404);
    expect((await request.get(`${FULL}/${ingestPath}/n1/c/x/0123456789abcdef`)).status()).toBe(404);

    const labels = (await (await request.get(`${FULL}/console/device-logs`, { headers: AUTH })).json()).labels;
    expect(labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'n1', lines: 3, devices: ['01234567'] }),
      expect.objectContaining({ label: 'k10', lines: 2, devices: ['fedcba98'] }),
    ]));
    const n1 = (await (await request.get(`${FULL}/console/device-logs/n1`, { headers: AUTH })).json()).entries;
    expect(n1.map((e: { m: string }) => e.m)).toEqual(['bare string', '{"magic":42}', 'Program starting']);
    expect(n1[2].t).toBe(Date.parse(t));
    expect((await (await request.get(`${FULL}/console/device-logs/k10?q=COMPRESSED&limit=1`, { headers: AUTH })).json()).entries).toHaveLength(1);
    expect((await request.get(`${FULL}/console/device-logs/..%2Faudit`, { headers: AUTH })).status()).toBe(404);
    expect((await request.get(`${FULL}/console/device-logs/x1`, { headers: AUTH })).status()).toBe(404);
    expect((await request.post(`${FULL}/console/device-logs`, { headers: AUTH })).status()).toBe(405);
    expect((await request.get(`${FULL}/console/device-logs`)).status()).toBe(401);

    // Past DEVICE_LOG_MAX_BYTES (4000 in tests) a log rotates to .1 and both are read.
    for (let i = 0; i < 4; i++) await post('/n1/c/x/0123456789abcdef', JSON.stringify(Array.from({ length: 20 }, (_, j) => ({ text: `filler ${i}-${j} ${'x'.repeat(40)}` }))));
    expect(fs.existsSync(path.join(SERVERS.full.dir, 'data', 'device-logs', 'n1.jsonl.1'))).toBe(true);
    expect((await (await request.get(`${FULL}/console/device-logs/n1?limit=10000`, { headers: AUTH })).json()).entries.length).toBe(83);
  });

  test('asks the root helper to allow device logs', async ({ request }) => {
    const reqFile = path.join(SERVERS.full.dir, 'state', 'update-request');
    fs.rmSync(reqFile, { force: true });
    expect((await request.post(`${FULL}/host/logtail`, { headers: AUTH })).status()).toBe(202);
    expect(fs.readFileSync(reqFile, 'utf8')).toBe('logtail-on\n');
    expect((await request.post(`${FULL}/host/logtail`, { headers: AUTH })).status()).toBe(409); // queued already
    fs.rmSync(reqFile, { force: true });
    fs.writeFileSync(path.join(SERVERS.full.dir, 'update-status', 'logtail.json'), '{"state":"on"}');
    expect((await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json()).headscaleLogtail).toBe('on');
    fs.rmSync(path.join(SERVERS.full.dir, 'update-status', 'logtail.json'));
    expect((await request.post(`${url('broken')}/host/logtail`, { headers: AUTH })).status()).toBe(500);
  });

  test('turns off, keeps what was collected, refuses devices', async ({ request }) => {
    const { ingestPath } = await (await request.get(`${FULL}/console/collector`, { headers: AUTH })).json();
    const off = await (await request.delete(`${FULL}/console/collector`, { headers: AUTH })).json();
    expect(off).toMatchObject({ enabled: false, prefix: expect.stringMatching(/^NEWKEY\d+$/) });
    expect((await request.post(`${FULL}/${ingestPath}/n1/c/x/0123456789abcdef`, { data: '[]' })).status()).toBe(404);
    expect((await (await request.get(`${FULL}/console/activity`, { headers: AUTH })).json()).entries.length).toBeGreaterThan(0);
    expect((await (await request.delete(`${FULL}/console/collector`, { headers: AUTH })).json()).prefix).toBeNull();
  });
});
