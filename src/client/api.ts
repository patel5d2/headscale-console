// The browser's API client: Headscale calls go through the console's /proxy/, and the
// console's own endpoints (host actions, audit log, policy history) sit beside them.
import { HeadscaleAPI } from '../shared/api.js';
import type { RawEntry } from '../shared/logparse.js';
import type { Release } from '../shared/types.js';

export { ApiError, normalizeNode } from '../shared/api.js';

export interface AuditEntry {
  at: string; actor: string; ip: string; method: string; path: string; status: number; summary: Record<string, unknown>;
}
export interface PolicyVersion { id: string; at: string; actor: string; bytes: number }
export interface UpdateStatus { state: string; from?: string; to?: string; at?: string; message?: string; log: string }

export class ConsoleAPI extends HeadscaleAPI {
  constructor(opts: { key: string; url?: string; onUnauthorized?: (msg: string) => void }) {
    super({ base: 'proxy/', ...opts });
  }

  // Host actions (src/server/host.ts)
  releases(): Promise<Release[]> { return this.raw<{ releases?: Release[] }>('GET', 'releases', { base: 'host/' }).then((r) => r.releases || []); }
  hostLogs(query: { since: string; lines: string }): Promise<{ unit: string; entries: RawEntry[]; hint: string | null }> {
    return this.raw('GET', 'logs', { query, base: 'host/' });
  }
  updateStatus(): Promise<UpdateStatus> { return this.raw('GET', 'update', { base: 'host/' }); }
  requestUpdate(version: string): Promise<{ queued: string }> { return this.raw('POST', 'update', { body: { version }, base: 'host/' }); }

  // Audit log and policy history (src/server/store.ts)
  audit(q = '', limit = 500): Promise<AuditEntry[]> {
    return this.raw<{ entries?: AuditEntry[] }>('GET', 'audit', { query: { q, limit }, base: 'console/' }).then((r) => r.entries || []);
  }
  policyHistory(): Promise<PolicyVersion[]> {
    return this.raw<{ versions?: PolicyVersion[] }>('GET', 'policy-history', { base: 'console/' }).then((r) => r.versions || []);
  }
  policyVersion(id: string): Promise<string> {
    return this.raw<{ policy: string }>('GET', `policy-history/${encodeURIComponent(id)}`, { base: 'console/' }).then((r) => r.policy);
  }
}
