// Headscale REST API client. All calls go through the console's /proxy/ endpoint,
// which forwards to the Headscale server chosen at login.

export class ApiError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// Headscale reports tagged nodes as owned by a pseudo-user ("tagged-devices",
// id 2147455555) in list responses and as user=null elsewhere. Normalize to null.
const TAGGED_USER_ID = '2147455555';
export function normalizeNode(n) {
  if (n && n.user && (String(n.user.id) === TAGGED_USER_ID || n.user.name === 'tagged-devices')) {
    return { ...n, user: null };
  }
  return n;
}

export class HeadscaleAPI {
  constructor({ url, key, onUnauthorized }) {
    this.url = url;
    this.key = key;
    this.onUnauthorized = onUnauthorized;
  }

  async raw(method, path, { body, query } = {}) {
    let qs = '';
    if (query) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
      const s = p.toString();
      if (s) qs = '?' + s;
    }
    const headers = { Authorization: `Bearer ${this.key}` };
    if (this.url) headers['X-Headscale-Url'] = this.url;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(`proxy/${path}${qs}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      throw new ApiError(`Network error: ${e.message}`, 0, 14);
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

    if (!res.ok) {
      let msg = data?.message || data?.error || `${res.status} ${res.statusText}`;
      if (res.status === 401 || /unauthorized|invalid api key|api key.*expired/i.test(msg)) {
        if (res.status === 401) msg = 'Unauthorized — the API key is invalid or expired.';
        if (this.onUnauthorized && res.status === 401) this.onUnauthorized(msg);
      }
      throw new ApiError(msg, res.status, data?.code, data);
    }
    return data;
  }

  get(p, query) { return this.raw('GET', `api/v1/${p}`, { query }); }
  post(p, body, query) { return this.raw('POST', `api/v1/${p}`, { body: body ?? {}, query }); }
  put(p, body) { return this.raw('PUT', `api/v1/${p}`, { body }); }
  del(p, query) { return this.raw('DELETE', `api/v1/${p}`, { query }); }

  // ---------------------------------------------------------------- meta --
  async version() {
    try { return await this.raw('GET', 'version'); } catch { return null; }
  }
  async health() {
    try { return await this.get('health'); } catch (e) { return { error: e.message }; }
  }

  // --------------------------------------------------------------- users --
  async listUsers() {
    return ((await this.get('user')).users || []).filter((u) => String(u.id) !== TAGGED_USER_ID && u.name !== 'tagged-devices');
  }
  createUser(u) { return this.post('user', u).then((r) => r.user); }
  deleteUser(id) { return this.del(`user/${encodeURIComponent(id)}`); }
  renameUser(id, newName) {
    return this.post(`user/${encodeURIComponent(id)}/rename/${encodeURIComponent(newName)}`).then((r) => r.user);
  }

  // --------------------------------------------------------------- nodes --
  async listNodes(user) { return ((await this.get('node', user ? { user } : undefined)).nodes || []).map(normalizeNode); }
  getNode(id) { return this.get(`node/${encodeURIComponent(id)}`).then((r) => normalizeNode(r.node)); }
  deleteNode(id) { return this.del(`node/${encodeURIComponent(id)}`); }
  renameNode(id, name) {
    return this.post(`node/${encodeURIComponent(id)}/rename/${encodeURIComponent(name)}`).then((r) => r.node);
  }
  expireNode(id) { return this.post(`node/${encodeURIComponent(id)}/expire`).then((r) => r.node); }
  setNodeExpiry(id, isoDate) {
    return this.post(`node/${encodeURIComponent(id)}/expire`, {}, { expiry: isoDate }).then((r) => r.node);
  }
  disableNodeExpiry(id) {
    return this.post(`node/${encodeURIComponent(id)}/expire`, {}, { disableExpiry: 'true' }).then((r) => r.node);
  }
  setTags(id, tags) { return this.post(`node/${encodeURIComponent(id)}/tags`, { tags }).then((r) => r.node); }
  setApprovedRoutes(id, routes) {
    return this.post(`node/${encodeURIComponent(id)}/approve_routes`, { routes }).then((r) => r.node);
  }
  registerNodeLegacy(user, key) { return this.post('node/register', {}, { user, key }).then((r) => r.node); }
  backfillIPs() { return this.post('node/backfillips', {}, { confirmed: 'true' }); }

  // Register a pending device by its auth ID (from the URL tailscale prints).
  async registerAuth(userName, authId) {
    try {
      return (await this.post('auth/register', { user: userName, authId })).node;
    } catch (e) {
      // Servers older than 0.29 only have /node/register?key=
      if (e.status === 404 || e.status === 501) return this.registerNodeLegacy(userName, authId);
      throw e;
    }
  }
  approveAuth(authId) { return this.post('auth/approve', { authId }); }
  rejectAuth(authId) { return this.post('auth/reject', { authId }); }

  // ------------------------------------------------------- pre-auth keys --
  async listPreAuthKeys(users) {
    try {
      const r = await this.get('preauthkey');
      return r.preAuthKeys || [];
    } catch (e) {
      // Older servers require ?user=; gather per user.
      if (!users) throw e;
      const all = [];
      for (const u of users) {
        try {
          const r = await this.get('preauthkey', { user: u.id });
          all.push(...(r.preAuthKeys || []).map((k) => ({ ...k, user: k.user || u })));
        } catch {
          const r = await this.get('preauthkey', { user: u.name }).catch(() => ({}));
          all.push(...(r.preAuthKeys || []).map((k) => ({ ...k, user: k.user || u })));
        }
      }
      return all;
    }
  }
  createPreAuthKey({ user, reusable, ephemeral, expiration, aclTags }) {
    const body = { reusable: !!reusable, ephemeral: !!ephemeral, expiration };
    if (user) body.user = String(user);
    if (aclTags?.length) body.aclTags = aclTags;
    return this.post('preauthkey', body).then((r) => r.preAuthKey);
  }
  async expirePreAuthKey(k) {
    try {
      return await this.post('preauthkey/expire', { id: String(k.id) });
    } catch (e) {
      if (e.status === 400 && k.user) {
        return this.post('preauthkey/expire', { user: String(k.user.id ?? k.user.name), key: k.key });
      }
      throw e;
    }
  }
  deletePreAuthKey(k) { return this.del('preauthkey', { id: String(k.id) }); }

  // ------------------------------------------------------------ API keys --
  async listApiKeys() { return (await this.get('apikey')).apiKeys || []; }
  createApiKey(expiration) { return this.post('apikey', { expiration }).then((r) => r.apiKey); }
  async expireApiKey(k) {
    try {
      return await this.post('apikey/expire', { id: String(k.id) });
    } catch (e) {
      if (e.status === 400) return this.post('apikey/expire', { prefix: k.prefix });
      throw e;
    }
  }
  async deleteApiKey(k) {
    // 0.29+: identify by id with an empty prefix segment ("provide either id or prefix").
    try {
      return await this.del('apikey/', { id: String(k.id) });
    } catch (e) {
      if (!k.prefix || (e.status !== 404 && e.status !== 400)) throw e;
      return this.del(`apikey/${encodeURIComponent(k.prefix)}`); // older servers
    }
  }

  // -------------------------------------------------------------- policy --
  async getPolicy() {
    try {
      return await this.get('policy');
    } catch (e) {
      if (/policy not found|no policy|record not found/i.test(e.message)) return { policy: '', updatedAt: null, empty: true };
      throw e;
    }
  }
  setPolicy(policy) { return this.put('policy', { policy }); }
  async checkPolicy(policy) {
    try {
      await this.post('policy/check', { policy });
      return { ok: true };
    } catch (e) {
      if (e.status === 404 || e.status === 501) return { ok: true, unsupported: true };
      return { ok: false, error: e.message };
    }
  }
}
