/**
 * Automatic log collection, switched on once from the Logs page. The console keeps an API
 * key of its own (created by the browser, stored in DATA_DIR/collector.json, mode 0600)
 * and uses it to watch the tailnet in the background:
 *
 *   network activity  machines joining, leaving, going on/offline, routes, tags, owners
 *                     and key expiry, found by polling Headscale (no agent anywhere)
 *   device logs       each device's tailscaled log, posted to /ingest/<token>/… by the
 *                     device itself (see ingest.ts and the join commands)
 *
 *   GET    /console/collector         status
 *   POST   /console/collector         {key} — turn on, with this API key
 *   DELETE /console/collector         turn off; returns the key's prefix so the browser can expire it
 *   GET    /console/activity          newest-first network activity (?q=&limit=)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { normalizeNode } from '../shared/api.js';
import { expiryState, nodeName, nodeTags, userLabel } from '../shared/model.js';
import type { Node } from '../shared/types.js';
import { requireApiKey } from './auth.js';
import { ACTIVITY_POLL_MS, AUDIT_MAX_BYTES, COLLECTOR_API_KEY, DATA_DIR, HOST_ACTIONS, UPDATE_STATUS_DIR } from './config.js';
import { HttpError, log, readJSON, sendJSON, upstreamGet } from './http.js';
import { AUDIT_ENABLED } from './store.js';

const CONFIG_FILE = path.join(DATA_DIR, 'collector.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.jsonl');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'activity-state.json');

interface Config { key: string; token: string; since: string }
export interface Activity { at: string; kind: string; node: string; name: string; detail: string }
type Snap = Record<string, { name: string; online: boolean; ips: string[]; tags: string[]; owner: string; advertised: string[]; approved: string[]; expired: boolean }>;

let config: Config | null = null;
let state: { ok: boolean; error: string | null; lastPoll: string | null } = { ok: false, error: null, lastPoll: null };
let timer: NodeJS.Timeout | undefined;

const readJsonFile = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };
const writePrivate = (file: string, data: unknown): void => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
};

/** The ingest token devices put in their log address; null while collection is off. */
export const ingestToken = (): string | null => config?.token ?? null;

/** What changed between two polls, as activity entries. Exported for tests. */
export function diff(prev: Snap, next: Snap, at: string): Activity[] {
  const out: Activity[] = [];
  const add = (kind: string, id: string, name: string, detail: string): void => { out.push({ at, kind, node: id, name, detail }); };
  const list = (a: string[]): string => a.join(', ') || 'none';
  for (const [id, n] of Object.entries(next)) {
    const p = prev[id];
    if (!p) { add('joined', id, n.name, `Joined as ${n.owner} (${list(n.ips)})`); continue; }
    if (p.name !== n.name) add('renamed', id, n.name, `Renamed from ${p.name}`);
    if (p.online !== n.online) add(n.online ? 'online' : 'offline', id, n.name, n.online ? 'Connected' : 'Disconnected');
    if (p.owner !== n.owner) add('owner', id, n.name, `Owner changed from ${p.owner} to ${n.owner}`);
    if (list(p.ips) !== list(n.ips)) add('addresses', id, n.name, `Addresses changed to ${list(n.ips)}`);
    if (list(p.tags) !== list(n.tags)) add('tags', id, n.name, `Tags changed to ${list(n.tags)}`);
    if (list(p.advertised) !== list(n.advertised)) add('routes', id, n.name, `Advertises ${list(n.advertised)}`);
    if (list(p.approved) !== list(n.approved)) add('routes', id, n.name, `Approved routes changed to ${list(n.approved)}`);
    if (!p.expired && n.expired) add('key-expired', id, n.name, 'Node key expired; the machine must log in again');
  }
  for (const [id, p] of Object.entries(prev)) if (!next[id]) add('removed', id, p.name, 'Removed from the tailnet');
  return out;
}

export function snapshot(nodes: Node[]): Snap {
  const s: Snap = {};
  for (const raw of nodes) {
    const n = normalizeNode(raw);
    s[n.id] = {
      name: nodeName(n), online: !!n.online, ips: [...(n.ipAddresses || [])].sort(), tags: nodeTags(n).sort(),
      owner: n.user ? userLabel(n.user) : 'tagged device',
      advertised: [...(n.availableRoutes || [])].sort(), approved: [...(n.approvedRoutes || [])].sort(), expired: expiryState(n).expired,
    };
  }
  return s;
}

