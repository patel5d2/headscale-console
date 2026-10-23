// The Logs page's automatic collection: turning it on, network activity, device logs and
// the Add device commands that send a device's log to the console.
import fs from 'node:fs';
import path from 'node:path';
import { SERVERS, url } from '../support/env.js';
import { expect, test } from '../support/fixtures.js';
import { API_KEY } from '../support/mock-headscale.js';

const AUTH = { Authorization: `Bearer ${API_KEY}` };
const LOGTAIL = path.join(SERVERS.full.dir, 'update-status', 'logtail.json');
const tab = (page: import('@playwright/test').Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
/** Each test starts with a fresh mock Headscale, so give the collector a key that exists in it. */
async function freshKey(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const key = (await (await request.post(`${url('full')}/proxy/api/v1/apikey`, { headers: AUTH, data: { expiration: '2099-01-01T00:00:00Z' } })).json()).apiKey;
  await request.post(`${url('full')}/console/collector`, { headers: AUTH, data: { key } });
}

test.describe.serial('automatic log collection', () => {
  test.afterAll(async ({ request }) => {
    await request.delete(`${url('full')}/console/collector`, { headers: AUTH });
    fs.rmSync(LOGTAIL, { force: true });
  });

  test('is explained where it is not available', async ({ login, page }) => {
    await login({ server: 'open', to: '#/logs' });
    await expect(page.locator('#main')).toContainText('Automatic collection is not available');
    await tab(page, 'Devices');
    await expect(page.locator('.empty-title')).toHaveText('Device logs are off');
    await tab(page, 'Network activity');
    await expect(page.locator('.empty-title')).toHaveText('Network activity is off');
    await tab(page, 'Headscale server');
    await expect(page.locator('#main')).toContainText('Logs need access to the Headscale host');
  });

  test('turns on with one click and records network activity', async ({ login, page, mock, request }) => {
    await request.delete(`${url('full')}/console/collector`, { headers: AUTH });
    for (const f of ['activity.jsonl', 'activity.jsonl.1', 'activity-state.json']) fs.rmSync(path.join(SERVERS.full.dir, 'data', f), { force: true });
    await login({ to: '#/logs/activity' });
    await mock('fail', { path: '^/api/v1/apikey$', method: 'POST', message: 'no keys today' });
    await page.getByRole('button', { name: 'Turn on automatic collection' }).click();
    await expect(page.locator('.toast').last()).toContainText('no keys today');
    await page.getByRole('button', { name: 'Turn on automatic collection' }).click();
    await expect(page.locator('.toast').last()).toContainText('Automatic collection is on');
    await expect(page.locator('#main')).toContainText('Collecting since');

    const { nodes } = await mock('state');
    await mock('set', { nodes: [{ ...nodes[0], online: false }, ...nodes.slice(1, 3), { ...nodes[0], id: '60', givenName: 'fresh-box' }] });
    await expect.poll(async () => {
      await page.getByRole('button', { name: 'Refresh' }).click();
      return page.locator('tbody tr').count();
    }, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    await expect(page.locator('tbody')).toContainText('fresh-box');
    await expect(page.locator('tr', { hasText: 'old-phone' })).toContainText('Removed');
    await expect(page.locator('tr', { hasText: 'laptop' }).first()).toContainText('Offline');
    await page.getByRole('searchbox', { name: 'Search network activity' }).fill('fresh-box');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    expect(fs.readFileSync((await (await downloaded).path())!, 'utf8')).toContain('joined fresh-box');
    await page.getByRole('searchbox', { name: 'Search network activity' }).fill('nothing-like-this');
    await expect(page.locator('.empty-title')).toHaveText('No matching activity');

    await page.route('**/console/activity?*', (r) => r.fulfill({ status: 500, json: { message: 'activity unavailable' } }));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.callout-error')).toContainText('activity unavailable');
    await page.unroute('**/console/activity?*');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.empty-title')).toHaveText('No matching activity');
    await page.route('**/console/collector', (r) => r.fulfill({ json: { enabled: true, error: 'The console\'s API key was rejected', since: null } }));
    await tab(page, 'Devices');
    await expect(page.locator('.callout-error').first()).toContainText('API key was rejected');
  });

  test('device logs: permission, address, setup and viewing', async ({ login, page, mock, request }) => {
    fs.rmSync(path.join(SERVERS.full.dir, 'data', 'device-logs'), { recursive: true, force: true });
    fs.rmSync(LOGTAIL, { force: true });
    await login({ to: '#/machines' });
    await freshKey(request);
    await page.evaluate(() => { location.hash = '#/logs/devices'; });
    // Headscale must allow device logs; the root helper is simulated by writing its status file.
    await expect(page.locator('.callout-warning').first()).toContainText('Headscale must allow device logs');
    const allow = page.getByRole('button', { name: 'Allow device logs' });
    await page.route('**/host/logtail', (r) => r.fulfill({ status: 202, json: { queued: 'logtail-on' } }));
    fs.writeFileSync(LOGTAIL, '{"state":"failed"}');
    await allow.click();
    await expect(page.locator('.toast').last()).toContainText('previous config was restored');
    await page.reload();
    await page.getByRole('button', { name: 'Try again' }).click();
    fs.writeFileSync(LOGTAIL, '{"state":"on"}');
    await expect(page.locator('.toast').last()).toContainText('Headscale now allows device logs', { timeout: 8000 });
    await expect(page.getByText('Headscale must allow device logs')).toHaveCount(0);

    // The address devices use: checked as it's typed.
    const address = page.getByLabel('Address devices use to reach this console');
    await expect(page.locator('.callout-warning')).toContainText('can\'t reach "localhost"');
    for (const [value, warning] of [['nonsense', 'Enter the full address'], ['http://203.0.113.5:8090', 'unencrypted'], ['http://100.64.0.9:8090', null], ['https://console.example.com/', null]] as const) {
      await address.fill(value);
      await address.press('Enter');
      await address.blur();
      if (warning) await expect(page.locator('.callout-warning')).toContainText(warning);
      else await expect(page.locator('.callout-warning')).toHaveCount(0);
    }

    // A machine not sending yet: the setup commands carry its label.
    const laptop = page.locator('tr', { hasText: 'laptop' });
    await expect(laptop).toContainText('Not sending');
    await laptop.getByRole('button', { name: 'Set up…' }).click();
    const d = page.getByRole('dialog');
    await expect(d).toContainText(/TS_LOG_TARGET=https:\/\/console\.example\.com\/ingest\/[A-Za-z0-9_-]+\/n1 >> \/etc\/default\/tailscaled/);
    await d.getByRole('tab', { name: 'Windows' }).click();
    await expect(d).toContainText('tailscaled-env.txt');
    await d.getByRole('tab', { name: 'Docker', exact: true }).click();
    await expect(d).toContainText('Add this environment variable');
    await d.getByRole('button', { name: 'Done' }).click();

    // Logs arrive (as tailscaled would post them) and can be read.
    const { ingestPath } = await (await request.get(`${url('full')}/console/collector`, { headers: AUTH })).json();
    const send = (label: string, lines: string[]) => request.post(`${url('full')}/${ingestPath}/${label}/c/x/0123456789abcdef`, { data: JSON.stringify(lines.map((text) => ({ text }))) });
    await send('n1', ['magicsock: disco ping', 'control: map response']);
    await send('k10', ['old key log']);
    await send('k12', ['from a removed machine']);
    await mock('set', { nodes: (await mock('state')).nodes.map((n: { id: string }) => (n.id === '1' ? { ...n, preAuthKey: { id: '10', key: '' } } : n)) });
    await page.reload();
    await expect(laptop).toContainText('Receiving');
    await laptop.getByRole('button', { name: 'View n1' }).click();
    await expect(page.locator('.log-msg').first()).toHaveText('control: map response');
    await page.getByRole('searchbox', { name: 'Search device log' }).fill('disco');
    await expect(page.locator('.log-msg')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Search device log' }).fill('zzz');
    await expect(page.locator('#main')).toContainText('No matching lines.');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    expect(fs.readFileSync((await (await downloaded).path())!, 'utf8')).toBe('');
    await page.getByRole('searchbox', { name: 'Search device log' }).fill('');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await laptop.getByRole('button', { name: 'View k10' }).click();
    await expect(page.locator('.log-msg')).toHaveText(['old key log']);
    await page.locator('tr', { hasText: 'Removed machine (k12)' }).getByRole('button', { name: 'View log' }).click();
    await expect(page.locator('.log-msg')).toHaveText(['from a removed machine']);

    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    expect(fs.readFileSync((await (await dl).path())!, 'utf8')).toMatch(/Z from a removed machine$/);
    await page.route('**/console/device-logs/k12?*', (r) => r.fulfill({ status: 500, json: { message: 'log unreadable' } }));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('section', { hasText: 'Log:' }).locator('.callout-error')).toContainText('log unreadable');
    await page.unroute('**/console/device-logs/k12?*');
    await page.locator('section', { hasText: 'Log:' }).getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.log-msg')).toHaveText(['from a removed machine']);
    await page.route('**/console/device-logs', (r) => r.fulfill({ status: 500, json: { message: 'labels unreadable' } }));
    await page.reload();
    await expect(page.locator('.callout-error')).toContainText('labels unreadable');
    await page.unroute('**/console/device-logs');
    await mock('set', { nodes: [] });
    await request.post(`${url('full')}/console/collector`, { headers: AUTH, data: {} }).catch(() => undefined);
    fs.rmSync(path.join(SERVERS.full.dir, 'data', 'device-logs'), { recursive: true, force: true });
    await page.reload();
    await expect(page.locator('.empty-title')).toHaveText('No machines yet');
  });

  test('a status that can\'t be read is treated as off', async ({ login, page }) => {
    await page.route('**/console/collector', (r) => r.fulfill({ status: 502, json: { message: 'no answer' } }));
    await login({ to: '#/logs/activity' });
    await expect(page.locator('.empty-title')).toHaveText('Network activity is off');
  });

  test('without host actions, Headscale\'s setting is shown to copy', async ({ login, page }) => {
    await page.route('**/console/collector', (r) => r.fulfill({ json: { enabled: true, ok: true, since: new Date().toISOString(), lastPoll: null, ingestPath: 'ingest/abc', hostActions: false, headscaleLogtail: 'unknown' } }));
    await login({ to: '#/logs/devices' });
    await expect(page.locator('.callout-warning').first()).toContainText('logtail:');
  });

  test('a failed request to allow device logs is shown', async ({ login, page }) => {
    await page.route('**/host/logtail', (r) => r.fulfill({ status: 409, json: { message: 'A Headscale update is in progress' } }));
    await login({ to: '#/logs/devices' });
    fs.rmSync(LOGTAIL, { force: true });
    await page.reload();
    await page.getByRole('button', { name: 'Allow device logs' }).click();
    await expect(page.locator('.toast').last()).toContainText('update is in progress');
  });

  test('Add device commands send the new device\'s log', async ({ login, page, request }) => {
    await login({ to: '#/machines' });
    await freshKey(request);
    await page.getByRole('button', { name: 'Add device', exact: true }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'Generate install command' }).click();
    await d.getByRole('tab', { name: 'Linux', exact: true }).click();
    const command = d.locator('.codeblock pre').last();
    await expect(command).toContainText(/TS_LOG_TARGET=\S+\/ingest\/[A-Za-z0-9_-]+\/k\d+/);
    await d.getByText('Command options', { exact: true }).click();
    await d.getByLabel('Send logs to the console', { exact: true }).uncheck();
    await expect(command).not.toContainText('TS_LOG_TARGET');
    await d.getByLabel('Send logs to the console', { exact: true }).check();
    await expect(command).toContainText('TS_LOG_TARGET');
  });

  test('turns off and expires its API key', async ({ login, page, mock, request }) => {
    await login({ to: '#/machines' });
    await freshKey(request);
    await page.evaluate(() => { location.hash = '#/logs'; });
    const turnOff = page.locator('#main').getByRole('button', { name: 'Turn off' });
    await turnOff.click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await turnOff.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
    await expect(page.locator('.toast').last()).toContainText('Automatic collection is off');
    await expect(page.getByRole('button', { name: 'Turn on automatic collection' })).toBeVisible();
    const keys = (await mock('state')).apiKeys.filter((k: { prefix: string }) => k.prefix.startsWith('NEWKEY'));
    // Expiring the key may fail; turning off still succeeds.
    await freshKey(request);
    await page.reload();
    await mock('fail', { path: '^/api/v1/apikey/expire$', status: 500, message: 'cannot expire' });
    await mock('fail', { path: '^/api/v1/apikey/expire$', status: 500, message: 'cannot expire' });
    await turnOff.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
    await expect(page.locator('.toast').last()).toContainText('Automatic collection is off');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k: { expiration: string }) => Date.parse(k.expiration) < Date.now())).toBe(true);
    await page.route('**/console/collector', (r) => (r.request().method() === 'DELETE' ? r.fulfill({ status: 500, json: { message: 'cannot stop' } }) : r.fulfill({ json: { enabled: true, ok: true, since: null, lastPoll: new Date().toISOString(), ingestPath: 'ingest/x', hostActions: true, headscaleLogtail: 'on' } })));
    await page.reload();
    await turnOff.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
    await expect(page.locator('.toast').last()).toContainText('cannot stop');
  });
});
