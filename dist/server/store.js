/**
 * Audit log and policy history, kept in DATA_DIR. Both need a locked server (so readers
 * can be verified against it) and are written by the proxy after Headscale answers.
 *
 *   GET /console/audit                  newest-first changes made through the console
 *   GET /console/policy-history         saved policy versions
 *   GET /console/policy-history/<id>    one version's text
 *
 * The audit log never stores secrets: request fields that carry keys are redacted and
 * the policy text goes to the history, not the log. Callers are named by the non-secret
 * prefix of their API key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requireApiKey } from './auth.js';
import { AUDIT_MAX_BYTES, AUDIT_WANTED, DATA_DIR, POLICY_HISTORY_MAX } from './config.js';
import { HttpError, log, sendJSON, upstreamGet } from './http.js';
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const HISTORY_DIR = path.join(DATA_DIR, 'policy-history');
const ID_RE = /^\d{8}T\d{9}Z-[A-Za-z0-9_-]{1,32}\.hujson$/;
const SECRET_FIELD = /^(key|apikey|authkey|secret|password|token)$/i;
function enable() {
    if (!AUDIT_WANTED)
        return false;
    try {
        fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
        fs.accessSync(DATA_DIR, fs.constants.W_OK);
        return true;
    }
    catch (e) {
        log(`Audit log and policy history disabled: ${DATA_DIR} is not writable (${e.message})`);
        return false;
    }
}
export const AUDIT_ENABLED = enable();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** What a change did, without secrets: body fields and query parameters, keys redacted. */
export function summarize(body, query) {
    const out = {};
    const put = (k, v) => {
        if (SECRET_FIELD.test(k))
            out[k] = '[redacted]';
        else if (k === 'policy' && typeof v === 'string') {
            out.policyBytes = v.length;
            out.policySha256 = sha(v).slice(0, 12);
        }
        else
            out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    };
    for (const [k, v] of query)
        put(k, v);
    if (body.length) {
        try {
            const v = JSON.parse(body.toString('utf8'));
            if (v && typeof v === 'object' && !Array.isArray(v))
                for (const [k, x] of Object.entries(v))
                    put(k, x);
        }
        catch {
            out.bytes = body.length;
        }
    }
    const s = JSON.stringify(out);
    return s.length > 2000 ? { truncated: true, bytes: s.length } : out;
}
export function record(entry) {
    if (!AUDIT_ENABLED)
        return;
    try {
        // Past the size limit, the current log becomes audit.jsonl.1 (one old file is kept).
        if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES)
            fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }
    catch (e) {
        log(`Could not write the audit log: ${e.message}`);
    }
}
function readAudit(limit, q) {
    const lines = [AUDIT_FILE + '.1', AUDIT_FILE]
        .filter((f) => fs.existsSync(f))
        .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n'))
        .filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (q && !lines[i].toLowerCase().includes(q))
            continue;
        try {
            out.push(JSON.parse(lines[i]));
        }
        catch { /* skip a torn line */ }
    }
    return out;
}
// ---------------------------------------------------------------- history --
const versionIds = () => fs.readdirSync(HISTORY_DIR).filter((f) => ID_RE.test(f)).sort();
export function savePolicyVersion(text, actor) {
    if (!AUDIT_ENABLED)
        return;
    try {
        const ids = versionIds();
        const last = ids[ids.length - 1];
        if (last && fs.readFileSync(path.join(HISTORY_DIR, last), 'utf8') === text)
            return; // unchanged
        const stamp = new Date().toISOString().replace(/[-:.]/g, '');
        fs.writeFileSync(path.join(HISTORY_DIR, `${stamp}-${actor.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unknown'}.hujson`), text, { mode: 0o600 });
        for (const old of versionIds().slice(0, -POLICY_HISTORY_MAX))
            fs.unlinkSync(path.join(HISTORY_DIR, old));
    }
    catch (e) {
        log(`Could not save the policy version: ${e.message}`);
    }
}
/** Before the first change through the console, keep the policy as it was. */
export async function snapshotBeforeFirstChange(authorization) {
    if (!AUDIT_ENABLED || versionIds().length)
        return;
    const { status, body } = await upstreamGet('api/v1/policy', authorization);
    if (status !== 200)
        return;
    try {
        const policy = JSON.parse(body).policy;
        if (typeof policy === 'string' && policy.trim())
            savePolicyVersion(policy, 'before-console');
    }
    catch { /* not JSON: nothing to keep */ }
}
function listVersions() {
    return versionIds().reverse().map((id) => {
        const m = id.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(.+)\.hujson$/);
        return {
            id,
            at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`,
            actor: m[8],
            bytes: fs.statSync(path.join(HISTORY_DIR, id)).size,
        };
    });
}
// ------------------------------------------------------------------ router --
export async function handleConsole(req, res, rest, query) {
    try {
        if (!AUDIT_ENABLED)
            throw new HttpError(404, 'The audit log is not enabled on this console');
        if (req.method !== 'GET')
            throw new HttpError(405, 'Method not allowed');
        await requireApiKey(req);
        if (rest === 'audit') {
            const limit = Math.min(Math.max(parseInt(query.get('limit') || '', 10) || 500, 1), 5000);
            return sendJSON(res, 200, { entries: readAudit(limit, (query.get('q') || '').toLowerCase()) });
        }
        if (rest === 'policy-history')
            return sendJSON(res, 200, { versions: listVersions() });
        const m = rest.match(/^policy-history\/(.+)$/);
        if (m && ID_RE.test(m[1]) && fs.existsSync(path.join(HISTORY_DIR, m[1]))) {
            return sendJSON(res, 200, { id: m[1], policy: fs.readFileSync(path.join(HISTORY_DIR, m[1]), 'utf8') });
        }
        throw new HttpError(404, 'Not found');
    }
    catch (e) {
        const err = e;
        return sendJSON(res, err.status || 500, { code: err.status === 401 ? 16 : undefined, message: err.message });
    }
}
//# sourceMappingURL=store.js.map