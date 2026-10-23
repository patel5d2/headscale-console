// Coverage for the whole codebase in one report: Node V8 coverage from the servers and
// the CLI, plus Chromium's from the browser, mapped back to src/**/*.ts via source maps.
import fs from 'node:fs';
import path from 'node:path';
import MCR, { type CoverageReportOptions, type CoverageResults } from 'monocart-coverage-reports';
import { BROWSER_COVERAGE_DIR, NODE_COVERAGE_DIR, ROOT } from './env.js';

/** Minimum percentages; the run fails below them. */
// The floor CI enforces: raise these as coverage grows, never lower them.
export const THRESHOLDS = { lines: 94, statements: 98, functions: 97, branches: 89 } as const;

// Type-only modules compile to nothing, so they have no code to cover.
const TYPE_ONLY = ['src/shared/types.ts', 'src/client/types.ts'];

export const options: CoverageReportOptions = {
  name: 'Headscale Console coverage',
  outputDir: path.join(ROOT, 'coverage'),
  baseDir: ROOT,
  reports: [['v8'], ['console-summary'], ['json-summary'], ['lcovonly'], ['console-details', { skipPercent: 100 }]],
  entryFilter: (entry) => /\/js\/(client|shared)\/|\/dist\/(server|cli|shared)\//.test(entry.url),
  sourceFilter: (p) => /(^|\/)src\//.test(p) && !TYPE_ONLY.some((t) => p.endsWith(t)),
  sourcePath: (p) => p.replace(/^.*?(?=src\/)/, ''),
  // Files no test loaded still count, at 0%. They're TypeScript, so hand the report the
  // JavaScript and source map our build already produced for each one.
  all: {
    dir: [path.join(ROOT, 'src')],
    filter: (p: string) => p.endsWith('.ts') && !TYPE_ONLY.some((t) => p.endsWith(t)),
    transformer: async (entry: { url: string; source: string; sourceMap?: unknown }) => {
      const rel = path.relative(path.join(ROOT, 'src'), new URL(entry.url).pathname).replace(/\.ts$/, '.js');
      const js = path.join(ROOT, /^(client|shared)\//.test(rel) ? 'public/js' : 'dist', rel);
      entry.source = fs.readFileSync(js, 'utf8');
      entry.sourceMap = JSON.parse(fs.readFileSync(`${js}.map`, 'utf8'));
    },
  },
  clean: false,
  cleanCache: false,
  logging: 'error',
};

export function resetCoverage(): void {
  fs.rmSync(path.join(ROOT, 'coverage'), { recursive: true, force: true });
  fs.mkdirSync(NODE_COVERAGE_DIR, { recursive: true });
  fs.mkdirSync(BROWSER_COVERAGE_DIR, { recursive: true });
}

export async function buildCoverageReport(): Promise<void> {
  const mcr = MCR({ ...options, clean: true });
  await mcr.addFromDir(NODE_COVERAGE_DIR);
  for (const f of fs.readdirSync(BROWSER_COVERAGE_DIR)) {
    await mcr.add(JSON.parse(fs.readFileSync(path.join(BROWSER_COVERAGE_DIR, f), 'utf8')));
  }
  const results = await mcr.generate() as CoverageResults;
  const below = (Object.keys(THRESHOLDS) as Array<keyof typeof THRESHOLDS>)
    .filter((k) => Number(results.summary[k]?.pct ?? 0) < THRESHOLDS[k])
    .map((k) => `${k} ${results.summary[k]?.pct}% < ${THRESHOLDS[k]}%`);
  if (below.length && !process.env.COVERAGE_REPORT_ONLY) throw new Error(`Coverage below the required level: ${below.join(', ')}`);
}
