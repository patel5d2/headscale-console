// Test fixtures: every page records Chromium JS coverage (with the local source maps
// attached, since the servers are gone when the report is built), plus helpers to sign
// in and to reach the mock Headscale.
import { expect, test as base, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { API_KEY } from './mock-headscale.js';
import { BROWSER_COVERAGE_DIR, MOCK, ROOT, url, type ServerName } from './env.js';

interface Fixtures {
  /** Signs in to a console server and lands on the given hash route. */
  login: (opts?: { server?: ServerName; to?: string; remember?: boolean }) => Promise<Page>;
  /** Calls the mock's control API: reset, set, fail, state. */
  mock: (pathname: string, body?: unknown) => Promise<any>;
}

let n = 0;

export const test = base.extend<Fixtures>({
  page: async ({ page }, use, info) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    const keep = entries.filter((e) => /\/js\/(client|shared)\//.test(e.url)).map((e) => {
      const file = path.join(ROOT, 'public', new URL(e.url).pathname);
      const map = `${file}.map`;
      return fs.existsSync(map) ? { ...e, sourceMap: JSON.parse(fs.readFileSync(map, 'utf8')) } : e;
    });
    if (keep.length) fs.writeFileSync(path.join(BROWSER_COVERAGE_DIR, `${process.pid}-${n++}-${info.testId}.json`), JSON.stringify(keep));
  },

  mock: async ({ request }, use) => {
    await use(async (pathname, body) => {
      const r = await request.post(`${MOCK}/__mock/${pathname}`, body === undefined ? {} : { data: body });
      return r.json();
    });
  },

  login: async ({ page, mock }, use) => {
    await mock('reset');
    await use(async ({ server = 'full', to = '#/overview', remember = false } = {}) => {
      await page.goto(`${url(server)}/#/login`);
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto(`${url(server)}/#/login`);
      if (server !== 'full' && server !== 'broken') await page.getByLabel('Headscale server URL').fill(MOCK);
      await page.getByLabel('API key', { exact: true }).fill(API_KEY);
      await page.getByLabel('Remember me on this device').setChecked(remember);
      await page.getByRole('button', { name: 'Connect' }).click();
      await expect(page.locator('h1')).toHaveText('Overview');
      if (to !== '#/overview') {
        await page.evaluate((h) => { location.hash = h; }, to);
        await page.waitForLoadState('networkidle');
      }
      return page;
    });
  },
});

export { expect };
