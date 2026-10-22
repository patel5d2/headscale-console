import { API_KEY } from '../support/mock-headscale.js';
import { MOCK, url } from '../support/env.js';
import { expect, test } from '../support/fixtures.js';

test.describe('login', () => {
  test('locked console asks only for the key and rejects a bad one', async ({ page, mock }) => {
    await mock('reset');
    await page.goto(`${url('full')}/#/login`);
    await expect(page.getByLabel('Headscale server URL')).toHaveValue(MOCK);
    await expect(page.getByLabel('Headscale server URL')).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.login-error')).toContainText('Enter an API key.');
    await page.getByRole('button', { name: 'Show API key' }).click();
    await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByLabel('API key', { exact: true }).fill('hskey-api-WRONG-nope');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.login-error')).toContainText('The API key was rejected');
    await page.locator('summary', { hasText: 'Need an API key?' }).click();
    await expect(page.locator('.login-help')).toContainText('docker exec -it headscale');
  });

  test('signs in, remembers the key, and signs out', async ({ login, page }) => {
    await login({ remember: true });
    await expect(page.locator('.brand-tailnet')).toHaveText('127.0.0.1:18281');
    await page.reload();
    await expect(page.locator('h1')).toHaveText('Overview'); // reconnected from localStorage
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menu')).toContainText('Headscale v0.29.5');
    await page.getByRole('menuitem', { name: 'Disconnect' }).click();
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.getByLabel('API key', { exact: true })).toBeFocused();
  });

  test('open console validates the URL and reports missing APIs', async ({ page, mock }) => {
    await mock('reset');
    await page.goto(`${url('open')}/#/login`);
    const urlBox = page.getByLabel('Headscale server URL');
    await urlBox.fill('');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.login-error')).toContainText('Enter your Headscale server URL.');
    await urlBox.fill('http://exa mple');
    await page.getByLabel('API key', { exact: true }).fill(API_KEY);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.login-error')).toContainText('valid URL');
    await urlBox.fill(`${MOCK}/nope/api/v1/`);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.login-error')).toContainText('No Headscale API found');
    await urlBox.fill('127.0.0.2:1'); // no scheme: https:// is added; host not allowed
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.login-error')).toContainText('not in ALLOWED_HEADSCALE_HOSTS');
  });

  test('a stored key that stops working sends you back to login with a reason', async ({ login, page, mock }) => {
    await login({ remember: true });
    await mock('fail', { path: '^/api/v1/user$', status: 401, times: 3 });
    await page.reload();
    await expect(page.locator('.login-error')).toContainText('Could not reconnect');
  });

  test('an expired key during a session signs you out', async ({ login, page, mock }) => {
    await login({ to: '#/machines' });
    await mock('fail', { path: '^/api/v1/node$', status: 401, times: 5 });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.locator('.toast')).toContainText('Unauthorized');
  });
});
