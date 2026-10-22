// Headscale REST API client, shared by the browser (through the console's /proxy/)
// and the CLI (straight to Headscale). Uses fetch, so it runs in both.
import type { ApiKey, Health, Node, PolicyResponse, PreAuthKey, User, VersionInfo } from './types.js';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: number, public body?: unknown) {
    super(message);
  }
}

// Headscale reports tagged nodes as owned by a pseudo-user ("tagged-devices",
// id 2147455555) in list responses and as user=null elsewhere. Normalize to null.
const TAGGED_USER_ID = '2147455555';
export function normalizeNode(n: Node): Node {
  if (n.user && (String(n.user.id) === TAGGED_USER_ID || n.user.name === 'tagged-devices')) return { ...n, user: null };
  return n;
}

export type Query = Record<string, string | number | boolean | undefined | null>;
export interface RawOpts { body?: unknown; query?: Query; base?: string }

export interface ApiOpts {
  /** Prefix for every request: "proxy/" in the browser, "https://hs.example.com/" in the CLI. */
  base: string;
  key: string;
  /** Sent as X-Headscale-Url when the console isn't locked to one server. */
  url?: string;
  onUnauthorized?: (msg: string) => void;
}

export class HeadscaleAPI {
  base: string;
  key: string;
  url: string | undefined;
  onUnauthorized: ((msg: string) => void) | undefined;

  constructor({ base, key, url, onUnauthorized }: ApiOpts) {
    this.base = base;
    this.key = key;
    this.url = url;
    this.onUnauthorized = onUnauthorized;
  }

