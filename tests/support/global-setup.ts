// Starts the mock Headscale and the console servers (as child processes that write V8
// coverage), and returns the teardown that stops them and builds the coverage report.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildCoverageReport, resetCoverage } from './coverage.js';
import { MOCK, MOCK_PORT, NODE_COVERAGE_DIR, ROOT, SERVERS, TMP, type ServerName } from './env.js';
import { startMockHeadscale } from './mock-headscale.js';

const FAKE_JOURNALCTL = `#!/bin/sh
# Test stand-in for journalctl: behaviour comes from the "mode" file next to it.
mode=$(cat "$(dirname "$0")/mode" 2>/dev/null || echo ok)
case "$mode" in
  error) echo "Failed to open journal: permission denied" >&2; exit 1 ;;
  empty) echo "Hint: You are currently not seeing messages from other users and the system." >&2; exit 0 ;;
esac
echo '{"__REALTIME_TIMESTAMP":"1761000000000000","PRIORITY":"6","MESSAGE":"2025-10-21T00:00:00Z INF Starting Headscale version=0.29.5"}'
echo '{"__REALTIME_TIMESTAMP":"1761000001000000","PRIORITY":"6","MESSAGE":"\\u001b[31m2025-10-21T00:00:01Z ERR failed to connect node=12 error=\\"timeout\\"\\u001b[0m"}'
echo '{"__REALTIME_TIMESTAMP":"1761000002000000","PRIORITY":"6","MESSAGE":"2025-10-21T00:00:02Z ERR failed to connect node=13 error=\\"timeout\\""}'
echo '{"__REALTIME_TIMESTAMP":"1761000003000000","PRIORITY":"4","MESSAGE":"{\\"level\\":\\"warn\\",\\"message\\":\\"noise handshake failed\\",\\"ip\\":\\"1.2.3.4\\",\\"n\\":2}"}'
echo '{"__REALTIME_TIMESTAMP":"1761000004000000","PRIORITY":"7","MESSAGE":[100,101,98,117,103]}'
echo 'not json'
`;

/** A copy of public/ whose Browser SSH client is the test stand-in. */
function testPublicDir(dir: string): string {
  const pub = path.join(dir, 'public');
  fs.cpSync(path.join(ROOT, 'public'), pub, { recursive: true, filter: (src) => !src.includes(`${path.sep}ssh`) });
  fs.mkdirSync(path.join(pub, 'ssh'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tests/support/fake-ssh/wasm_exec.js'), path.join(pub, 'ssh/wasm_exec.js'));
  fs.writeFileSync(path.join(pub, 'ssh/hp_ssh.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])); // an empty module
  return pub;
}

function envFor(name: ServerName): NodeJS.ProcessEnv {
  const { port, dir } = SERVERS[name];
  const bin = path.join(dir, 'bin');
  const base = { PORT: String(port), HOST: '127.0.0.1', NODE_V8_COVERAGE: NODE_COVERAGE_DIR, PROXY_TIMEOUT_MS: '3000' };
  switch (name) {
    case 'full':
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'journalctl'), FAKE_JOURNALCTL, { mode: 0o755 });
      for (const d of ['data', 'state', 'update-status']) fs.mkdirSync(path.join(dir, d), { recursive: true });
      return {
        ...base, HEADSCALE_URL: MOCK, HOST_ACTIONS: 'true', HEADSCALE_UNIT: 'headscale', PUBLIC_DIR: testPublicDir(dir),
        DATA_DIR: path.join(dir, 'data'), STATE_DIRECTORY: path.join(dir, 'state'), UPDATE_STATUS_DIR: path.join(dir, 'update-status'),
        HEADSCALE_RELEASES_URL: `${MOCK}/__mock/releases`, AUDIT_MAX_BYTES: '4000', PATH: `${bin}:${process.env.PATH}`,
      };
    case 'open':
      return { ...base, ALLOWED_HEADSCALE_HOSTS: '127.0.0.1, localhost', HEADSCALE_RELEASES_URL: `${MOCK}/__mock/releases` };
    case 'bare':
      return { ...base, HOST_ACTIONS: 'yes', HEADSCALE_INSECURE_TLS: 'true', HEADSCALE_RELEASES_URL: 'http://127.0.0.1:9/' };
    case 'broken':
      return {
        ...base, HEADSCALE_URL: `${MOCK}/`, HOST_ACTIONS: '1', BROWSER_SSH: 'false', HEADSCALE_UNIT: '-bad unit',
        DATA_DIR: '/proc/headscale-console-test', STATE_DIRECTORY: path.join(dir, 'missing-state'), UPDATE_STATUS_DIR: path.join(dir, 'missing'),
        HEADSCALE_RELEASES_URL: 'http://127.0.0.1:9/', PATH: '/nonexistent',
      };
  }
}

async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`console on port ${port} didn't start`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  fs.rmSync(TMP, { recursive: true, force: true });
  resetCoverage();
  const mock = await startMockHeadscale(MOCK_PORT);
  const procs: ChildProcess[] = [];
  for (const name of Object.keys(SERVERS) as ServerName[]) {
    fs.mkdirSync(SERVERS[name].dir, { recursive: true });
    const log = fs.openSync(path.join(SERVERS[name].dir, 'server.log'), 'w');
    procs.push(spawn(process.execPath, [path.join(ROOT, 'dist/server/server.js')], { env: envFor(name), stdio: ['ignore', log, log] }));
  }
  await Promise.all(Object.values(SERVERS).map((s) => waitUp(s.port)));

  return async () => {
    // SIGTERM lets each server exit cleanly, which is when Node writes its coverage.
    await Promise.all(procs.map((p) => new Promise<void>((resolve) => { p.on('exit', () => resolve()); p.kill('SIGTERM'); })));
    await mock.close();
    await buildCoverageReport();
  };
}
