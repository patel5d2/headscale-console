export const ZERO_TIME = '0001-01-01T00:00:00Z';
export function parseTime(t) {
    if (!t)
        return null;
    const d = new Date(t);
    if (isNaN(d.getTime()) || d.getUTCFullYear() <= 1)
        return null;
    return d;
}
export function relTime(t, { future = true } = {}) {
    const d = t instanceof Date ? t : parseTime(t);
    if (!d)
        return '—';
    const diff = (d.getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 45)
        return diff < 0 || !future ? 'just now' : 'in a few seconds';
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    const [u, s] = units.find(([, secs]) => abs >= secs) ?? ['minute', 60]; // 45–59 s rounds to a minute
    const n = Math.max(1, Math.round(abs / s));
    const label = `${n} ${u}${n === 1 ? '' : 's'}`;
    return diff < 0 ? `${label} ago` : `in ${label}`;
}
export const isoInDays = (days) => new Date(Date.now() + days * 86400000).toISOString();
export const nodeName = (n) => n.givenName || n.name || `node-${n.id}`;
export function nodeTags(n) {
    if (Array.isArray(n.tags) && n.tags.length)
        return [...n.tags];
    // pre-0.28 servers exposed forced/valid tags separately
    return [...new Set([...(n.forcedTags || []), ...(n.validTags || [])])];
}
export const nodeIPv4 = (n) => (n.ipAddresses || []).find((a) => a.includes('.')) || '';
export const nodeIPv6 = (n) => (n.ipAddresses || []).find((a) => a.includes(':')) || '';
export function expiryState(n) {
    const d = parseTime(n.expiry);
    if (!d)
        return { disabled: true, expired: false, date: null };
    return { disabled: false, expired: d.getTime() <= Date.now(), date: d };
}
export const EXIT_ROUTES = ['0.0.0.0/0', '::/0'];
export const isExitRoute = (r) => EXIT_ROUTES.includes(r);
export function routeInfo(n) {
    const available = n.availableRoutes || [];
    const approved = n.approvedRoutes || [];
    const all = [...new Set([...available, ...approved])];
    const subnets = all.filter((r) => !isExitRoute(r));
    const exitAdvertised = available.some(isExitRoute);
    return {
        available, approved, primary: n.subnetRoutes || [], subnets, exitAdvertised,
        exitApproved: approved.some(isExitRoute) && !available.some((r) => isExitRoute(r) && !approved.includes(r)),
        exitPending: exitAdvertised && !approved.some(isExitRoute),
        pendingSubnets: subnets.filter((r) => available.includes(r) && !approved.includes(r)),
        hasAny: all.length > 0,
    };
}
export function ownerLabel(n) {
    const tags = nodeTags(n);
    if (!n.user && tags.length)
        return { tagged: true, label: 'Tagged device', sub: tags.join(', ') };
    const u = n.user || {};
    return { tagged: false, label: u.displayName || u.name || 'Unknown', sub: u.email || u.name || '' };
}
export const REGISTER_METHOD = {
    REGISTER_METHOD_AUTH_KEY: 'Auth key',
    REGISTER_METHOD_CLI: 'CLI / API',
    REGISTER_METHOD_OIDC: 'OIDC',
    REGISTER_METHOD_UNSPECIFIED: 'Unknown',
};
export const userLabel = (u) => (u ? u.displayName || u.name || u.email || `user-${u.id}` : 'Unknown');
/** How a policy refers to a user: "alice@" (or the name itself if it already has an @). */
export const userRef = (u) => (u.name.includes('@') ? u.name : `${u.name}@`);
export function initials(s) {
    const parts = String(s || '?').replace(/[@._-]+/g, ' ').trim().split(/\s+/);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
export function avatarHue(s) {
    let h = 0;
    for (const ch of String(s || ''))
        h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
}
export function validCIDR(s) {
    s = String(s || '').trim();
    const m4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
    if (m4)
        return m4.slice(1, 5).every((o) => +o <= 255) && +m4[5] <= 32;
    const m6 = s.match(/^([0-9a-fA-F:]+)\/(\d{1,3})$/);
    return !!m6 && m6[1].includes(':') && +m6[2] <= 128;
}
export const pluralize = (n, word, plural) => `${n} ${n === 1 ? word : (plural || word + 's')}`;
export function hostOf(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return url;
    }
}
export function semver(v) {
    return String(v || '').replace(/^v/, '').match(/^\d+\.\d+\.\d+/)?.[0] || null;
}
/** Compares "X.Y.Z" versions: negative, zero or positive. */
export function cmpVersion(a, b) {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
// ------------------------------------------------------------------ HuJSON --
// Headscale policies are HuJSON (JSON + comments + trailing commas).
export function stripHuJSON(src) {
    let out = '';
    let i = 0;
    let inStr = false;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (inStr) {
            out += c;
            if (c === '\\') {
                out += n ?? '';
                i += 2;
                continue;
            }
            if (c === '"')
                inStr = false;
            i++;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && n === '/') {
            while (i < src.length && src[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (c === '/' && n === '*') {
            out += '  ';
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += '  ';
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out.replace(/,(\s*[}\]])/g, ' $1'); // drop trailing commas before } or ]
}
export function parseHuJSON(src) {
    const clean = stripHuJSON(src);
    try {
        return { ok: true, value: JSON.parse(clean) };
    }
    catch (e) {
        const msg = String(e.message);
        let line = null;
        let col = null;
        const lc = msg.match(/line (\d+) column (\d+)/);
        const m = msg.match(/position (\d+)/);
        if (lc) {
            line = +lc[1];
            col = +lc[2];
        }
        else if (m) {
            const before = clean.slice(0, +m[1]);
            line = before.split('\n').length;
            col = +m[1] - before.lastIndexOf('\n');
        }
        return { ok: false, error: msg, line, col };
    }
}
/** True when the source contains // or /* comments outside of strings. */
export function hasComments(src) {
    let inStr = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inStr) {
            if (c === '\\')
                i++;
            else if (c === '"')
                inStr = false;
        }
        else if (c === '"')
            inStr = true;
        else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))
            return true;
    }
    return false;
}
/** Line diff a → b via longest common subsequence. */
// ponytail: O(n·m) memory; returns null past ~4M cells (Myers' algorithm if that ever matters).
export function lineDiff(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    const n = x.length;
    const m = y.length;
    if (n * m > 4e6)
        return null;
    const L = new Uint32Array((n + 1) * (m + 1)); // L[i*(m+1)+j] = LCS length of x[i..], y[j..]
    const at = (i, j) => L[i * (m + 1) + j];
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--)
            L[i * (m + 1) + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (x[i] === y[j]) {
            out.push({ op: ' ', line: x[i] });
            i++;
            j++;
        }
        else if (at(i + 1, j) >= at(i, j + 1))
            out.push({ op: '-', line: x[i++] });
        else
            out.push({ op: '+', line: y[j++] });
    }
    while (i < n)
        out.push({ op: '-', line: x[i++] });
    while (j < m)
        out.push({ op: '+', line: y[j++] });
    return out;
}
//# sourceMappingURL=model.js.map