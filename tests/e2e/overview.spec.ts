import { expect, test } from '../support/fixtures.js';

test.describe('overview and app shell', () => {
  test('lists what needs attention', async ({ login, page }) => {
    await login();
    const items = page.locator('.attention');
    await expect(items).toHaveCount(6);
    await expect(page.locator('.attention-list')).toContainText('1 machine waiting for route approval');
    await expect(page.locator('.attention-list')).toContainText('old-phone: key expired');
    await expect(page.locator('.attention-list')).toContainText(/server: key expires in \d days/);
    await expect(page.locator('.attention-list')).toContainText('1 machine not seen for over 30 days');
    await expect(page.locator('.attention-list')).toContainText(/This console's API key expires in \d days/);
    await expect(page.locator('.attention-list')).toContainText('Headscale 0.30.1 is available (running 0.29.5)');
    await expect(page.locator('.stat-row')).toContainText('4Machines2 connected');
    await expect(page.locator('.nav-badge')).toHaveText('3'); // 10.0.0.0/8, 0.0.0.0/0, ::/0
    await items.filter({ hasText: 'route approval' }).click();
    await expect(page.locator('h1')).toHaveText('Routes');
  });

  test('flags tags missing from the policy, and says when all is well', async ({ login, page, mock }) => {
    await mock('reset');
    const st = await mock('state');
    st.nodes[0].tags = ['tag:ghost'];
    await mock('set', { nodes: st.nodes });
    await login();
    await expect(page.locator('.attention-list')).toContainText('1 tag in use but not in tagOwners');
    await expect(page.locator('.attention-list')).toContainText('tag:ghost');

    const now = Date.now();
    for (const n of st.nodes) { n.expiry = '0001-01-01T00:00:00Z'; n.online = true; n.tags = []; n.availableRoutes = []; }
    st.apiKeys[0].expiration = new Date(now + 400 * 86400e3).toISOString();
    await mock('set', { nodes: st.nodes, apiKeys: st.apiKeys, releases: [] });
    await page.reload();
    await expect(page.locator('.callout-success')).toContainText('Nothing needs attention');
  });

  test('an unreadable policy and missing releases still render', async ({ login, page, mock }) => {
    await mock('reset');
    await mock('set', { policy: '{ broken' });
    await login({ server: 'bare' }); // can't reach GitHub
    await expect(page.locator('.attention-list')).not.toContainText('tagOwners');
    await expect(page.locator('.attention-list')).not.toContainText('is available');
  });

  test('shows an error when the tailnet can\'t be loaded', async ({ login, page, mock }) => {
    await login({ to: '#/machines' });
    await mock('fail', { path: '^/api/v1/user$', status: 500, message: 'database is locked' });
    await page.evaluate(() => { location.hash = '#/overview'; });
    await expect(page.locator('.callout-error')).toContainText('database is locked');
  });

  test('theme menu, keyboard shortcuts and skip link', async ({ login, page }) => {
    await login();
    await page.getByRole('button', { name: 'Change theme' }).click();
    await page.getByRole('menuitem', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Change theme' }).click();
    await page.getByRole('menuitem', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Change theme' }).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.getByRole('menuitem', { name: 'System' }).click();

    const go = async (key: string, title: string): Promise<void> => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('g');
      await page.keyboard.press(key);
      await expect(page.locator('h1')).toHaveText(title);
    };
    await go('m', 'Machines');
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search machines' })).toBeFocused();
    await page.keyboard.press('Escape');
    await go('u', 'Users');
    await go('r', 'Routes');
    await go('a', 'Access controls');
    await go('d', 'DNS');
    await go('l', 'Logs');
    await go('h', 'Audit log');
    await go('s', 'Settings');
    await go('k', 'Settings');
    await go('o', 'Overview');
    await page.keyboard.press('x'); // not a shortcut: nothing happens
    await page.keyboard.press('Control+g');

    await page.evaluate(() => { location.hash = '#/nowhere'; });
    await expect(page).toHaveURL(/#\/overview$/);
    await page.evaluate(() => { location.hash = '#/login'; });
    await expect(page).toHaveURL(/#\/overview$/); // already signed in
    await page.getByRole('link', { name: 'Skip to content' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'API keys' }).click();
    await expect(page).toHaveURL(/#\/settings\/api-keys$/);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Server settings' }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('a dropped upstream connection is explained', async ({ login, page, mock }) => {
    await login();
    await mock('fail', { path: '^/api/v1/node/1$', status: 0 });
    await page.evaluate(() => { location.hash = '#/ssh/1'; });
    await expect(page.locator('.callout-error')).toContainText('Could not reach Headscale');
  });

  test('a page that throws shows the error instead of a blank screen', async ({ login, page }) => {
    await login({ remember: true });
    // Signing back in works, but the machine list can't be fetched, and this page doesn't catch that itself.
    await page.route('**/proxy/api/v1/node', (r) => r.abort());
    await page.evaluate(() => { location.hash = '#/settings/devices'; });
    await page.reload();
    await expect(page.locator('.page .callout-error')).toContainText('Network error');
  });
});
