// Smaller paths: the machine list's row menu, live refresh, compatibility fallbacks for
// older Headscale versions, and browser fallbacks.
import { expect, test } from '../support/fixtures.js';

test('every action in a machine row menu', async ({ login, page, mock }) => {
  await login({ to: '#/machines' });
  const menu = async (machine: string, item: string) => {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.locator('tr', { hasText: machine }).first().getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  const cancel = () => page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await menu('laptop', 'View machine details');
  await expect(page.locator('h1')).toHaveText('laptop');
  await page.goBack();
  for (const item of ['Edit machine name…', 'Edit ACL tags…', 'Change key expiry…', 'Expire key', 'Remove…']) {
    await menu('laptop', item);
    await cancel();
  }
  await menu('router', 'Edit route settings…');
  await page.getByRole('dialog').getByRole('checkbox').first().uncheck();
  await page.getByRole('dialog').getByRole('checkbox').first().check();
  await cancel();
  await menu('router', 'Enable key expiry…');
  await cancel();
  await mock('fail', { path: '/node/1/expire$', message: 'expiry refused' });
  await menu('laptop', 'Disable key expiry');
  await expect(page.locator('.toast').last()).toContainText('expiry refused');
  await menu('laptop', 'Disable key expiry');
  await expect(page.locator('.toast').last()).toContainText('Key expiry disabled');
  await expect(page.locator('tr', { hasText: 'laptop' })).toContainText('Expiry disabled');

  // From the detail page's menu too.
  await page.getByRole('link', { name: 'server', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('server');
  await page.locator('.page-actions').getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit ACL tags…' }).click();
  await cancel();
  await page.getByRole('button', { name: 'SSH', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('SSH to server');
});

test('lists refresh themselves while open', async ({ login, page, mock }) => {
  await page.clock.install();
  await login({ to: '#/machines' });
  const { nodes } = await mock('state');
  await mock('set', { nodes: nodes.slice(0, 3) });
  await page.clock.fastForward(16_000);
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.evaluate(() => { location.hash = '#/routes'; });
  await mock('set', { nodes: nodes.slice(0, 1) });
  await page.clock.fastForward(21_000);
  await expect(page.locator('.empty-title')).toHaveText('No routes advertised');
  await page.evaluate(() => { location.hash = '#/machines/1'; });
  await mock('set', { nodes: [{ ...nodes[0], givenName: 'renamed-elsewhere' }] });
  await page.clock.fastForward(21_000);
  await expect(page.locator('h1')).toHaveText('renamed-elsewhere');
});

test('older Headscale versions: fallbacks for keys, API keys and registration', async ({ login, page, mock }) => {
  await mock('reset');
  const { keys } = await mock('state');
  const fresh = (id: string) => ({ ...keys[0], id, key: `hskey-auth-${id.repeat(24).slice(0, 24)}`, used: false });
  await mock('set', { keys: [...keys, fresh('20'), fresh('21')] });
  await login({ to: '#/settings/keys' });
  // Revoking by id is rejected (before 0.26), so the console retries with user + key.
  await mock('fail', { path: '^/api/v1/preauthkey/expire$', status: 400, message: 'id not supported' });
  const row = page.locator('tbody tr', { hasText: 'ID 20' });
  await row.getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Revoke (expire now)' }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.locator('.toast').last()).toContainText('Auth key revoked');
  // Without a user to fall back on, the error is shown.
  await mock('fail', { path: '^/api/v1/preauthkey/expire$', status: 500, message: 'expire failed' });
  await page.locator('tbody tr', { hasText: 'ID 21' }).getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Revoke (expire now)' }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.locator('.toast').last()).toContainText('expire failed');

  // Listing keys per user when the unscoped list isn't supported.
  await mock('fail', { path: '^/api/v1/preauthkey$', method: 'GET', status: 400, message: 'user required' });
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'General', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'Auth keys', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toBeVisible();

  // API keys: expire by prefix, delete by prefix.
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'API keys', exact: true }).click();
  const old = page.locator('tbody tr', { hasText: 'legacy01' });
  await mock('fail', { path: '^/api/v1/apikey/expire$', status: 400, message: 'id not supported' });
  await old.getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Expire', exact: true }).click();
  await page.getByRole('button', { name: 'Expire key', exact: true }).click();
  await expect(old).toContainText('Expired');
  await mock('fail', { path: '^/api/v1/apikey/expire$', status: 500, message: 'expire broken' });
  await page.locator('tbody tr', { hasText: 'odd' }).getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Expire', exact: true }).click();
  await page.getByRole('button', { name: 'Expire key', exact: true }).click();
  await expect(page.locator('.toast').last()).toContainText('expire broken');
  await mock('fail', { path: '^/api/v1/apikey/$', method: 'DELETE', status: 404, message: 'old server' });
  await old.getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete key', exact: true }).click();
  await expect(old).toHaveCount(0);

  // Registering by auth ID falls back to /node/register on servers before 0.29.
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'Device approval', exact: true }).click();
  await mock('fail', { path: '^/api/v1/auth/register$', status: 404, message: 'no such route' });
  await page.getByLabel('Login URL or auth ID', { exact: true }).fill('legacy-key');
  await page.getByRole('button', { name: 'Register device' }).click();
  await expect(page.locator('.callout-success')).toContainText('Device registered');
});

test('auth key for a user from the users page, required fields and chips', async ({ login, page }) => {
  await login({ to: '#/users' });
  await page.locator('#main').getByRole('button', { name: 'Add user' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('dialog')).toContainText('Username is required.');
  await page.keyboard.press('Escape');

  await page.locator('tr', { hasText: 'bob' }).first().getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Create auth key…' }).click();
  const d = page.getByRole('dialog', { name: 'Generate auth key' });
  await expect(d.getByLabel('Owner', { exact: true })).toHaveValue('2');
  const chips = d.locator('.chip-input-field');
  await chips.fill('tag:a, tag:b');
  await chips.press('Enter');
  await expect(d.locator('.chip')).toHaveCount(2);
  await d.getByRole('button', { name: 'Remove tag:a' }).click();
  await chips.press('Backspace');
  await expect(d.locator('.chip')).toHaveCount(0);
  await chips.fill('web');
  await chips.blur();
  await expect(d.locator('.chip')).toHaveText(['tag:web']);
  await d.getByRole('button', { name: 'Generate key', exact: true }).click();
  await expect(d).toContainText('hskey-auth-');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('tbody')).toContainText('bob');
});

test('browser fallbacks: clipboard without the API, broken pictures, bad stored data', async ({ login, page, mock }) => {
  await page.addInitScript(() => {
    localStorage.setItem('hsconsole:machines.sort', '{not json');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('insecure')), readText: () => Promise.resolve('') } });
    document.execCommand = () => true;
  });
  const { users } = await mock('state');
  await login({ to: '#/machines' });
  await page.locator('tr', { hasText: 'laptop' }).getByRole('button', { name: 'Copy addresses' }).click();
  await page.getByRole('menuitem', { name: '100.64.0.1' }).click();
  await expect(page.locator('.toast').last()).toContainText('Copied');

  await mock('set', { users: [{ ...users[0], profilePicUrl: 'http://127.0.0.1:9/missing.png' }, users[1]] });
  await page.evaluate(() => { location.hash = '#/users'; });
  await expect(page.locator('tr', { hasText: 'Alice Doe' }).locator('img')).toHaveCount(0);
  await expect(page.locator('tr', { hasText: 'Alice Doe' }).locator('.avatar')).toBeVisible();
});
