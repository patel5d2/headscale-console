// Run pure/shared and CLI checks against the built JavaScript so Node's V8 output
// has the same source maps as the server and contributes to the combined report.
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_COVERAGE_DIR, ROOT } from '../support/env.js';

test('shared logic and command-line regression suite', async () => {
  const files = ['unit', 'cli'].filter((dir) => fs.existsSync(path.join(ROOT, 'tests', dir))).flatMap((dir) => fs.readdirSync(path.join(ROOT, 'tests', dir))
    .filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(ROOT, 'tests', dir, f)));
  const result = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=dot', ...files], {
    cwd: ROOT,
    env: { ...process.env, NODE_V8_COVERAGE: NODE_COVERAGE_DIR },
    maxBuffer: 16 * 1024 * 1024,
  }).catch((e: { stdout: string; stderr: string }) => { throw new Error(`node --test failed:\n${e.stdout}\n${e.stderr}`); });
  expect(result.stderr).toBe('');
});