  async raw<T = Record<string, unknown>>(method: string, path: string, { body, query, base = this.base }: RawOpts = {}): Promise<T> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const qs = p.toString() ? `?${p}` : '';
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}` };
    if (this.url) headers['X-Headscale-Url'] = this.url;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      // cache: browsers only (Node's fetch has no HTTP cache and no such option in its types)
      const init = { method, headers, cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
      res = await fetch(`${base}${path}${qs}`, init as unknown as RequestInit);
    } catch (e) {
      throw new ApiError(`Network error: ${(e as Error).message}`, 0, 14);
    }

    const text = await res.text();
    let data: Record<string, unknown>;
    try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { data = { message: text }; }

    if (!res.ok) {
      let msg = String(data.message || data.error || `${res.status} ${res.statusText}`);
      if (res.status === 401) {
        msg = 'Unauthorized — the API key is invalid or expired.';
        this.onUnauthorized?.(msg);
      }
      throw new ApiError(msg, res.status, typeof data.code === 'number' ? data.code : undefined, data);
    }
    return data as T;
  }

  get<T = Record<string, unknown>>(p: string, query?: Query): Promise<T> { return this.raw<T>('GET', `api/v1/${p}`, query ? { query } : {}); }
  post<T = Record<string, unknown>>(p: string, body?: unknown, query?: Query): Promise<T> { return this.raw<T>('POST', `api/v1/${p}`, { body: body ?? {}, ...(query ? { query } : {}) }); }
  put<T = Record<string, unknown>>(p: string, body: unknown): Promise<T> { return this.raw<T>('PUT', `api/v1/${p}`, { body }); }
  del<T = Record<string, unknown>>(p: string, query?: Query): Promise<T> { return this.raw<T>('DELETE', `api/v1/${p}`, query ? { query } : {}); }

  // -------------------------------------------------------------------- meta --
  async version(): Promise<VersionInfo | null> {
    try { return await this.raw<VersionInfo>('GET', 'version'); } catch { return null; }
  }
  async health(): Promise<Health> {
    try { return await this.get<Health>('health'); } catch (e) { return { error: (e as Error).message }; }
  }

  // ------------------------------------------------------------------- users --
  async listUsers(): Promise<User[]> {
    return ((await this.get<{ users?: User[] }>('user')).users || []).filter((u) => String(u.id) !== TAGGED_USER_ID && u.name !== 'tagged-devices');
  }
  createUser(u: { name: string; displayName?: string; email?: string; pictureUrl?: string }): Promise<User> {
    return this.post<{ user: User }>('user', u).then((r) => r.user);
  }
  deleteUser(id: string): Promise<unknown> { return this.del(`user/${encodeURIComponent(id)}`); }
  renameUser(id: string, newName: string): Promise<User> {
    return this.post<{ user: User }>(`user/${encodeURIComponent(id)}/rename/${encodeURIComponent(newName)}`).then((r) => r.user);
  }

  // ------------------------------------------------------------------- nodes --
  async listNodes(user?: string): Promise<Node[]> {
    return ((await this.get<{ nodes?: Node[] }>('node', user ? { user } : undefined)).nodes || []).map(normalizeNode);
  }
  getNode(id: string): Promise<Node> { return this.get<{ node: Node }>(`node/${encodeURIComponent(id)}`).then((r) => normalizeNode(r.node)); }
  deleteNode(id: string): Promise<unknown> { return this.del(`node/${encodeURIComponent(id)}`); }
  renameNode(id: string, name: string): Promise<Node> {
    return this.post<{ node: Node }>(`node/${encodeURIComponent(id)}/rename/${encodeURIComponent(name)}`).then((r) => r.node);
  }
  expireNode(id: string): Promise<Node> { return this.post<{ node: Node }>(`node/${encodeURIComponent(id)}/expire`).then((r) => r.node); }
  setNodeExpiry(id: string, isoDate: string): Promise<Node> {
    return this.post<{ node: Node }>(`node/${encodeURIComponent(id)}/expire`, {}, { expiry: isoDate }).then((r) => r.node);
  }
  disableNodeExpiry(id: string): Promise<Node> {
    return this.post<{ node: Node }>(`node/${encodeURIComponent(id)}/expire`, {}, { disableExpiry: 'true' }).then((r) => r.node);
  }
  setTags(id: string, tags: string[]): Promise<Node> { return this.post<{ node: Node }>(`node/${encodeURIComponent(id)}/tags`, { tags }).then((r) => r.node); }
  setApprovedRoutes(id: string, routes: string[]): Promise<Node> {
    return this.post<{ node: Node }>(`node/${encodeURIComponent(id)}/approve_routes`, { routes }).then((r) => r.node);
  }
  registerNodeLegacy(user: string, key: string): Promise<Node> {
    return this.post<{ node: Node }>('node/register', {}, { user, key }).then((r) => r.node);
  }
  backfillIPs(): Promise<{ changes?: string[] }> { return this.post('node/backfillips', {}, { confirmed: 'true' }); }

  /** Registers a pending device by its auth ID (from the URL tailscale prints). */
  async registerAuth(userName: string, authId: string): Promise<Node | undefined> {
    try {
      return (await this.post<{ node?: Node }>('auth/register', { user: userName, authId })).node;
    } catch (e) {
      // Servers older than 0.29 only have /node/register?key=
      if ((e as ApiError).status === 404 || (e as ApiError).status === 501) return this.registerNodeLegacy(userName, authId);
      throw e;
    }
  }
  approveAuth(authId: string): Promise<unknown> { return this.post('auth/approve', { authId }); }
  rejectAuth(authId: string): Promise<unknown> { return this.post('auth/reject', { authId }); }

  // ----------------------------------------------------------- pre-auth keys --
  async listPreAuthKeys(users?: User[]): Promise<PreAuthKey[]> {
    try {
      return (await this.get<{ preAuthKeys?: PreAuthKey[] }>('preauthkey')).preAuthKeys || [];
    } catch (e) {
      // Older servers require ?user=; gather per user.
      if (!users) throw e;
      const all: PreAuthKey[] = [];
      for (const u of users) {
        const r = await this.get<{ preAuthKeys?: PreAuthKey[] }>('preauthkey', { user: u.id })
          .catch(() => this.get<{ preAuthKeys?: PreAuthKey[] }>('preauthkey', { user: u.name }))
          .catch(() => ({ preAuthKeys: [] }));
        all.push(...(r.preAuthKeys || []).map((k) => ({ ...k, user: k.user || u })));
      }
      return all;
    }
  }
  createPreAuthKey({ user, reusable, ephemeral, expiration, aclTags }: {
    user?: string; reusable?: boolean; ephemeral?: boolean; expiration: string; aclTags?: string[];
  }): Promise<PreAuthKey> {
    const body: Record<string, unknown> = { reusable: !!reusable, ephemeral: !!ephemeral, expiration };
    if (user) body.user = String(user);
    if (aclTags?.length) body.aclTags = aclTags;
    return this.post<{ preAuthKey: PreAuthKey }>('preauthkey', body).then((r) => r.preAuthKey);
  }
  async expirePreAuthKey(k: PreAuthKey): Promise<unknown> {
    try {
      return await this.post('preauthkey/expire', { id: String(k.id) });
    } catch (e) {
      if ((e as ApiError).status === 400 && k.user) return this.post('preauthkey/expire', { user: String(k.user.id ?? k.user.name), key: k.key });
      throw e;
    }
  }
  deletePreAuthKey(k: PreAuthKey): Promise<unknown> { return this.del('preauthkey', { id: String(k.id) }); }

  // ---------------------------------------------------------------- API keys --
  async listApiKeys(): Promise<ApiKey[]> { return (await this.get<{ apiKeys?: ApiKey[] }>('apikey')).apiKeys || []; }
  createApiKey(expiration: string): Promise<string> { return this.post<{ apiKey: string }>('apikey', { expiration }).then((r) => r.apiKey); }
  async expireApiKey(k: ApiKey): Promise<unknown> {
    try {
      return await this.post('apikey/expire', { id: String(k.id) });
    } catch (e) {
      if ((e as ApiError).status === 400) return this.post('apikey/expire', { prefix: k.prefix });
      throw e;
    }
  }
  async deleteApiKey(k: ApiKey): Promise<unknown> {
    // 0.29+: identify by id with an empty prefix segment ("provide either id or prefix").
    try {
      return await this.del('apikey/', { id: String(k.id) });
    } catch (e) {
      const status = (e as ApiError).status;
      if (!k.prefix || (status !== 404 && status !== 400)) throw e;
      return this.del(`apikey/${encodeURIComponent(k.prefix)}`); // older servers
    }
  }

  // ------------------------------------------------------------------ policy --
  async getPolicy(): Promise<PolicyResponse> {
    try {
      return await this.get<PolicyResponse>('policy');
    } catch (e) {
      if (/policy not found|no policy|record not found/i.test((e as Error).message)) return { policy: '', empty: true };
      throw e;
    }
  }
  setPolicy(policy: string): Promise<PolicyResponse> { return this.put<PolicyResponse>('policy', { policy }); }
  async checkPolicy(policy: string): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
    try {
      await this.post('policy/check', { policy });
      return { ok: true };
    } catch (e) {
      const status = (e as ApiError).status;
      if (status === 404 || status === 501) return { ok: true, unsupported: true };
      return { ok: false, error: (e as Error).message };
    }
  }
}
