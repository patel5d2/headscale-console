// An in-memory Headscale for tests: the v0.29 REST API the console uses, the /key and
// /ts2021 control endpoints Browser SSH needs, and a GitHub-style releases feed.
// Control endpoints under /__mock/ let a test reset state, read it, or make the next
// matching request fail.
import crypto from 'node:crypto';
import http from 'node:http';
import type { ApiKey, Node, PreAuthKey, User } from '../../src/shared/types.js';

export const API_KEY = 'hskey-api-TESTKEY0001-0123456789abcdefghijklmnopqrstuv';
export const API_PREFIX = 'TESTKEY0001';

interface State {
  users: User[]; nodes: Node[]; keys: PreAuthKey[]; apiKeys: Array<ApiKey & { secret: string }>;
  policy: string | null; policyUpdatedAt: string; nextId: number;
  fail: Array<{ method: string; path: RegExp; status: number; message: string; times: number }>;
  releases: unknown[] | null; releasesStatus: number; wsMode: 'accept' | 'refuse' | 'drop' | 'hang';
  authRequests: Record<string, 'pending' | 'approved' | 'rejected'>;
}

const iso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();
const DAY = 86400000;

export function seed(): State {
  const alice: User = { id: '1', name: 'alice', displayName: 'Alice Doe', email: 'alice@example.com', createdAt: iso(-90 * DAY), provider: 'oidc', providerId: 'https://idp/1', profilePicUrl: '' };
  const bob: User = { id: '2', name: 'bob', createdAt: iso(-30 * DAY), provider: 'cli' };
  const node = (id: string, givenName: string, user: User | null, extra: Partial<Node> = {}): Node => ({
    id, givenName, name: `${givenName}-host`, user, ipAddresses: [`100.64.0.${id}`, `fd7a:115c:a1e0::${id}`],
    machineKey: `mkey:${id.repeat(64).slice(0, 64)}`, nodeKey: `nodekey:${id.repeat(64).slice(0, 64)}`, discoKey: `discokey:${'0'.repeat(64)}`,
    online: true, lastSeen: iso(-60000), expiry: iso(120 * DAY), createdAt: iso(-60 * DAY), registerMethod: 'REGISTER_METHOD_AUTH_KEY',
    approvedRoutes: [], availableRoutes: [], subnetRoutes: [], tags: [], preAuthKey: { id: '10', key: '', reusable: false, ephemeral: false },
    ...extra,
  });
  return {
    users: [alice, bob],
    nodes: [
      node('1', 'laptop', alice),
      node('2', 'router', null, {
        tags: ['tag:router'], availableRoutes: ['192.168.1.0/24', '10.0.0.0/8', '0.0.0.0/0', '::/0'], approvedRoutes: ['192.168.1.0/24'],
        subnetRoutes: ['192.168.1.0/24'], expiry: '0001-01-01T00:00:00Z',
      }),
      node('3', 'server', bob, { online: false, lastSeen: iso(-45 * DAY), expiry: iso(3 * DAY), tags: [], registerMethod: 'REGISTER_METHOD_CLI' }),
      node('4', 'old-phone', bob, { online: false, lastSeen: iso(-2 * DAY), expiry: iso(-DAY), preAuthKey: { id: '11', key: '', ephemeral: true } }),
    ],
    keys: [
      { id: '10', user: alice, key: 'hskey-auth-aaaaaaaaaaaaaaaaaaaaaaaa', reusable: true, ephemeral: false, used: true, expiration: iso(30 * DAY), createdAt: iso(-10 * DAY), aclTags: [] },
      { id: '11', user: bob, key: 'hskey-auth-bbbbbbbbbbbbbbbbbbbbbbbb', reusable: false, ephemeral: true, used: true, expiration: iso(30 * DAY), createdAt: iso(-5 * DAY), aclTags: [] },
      { id: '12', user: null, key: 'hskey-auth-cccccccccccccccccccccccc', reusable: false, ephemeral: false, used: false, expiration: iso(-DAY), createdAt: iso(-40 * DAY), aclTags: ['tag:router'] },
    ],
    apiKeys: [
      { id: '1', prefix: API_PREFIX, secret: API_KEY, expiration: iso(5 * DAY), createdAt: iso(-20 * DAY), lastSeen: iso(-1000) },
      { id: '2', prefix: 'OLDKEY00002', secret: 'hskey-api-OLDKEY00002-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', expiration: iso(-DAY), createdAt: iso(-100 * DAY) },
      { id: '3', prefix: 'legacy01', secret: 'legacy01.0123456789abcdef0123456789', expiration: iso(90 * DAY), createdAt: iso(-200 * DAY) },
      { id: '4', prefix: 'odd', secret: 'oddkeywithoutanyseparator', expiration: iso(90 * DAY), createdAt: iso(-200 * DAY) },
    ],
    policy: `{
  // Admins reach everything
  "groups": { "group:admins": ["alice@"] },
  "tagOwners": { "tag:router": ["group:admins"] },
  "hosts": { "home-lan": "192.168.1.0/24" },
  "acls": [
    { "action": "accept", "src": ["group:admins"], "dst": ["*:*"] },
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:self:*"] },
  ],
  "ssh": [
    { "action": "accept", "src": ["group:admins"], "dst": ["autogroup:self"], "users": ["root", "autogroup:nonroot"] },
  ],
}
`,
    policyUpdatedAt: iso(-3 * DAY),
    nextId: 100,
    fail: [],
    releases: [
      { tag_name: 'v0.30.1', published_at: iso(-2 * DAY), draft: false, prerelease: false },
      { tag_name: 'v0.31.0-beta.1', published_at: iso(-DAY), draft: false, prerelease: true },
      { tag_name: 'v0.30.0', published_at: iso(-20 * DAY), draft: false, prerelease: false },
      { tag_name: 'v0.29.5', published_at: iso(-40 * DAY), draft: false, prerelease: false },
      { tag_name: 'not-a-version', published_at: iso(-50 * DAY), draft: false, prerelease: false },
    ],
    releasesStatus: 200,
    wsMode: 'accept',
    authRequests: { 'hskey-authreq-PENDING1': 'pending', ANOTHER: 'pending' },
  };
}

