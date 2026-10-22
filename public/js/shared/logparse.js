// Parses Headscale log lines and groups similar ones, for the Logs page.
const TEXT_LEVEL = { TRC: 'debug', DBG: 'debug', INF: 'info', WRN: 'warn', ERR: 'error', FTL: 'error', PNC: 'error' };
const JSON_LEVEL = { trace: 'debug', debug: 'debug', info: 'info', warn: 'warn', warning: 'warn', error: 'error', fatal: 'error', panic: 'error' };
/**
 * Headscale logs zerolog console text ("2025-01-01T00:00:00Z INF msg k=v") or JSON;
 * the journald priority is the fallback when neither carries a level.
 */
export function parseEntry({ t, p, m }) {
    let level;
    let msg = m;
    if (m.startsWith('{')) {
        try {
            const { level: lv, time: _time, message, ...rest } = JSON.parse(m);
            level = JSON_LEVEL[String(lv).toLowerCase()];
            msg = [message ?? '', ...Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)].join(' ').trim();
        }
        catch { /* plain text */ }
    }
    else {
        const x = m.match(/^(?:\S+\s+)?(TRC|DBG|INF|WRN|ERR|FTL|PNC)\s+([\s\S]*)$/);
        if (x) {
            level = TEXT_LEVEL[x[1]];
            msg = x[2];
        }
    }
    level ||= p <= 3 ? 'error' : p === 4 ? 'warn' : p === 7 ? 'debug' : 'info';
    return { t, level, msg };
}
/** Similar messages share a pattern: values, long hex ids and numbers are masked. */
export const pattern = (s) => s.replace(/=("[^"]*"|\S+)/g, '=…').replace(/\b[0-9a-f]{12,}\b/gi, '…').replace(/\d+(?:[.:]\d+)*/g, 'N').slice(0, 240);
/** Counts per level and the most frequent error/warning patterns. */
export function analyze(entries, top = 10) {
    const counts = { error: 0, warn: 0, info: 0, debug: 0 };
    const groups = new Map();
    for (const e of entries) {
        counts[e.level]++;
        if (e.level !== 'error' && e.level !== 'warn')
            continue;
        const k = e.level + pattern(e.msg);
        const g = groups.get(k);
        if (g) {
            g.n++;
            g.last = e;
        }
        else
            groups.set(k, { n: 1, level: e.level, last: e });
    }
    return { counts, groups: [...groups.values()].sort((a, b) => b.n - a.n).slice(0, top) };
}
//# sourceMappingURL=logparse.js.map