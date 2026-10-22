// The console server without a browser: static files, the proxy, the SSH relay, host
// actions, the audit log and policy history, and how each fails.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { ROOT, SERVERS, MOCK, url } from '../support/env.js';
import { expect, test } from '../support/fixtures.js';
import { API_KEY } from '../support/mock-headscale.js';

const AUTH = { Authorization: `Bearer ${API_KEY}` };
const FULL = SERVERS.full.dir;

/** A raw HTTP exchange, for requests a normal client won't send. */
function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(payload));
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    setTimeout(() => s.destroy(), 1500);
  });
}

/** A WebSocket handshake to /ts2021; resolves with what came back. */
function wsHandshake(port: number, pathName = '/ts2021?X-Tailscale-Handshake=abc', method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request({
      port, host: '127.0.0.1', path: pathName, method,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'tailscale-control-protocol', Origin: 'http://evil.example' },
    });
    req.on('upgrade', (res, socket, head) => {
      const chunks = [head];
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.on('close', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).subarray(2).toString() }));
      setTimeout(() => socket.destroy(), 300); // the frame may already be in `head`
    });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode!, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

test.describe('static files and routing', () => {
  test('health, config, SPA fallback and security headers', async ({ request }) => {
    expect(await (await request.get(`${url('full')}/healthz`)).json()).toEqual({ status: 'ok' });
    expect(await (await request.get(`${url('full')}/console-config.json`)).json()).toEqual({
      lockedUrl: MOCK, allowedHosts: [], insecureTls: false, hostActions: true, browserSsh: true, auditLog: true,
    });
    expect(await (await request.get(`${url('open')}/console-config.json`)).json()).toMatchObject({ lockedUrl: null, allowedHosts: ['127.0.0.1', 'localhost'], hostActions: false, browserSsh: false, auditLog: false });
    expect(await (await request.get(`${url('bare')}/console-config.json`)).json()).toMatchObject({ lockedUrl: null, insecureTls: true, hostActions: false });
    expect(await (await request.get(`${url('broken')}/console-config.json`)).json()).toMatchObject({ lockedUrl: MOCK, hostActions: true, browserSsh: false, auditLog: false });

    const index = await request.get(`${url('full')}/machines/42`);
    expect(index.status()).toBe(200);
    expect(index.headers()['content-type']).toContain('text/html');
    expect(index.headers()['cache-control']).toBe('no-cache');
    const csp = index.headers()['content-security-policy']!;
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect((await request.get(`${url('open')}/`)).headers()['content-security-policy']).not.toContain('wasm');
    expect(index.headers()['x-frame-options']).toBe('DENY');

    const js = await request.get(`${url('full')}/js/client/app.js`);
    expect(js.headers()['content-type']).toContain('text/javascript');
    expect(js.headers()['cache-control']).toContain('max-age=300');
    expect((await request.get(`${url('full')}/js/client/app.js.map`)).headers()['content-type']).toContain('application/json');
    expect((await request.get(`${url('full')}/favicon.svg`)).headers()['content-type']).toBe('image/svg+xml');
    expect((await request.get(`${url('full')}/nope.css`)).status()).toBe(404);
    expect((await request.get(`${url('full')}/vendor/xterm/LICENSE`)).headers()['content-type']).toBe('application/octet-stream');
    expect((await request.post(`${url('full')}/index.html`)).status()).toBe(405);
    const head = await request.head(`${url('full')}/`);
    expect(head.status()).toBe(200);
    expect(await head.body()).toHaveLength(0);
  });

  test('serves the precompressed SSH client when gzip is accepted', async ({ request }) => {
    const gz = await request.get(`${url('full')}/ssh/hp_ssh.wasm`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(gz.headers()['content-encoding']).toBe('gzip');
    expect(gz.headers()['content-type']).toBe('application/wasm');
    const plain = await request.get(`${url('full')}/ssh/hp_ssh.wasm`, { headers: { 'Accept-Encoding': 'identity' } });
    expect(plain.headers()['content-encoding']).toBeUndefined();
  });

  test('rejects path traversal, malformed escapes and garbage requests', async () => {
    expect(await raw(SERVERS.full.port, 'GET /..%2F..%2Fpackage.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
    expect(await raw(SERVERS.full.port, 'GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
    expect(await raw(SERVERS.full.port, 'NOT A REQUEST\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
  });
});

test.describe('proxy', () => {
  test('forwards API calls and refuses anything else', async ({ request, mock }) => {
    await mock('reset');
    const users = await request.get(`${url('full')}/proxy/api/v1/user`, { headers: AUTH });
    expect(users.status()).toBe(200);
    expect(users.headers()['cache-control']).toBe('no-store');
    expect((await users.json()).users).toHaveLength(3);
    expect((await request.get(`${url('full')}/proxy/version`)).status()).toBe(200);
    expect((await request.get(`${url('full')}/proxy/metrics`)).status()).toBe(404);
    expect((await request.get(`${url('full')}/proxy/api/v1/a..b`)).status()).toBe(404);
    // An HTML answer is never relayed as HTML on our origin.
    const html = await request.get(`${url('full')}/proxy/api/v1/html`, { headers: AUTH });
    expect(html.headers()['content-type']).toBe('text/plain; charset=utf-8');
  });

  test('an unlocked console needs a target and honours its allowlist', async ({ request }) => {
    expect((await request.get(`${url('open')}/proxy/version`)).status()).toBe(400);
    const bad = await request.get(`${url('open')}/proxy/version`, { headers: { 'X-Headscale-Url': 'http://' } });
    expect(bad.status()).toBe(400);
    expect((await request.get(`${url('open')}/proxy/version`, { headers: { 'X-Headscale-Url': 'ftp://x' } })).status()).toBe(403); // becomes https://ftp://x
    const denied = await request.get(`${url('open')}/proxy/version`, { headers: { 'X-Headscale-Url': 'https://evil.example' } });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).message).toContain('evil.example');
    const ok = await request.get(`${url('open')}/proxy/version`, { headers: { 'X-Headscale-Url': `${MOCK}/` } });
    expect(ok.status()).toBe(200);
    // No allowlist: any target is tried; a closed port is a clear 502.
    const down = await request.get(`${url('bare')}/proxy/version`, { headers: { 'X-Headscale-Url': 'http://127.0.0.1:9' } });
    expect(down.status()).toBe(502);
    expect((await down.json()).message).toContain('Could not reach Headscale');
  });

  test('explains certificate errors', async ({ request }) => {
    const tls = https.createServer({ key: fs.readFileSync(path.join(ROOT, 'tests/support/tls/key.pem')), cert: fs.readFileSync(path.join(ROOT, 'tests/support/tls/cert.pem')) }, (_q, s) => s.end('{}'));
    await new Promise<void>((r) => tls.listen(18299, '127.0.0.1', () => r()));
    try {
      const r = await request.get(`${url('open')}/proxy/version`, { headers: { 'X-Headscale-Url': 'https://127.0.0.1:18299' } });
      expect(r.status()).toBe(502);
      expect((await r.json()).message).toContain('HEADSCALE_INSECURE_TLS=true');
      // The bare console trusts self-signed certificates (HEADSCALE_INSECURE_TLS=true).
      expect((await request.get(`${url('bare')}/proxy/version`, { headers: { 'X-Headscale-Url': 'https://127.0.0.1:18299' } })).status()).toBe(200);
    } finally { tls.close(); }
  });

  test('limits request bodies and survives upstream stalls', async ({ request, mock }) => {
    await mock('reset');
    const big = await request.put(`${url('full')}/proxy/api/v1/policy`, { headers: AUTH, data: 'x'.repeat(2 * 1024 * 1024 + 10) });
    expect(big.status()).toBe(413);
    await mock('fail', { path: '^/api/v1/node$', status: -1 });
    const slow = await request.get(`${url('full')}/proxy/api/v1/node`, { headers: AUTH });
    expect(slow.status()).toBe(502);
    expect((await slow.json()).message).toContain('timed out');
    // Headers arrive, then the body stalls: the client sees a cut-off response.
    await mock('fail', { path: '^/api/v1/node$', status: -2 });
    await expect(request.get(`${url('full')}/proxy/api/v1/node`, { headers: AUTH }).then((r) => r.text())).rejects.toThrow();
  });
});

test.describe('Browser SSH relay', () => {
  test('relays /ts2021 to Headscale without the Origin header', async ({ mock }) => {
    await mock('reset');
    expect(await wsHandshake(SERVERS.full.port)).toEqual({ status: 101, body: 'hello' });
    await mock('set', { wsMode: 'refuse' });
    expect((await wsHandshake(SERVERS.full.port)).status).toBe(405);
    await mock('set', { wsMode: 'drop' });
    expect((await wsHandshake(SERVERS.full.port)).status).toBe(0);
    await mock('set', { wsMode: 'hang' });
    expect((await wsHandshake(SERVERS.full.port)).status).toBe(0); // times out after PROXY_TIMEOUT_MS
    await mock('set', { wsMode: 'accept' });
    expect((await wsHandshake(SERVERS.full.port, '/elsewhere')).status).toBe(0);
    expect((await wsHandshake(SERVERS.full.port, '/ts2021', 'POST')).status).toBe(0);
    expect((await wsHandshake(SERVERS.open.port)).status).toBe(0); // SSH is off there
  });

  test('/key reaches Headscale only when Browser SSH is on', async ({ request }) => {
    expect(await (await request.get(`${url('full')}/key?v=88`)).json()).toMatchObject({ publicKey: 'mkey:1' });
    expect((await request.get(`${url('open')}/key?v=88`)).headers()['content-type']).toContain('text/html'); // just the app
  });
});

test.describe('host actions', () => {
  const mode = (m: string): void => fs.writeFileSync(path.join(FULL, 'bin', 'mode'), m);

  test('require host actions and a valid key', async ({ request, mock }) => {
    await mock('reset');
    expect((await request.get(`${url('open')}/host/logs`, { headers: AUTH })).status()).toBe(404);
    const noKey = await request.get(`${url('full')}/host/logs`);
    expect(noKey.status()).toBe(401);
    expect((await noKey.json()).code).toBe(16);
    expect((await request.get(`${url('full')}/host/logs`, { headers: { Authorization: 'Bearer hskey-api-nope-nope' } })).status()).toBe(401);
    expect((await request.get(`${url('full')}/host/nope`, { headers: AUTH })).status()).toBe(404);
    await mock('fail', { path: '^/api/v1/apikey$', status: 0 }); // can't ask Headscale
    expect((await request.get(`${url('full')}/host/logs`, { headers: { Authorization: 'Bearer legacy01.0123456789abcdef0123456789' } })).status()).toBe(502);
    await mock('fail', { path: '^/api/v1/apikey$', status: -1 });
    expect((await request.get(`${url('full')}/host/logs`, { headers: { Authorization: 'Bearer oddkeywithoutanyseparator' } })).status()).toBe(502);
  });

  test('read the journal in every shape it comes in', async ({ request }) => {
    mode('ok');
    const r = await (await request.get(`${url('full')}/host/logs?since=6h&lines=99999`, { headers: AUTH })).json();
    expect(r.unit).toBe('headscale');
    expect(r.entries).toHaveLength(5);
    expect(r.entries[1].m).not.toContain('\u001b'); // colour codes stripped
    expect(r.entries[4].m).toBe('debug'); // MESSAGE as a byte array
    expect(fs.readFileSync(path.join(FULL, 'bin', 'mode'), 'utf8')).toBe('ok');
    mode('empty');
    expect((await (await request.get(`${url('full')}/host/logs?since=bogus&lines=x`, { headers: AUTH })).json()).hint).toContain('not seeing messages');
    mode('error');
    const e = await request.get(`${url('full')}/host/logs`, { headers: AUTH });
    expect(e.status()).toBe(500);
    expect((await e.json()).message).toContain('permission denied');
    mode('ok');
    const missing = await request.get(`${url('broken')}/host/logs`, { headers: AUTH });
    expect(missing.status()).toBe(501);
  });

  test('list releases, with caching and failures', async ({ request, mock }) => {
    await mock('reset');
    await mock('set', { releasesStatus: 500 });
    expect((await request.get(`${url('open')}/host/releases`)).status()).toBe(502); // nothing cached yet
    await mock('set', { releasesStatus: 200 });
    const list = (await (await request.get(`${url('open')}/host/releases`)).json()).releases;
    expect(list.map((x: { version: string }) => x.version)).toEqual(['0.30.1', '0.30.0', '0.29.5']);
    expect((await request.get(`${url('open')}/host/releases`)).status()).toBe(200); // from the cache
    await mock('set', { releases: null });
    expect((await request.get(`${url('full')}/host/releases`)).status()).toBe(502); // full has no cache yet: bad JSON fails
    await mock('reset');
    expect((await request.get(`${url('full')}/host/releases`)).status()).toBe(200);
    await mock('set', { releasesStatus: 503 });
    expect((await request.get(`${url('full')}/host/releases`)).status()).toBe(200); // stale list beats nothing
    expect((await request.get(`${url('broken')}/host/releases`)).status()).toBe(502);
  });

  test('queue updates and report their status', async ({ request, mock }) => {
    await mock('reset');
    const status = path.join(FULL, 'update-status');
    const requestFile = path.join(FULL, 'state', 'update-request');
    fs.rmSync(requestFile, { force: true });
    fs.rmSync(path.join(status, 'status.json'), { force: true });
    expect(await (await request.get(`${url('full')}/host/update`, { headers: AUTH })).json()).toEqual({ state: 'idle', log: '' });
    fs.writeFileSync(path.join(status, 'status.json'), '{not json');
    expect((await (await request.get(`${url('full')}/host/update`, { headers: AUTH })).json()).state).toBe('idle');
    fs.writeFileSync(path.join(status, 'status.json'), JSON.stringify({ state: 'running', to: '0.30.1', at: '2020-01-01T00:00:00Z' }));
    fs.writeFileSync(path.join(status, 'update.log'), 'x'.repeat(70 * 1024) + 'END');
    const stale = await (await request.get(`${url('full')}/host/update`, { headers: AUTH })).json();
    expect(stale.state).toBe('stale');
    expect(stale.log.endsWith('END')).toBe(true);
    expect(stale.log.length).toBe(64 * 1024);

    const post = (body: string) => request.post(`${url('full')}/host/update`, { headers: { ...AUTH, 'Content-Type': 'application/json' }, data: body });
    expect((await post('nope')).status()).toBe(400);
    expect((await post('123')).status()).toBe(400); // not an object: no version
    expect((await post(JSON.stringify({ version: '9.9.9' }))).status()).toBe(400);
    expect((await post(JSON.stringify({ version: '0.30.1', pad: 'x'.repeat(2000) }))).status()).toBe(413);
    const ok = await post(JSON.stringify({ version: '0.30.1' }));
    expect(ok.status()).toBe(202);
    expect(fs.readFileSync(requestFile, 'utf8')).toBe('0.30.1\n');
    expect((await (await request.get(`${url('full')}/host/update`, { headers: AUTH })).json()).state).toBe('queued');
    expect((await post(JSON.stringify({ version: '0.30.1' }))).status()).toBe(409);
    fs.rmSync(requestFile);
    fs.writeFileSync(path.join(status, 'status.json'), JSON.stringify({ state: 'running', at: new Date().toISOString() }));
    expect((await post(JSON.stringify({ version: '0.30.1' }))).status()).toBe(409);
    fs.rmSync(path.join(status, 'status.json'));
    // The broken console's state directory doesn't exist, so queuing fails clearly.
    await mock('set', { releasesStatus: 200 });
    const cantWrite = await request.post(`${url('broken')}/host/update`, { headers: { ...AUTH, 'Content-Type': 'application/json' }, data: { version: '0.30.1' } });
    expect([500, 502]).toContain(cantWrite.status());
  });
});

test.describe('audit log and policy history', () => {
  const data = path.join(FULL, 'data');

  test('record changes without secrets, and serve them to verified callers', async ({ request, mock }) => {
    await mock('reset');
    fs.rmSync(data, { recursive: true, force: true });
    fs.mkdirSync(path.join(data, 'policy-history'), { recursive: true });
    const H = { ...AUTH, 'Content-Type': 'application/json' };
    await request.post(`${url('full')}/proxy/api/v1/preauthkey`, { headers: H, data: { user: '1', reusable: true, expiration: new Date().toISOString(), key: 'should-not-be-logged' } });
    await request.post(`${url('full')}/proxy/api/v1/node/1/expire?expiry=2030-01-01T00:00:00Z`, { headers: H, data: {} });
    await request.post(`${url('full')}/proxy/api/v1/user`, { headers: { Authorization: 'Bearer legacy01.0123456789abcdef0123456789', 'Content-Type': 'application/json' }, data: ['not', 'an', 'object'] });
    await request.post(`${url('full')}/proxy/api/v1/user`, { headers: { Authorization: 'Bearer oddkeywithoutanyseparator', 'Content-Type': 'text/plain' }, data: 'not json' });
    await request.post(`${url('full')}/proxy/api/v1/user`, { headers: H, data: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`field${i}`, 'y'.repeat(300)])) });
    await request.get(`${url('full')}/proxy/api/v1/user`, { headers: AUTH }); // reads aren't recorded

    expect((await request.get(`${url('full')}/console/audit`)).status()).toBe(401);
    expect((await request.post(`${url('full')}/console/audit`, { headers: AUTH })).status()).toBe(405);
    const entries = (await (await request.get(`${url('full')}/console/audit?limit=0`, { headers: AUTH })).json()).entries;
    expect(entries.map((e: { path: string }) => e.path)).toEqual(['/api/v1/user', '/api/v1/user', '/api/v1/user', '/api/v1/node/1/expire', '/api/v1/preauthkey']);
    const [big, odd, legacy, expire, key] = entries;
    expect(key.actor).toBe('TESTKEY0001');
    expect(key.summary).toMatchObject({ user: '1', reusable: true, key: '[redacted]' });
    expect(JSON.stringify(entries)).not.toContain('should-not-be-logged');
    expect(expire.summary).toEqual({ expiry: '2030-01-01T00:00:00Z' });
    expect(legacy.actor).toBe('legacy01');
    expect(legacy.summary).toEqual({});
    expect(odd.actor).toBe('unknown');
    expect(odd.summary).toEqual({ bytes: 8 });
    expect(big.summary).toMatchObject({ truncated: true });
    const filtered = (await (await request.get(`${url('full')}/console/audit?q=EXPIRE`, { headers: AUTH })).json()).entries;
    expect(filtered).toHaveLength(1);
    fs.appendFileSync(path.join(data, 'audit.jsonl'), '{torn line\n');
    expect((await (await request.get(`${url('full')}/console/audit`, { headers: AUTH })).json()).entries).toHaveLength(5);
    expect((await request.get(`${url('open')}/console/audit`, { headers: AUTH })).status()).toBe(404);
  });

  test('rotate the log when it grows, and keep going when it can\'t be written', async ({ request, mock }) => {
    await mock('reset');
    const H = { ...AUTH, 'Content-Type': 'application/json' };
    for (let i = 0; i < 40; i++) await request.post(`${url('full')}/proxy/api/v1/node/1/rename/n${i}`, { headers: H, data: { pad: 'p'.repeat(500) } });
    expect(fs.existsSync(path.join(data, 'audit.jsonl.1'))).toBe(true);
    expect((await (await request.get(`${url('full')}/console/audit?limit=5000`, { headers: AUTH })).json()).entries.length).toBeGreaterThan(30);
    fs.chmodSync(path.join(data, 'audit.jsonl'), 0o400);
    const r = await request.post(`${url('full')}/proxy/api/v1/node/1/rename/still-works`, { headers: H, data: {} });
    expect(r.status()).toBe(200);
    fs.chmodSync(path.join(data, 'audit.jsonl'), 0o600);
  });

  test('keep policy versions, oldest pruned, and serve them', async ({ request, mock }) => {
    await mock('reset');
    const hist = path.join(data, 'policy-history');
    fs.rmSync(hist, { recursive: true, force: true });
    fs.mkdirSync(hist);
    // The server saves the version just after answering, so let it finish before looking.
    const put = async (policy: string) => {
      const r = await request.put(`${url('full')}/proxy/api/v1/policy`, { headers: { ...AUTH, 'Content-Type': 'application/json' }, data: { policy } });
      await new Promise((res) => setTimeout(res, 100));
      return r;
    };
    // The first save through the console keeps the policy as it was beforehand.
    await put('{"acls":[]}');
    let versions = (await (await request.get(`${url('full')}/console/policy-history`, { headers: AUTH })).json()).versions;
    expect(versions.map((v: { actor: string }) => v.actor)).toEqual(['TESTKEY0001', 'before-console']);
    await put('{"acls":[]}'); // unchanged: no new version
    await put('INVALID'); // rejected: no version
    for (let i = 0; i < 5; i++) await put(`{"acls":[], "n": ${i}}`);
    versions = (await (await request.get(`${url('full')}/console/policy-history`, { headers: AUTH })).json()).versions;
    expect(versions).toHaveLength(5);
    const one = await (await request.get(`${url('full')}/console/policy-history/${versions[0].id}`, { headers: AUTH })).json();
    expect(one.policy).toBe('{"acls":[], "n": 4}');
    expect((await request.get(`${url('full')}/console/policy-history/..%2Fsecret`, { headers: AUTH })).status()).toBe(404);
    expect((await request.get(`${url('full')}/console/policy-history/20200101T000000000Z-nobody.hujson`, { headers: AUTH })).status()).toBe(404);
    expect((await request.get(`${url('full')}/console/elsewhere`, { headers: AUTH })).status()).toBe(404);

    // No snapshot when the policy can't be read, is empty, or isn't JSON.
    fs.rmSync(hist, { recursive: true });
    fs.mkdirSync(hist);
    await mock('fail', { method: 'GET', path: '^/api/v1/policy$', status: 500 });
    await put('{"a":1}');
    await mock('set', { policy: '   ' });
    fs.rmSync(hist, { recursive: true }); fs.mkdirSync(hist);
    await put('{"a":2}');
    fs.rmSync(hist, { recursive: true }); fs.mkdirSync(hist);
    await mock('fail', { method: 'GET', path: '^/api/v1/policy$', status: -2 });
    await put('{"a":3}');
    expect(fs.readdirSync(hist).length).toBeGreaterThan(0);
    // A history directory that can't be written doesn't break saving.
    fs.chmodSync(hist, 0o500);
    expect((await put('{"a":4}')).status()).toBe(200);
    fs.chmodSync(hist, 0o700);
  });
});

test.describe('API key verification', () => {
  test('caches verified keys and stays bounded', async ({ request, mock }) => {
    await mock('reset');
    const keys: string[] = [];
    for (let i = 0; i < 102; i++) {
      const r = await request.post(`${MOCK}/api/v1/apikey`, { headers: { ...AUTH, 'Content-Type': 'application/json' }, data: { expiration: new Date(Date.now() + 86400e3).toISOString() } });
      keys.push((await r.json()).apiKey);
    }
    for (const k of keys) expect((await request.get(`${url('full')}/console/audit?limit=1`, { headers: { Authorization: `Bearer ${k}` } })).status()).toBe(200);
    expect((await request.get(`${url('full')}/console/audit?limit=1`, { headers: { Authorization: `Bearer ${keys[0]}` } })).status()).toBe(200);
  });
});
