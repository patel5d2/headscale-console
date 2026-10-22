// Where the test servers listen and keep their files. Shared by setup, fixtures and specs.
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const TMP = path.join(ROOT, 'test-results', 'env');
export const NODE_COVERAGE_DIR = path.join(ROOT, 'coverage', '.v8-node');
export const BROWSER_COVERAGE_DIR = path.join(ROOT, 'coverage', '.v8-browser');

export const MOCK_PORT = 18281;
export const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** The console servers, each in a different configuration so every code path is reachable. */
export const SERVERS = {
  /** Locked to the mock, with every feature on: SSH, audit log, host actions. */
  full: { port: 18282, dir: path.join(TMP, 'full') },
  /** Not locked; the login page asks for a URL; hosts limited to 127.0.0.1. */
  open: { port: 18283, dir: path.join(TMP, 'open') },
  /** Not locked, no host allowlist; HOST_ACTIONS requested but ignored. */
  bare: { port: 18284, dir: path.join(TMP, 'bare') },
  /** Locked, but journalctl and the data directory are unavailable and GitHub is unreachable. */
  broken: { port: 18285, dir: path.join(TMP, 'broken') },
} as const;
export type ServerName = keyof typeof SERVERS;
export const url = (s: ServerName): string => `http://127.0.0.1:${SERVERS[s].port}`;
