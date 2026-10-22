// Verifies a caller's Headscale API key against the locked server, for the console's
// own endpoints (host actions, audit log, policy history). Never stores the key.
import crypto from 'node:crypto';
import { HttpError, upstreamGet } from './http.js';
// ponytail: a revoked key keeps console-endpoint access for up to 60s; shorten the TTL if that matters.
const verified = new Map(); // sha256(Authorization) → expiry
export async function requireApiKey(req) {
    const auth = req.headers.authorization || '';
    if (!/^Bearer [\x21-\x7e]{8,512}$/.test(auth))
        throw new HttpError(401, 'Unauthorized — the API key is invalid or expired.');
    const id = crypto.createHash('sha256').update(auth).digest('hex');
    if ((verified.get(id) ?? 0) > Date.now())
        return;
    const { status } = await upstreamGet('api/v1/apikey', auth);
    if (status === 401 || status === 403)
        throw new HttpError(401, 'Unauthorized — the API key is invalid or expired.');
    if (status !== 200)
        throw new HttpError(502, 'Could not verify the API key with Headscale');
    if (verified.size > 100)
        verified.clear();
    verified.set(id, Date.now() + 60_000);
}
/**
 * The non-secret part of the caller's API key, to name who made a change: the prefix
 * Headscale shows in its API key list ("hskey-api-<prefix>-<secret>" or "<prefix>.<secret>").
 */
export function actorOf(req) {
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const m = key.match(/^hskey-api-([A-Za-z0-9]+)-/) || key.match(/^([A-Za-z0-9_-]{4,16})\./);
    return m ? m[1] : 'unknown';
}
//# sourceMappingURL=auth.js.map