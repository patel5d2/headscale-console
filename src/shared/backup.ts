// Backup format for a tailnet's configuration: users, machine and key metadata, and the
// policy. Secrets are never included: auth keys appear by id only, API keys by prefix.
// Restoring recreates missing users and the policy; machines re-join by themselves.
import type { ApiKey, Node, PreAuthKey, User } from './types.js';

export const BACKUP_FORMAT = 'headscale-console-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  server: string;
  headscaleVersion: string | null;
  users: Array<Pick<User, 'id' | 'name' | 'displayName' | 'email' | 'provider' | 'createdAt'>>;
  nodes: Array<{ id: string; name: string; user: string | null; tags: string[]; ipAddresses: string[]; approvedRoutes: string[]; expiry: string | null; createdAt: string | null }>;
  preAuthKeys: Array<{ id: string | null; user: string | null; reusable: boolean; ephemeral: boolean; used: boolean; expiration: string | null; aclTags: string[] }>;
  apiKeys: Array<{ prefix: string; expiration: string | null; createdAt: string | null }>;
  policy: string;
}

export function buildBackup(input: {
  server: string; headscaleVersion: string | null; users: User[]; nodes: Node[];
  preAuthKeys: PreAuthKey[]; apiKeys: ApiKey[]; policy: string; now?: Date;
}): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    server: input.server,
    headscaleVersion: input.headscaleVersion,
    users: input.users.map(({ id, name, displayName, email, provider, createdAt }) => ({ id, name, displayName, email, provider, createdAt })),
    nodes: input.nodes.map((n) => ({
      id: n.id, name: n.givenName || n.name || '', user: n.user?.name ?? null, tags: n.tags || [],
      ipAddresses: n.ipAddresses || [], approvedRoutes: n.approvedRoutes || [], expiry: n.expiry ?? null, createdAt: n.createdAt ?? null,
    })),
    preAuthKeys: input.preAuthKeys.map((k) => ({
      id: k.id ?? null, user: k.user?.name ?? null, reusable: !!k.reusable, ephemeral: !!k.ephemeral, used: !!k.used,
      expiration: k.expiration ?? null, aclTags: k.aclTags || [],
    })),
    apiKeys: input.apiKeys.map((k) => ({ prefix: k.prefix, expiration: k.expiration ?? null, createdAt: k.createdAt ?? null })),
    policy: input.policy,
  };
}

/** Checks an uploaded file and returns its backup, or throws with a readable reason. */
export function parseBackup(text: string): Backup {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error('This file is not JSON.'); }
  const b = v as Partial<Backup> | null;
  if (!b || b.format !== BACKUP_FORMAT) throw new Error('This is not a Headscale Console backup.');
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the console.');
  if (!Array.isArray(b.users) || typeof b.policy !== 'string') throw new Error('The backup is incomplete.');
  return b as Backup;
}

/** What a restore would do against the current users. */
export function restorePlan(backup: Backup, currentUsers: User[], currentPolicy: string): { createUsers: Backup['users']; policyChanged: boolean } {
  const have = new Set(currentUsers.map((u) => u.name));
  return {
    createUsers: backup.users.filter((u) => !have.has(u.name)),
    policyChanged: backup.policy.trim() !== currentPolicy.trim(),
  };
}