function append(entries: Activity[]): void {
  if (!entries.length) return;
  if (fs.existsSync(ACTIVITY_FILE) && fs.statSync(ACTIVITY_FILE).size > AUDIT_MAX_BYTES) fs.renameSync(ACTIVITY_FILE, ACTIVITY_FILE + '.1');
  fs.appendFileSync(ACTIVITY_FILE, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
}

export async function poll(): Promise<void> {
  if (!config) return;
  const { status, body } = await upstreamGet('api/v1/node', `Bearer ${config.key}`);
  const at = new Date().toISOString();
  if (status !== 200) {
    state = { ok: false, lastPoll: at, error: status === 401 || status === 403 ? 'The console\'s API key was rejected (expired or deleted). Turn collection off and on again.' : status ? `Headscale answered ${status}` : 'Headscale is unreachable' };
    return;
  }
  let nodes: Node[];
  try { nodes = (JSON.parse(body) as { nodes?: Node[] }).nodes || []; } catch { state = { ok: false, lastPoll: at, error: 'Headscale sent an unreadable node list' }; return; }
  const next = snapshot(nodes);
  const prev = readJsonFile<Snap>(SNAPSHOT_FILE);
  if (prev) append(diff(prev, next, at)); // the first poll only records where things stand
  writePrivate(SNAPSHOT_FILE, next);
  state = { ok: true, error: null, lastPoll: at };
}

/** One poll, then the next one is scheduled; a failure (e.g. a full disk) is shown as the status. */
const tick = (): Promise<void> => poll().catch((e: Error) => { state = { ok: false, lastPoll: new Date().toISOString(), error: e.message }; }).finally(schedule);

function schedule(): void {
  clearTimeout(timer);
  if (!config) return;
  timer = setTimeout(() => void tick(), ACTIVITY_POLL_MS);
  timer.unref();
}

/** Turns collection on with `key` after checking Headscale accepts it. */
async function enable(key: string): Promise<void> {
  const check = await upstreamGet('api/v1/node', `Bearer ${key}`);
  if (check.status !== 200) throw new HttpError(400, 'Headscale rejected that API key');
  config = { key, token: config?.token ?? crypto.randomBytes(18).toString('base64url'), since: new Date().toISOString() };
  writePrivate(CONFIG_FILE, config);
  await tick();
}

/** Loads a saved configuration, or uses COLLECTOR_API_KEY, and starts polling (called once at startup). */
export function startCollector(): void {
  if (!AUDIT_ENABLED) return;
  config = readJsonFile<Config>(CONFIG_FILE);
  if (config) { log('Automatic log collection enabled'); void tick(); return; }
  if (COLLECTOR_API_KEY) {
    void enable(COLLECTOR_API_KEY).then(
      () => log('Automatic log collection turned on with COLLECTOR_API_KEY'),
      (e: Error) => log(`COLLECTOR_API_KEY not used: ${e.message}`),
    );
  }
}

export function readActivity(limit: number, q: string): Activity[] {
  const lines = [ACTIVITY_FILE + '.1', ACTIVITY_FILE].flatMap((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : []));
  const out: Activity[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i] || (q && !lines[i]!.toLowerCase().includes(q))) continue;
    try { out.push(JSON.parse(lines[i]!) as Activity); } catch { /* torn line */ }
  }
  return out;
}

function logtailStatus(): string {
  return readJsonFile<{ state?: string }>(path.join(UPDATE_STATUS_DIR, 'logtail.json'))?.state || 'unknown';
}

const status = (): Record<string, unknown> => ({
  enabled: !!config, since: config?.since ?? null, ...state,
  ingestPath: config ? `ingest/${config.token}` : null,
  hostActions: HOST_ACTIONS, headscaleLogtail: logtailStatus(),
});

// ------------------------------------------------------------------ router --
export async function handleCollector(req: IncomingMessage, res: ServerResponse, rest: string, query: URLSearchParams): Promise<boolean> {
  if (rest !== 'collector' && rest !== 'activity') return false;
  try {
    if (!AUDIT_ENABLED) throw new HttpError(404, 'Log collection needs HEADSCALE_URL and a writable DATA_DIR');
    await requireApiKey(req);
    if (rest === 'activity' && req.method === 'GET') {
      const limit = Math.min(Math.max(parseInt(query.get('limit') || '', 10) || 500, 1), 5000);
      sendJSON(res, 200, { entries: readActivity(limit, (query.get('q') || '').toLowerCase()) });
    } else if (rest === 'collector' && req.method === 'GET') {
      sendJSON(res, 200, status());
    } else if (rest === 'collector' && req.method === 'POST') {
      const key = String((await readJSON(req, res, 2048)).key || '');
      if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw new HttpError(400, 'Missing API key');
      await enable(key);
      log(`Automatic log collection turned on from ${req.socket.remoteAddress}`);
      sendJSON(res, 200, status());
    } else if (rest === 'collector' && req.method === 'DELETE') {
      const prefix = config?.key.match(/^hskey-api-([A-Za-z0-9]+)-/)?.[1] ?? config?.key.split('.')[0] ?? null;
      config = null;
      clearTimeout(timer);
      fs.rmSync(CONFIG_FILE, { force: true });
      state = { ok: false, error: null, lastPoll: null };
      log('Automatic log collection turned off');
      sendJSON(res, 200, { ...status(), prefix });
    } else throw new HttpError(405, 'Method not allowed');
  } catch (e) {
    const err = e as HttpError;
    sendJSON(res, err.status || 500, { code: err.status === 401 ? 16 : undefined, message: err.message });
  }
  return true;
}
