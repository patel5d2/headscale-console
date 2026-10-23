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
export interface CollectorStatus {
  enabled: boolean; since: string | null; ok: boolean; error: string | null; lastPoll: string | null;
  ingestPath: string | null; hostActions: boolean; headscaleLogtail: string; prefix?: string | null;
}
export interface Activity { at: string; kind: string; node: string; name: string; detail: string }
export interface DeviceLabel { label: string; lines: number; last: number | null; devices: string[] }
export interface DeviceLine { t: number; id: string; m: string }
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
  requestLogtail(): Promise<{ queued: string }> { return this.raw('POST', 'logtail', { base: 'host/' }); }

  // Automatic log collection (src/server/collector.ts, ingest.ts)
  collector(): Promise<CollectorStatus> { return this.raw('GET', 'collector', { base: 'console/' }); }
  enableCollector(key: string): Promise<CollectorStatus> { return this.raw('POST', 'collector', { body: { key }, base: 'console/' }); }
  disableCollector(): Promise<CollectorStatus> { return this.raw('DELETE', 'collector', { base: 'console/' }); }
  activity(q = '', limit = 1000): Promise<Activity[]> {
    return this.raw<{ entries?: Activity[] }>('GET', 'activity', { query: { q, limit }, base: 'console/' }).then((r) => r.entries || []);
  }
  deviceLabels(): Promise<DeviceLabel[]> { return this.raw<{ labels?: DeviceLabel[] }>('GET', 'device-logs', { base: 'console/' }).then((r) => r.labels || []); }
  deviceLog(label: string, q = '', limit = 2000): Promise<DeviceLine[]> {
    return this.raw<{ entries?: DeviceLine[] }>('GET', `device-logs/${encodeURIComponent(label)}`, { query: { q, limit }, base: 'console/' }).then((r) => r.entries || []);
  }

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
