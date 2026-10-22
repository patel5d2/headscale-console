// The Headscale API proxy (/proxy/*) and the Browser SSH control relay (/ts2021).
// Headscale's REST API sends no CORS headers, so the browser calls it through here.
// The API key travels in the Authorization header and is never stored.
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { actorOf } from './auth.js';
import { ALLOWED_HOSTS, BROWSER_SSH, INSECURE_TLS, LOCKED_URL, MAX_BODY, normalizeBase, TIMEOUT } from './config.js';
import { agentFor, HttpError, log, readBody, SECURITY_HEADERS, sendJSON } from './http.js';
import { AUDIT_ENABLED, record, savePolicyVersion, snapshotBeforeFirstChange, summarize } from './store.js';

// Only these upstream paths are reachable through the proxy.
const ALLOWED_UPSTREAM = /^(api\/v1\/[A-Za-z0-9_\-./%:@]*|version|health|key)$/;

export async function handleProxy(req: IncomingMessage, res: ServerResponse, rest: string, search: string): Promise<void> {
  if (!ALLOWED_UPSTREAM.test(rest) || rest.includes('..')) return sendJSON(res, 404, { code: 5, message: 'Unknown proxy path' });

  const base = LOCKED_URL || normalizeBase(req.headers['x-headscale-url']);
  if (!base) return sendJSON(res, 400, { code: 3, message: 'Missing or invalid Headscale URL' });
  const target = new URL(base + '/' + rest + search);
  if (!LOCKED_URL && ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(target.hostname.toLowerCase())) {
    return sendJSON(res, 403, { code: 7, message: `Host "${target.hostname}" is not in ALLOWED_HEADSCALE_HOSTS` });
  }

  let body: Buffer;
  try {
    body = await readBody(req, res, MAX_BODY);
  } catch (e) {
    return sendJSON(res, (e as HttpError).status || 400, { code: 8, message: (e as Error).message });
  }

  const method = req.method || 'GET';
  const isChange = AUDIT_ENABLED && method !== 'GET' && method !== 'HEAD' && rest.startsWith('api/v1/');
  const isPolicyWrite = isChange && method === 'PUT' && rest === 'api/v1/policy';
  if (isPolicyWrite && req.headers.authorization) await snapshotBeforeFirstChange(req.headers.authorization);

  const headers: Record<string, string | number> = { Accept: 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (body.length) headers['Content-Length'] = body.length;

  const started = Date.now();
  const upstream = (target.protocol === 'https:' ? https : http).request(target, {
    method, headers, agent: agentFor(target), timeout: TIMEOUT,
  }, (up) => {
    // Never relay an upstream HTML page on our origin; the UI only expects JSON.
    const ct = String(up.headers['content-type'] || '');
    res.writeHead(up.statusCode || 502, {
      ...SECURITY_HEADERS,
      'Content-Type': /^application\/json\b/i.test(ct) ? ct : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    up.pipe(res);
    up.on('end', () => {
      const status = up.statusCode || 0;
      log(`${method} /${rest} -> ${status} (${Date.now() - started}ms)`);
      if (!isChange) return;
      const actor = actorOf(req);
      record({
        at: new Date().toISOString(), actor, ip: req.socket.remoteAddress || '', method,
        path: '/' + rest, status, summary: summarize(body, new URLSearchParams(search)),
      });
      if (isPolicyWrite && status === 200) {
        try {
          const policy = (JSON.parse(body.toString('utf8')) as { policy?: unknown }).policy;
          if (typeof policy === 'string') savePolicyVersion(policy, actor);
        } catch { /* Headscale accepted it, so it was JSON; nothing to keep otherwise */ }
      }
    });
  });

  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timed out')));
  upstream.on('error', (err: NodeJS.ErrnoException) => {
    log(`${method} /${rest} -> error: ${err.code || ''} ${err.message}`);
    if (res.headersSent) { res.destroy(); return; }
    let message = `Could not reach Headscale at ${base}: ${err.message}`;
    if (/certificate|self[- ]signed|UNABLE_TO_VERIFY/i.test(err.message + (err.code || ''))) {
      message += ' (set HEADSCALE_INSECURE_TLS=true to allow self-signed certificates)';
    }
    sendJSON(res, 502, { code: 14, message });
  });
  upstream.end(body.length ? body : undefined);
}

// Browser SSH: the in-page Tailscale client speaks Tailscale's control protocol over
// a WebSocket to /ts2021. Relay it unchanged to the locked Headscale server. Headscale
// serves this endpoint publicly anyway; relaying keeps the browser same-origin, so
// Headscale needs no CORS setup.
const WS_HEADERS = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!BROWSER_SSH || url.pathname !== '/ts2021' || req.method !== 'GET') { socket.destroy(); return; }

  const target = new URL(LOCKED_URL + '/ts2021' + url.search);
  const headers: Record<string, string | string[]> = {};
  for (const k of WS_HEADERS) { const v = req.headers[k]; if (v) headers[k] = v; } // no Origin, cookies or auth
  const upReq = (target.protocol === 'https:' ? https : http).request(target, {
    headers, agent: false, rejectUnauthorized: !INSECURE_TLS, timeout: TIMEOUT,
  });

  upReq.on('upgrade', (up, upSocket, upHead) => {
    upReq.setTimeout(0);
    let raw = `HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\n`;
    for (let i = 0; i < up.rawHeaders.length; i += 2) raw += `${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}\r\n`;
    socket.write(raw + '\r\n');
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    for (const [a, b] of [[upSocket, socket], [socket, upSocket]] as const) {
      a.on('error', () => b.destroy());
      a.on('close', () => b.destroy());
    }
    log('WS /ts2021 -> 101 (Browser SSH control connection)');
  });
  upReq.on('response', (up) => { // Headscale refused the upgrade: pass its status through
    socket.end(`HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\nConnection: close\r\n\r\n`);
    up.resume();
  });
  upReq.on('timeout', () => upReq.destroy(new Error('Upstream timed out')));
  upReq.on('error', (err) => { log(`WS /ts2021 -> error: ${err.message}`); socket.destroy(); });
  socket.on('error', () => upReq.destroy());
  upReq.end();
}
