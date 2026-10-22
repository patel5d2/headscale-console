// The browser's API client: Headscale calls go through the console's /proxy/, and the
// console's own endpoints (host actions, audit log, policy history) sit beside them.
import { HeadscaleAPI } from '../shared/api.js';
export { ApiError, normalizeNode } from '../shared/api.js';
export class ConsoleAPI extends HeadscaleAPI {
    constructor(opts) {
        super({ base: 'proxy/', ...opts });
    }
    // Host actions (src/server/host.ts)
    releases() { return this.raw('GET', 'releases', { base: 'host/' }).then((r) => r.releases || []); }
    hostLogs(query) {
        return this.raw('GET', 'logs', { query, base: 'host/' });
    }
    updateStatus() { return this.raw('GET', 'update', { base: 'host/' }); }
    requestUpdate(version) { return this.raw('POST', 'update', { body: { version }, base: 'host/' }); }
    // Audit log and policy history (src/server/store.ts)
    audit(q = '', limit = 500) {
        return this.raw('GET', 'audit', { query: { q, limit }, base: 'console/' }).then((r) => r.entries || []);
    }
    policyHistory() {
        return this.raw('GET', 'policy-history', { base: 'console/' }).then((r) => r.versions || []);
    }
    policyVersion(id) {
        return this.raw('GET', `policy-history/${encodeURIComponent(id)}`, { base: 'console/' }).then((r) => r.policy);
    }
}
//# sourceMappingURL=api.js.map