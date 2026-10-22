#!/usr/bin/env node
/**
 * Headscale Console server: the static UI, the Headscale API proxy, Browser SSH's
 * control relay, host actions, and the audit log / policy history. Zero runtime
 * dependencies (Node 20+). Configuration is environment variables; see config.ts.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  ALLOWED_HOSTS, BROWSER_SSH, HEADSCALE_UNIT, HOST, HOST_ACTIONS, HOST_ACTIONS_WANTED, INSECURE_TLS, LOCKED_URL, PORT, PUBLIC_DIR,
} from './config.js';
import { handleHost } from './host.js';
import { log, SECURITY_HEADERS, sendJSON } from './http.js';
import { handleProxy, handleUpgrade } from './proxy.js';
import { AUDIT_ENABLED, handleConsole } from './store.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  let rel: string;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return sendJSON(res, 400, { message: 'Bad request' }); }
  if (!rel) rel = 'index.html';
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { message: 'Forbidden' });

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback: unknown paths without an extension get index.html
      if (path.extname(rel)) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      file = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    // Serve a precompressed sibling when there is one (the SSH client: 30 MB → 7 MB).
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && fs.existsSync(file + '.gz');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(gz ? file + '.gz' : file).pipe(res);
  });
}

export const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') return sendJSON(res, 200, { status: 'ok' });
  if (p === '/console-config.json') {
    return sendJSON(res, 200, {
      lockedUrl: LOCKED_URL || null,
      allowedHosts: ALLOWED_HOSTS,
      insecureTls: INSECURE_TLS,
      hostActions: HOST_ACTIONS,
      browserSsh: BROWSER_SSH,
      auditLog: AUDIT_ENABLED,
    });
  }
  // Control-plane key fetch for the Browser SSH client (see handleUpgrade).
  if (p === '/key' && BROWSER_SSH && req.method === 'GET') return void handleProxy(req, res, 'key', url.search);
  if (p.startsWith('/host/')) return void handleHost(req, res, p.slice('/host/'.length), url.searchParams);
  if (p.startsWith('/console/')) return void handleConsole(req, res, p.slice('/console/'.length), url.searchParams);
  if (p.startsWith('/proxy/')) return void handleProxy(req, res, p.slice('/proxy/'.length), url.search);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { message: 'Method not allowed' });
  return serveStatic(req, res, p);
});

server.on('upgrade', handleUpgrade);
// A request line Node can't parse never reaches the handler; answer it instead of hanging.
server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

server.listen(PORT, HOST, () => {
  log(`Headscale Console listening on http://${HOST}:${PORT}`);
  if (LOCKED_URL) log(`Locked to Headscale server: ${LOCKED_URL}`);
  else if (ALLOWED_HOSTS.length) log(`Proxy restricted to hosts: ${ALLOWED_HOSTS.join(', ')}`);
  else log('Proxy accepts any Headscale URL entered at login (set HEADSCALE_URL to lock it down)');
  if (BROWSER_SSH) log('Browser SSH enabled');
  if (AUDIT_ENABLED) log('Audit log and policy history enabled');
  if (HOST_ACTIONS) log(`Host actions enabled (logs + updates for unit "${HEADSCALE_UNIT}")`);
  else if (HOST_ACTIONS_WANTED) log('HOST_ACTIONS ignored: it requires HEADSCALE_URL so API keys can be verified');
  if (INSECURE_TLS) log('WARNING: TLS certificate verification to Headscale is disabled');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`Received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
