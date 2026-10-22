/**
 * Optional host actions, for a console installed on the same VM as Headscale
 * (deploy/install-vm.sh --url <url> --host-actions). Enabled with HOST_ACTIONS=true
 * and only when HEADSCALE_URL is set: every call is authorised by checking the
 * caller's API key against that Headscale server, so it must not be user-chosen.
 *
 *   GET  /host/releases  latest stable Headscale releases (public data, cached 1h)
 *   GET  /host/logs      Headscale's journald log            (API key required)
 *   GET  /host/update    status of the last update            (API key required)
 *   POST /host/update    request an update to {version}      (API key required)
 *
 * The console never runs anything privileged. An update request is just a version
 * number written to a file; a root systemd path unit (headscale-console-update)
 * picks it up, re-validates it, downloads the official .deb, verifies its checksum,
 * backs up the database, installs it and rolls back if Headscale doesn't start.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { requireApiKey } from './auth.js';
import { HEADSCALE_UNIT, HOST_ACTIONS, RELEASES_CACHE_MS, RELEASES_URL, STATE_DIR, UPDATE_STATUS_DIR } from './config.js';
import { HttpError, log, readJSON, sendJSON } from './http.js';

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const SINCE: Record<string, string> = { '15m': '-15min', '1h': '-1h', '6h': '-6h', '24h': '-24h', '7d': '-7d' };
const STALE_MS = 20 * 60 * 1000; // an update still "running" after this is assumed dead
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const REQUEST_FILE = path.join(STATE_DIR, 'update-request');

export interface Release { version: string; publishedAt: string }
export interface LogEntry { t: number; p: number; m: string }
interface UpdateStatus { state: string; from?: string; to?: string; at?: string; message?: string; log: string }

// ---------------------------------------------------------------- releases --
let cache: { at: number; list: Release[] | null } = { at: 0, list: null };

export async function releases(): Promise<Release[]> {
  if (cache.list && Date.now() - cache.at < RELEASES_CACHE_MS) return cache.list;
  try {
    const r = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'headscale-console' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const raw = await r.json() as Array<{ tag_name?: unknown; published_at?: unknown; draft?: boolean; prerelease?: boolean }>;
    const list = raw
      .filter((x) => !x.draft && !x.prerelease)
      .map((x) => ({ version: String(x.tag_name).replace(/^v/, ''), publishedAt: String(x.published_at || '') }))
      .filter((x) => VERSION_RE.test(x.version));
    cache = { at: Date.now(), list };
    return list;
  } catch (e) {
    if (cache.list) return cache.list; // serve stale rather than nothing
    throw new HttpError(502, `Could not check for Headscale releases: ${(e as Error).message}`);
  }
}

// -------------------------------------------------------------------- logs --
function readLogs(query: URLSearchParams): Promise<{ unit: string; entries: LogEntry[]; hint: string | null }> {
  const lines = Math.min(Math.max(parseInt(query.get('lines') || '', 10) || 1000, 1), 10000);
  const since = SINCE[query.get('since') || ''] || SINCE['24h']!;
  const args = ['-u', HEADSCALE_UNIT, '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY', '-n', String(lines), `--since=${since}`];
  return new Promise((resolve, reject) => {
    execFile('journalctl', args, { maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return reject(new HttpError(501, 'journalctl is not available on this host'));
      if (err && !stdout) return reject(new HttpError(500, String(stderr || err.message).trim().slice(0, 500)));
      const entries: LogEntry[] = [];
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        try {
          const j = JSON.parse(line) as { MESSAGE?: unknown; PRIORITY?: unknown; __REALTIME_TIMESTAMP?: unknown };
          const m = Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE as number[]).toString('utf8') : String(j.MESSAGE ?? '');
          entries.push({ t: Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000), p: Number(j.PRIORITY), m: m.replace(ANSI, '').slice(0, 8000) });
        } catch { /* skip malformed line */ }
      }
      resolve({ unit: HEADSCALE_UNIT, entries, hint: String(stderr || '').trim().slice(0, 500) || null });
    });
  });
}

// ------------------------------------------------------------------ update --
function tail(file: string, max: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function updateStatus(): UpdateStatus {
  let s: Omit<UpdateStatus, 'log'> = { state: 'idle' };
  try { s = { ...s, ...JSON.parse(tail(path.join(UPDATE_STATUS_DIR, 'status.json'), 4096)) }; } catch { /* never updated */ }
  if (s.state === 'running' && Date.now() - Date.parse(s.at || '') > STALE_MS) s.state = 'stale';
  if (s.state !== 'running' && fs.existsSync(REQUEST_FILE)) return { state: 'queued', log: '' }; // older status is stale
  return { ...s, log: tail(path.join(UPDATE_STATUS_DIR, 'update.log'), 64 * 1024) };
}

async function requestUpdate(req: IncomingMessage, res: ServerResponse): Promise<{ queued: string }> {
  const body = await readJSON(req, res, 1024);
  const version = String(body.version || '');
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'Invalid version');
  if (!(await releases()).some((r) => r.version === version)) throw new HttpError(400, `${version} is not a stable Headscale release`);
  const st = updateStatus();
  if (st.state === 'running' || st.state === 'queued') throw new HttpError(409, 'An update is already in progress');
  try {
    fs.writeFileSync(REQUEST_FILE, version + '\n', { mode: 0o600 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new HttpError(500, `Could not queue the update (${err.code || err.message}). Re-run install-vm.sh with --host-actions.`);
  }
  log(`Headscale update to ${version} requested from ${req.socket.remoteAddress}`);
  return { queued: version };
}

// ------------------------------------------------------------------ router --
export async function handleHost(req: IncomingMessage, res: ServerResponse, action: string, query: URLSearchParams): Promise<void> {
  try {
    if (action === 'releases' && req.method === 'GET') return sendJSON(res, 200, { releases: (await releases()).slice(0, 20) });
    if (!HOST_ACTIONS) return sendJSON(res, 404, { message: 'Host actions are not enabled on this console' });
    await requireApiKey(req);
    if (action === 'logs' && req.method === 'GET') return sendJSON(res, 200, await readLogs(query));
    if (action === 'update' && req.method === 'GET') return sendJSON(res, 200, updateStatus());
    if (action === 'update' && req.method === 'POST') return sendJSON(res, 202, await requestUpdate(req, res));
    return sendJSON(res, 404, { message: 'Unknown host action' });
  } catch (e) {
    const err = e as HttpError;
    log(`/host/${action} -> ${err.status || 500}: ${err.message}`);
    return sendJSON(res, err.status || 500, { code: err.status === 401 ? 16 : undefined, message: err.message });
  }
}
