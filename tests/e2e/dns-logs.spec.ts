import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../support/fixtures.js';
import { SERVERS } from '../support/env.js';

const journalMode = (mode: string): void => fs.writeFileSync(path.join(SERVERS.full.dir, 'bin', 'mode'), mode);

test.describe('DNS', () => {
  test('base domain, machine names and the config snippet', async ({ login, page, mock }) => {
    await login({ to: '#/dns' });
    await expect(page.locator('#main')).toContainText('Set your base domain above');
    await expect(page.locator('tbody tr')).toHaveCount(4);
    const domain = page.getByLabel('MagicDNS base domain');
    await domain.fill('not a domain');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast').last()).toContainText('Enter a valid domain');
    await domain.fill('.Tail.Example.COM.');
    await domain.press('Enter');
    await expect(page.locator('.toast').last()).toContainText('Base domain saved');
    await expect(domain).toHaveValue('tail.example.com');
    await expect(page.locator('tbody')).toContainText('laptop.tail.example.com');
    await domain.fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast').last()).toContainText('Base domain cleared');
    await expect(page.locator('.codeblock').last()).toContainText('base_domain: tail.example.com');

    const { nodes } = await mock('state');
    await mock('set', { nodes: [{ ...nodes[0], ipAddresses: [] }] });
    await page.reload();
    await expect(page.locator('tbody tr')).toContainText('—');
    await mock('set', { nodes: [] });
    await page.reload();
    await expect(page.locator('.empty-title')).toHaveText('No machines');

    await mock('fail', { path: '^/api/v1/node$', message: 'dns load failed', times: 99 });
    await page.reload();
    await expect(page.locator('.callout-error')).toContainText('dns load failed');
  });
});

test.describe('logs', () => {
  test.afterEach(() => journalMode('ok'));

  test('levels, top issues, search, ranges and download', async ({ login, page }) => {
    journalMode('ok');
    await login({ to: '#/logs' });
    await expect(page.getByRole('button', { name: /All entries/ })).toContainText('5');
    await expect(page.getByRole('button', { name: /Errors/ })).toContainText('2');
    await expect(page.getByRole('button', { name: /Warnings/ })).toContainText('1');
    const issues = page.locator('section', { hasText: 'Top issues' });
    await expect(issues.locator('tbody tr').first()).toContainText('failed to connect');
    await expect(issues.locator('tbody tr').first()).toContainText('2');

    await page.getByRole('button', { name: /Warnings/ }).click();
    await expect(page.locator('section', { hasText: 'Entries' }).locator('tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: /All entries/ }).click();
    await page.getByRole('searchbox', { name: 'Search logs' }).fill('starting');
    await expect(page.locator('#main')).toContainText('1 shown, newest first');
    await page.getByRole('searchbox', { name: 'Search logs' }).fill('zzz');
    await expect(page.locator('#main')).toContainText('No matching entries.');
    await page.getByRole('searchbox', { name: 'Search logs' }).fill('');

    await issues.locator('tbody tr').first().click();
    await expect(page.getByRole('searchbox', { name: 'Search logs' })).not.toHaveValue('');
    await expect(page.getByRole('button', { name: /Errors/ })).toHaveAttribute('aria-pressed', 'true');
    await issues.locator('tbody tr').first().focus();
    await page.keyboard.press('Enter');

    await page.getByLabel('Time range').selectOption('24h');
    await page.getByLabel('Lines').selectOption('500');
    await page.getByRole('button', { name: 'Refresh' }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    const text = fs.readFileSync((await (await downloaded).path())!, 'utf8');
    expect(text).toContain('ERROR failed to connect node=12');
  });

  test('no visible entries, a journal error, a quiet log and very long logs', async ({ login, page }) => {
    journalMode('empty');
    await login({ to: '#/logs' });
    await expect(page.locator('.callout-warning')).toContainText('No log entries visible');
    await expect(page.locator('#main')).toContainText('No errors or warnings in this range.');

    journalMode('error');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.callout-error')).toContainText('permission denied');
    journalMode('ok');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('button', { name: /All entries/ })).toContainText('5');

    const entries = Array.from({ length: 1100 }, (_, i) => ({ t: 1761000000000 + i, p: 6, m: `INF line ${i}` }));
    await page.route('**/host/logs?*', (route) => route.fulfill({ json: { unit: 'headscale', entries, hint: null } }));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('#main')).toContainText('Newest 1000 of 1100');
  });

  test('without host actions it shows how to enable them', async ({ login, page }) => {
    await login({ server: 'open', to: '#/logs' });
    await expect(page.locator('#main')).toContainText('Logs need access to the Headscale host');
    await expect(page.locator('#main')).toContainText('journalctl -u headscale');
  });
});
