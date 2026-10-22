// Runtime configuration, read once from the environment. See README → Configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const env = process.env;
const truthy = (v) => /^(1|true|yes)$/i.test(v ?? '');
const falsy = (v) => /^(0|false|no)$/i.test(v ?? '');
/** "hs.example.com/" → "https://hs.example.com"; keeps a sub-path; '' if invalid. */
export function normalizeBase(raw) {
    if (!raw)
        return '';
    let s = String(raw).trim();
    if (!/^https?:\/\//i.test(s))
        s = 'https://' + s;
    try {
        const u = new URL(s);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return '';
        return (u.origin + u.pathname).replace(/\/+$/, '');
    }
    catch {
        return '';
    }
}
// dist/server/config.js → <repo>/public
export const PUBLIC_DIR = env.PUBLIC_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
export const PORT = parseInt(env.PORT || '8080', 10);
export const HOST = env.HOST || '0.0.0.0';
export const LOCKED_URL = normalizeBase(env.HEADSCALE_URL);
export const ALLOWED_HOSTS = (env.ALLOWED_HEADSCALE_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const INSECURE_TLS = truthy(env.HEADSCALE_INSECURE_TLS);
export const TIMEOUT = parseInt(env.PROXY_TIMEOUT_MS || '20000', 10);
export const MAX_BODY = 2 * 1024 * 1024; // policies can be large-ish; 2 MB is plenty
// Browser SSH: only with a locked server (its control traffic is relayed there) and a built client.
export const BROWSER_SSH = !!LOCKED_URL && !falsy(env.BROWSER_SSH) && fs.existsSync(path.join(PUBLIC_DIR, 'ssh', 'hp_ssh.wasm'));
// Host actions (logs + updates): opt-in, and only with a locked server to verify keys against.
export const HOST_ACTIONS = truthy(env.HOST_ACTIONS) && !!LOCKED_URL;
export const HOST_ACTIONS_WANTED = truthy(env.HOST_ACTIONS);
export const HEADSCALE_UNIT = /^[\w@][\w@.-]*$/.test(env.HEADSCALE_UNIT || '') ? env.HEADSCALE_UNIT : 'headscale';
export const STATE_DIR = env.STATE_DIRECTORY || '/var/lib/headscale-console';
export const UPDATE_STATUS_DIR = env.UPDATE_STATUS_DIR || '/var/lib/headscale-console-update';
export const RELEASES_URL = env.HEADSCALE_RELEASES_URL || 'https://api.github.com/repos/juanfont/headscale/releases?per_page=30';
// Audit log + policy history: on with a locked server unless AUDIT_LOG=false.
export const DATA_DIR = env.DATA_DIR || (env.STATE_DIRECTORY ? env.STATE_DIRECTORY : path.resolve('data'));
export const AUDIT_WANTED = !!LOCKED_URL && !falsy(env.AUDIT_LOG);
//# sourceMappingURL=config.js.map