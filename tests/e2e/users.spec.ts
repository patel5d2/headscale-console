import { expect, test } from '../support/fixtures.js';

test.describe('users', () => {
  test('list, search, create, rename and jump to machines', async ({ login, page, mock }) => {
    await login({ to: '#/users' });
    const rows = page.locator('tbody tr');
    await expect(page.locator('.list-meta')).toHaveText('2 users');
    await expect(rows.first()).toContainText('Alice Doe');
    await expect(rows.first()).toContainText('OIDC');
    await expect(rows.first()).toContainText('1 machine');
    await expect(rows.nth(1)).toContainText('Local');
    await expect(rows.nth(1)).toContainText('2 machines');

    const search = page.getByRole('searchbox', { name: 'Search users' });
    await search.fill('example.com');
    await expect(page.locator('.list-meta')).toHaveText('Showing 1 of 2');
    await search.fill('nobody');
    await expect(page.locator('.empty-title')).toHaveText('No matching users');
    await search.fill('');

    await page.getByRole('button', { name: 'Add user' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Username').fill('bad name!');
    await d.getByRole('button', { name: 'Add user' }).click();
    await expect(d).toContainText('Username may contain');
    await d.getByLabel('Username').fill('carol');
    await d.getByLabel('Display name').fill('Carol C');
    await d.getByLabel('Email').fill('carol@example.com');
    await d.getByLabel('Profile picture URL').fill('https://example.com/c.png');
    await d.getByRole('button', { name: 'Add user' }).click();
    await expect(page.locator('.toast').last()).toContainText('User Carol C created');
    await expect(page.locator('.list-meta')).toHaveText('3 users');
    await expect(page.locator('tr', { hasText: 'Carol C' })).toContainText('None');

    const carol = page.locator('tr', { hasText: 'Carol C' });
    await carol.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename user…' }).click();
    await d.getByRole('button', { name: 'Rename' }).click(); // unchanged name: nothing to send
    await expect(page.locator('.toast').last()).toContainText('User renamed');
    await carol.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename user…' }).click();
    await d.getByLabel('Username').fill('carol2');
    await d.getByRole('button', { name: 'Rename' }).click();
    await expect(carol).toContainText('carol2');

    const bob = page.locator('tr', { hasText: 'bob' }).first();
    await bob.getByRole('link', { name: /2 machines/ }).click();
    await expect(page.locator('h1')).toHaveText('Machines');
    await expect(page.getByRole('searchbox', { name: 'Search machines' })).toHaveValue('bob');
    await page.goBack();
    await bob.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'View machines' }).click();
    await expect(page.locator('h1')).toHaveText('Machines');
    await page.goBack();
    await bob.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Create auth key…' }).click();
    await expect(page).toHaveURL(/#\/settings\/keys$/);
    await page.goBack();
    await bob.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Add device for user…' }).click();
    await expect(page.getByRole('dialog', { name: 'Add device' })).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('Owner', { exact: true })).toHaveValue('2');
    await page.keyboard.press('Escape');
    expect((await mock('state')).users.map((u: { name: string }) => u.name)).toEqual(['alice', 'bob', 'carol2']);
  });

  test('delete users, with and without machines', async ({ login, page, mock }) => {
    await login({ to: '#/users' });
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByRole('dialog').getByLabel('Username').fill('temp');
    await page.getByRole('dialog').getByRole('button', { name: 'Add user' }).click();
    const temp = page.locator('tr', { hasText: 'temp' });
    await temp.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete user…' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await temp.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete user…' }).click();
    await page.getByRole('button', { name: 'Delete user', exact: true }).click();
    await expect(page.locator('.toast').last()).toContainText('temp deleted');
    await expect(temp).toHaveCount(0);

    // Bob owns two machines: they are removed first.
    const bob = page.locator('tr', { hasText: 'bob' }).first();
    await bob.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete user…' }).click();
    const d = page.getByRole('dialog');
    await expect(d).toContainText('server');
    await expect(d).toContainText('old-phone');
    await mock('fail', { path: '^/api/v1/node/4$', method: 'DELETE', message: 'cannot remove machine' });
    await d.locator('input').fill('bob');
    await d.getByRole('button', { name: 'Remove machines and delete user' }).click();
    await expect(d).toContainText('cannot remove machine');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(bob).toContainText('1 machine');
    await bob.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete user…' }).click();
    await d.locator('input').fill('bob');
    await d.getByRole('button', { name: 'Remove machines and delete user' }).click();
    await expect(page.locator('.toast').last()).toContainText('bob deleted');
    expect((await mock('state')).users.map((u: { name: string }) => u.name)).toEqual(['alice']);
  });

  test('a user with many machines, an empty list and a failed load', async ({ login, page, mock }) => {
    const state = await mock('state');
    const base = state.nodes[0];
    await login({ to: '#/users' });
    await mock('set', { nodes: Array.from({ length: 10 }, (_, i) => ({ ...base, id: String(50 + i), givenName: `m${i}`, online: false })) });
    await page.reload();
    const alice = page.locator('tr', { hasText: 'Alice Doe' });
    await expect(alice).toContainText('10 machines');
    await alice.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete user…' }).click();
    await expect(page.getByRole('dialog')).toContainText('…and 2 more');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await mock('set', { users: [], nodes: [] });
    await page.reload();
    await expect(page.locator('.empty-title')).toHaveText('No users yet');
    await page.locator('.empty').getByRole('button', { name: 'Add user' }).click();
    await page.getByRole('dialog').getByLabel('Username').fill('first');
    await page.getByRole('dialog').getByRole('button', { name: 'Add user' }).click();
    await expect(page.locator('.list-meta')).toHaveText('1 user');

    await page.evaluate(() => { location.hash = '#/dns'; });
    await mock('fail', { path: '^/api/v1/user$', method: 'GET', message: 'users unavailable', times: 99 });
    await page.evaluate(() => { location.hash = '#/users'; });
    await expect(page.locator('.callout-error')).toContainText('users unavailable');
    await mock('set', { fail: [] });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.list-meta')).toHaveText('1 user');
  });
});
