/**
 * Device logs. Each device's tailscaled uploads its log in Tailscale's logtail format
 * (a JSON array, often zstd-compressed) to TS_LOG_TARGET + "/c/<collection>/<private id>".
 * The join commands set TS_LOG_TARGET to <console>/ingest/<token>/<label>, where the label
 * names the machine ("n12") or, for a device joining now, its auth key ("k34").
 *
 *   POST /ingest/<token>/<label>/c/<collection>/<id>   from devices (the token is the only credential)
 *   GET  /console/device-logs                          labels with counts      (API key required)
 *   GET  /console/device-logs/<label>                  newest-first lines      (?q=&limit=)
 *
 * Bodies are capped before and after decompression and each line is cut to 2 KB; each
 * label's file rotates to .1 past DEVICE_LOG_MAX_BYTES, so disk use stays bounded.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { requireApiKey } from './auth.js';
import { ingestToken } from './collector.js';
import { DATA_DIR, DEVICE_LOG_MAX_BYTES } from './config.js';
import { HttpError, readBody, sendJSON } from './http.js';
import { AUDIT_ENABLED } from './store.js';

const DIR = path.join(DATA_DIR, 'device-logs');
const LABEL = /^[nk]\d{1,10}$/;
const INGEST = /^([A-Za-z0-9_-]{16,64})\/([nk]\d{1,10})\/c\/[A-Za-z0-9._-]{1,128}\/([A-Fa-f0-9]{8,128})$/;
const MAX_BODY = 512 * 1024;
const MAX_JSON = 4 * 1024 * 1024;

export interface DeviceLine { t: number; id: string; m: string }

const same = (a: string, b: string): boolean => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** One logtail entry as a line of text: its "text", or its other fields as JSON. */
export function toLine(e: unknown): { t: number; m: string } {
  const o = (e && typeof e === 'object' ? e : { text: String(e) }) as Record<string, unknown>;
  const meta = (o.logtail || {}) as { client_time?: string };
  const t = Date.parse(meta.client_time || '') || Date.now();
  const { logtail: _l, metrics: _m, v: _v, ...rest } = o;
  const m = typeof rest.text === 'string' ? rest.text : JSON.stringify(rest);
  return { t, m: m.replace(/\s+$/, '').slice(0, 2048) };
}

async function ingest(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
  const m = rest.match(INGEST);
  const token = ingestToken();
  // Unknown paths and wrong tokens look the same, and nothing is read from them.
  if (!m || !token || !same(m[1]!, token) || req.method !== 'POST') throw new HttpError(404, 'Not found');
  let body = await readBody(req, res, MAX_BODY);
  const enc = String(req.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'zstd') {
    try { body = zlib.zstdDecompressSync(body, { maxOutputLength: MAX_JSON }); } catch { throw new HttpError(400, 'Bad zstd body'); }
  } else if (enc && enc !== 'identity') throw new HttpError(415, 'Unsupported Content-Encoding');
  let entries: unknown;
  try { entries = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  const list = Array.isArray(entries) ? entries : [entries];
  const id = m[3]!.slice(0, 8).toLowerCase();
  const out = list.map((e) => JSON.stringify({ ...toLine(e), id }) + '\n').join('');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, `${m[2]}.jsonl`);
  if (fs.existsSync(file) && fs.statSync(file).size > DEVICE_LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
  fs.appendFileSync(file, out, { mode: 0o600 });
  sendJSON(res, 200, {});
}

function lines(label: string): string[] {
  const f = path.join(DIR, `${label}.jsonl`);
  return [f + '.1', f].flatMap((x) => (fs.existsSync(x) ? fs.readFileSync(x, 'utf8').split('\n') : []));
}

function listLabels(): Array<{ label: string; lines: number; last: number | null; devices: string[] }> {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => {
    const label = f.slice(0, -6);
    const all = lines(label).filter(Boolean);
    const ids = new Set<string>();
    let last: number | null = null;
    for (const l of all.slice(-500)) {
      try { const e = JSON.parse(l) as DeviceLine; ids.add(e.id); last = Math.max(last ?? 0, e.t); } catch { /* torn line */ }
    }
    return { label, lines: all.length, last, devices: [...ids] };
  });
}

export async function handleIngest(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
  try { await ingest(req, res, rest); } catch (e) {
    const err = e as HttpError;
    sendJSON(res, err.status || 500, { message: err.message });
  }
}

export async function handleDeviceLogs(req: IncomingMessage, res: ServerResponse, rest: string, query: URLSearchParams): Promise<boolean> {
  const m = rest.match(/^device-logs(?:\/(.+))?$/);
  if (!m) return false;
  try {
    if (!AUDIT_ENABLED) throw new HttpError(404, 'Log collection needs HEADSCALE_URL and a writable DATA_DIR');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    await requireApiKey(req);
    if (!m[1]) { sendJSON(res, 200, { labels: listLabels() }); return true; }
    if (!LABEL.test(m[1])) throw new HttpError(404, 'Not found');
    const limit = Math.min(Math.max(parseInt(query.get('limit') || '', 10) || 1000, 1), 10000);
    const q = (query.get('q') || '').toLowerCase();
    const all = lines(m[1]);
    const out: DeviceLine[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      if (!all[i] || (q && !all[i]!.toLowerCase().includes(q))) continue;
      try { out.push(JSON.parse(all[i]!) as DeviceLine); } catch { /* torn line */ }
    }
    sendJSON(res, 200, { entries: out });
  } catch (e) {
    const err = e as HttpError;
    sendJSON(res, err.status || 500, { code: err.status === 401 ? 16 : undefined, message: err.message });
  }
  return true;
}
