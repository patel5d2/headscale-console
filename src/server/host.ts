'use strict';
/**
 * Optional host actions, for a console installed on the same VM as Headscale
 * (deploy/install-vm.sh <url> --host-actions). Enabled with HOST_ACTIONS=true and
 * only when HEADSCALE_URL is set: every call is authorised by checking the
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
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const SINCE = { '15m': '-15min', '1h': '-1h', '6h': '-6h', '24h': '-24h', '7d': '-7d' };
const STALE_MS = 20 * 60 * 1000; // an update still "running" after this is assumed dead
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g; // eslint-disable-line no-control-regex

const httpError = (status, message) => Object.assign(new Error(message), { status });

module.exports = function createHost({ lockedUrl, upstreamStatus, sendJSON, log }) {
  const wanted = /^(1|true|yes)$/i.test(process.env.HOST_ACTIONS || '');
  const enabled = wanted && !!lockedUrl;
  if (wanted && !lockedUrl) log('HOST_ACTIONS ignored: it requires HEADSCALE_URL so API keys can be verified');
  const unit = /^[\w@][\w@.-]*$/.test(process.env.HEADSCALE_UNIT || '') ? process.env.HEADSCALE_UNIT : 'headscale';
  const stateDir = process.env.STATE_DIRECTORY || '/var/lib/headscale-console'; // set by systemd StateDirectory=
  const statusDir = process.env.UPDATE_STATUS_DIR || '/var/lib/headscale-console-update'; // root-owned, read-only to us
  const requestFile = path.join(stateDir, 'update-request');

  // ------------------------------------------------------------------ auth --
  // ponytail: a revoked key keeps host access for up to 60s; shorten the TTL if that matters.
  const verified = new Map(); // sha256(Authorization) -> expiry

  async function authorized(req) {
    const auth = req.headers.authorization || '';
    if (!/^Bearer [\x21-\x7e]{8,512}$/.test(auth)) return false;
    const id = crypto.createHash('sha256').update(auth).digest('hex');
    if (verified.get(id) > Date.now()) return true;
    const status = await upstreamStatus('api/v1/apikey', auth);
    if (status === 401 || status === 403) return false;
    if (status !== 200) throw httpError(502, 'Could not verify the API key with Headscale');
    if (verified.size > 100) verified.clear();
    verified.set(id, Date.now() + 60000);
    return true;
  }

  // -------------------------------------------------------------- releases --
  let cache = { at: 0, list: null };

  async function releases() {
    if (cache.list && Date.now() - cache.at < 3600e3) return cache.list;
    try {
      const r = await fetch('https://api.github.com/repos/juanfont/headscale/releases?per_page=30', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'headscale-console' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
      const list = (await r.json())
        .filter((x) => !x.draft && !x.prerelease)
        .map((x) => ({ version: String(x.tag_name).replace(/^v/, ''), publishedAt: String(x.published_at || '') }))
        .filter((x) => VERSION_RE.test(x.version));
      cache = { at: Date.now(), list };
      return list;
    } catch (e) {
      if (cache.list) return cache.list; // serve stale rather than nothing
      throw httpError(502, `Could not check for Headscale releases: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------ logs --
  function readLogs(query) {
    const lines = Math.min(Math.max(parseInt(query.get('lines'), 10) || 1000, 1), 10000);
    const since = SINCE[query.get('since')] || SINCE['24h'];
    const args = ['-u', unit, '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY', '-n', String(lines), `--since=${since}`];
    return new Promise((resolve, reject) => {
      execFile('journalctl', args, { maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') return reject(httpError(501, 'journalctl is not available on this host'));
        if (err && !stdout) return reject(httpError(500, String(stderr || err.message).trim().slice(0, 500)));
        const entries = [];
        for (const line of stdout.split('\n')) {
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            const m = Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE).toString('utf8') : String(j.MESSAGE ?? '');
            entries.push({ t: Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000), p: Number(j.PRIORITY), m: m.replace(ANSI, '').slice(0, 8000) });
          } catch { /* skip malformed line */ }
        }
        resolve({ unit, entries, hint: String(stderr || '').trim().slice(0, 500) || null });
      });
    });
  }

  // ---------------------------------------------------------------- update --
  function tail(file, max) {
    let fd;
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

  function updateStatus() {
    let s = { state: 'idle' };
    try { s = { ...s, ...JSON.parse(tail(path.join(statusDir, 'status.json'), 4096)) }; } catch { /* never updated */ }
    if (s.state === 'running' && Date.now() - Date.parse(s.at) > STALE_MS) s.state = 'stale';
    if (s.state !== 'running' && fs.existsSync(requestFile)) return { state: 'queued', log: '' }; // older status is stale
    return { ...s, log: tail(path.join(statusDir, 'update.log'), 64 * 1024) };
  }

  async function requestUpdate(req) {
    const body = await readJSON(req, 1024);
    const version = String(body.version || '');
    if (!VERSION_RE.test(version)) throw httpError(400, 'Invalid version');
    if (!(await releases()).some((r) => r.version === version)) throw httpError(400, `${version} is not a stable Headscale release`);
    const st = updateStatus();
    if (st.state === 'running' || st.state === 'queued') throw httpError(409, 'An update is already in progress');
    try {
      fs.writeFileSync(requestFile, version + '\n', { mode: 0o600 });
    } catch (e) {
      throw httpError(500, `Could not queue the update (${e.code || e.message}). Re-run install-vm.sh with --host-actions.`);
    }
    log(`Headscale update to ${version} requested from ${req.socket.remoteAddress}`);
    return { queued: version };
  }

  function readJSON(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) reject(httpError(413, 'Request body too large')); // handle() closes the socket after replying
        else chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') || {}); } catch { reject(httpError(400, 'Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  // ---------------------------------------------------------------- router --
  async function handle(req, res, action, query) {
    try {
      if (action === 'releases' && req.method === 'GET') return sendJSON(res, 200, { releases: (await releases()).slice(0, 20) });
      if (!enabled) return sendJSON(res, 404, { message: 'Host actions are not enabled on this console' });
      if (!(await authorized(req))) return sendJSON(res, 401, { code: 16, message: 'Unauthorized — the API key is invalid or expired.' });
      if (action === 'logs' && req.method === 'GET') return sendJSON(res, 200, await readLogs(query));
      if (action === 'update' && req.method === 'GET') return sendJSON(res, 200, updateStatus());
      if (action === 'update' && req.method === 'POST') return sendJSON(res, 202, await requestUpdate(req));
      return sendJSON(res, 404, { message: 'Unknown host action' });
    } catch (e) {
      log(`/host/${action} -> ${e.status || 500}: ${e.message}`);
      if (e.status === 413) res.on('finish', () => req.destroy());
      return sendJSON(res, e.status || 500, { message: e.message });
    }
  }

  return { enabled, handle };
};