export function startMockHeadscale(port: number): Promise<{ state: () => State; close: () => Promise<void> }> {
  let st = seed();
  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, status: number, message: string): void => send(res, status, { code: status === 404 ? 5 : 3, message });
  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve) => {
    let b = '';
    req.on('data', (c: Buffer) => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) as Record<string, unknown> : {}); } catch { resolve({}); } });
  });
  const findNode = (id: string): Node | undefined => st.nodes.find((n) => n.id === id);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const q = url.searchParams;
    const method = req.method || 'GET';

    // ------------------------------------------------------------ test control --
    if (p === '/__mock/reset') { st = seed(); return send(res, 200, {}); }
    if (p === '/__mock/state') return send(res, 200, st);
    if (p === '/__mock/set') { Object.assign(st, await readBody(req)); return send(res, 200, {}); }
    if (p === '/__mock/fail') {
      const b = await readBody(req);
      st.fail.push({ method: String(b.method || '*'), path: new RegExp(String(b.path)), status: Number(b.status ?? 500), message: String(b.message || 'injected failure'), times: Number(b.times || 1) });
      return send(res, 200, {});
    }
    if (p === '/__mock/releases') {
      if (st.releasesStatus !== 200) return err(res, st.releasesStatus, 'rate limited');
      if (st.releases === null) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json'); return; }
      return send(res, 200, st.releases);
    }
    if (p === '/__mock/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>alert(1)</script>'); return; }

    const f = st.fail.find((x) => (x.method === '*' || x.method === method) && x.path.test(p));
    if (f) {
      if (--f.times <= 0) st.fail.splice(st.fail.indexOf(f), 1);
      if (f.status === 0) { req.socket.destroy(); return; } // a dropped connection
      if (f.status === -1) return; // no answer at all
      if (f.status === -2) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"partial":'); return; } // stalls mid-body
      return err(res, f.status, f.message);
    }

    // -------------------------------------------------------- public endpoints --
    if (p === '/version') return send(res, 200, { version: 'v0.29.5', commit: '0f7d1e536bed9f01dd7161f7637af19bb0908335', buildTime: iso(-40 * DAY), dirty: false });
    if (p === '/key') {
      // Browser SSH's fake client registers itself here with its single-use key.
      const k = st.keys.find((x) => x.key === q.get('authkey'));
      if (k && q.get('hostname')) {
        k.used = true;
        st.nodes.push({
          id: String(st.nextId++), givenName: q.get('hostname')!, name: q.get('hostname')!, user: k.user ?? null, online: true,
          ipAddresses: ['100.64.9.9'], preAuthKey: { id: k.id!, key: '', ephemeral: !!k.ephemeral }, registerMethod: 'REGISTER_METHOD_AUTH_KEY',
          approvedRoutes: [], availableRoutes: [], tags: [], lastSeen: iso(0), expiry: '0001-01-01T00:00:00Z', createdAt: iso(0),
        });
      }
      return send(res, 200, { legacyPublicKey: 'mkey:0', publicKey: 'mkey:1' });
    }

    // ------------------------------------------------------------------- auth --
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    const apiKey = st.apiKeys.find((k) => k.secret === auth);
    if (!apiKey || Date.parse(apiKey.expiration || '') < Date.now()) return err(res, 401, 'Unauthorized');
    apiKey.lastSeen = iso(0);
    const m = p.match(/^\/api\/v1\/(.*)$/);
    if (!m) return err(res, 404, 'Not Found');
    const r = m[1]!;
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);

    if (r === 'health') return send(res, 200, { databaseConnectivity: true });
    if (r === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>alert(1)</script>'); return; }

    // users
    if (r === 'user' && method === 'GET') return send(res, 200, { users: [...st.users, { id: '2147455555', name: 'tagged-devices' }] });
    if (r === 'user' && method === 'POST') {
      if (st.users.some((u) => u.name === body.name)) return err(res, 500, 'user already exists');
      const u: User = { id: String(st.nextId++), name: String(body.name), createdAt: iso(0), provider: 'cli', ...(body.displayName ? { displayName: String(body.displayName) } : {}), ...(body.email ? { email: String(body.email) } : {}) };
      st.users.push(u);
      return send(res, 200, { user: u });
    }
    let mm = r.match(/^user\/([^/]+)\/rename\/([^/]+)$/);
    if (mm && method === 'POST') {
      const u = st.users.find((x) => x.id === mm![1]);
      if (!u) return err(res, 404, 'user not found');
      u.name = decodeURIComponent(mm[2]!);
      return send(res, 200, { user: u });
    }
    mm = r.match(/^user\/([^/]+)$/);
    if (mm && method === 'DELETE') {
      if (st.nodes.some((n) => n.user?.id === mm![1])) return err(res, 500, 'user has nodes');
      st.users = st.users.filter((u) => u.id !== mm![1]);
      return send(res, 200, {});
    }

    // nodes
    if (r === 'node' && method === 'GET') {
      const list = q.get('user') ? st.nodes.filter((n) => n.user?.name === q.get('user')) : st.nodes;
      return send(res, 200, { nodes: list.map((n) => (n.user ? n : { ...n, user: { id: '2147455555', name: 'tagged-devices' } })) });
    }
    if (r === 'node/backfillips' && method === 'POST') return send(res, 200, { changes: q.get('confirmed') === 'true' ? ['laptop: added IPv6 fd7a:115c:a1e0::1'] : [] });
    if (r === 'node/register' && method === 'POST') {
      const u = st.users.find((x) => x.name === q.get('user'));
      if (!u) return err(res, 500, 'user not found');
      const n: Node = { id: String(st.nextId++), givenName: 'registered', name: 'registered', user: u, online: true, ipAddresses: ['100.64.0.50'], approvedRoutes: [], availableRoutes: [], tags: [], expiry: iso(180 * DAY) };
      st.nodes.push(n);
      return send(res, 200, { node: n });
    }
    mm = r.match(/^node\/([^/]+)(?:\/(.+))?$/);
    if (mm) {
      const n = findNode(mm[1]!);
      if (!n) return err(res, 404, 'node not found');
      const action = mm[2] || '';
      if (!action && method === 'GET') return send(res, 200, { node: n });
      if (!action && method === 'DELETE') { st.nodes = st.nodes.filter((x) => x !== n); return send(res, 200, {}); }
      if (action.startsWith('rename/') && method === 'POST') { n.givenName = decodeURIComponent(action.slice(7)); return send(res, 200, { node: n }); }
      if (action === 'expire' && method === 'POST') {
        n.expiry = q.get('disableExpiry') === 'true' ? '0001-01-01T00:00:00Z' : q.get('expiry') || iso(-1000);
        return send(res, 200, { node: n });
      }
      if (action === 'tags' && method === 'POST') {
        const tags = (body.tags as string[]) || [];
        if (tags.some((t) => !/^tag:[a-z0-9-]+$/.test(t))) return err(res, 400, 'requested tags [x] are invalid or not permitted');
        n.tags = tags;
        if (tags.length) n.user = null;
        return send(res, 200, { node: n });
      }
      if (action === 'approve_routes' && method === 'POST') { n.approvedRoutes = (body.routes as string[]) || []; return send(res, 200, { node: n }); }
    }

    // auth requests
    if (r === 'auth/register' && method === 'POST') {
      const u = st.users.find((x) => x.name === body.user);
      if (!u) return err(res, 500, 'user not found');
      if (!String(body.authId).startsWith('hskey-authreq-')) return err(res, 404, 'auth request not found');
      const n: Node = { id: String(st.nextId++), givenName: 'new-device', name: 'new-device', user: u, online: true, ipAddresses: ['100.64.0.60'], approvedRoutes: [], availableRoutes: [], tags: [] };
      st.nodes.push(n);
      return send(res, 200, { node: n });
    }
    if ((r === 'auth/approve' || r === 'auth/reject') && method === 'POST') {
      const id = String(body.authId);
      if (st.authRequests[id] !== 'pending') return err(res, 404, 'auth request not found');
      st.authRequests[id] = r === 'auth/approve' ? 'approved' : 'rejected';
      return send(res, 200, {});
    }

    // pre-auth keys
    if (r === 'preauthkey' && method === 'GET') return send(res, 200, { preAuthKeys: st.keys });
    if (r === 'preauthkey' && method === 'POST') {
      const u = body.user ? st.users.find((x) => x.id === body.user) : null;
      if (body.user && !u) return err(res, 500, 'user not found');
      const k: PreAuthKey = {
        id: String(st.nextId++), user: u ?? null, key: `hskey-auth-${crypto.randomBytes(12).toString('hex')}`,
        reusable: !!body.reusable, ephemeral: !!body.ephemeral, used: false, expiration: String(body.expiration), createdAt: iso(0), aclTags: (body.aclTags as string[]) || [],
      };
      st.keys.push(k);
      return send(res, 200, { preAuthKey: k });
    }
    if (r === 'preauthkey/expire' && method === 'POST') {
      const k = st.keys.find((x) => x.id === body.id);
      if (!k) return err(res, 404, 'key not found');
      k.expiration = iso(-1000);
      return send(res, 200, {});
    }
    if (r === 'preauthkey' && method === 'DELETE') { st.keys = st.keys.filter((x) => x.id !== q.get('id')); return send(res, 200, {}); }

    // API keys
    // Listed like Headscale 0.29: new-format keys as "hskey-api-<prefix>-***", legacy ones as "<prefix>***".
    const listed = (k: ApiKey & { secret: string }): string => (k.secret.startsWith('hskey-api-') ? `hskey-api-${k.prefix}-***` : `${k.prefix}***`);
    if (r === 'apikey' && method === 'GET') return send(res, 200, { apiKeys: st.apiKeys.map((k) => ({ id: k.id, prefix: listed(k), expiration: k.expiration, createdAt: k.createdAt, lastSeen: k.lastSeen })) });
    if (r === 'apikey' && method === 'POST') {
      const prefix = `NEWKEY${st.nextId++}`;
      const secret = `hskey-api-${prefix}-${crypto.randomBytes(16).toString('hex')}`;
      st.apiKeys.push({ id: String(st.nextId++), prefix, secret, expiration: String(body.expiration), createdAt: iso(0) });
      return send(res, 200, { apiKey: secret });
    }
    if (r === 'apikey/expire' && method === 'POST') {
      const k = st.apiKeys.find((x) => x.id === body.id);
      if (!k) return err(res, 400, 'provide either id or prefix');
      k.expiration = iso(-1000);
      return send(res, 200, {});
    }
    if (r.startsWith('apikey/') && method === 'DELETE') {
      const id = q.get('id');
      const pfx = decodeURIComponent(r.slice(7));
      st.apiKeys = st.apiKeys.filter((x) => x.id !== id && listed(x) !== pfx);
      return send(res, 200, {});
    }

    // policy
    if (r === 'policy' && method === 'GET') {
      if (st.policy === null) return err(res, 500, 'policy not found');
      return send(res, 200, { policy: st.policy, updatedAt: st.policyUpdatedAt });
    }
    if ((r === 'policy' && method === 'PUT') || (r === 'policy/check' && method === 'POST')) {
      const text = String(body.policy || '');
      if (text.includes('INVALID')) return err(res, 400, 'parsing policy: unknown field "INVALID"');
      if (r === 'policy/check') return send(res, 200, {});
      st.policy = text;
      st.policyUpdatedAt = iso(0);
      return send(res, 200, { policy: text, updatedAt: st.policyUpdatedAt });
    }

    return err(res, 404, `no route for ${method} ${p}`);
  });

  // Browser SSH's control connection: accept the WebSocket and send one text frame.
  server.on('upgrade', (req, socket) => {
    if (st.wsMode === 'refuse') { socket.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n'); return; }
    if (st.wsMode === 'drop') { socket.destroy(); return; }
    if (st.wsMode === 'hang') return;
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 5, ...Buffer.from('hello')]));
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
  });

  // Upgraded and stalled sockets aren't closed by closeAllConnections(), so track them all.
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      state: () => st,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}
