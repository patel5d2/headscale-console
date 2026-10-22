export const BACKUP_FORMAT = 'headscale-console-backup';
export const BACKUP_VERSION = 1;
export function buildBackup(input) {
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
export function parseBackup(text) {
    let v;
    try {
        v = JSON.parse(text);
    }
    catch {
        throw new Error('This file is not JSON.');
    }
    const b = v;
    if (!b || b.format !== BACKUP_FORMAT)
        throw new Error('This is not a Headscale Console backup.');
    if (typeof b.version !== 'number' || b.version > BACKUP_VERSION)
        throw new Error('This backup was made by a newer version of the console.');
    if (!Array.isArray(b.users) || typeof b.policy !== 'string')
        throw new Error('The backup is incomplete.');
    return b;
}
/** What a restore would do against the current users. */
export function restorePlan(backup, currentUsers, currentPolicy) {
    const have = new Set(currentUsers.map((u) => u.name));
    return {
        createUsers: backup.users.filter((u) => !have.has(u.name)),
        policyChanged: backup.policy.trim() !== currentPolicy.trim(),
    };
}
//# sourceMappingURL=backup.js.map