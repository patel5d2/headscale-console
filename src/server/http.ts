// Small HTTP helpers shared by every route: security headers, JSON replies, body reading.
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { BROWSER_SSH, INSECURE_TLS, LOCKED_URL, TIMEOUT } from './config.js';

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Browser SSH must compile WebAssembly and reach DERP relays (wss/https) directly.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
    `script-src 'self'${BROWSER_SSH ? " 'wasm-unsafe-eval'" : ''}; connect-src 'self'${BROWSER_SSH ? ' wss: https:' : ''}; ` +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function sendJSON(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** Reads a request body up to `limit` bytes; a 413 closes the socket once it's sent. */
export function readBody(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        if (!over) { over = true; res.on('finish', () => req.destroy()); reject(new HttpError(413, 'Request body too large')); }
      } else chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

export async function readJSON(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Record<string, unknown>> {
  const buf = await readBody(req, res, limit);
  try {
    const v: unknown = JSON.parse(buf.toString('utf8') || '{}');
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });
export const agentFor = (u: URL): http.Agent => (u.protocol === 'https:' ? (INSECURE_TLS ? insecureAgent : httpsAgent) : httpAgent);

/** A GET to the locked Headscale server with the caller's credentials: status + body (status 0 = unreachable). */
export function upstreamGet(rest: string, authorization: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const target = new URL(LOCKED_URL + '/' + rest);
    const r = (target.protocol === 'https:' ? https : http).request(target, {
      headers: { Accept: 'application/json', Authorization: authorization },
      agent: agentFor(target),
      timeout: TIMEOUT,
    }, (up) => {
      const chunks: Buffer[] = [];
      up.on('data', (c: Buffer) => chunks.push(c));
      up.on('end', () => resolve({ status: up.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('Upstream timed out')));
    r.on('error', () => resolve({ status: 0, body: '' }));
    r.end();
  });
}
