#!/usr/bin/env node
/**
 * Headscale Console — static file server + API proxy.
 *
 * Headscale's REST API does not send CORS headers, so a browser cannot call it
 * directly from another origin. This tiny server (zero dependencies, Node 18+)
 * serves the console UI and forwards /proxy/* requests to the Headscale server
 * chosen at login. The API key travels from the browser in the Authorization
 * header and is never stored server-side.
 *
 * Environment variables:
 *   PORT                     Port to listen on (default 8080)
 *   HOST                     Interface to bind (default 0.0.0.0)
 *   HEADSCALE_URL            Lock the console to one Headscale server (recommended).
 *                            When set, the login screen only asks for the API key.
 *   ALLOWED_HEADSCALE_HOSTS  Comma-separated hostnames the proxy may reach when
 *                            HEADSCALE_URL is not set (e.g. "hs.example.com,10.0.0.5").
 *   HEADSCALE_INSECURE_TLS   "true" to accept self-signed certificates on Headscale.
 *   PROXY_TIMEOUT_MS         Upstream timeout (default 20000).
 *   HOST_ACTIONS             "true" to enable logs + one-click updates when the console
 *                            runs on the Headscale VM (see host.js). Needs HEADSCALE_URL.
 *   HEADSCALE_UNIT           systemd unit whose journal is shown (default "headscale").
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LOCKED_URL = normalizeBase(process.env.HEADSCALE_URL || '');
const ALLOWED_HOSTS = (process.env.ALLOWED_HEADSCALE_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const INSECURE_TLS = /^(1|true|yes)$/i.test(process.env.HEADSCALE_INSECURE_TLS || '');
const TIMEOUT = parseInt(process.env.PROXY_TIMEOUT_MS || '20000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024; // policies can be large-ish; 2 MB is plenty

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function normalizeBase(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    // keep any sub-path (Headscale behind a reverse proxy at /headscale)
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------- proxy ----

// Only these upstream paths are reachable through the proxy.
const ALLOWED_UPSTREAM = /^(api\/v1\/[A-Za-z0-9_\-./%:@]*|version|health)$/;

function handleProxy(req, res, rest, search) {
  if (!ALLOWED_UPSTREAM.test(rest) || rest.includes('..')) {
    return sendJSON(res, 404, { code: 5, message: 'Unknown proxy path' });
  }

  const base = LOCKED_URL || normalizeBase(req.headers['x-headscale-url']);
  if (!base) {
    return sendJSON(res, 400, { code: 3, message: 'Missing or invalid Headscale URL' });
  }

  let target;
  try {
    target = new URL(base + '/' + rest + (search || ''));
  } catch {
    return sendJSON(res, 400, { code: 3, message: 'Invalid Headscale URL' });
  }

  if (!LOCKED_URL && ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(target.hostname.toLowerCase())) {
    return sendJSON(res, 403, {
      code: 7,
      message: `Host "${target.hostname}" is not in ALLOWED_HEADSCALE_HOSTS`,
    });
  }

  const isHttps = target.protocol === 'https:';
  const headers = { Accept: 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      sendJSON(res, 413, { code: 8, message: 'Request body too large' });
      req.destroy();
    } else chunks.push(c);
  });

  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    if (body.length) headers['Content-Length'] = body.length;

    const started = Date.now();
    const upstream = (isHttps ? https : http).request(
      target,
      {
        method: req.method,
        headers,
        agent: isHttps ? (INSECURE_TLS ? insecureAgent : httpsAgent) : httpAgent,
        timeout: TIMEOUT,
      },
      (up) => {
        // Never relay an upstream HTML page on our origin; the UI only expects JSON.
        const ct = String(up.headers['content-type'] || '');
        const out = {
          ...SECURITY_HEADERS,
          'Content-Type': /^application\/json\b/i.test(ct) ? ct : 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        };
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
        up.on('end', () =>
          log(`${req.method} /${rest} -> ${up.statusCode} (${Date.now() - started}ms)`));
      },
    );

    upstream.on('timeout', () => upstream.destroy(new Error('Upstream timed out')));
    upstream.on('error', (err) => {
      log(`${req.method} /${rest} -> error: ${err.code || ''} ${err.message}`);
      if (res.headersSent) return res.destroy();
      let message = `Could not reach Headscale at ${base}: ${err.message}`;
      if (/certificate|self[- ]signed|UNABLE_TO_VERIFY/i.test(err.message + (err.code || ''))) {
        message += ' (set HEADSCALE_INSECURE_TLS=true to allow self-signed certificates)';
      }
      sendJSON(res, 502, { code: 14, message });
    });

    upstream.end(body.length ? body : undefined);
  });
}

// Status code of an authenticated GET to the locked Headscale server (0 = unreachable).
function upstreamStatus(rest, authorization) {
  return new Promise((resolve) => {
    const target = new URL(LOCKED_URL + '/' + rest);
    const isHttps = target.protocol === 'https:';
    const r = (isHttps ? https : http).request(target, {
      headers: { Accept: 'application/json', Authorization: authorization },
      agent: isHttps ? (INSECURE_TLS ? insecureAgent : httpsAgent) : httpAgent,
      timeout: TIMEOUT,
    }, (up) => { up.resume(); resolve(up.statusCode || 0); });
    r.on('timeout', () => r.destroy(new Error('Upstream timed out')));
    r.on('error', () => resolve(0));
    r.end();
  });
}

const host = require('./host.js')({ lockedUrl: LOCKED_URL, upstreamStatus, sendJSON, log });

// --------------------------------------------------------------- static ----

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { message: 'Forbidden' });

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback: unknown paths without an extension get index.html
      if (path.extname(rel)) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      file = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// --------------------------------------------------------------- server ----

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJSON(res, 400, { message: 'Bad request' });
  }
  const p = url.pathname;

  if (p === '/healthz') return sendJSON(res, 200, { status: 'ok' });

  if (p === '/console-config.json') {
    return sendJSON(res, 200, {
      lockedUrl: LOCKED_URL || null,
      allowedHosts: ALLOWED_HOSTS,
      insecureTls: INSECURE_TLS,
      hostActions: host.enabled,
    });
  }

  if (p.startsWith('/host/')) return host.handle(req, res, p.slice('/host/'.length), url.searchParams);

  if (p.startsWith('/proxy/')) return handleProxy(req, res, p.slice('/proxy/'.length), url.search);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { message: 'Method not allowed' });
  }
  return serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  log(`Headscale Console listening on http://${HOST}:${PORT}`);
  if (LOCKED_URL) log(`Locked to Headscale server: ${LOCKED_URL}`);
  else if (ALLOWED_HOSTS.length) log(`Proxy restricted to hosts: ${ALLOWED_HOSTS.join(', ')}`);
  else log('Proxy accepts any Headscale URL entered at login (set HEADSCALE_URL to lock it down)');
  if (host.enabled) log(`Host actions enabled (logs + updates for unit "${process.env.HEADSCALE_UNIT || 'headscale'}")`);
  if (INSECURE_TLS) log('WARNING: TLS certificate verification to Headscale is disabled');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`Received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
