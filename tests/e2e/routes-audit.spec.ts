import fs from 'node:fs/promises';
import { expect, test } from '../support/fixtures.js';

test.describe('routes', () => {
  test('exit nodes and subnets, approval, the pending view and HA', async ({ login, page, mock }) => {
    const { nodes } = await mock('state');
    await login({ to: '#/routes' });
    await expect(page.getByRole('tab', { name: /All routes/ })).toContainText('3');
    await expect(page.getByRole('tab', { name: /Awaiting approval/ })).toContainText('2');
    const exit = page.locator('section', { hasText: 'Exit nodes' });
    await expect(exit).toContainText('Awaiting approval');
    await expect(page.locator('tr', { hasText: '192.168.1.0/24' })).toContainText('Primary');

    await page.getByRole('tab', { name: /Awaiting approval/ }).click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await page.getByRole('switch', { name: 'Allow exit node' }).click();
    await expect(page.getByRole('switch', { name: 'Allow exit node' })).toHaveCount(0);
    await page.getByRole('switch', { name: 'Approve 10.0.0.0/8' }).click();
    await expect(page.locator('.empty-title')).toHaveText('All caught up');
    await page.getByRole('tab', { name: /All routes/ }).click();
    await expect(exit).toContainText('Allowed');

    // A second approved router for 192.168.1.0/24 makes it highly available; a
    // pre-approved route the machine no longer advertises shows as such.
    const second = { ...nodes[1], id: '9', givenName: 'router-2', online: false, availableRoutes: ['192.168.1.0/24'], approvedRoutes: ['192.168.1.0/24', '172.16.0.0/12'], subnetRoutes: [] };
    await mock('set', { nodes: [...(await mock('state')).nodes, second] });
    await page.evaluate(() => { location.hash = '#/dns'; });
    await page.evaluate(() => { location.hash = '#/routes'; });
    await expect(page.locator('tr', { hasText: '192.168.1.0/24' })).toContainText('HA');
    await expect(page.locator('tr.grouped')).toContainText('Standby');
    await expect(page.locator('tr', { hasText: '172.16.0.0/12' })).toContainText('Not advertised');
    await page.getByRole('switch', { name: 'Approve 172.16.0.0/12' }).click();
    await expect(page.locator('tr', { hasText: '172.16.0.0/12' })).toHaveCount(0);

    // An exit node approved before it was advertised.
    await mock('set', { nodes: [{ ...nodes[0], availableRoutes: [], approvedRoutes: ['0.0.0.0/0', '::/0'] }] });
    await page.evaluate(() => { location.hash = '#/dns'; });
    await page.evaluate(() => { location.hash = '#/routes'; });
    await expect(page.locator('section', { hasText: 'Exit nodes' })).toContainText('Allowed');

    await mock('set', { nodes: [nodes[0]] });
    await page.evaluate(() => { location.hash = '#/dns'; });
    await page.evaluate(() => { location.hash = '#/routes'; });
    await expect(page.locator('.empty-title')).toHaveText('No routes advertised');

    await page.evaluate(() => { location.hash = '#/dns'; });
    await mock('fail', { path: '^/api/v1/node$', message: 'nodes unavailable', times: 99 });
    await page.evaluate(() => { location.hash = '#/routes'; });
    await expect(page.locator('.callout-error')).toContainText('nodes unavailable');
    await mock('set', { fail: [] });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.empty-title')).toHaveText('No routes advertised');
  });
});

test.describe('audit log', () => {
  test('records changes made in the console, with search, filter and export', async ({ login, page, mock }) => {
    await login({ to: '#/users' });
    const addUser = page.locator('#main').getByRole('button', { name: 'Add user' });
    await addUser.click();
    await page.getByRole('dialog').getByLabel('Username').fill('audited');
    await page.getByRole('dialog').getByRole('button', { name: 'Add user' }).click();
    await expect(page.locator('.toast').last()).toContainText('created');
    await mock('fail', { path: '^/api/v1/user$', method: 'POST', message: 'nope' });
    await addUser.click();
    await page.getByRole('dialog').getByLabel('Username').fill('failing');
    await page.getByRole('dialog').getByRole('button', { name: 'Add user' }).click();
    await expect(page.getByRole('dialog')).toContainText('nope');
    await page.keyboard.press('Escape');

    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page.locator('h1')).toHaveText('Audit log');
    await expect(page.locator('tbody')).toContainText('Created user audited');
    await expect(page.locator('tbody')).toContainText('Created user failing');
    await page.getByLabel('Only failed changes').check();
    await expect(page.locator('tbody')).not.toContainText('Created user audited');
    await expect(page.locator('tr', { hasText: 'Created user failing' })).toContainText('500');
    await page.getByLabel('Only failed changes').uncheck();

    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const csv = await fs.readFile((await (await downloaded).path())!, 'utf8');
    expect(csv.split('\n')[0]).toBe('time,actor,ip,method,path,status,change,details');
    expect(csv).toContain('Created user audited');

    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('no-such-change');
    await expect(page.locator('.empty-title')).toHaveText('No matching changes');
    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('tbody')).toContainText('Created user audited');
  });

  test('describes every kind of change', async ({ login, page }) => {
    const e = (method: string, path: string, summary: Record<string, unknown> = {}, status = 200) =>
      ({ at: new Date().toISOString(), actor: 'TESTKEY0001', ip: '127.0.0.1', method, path: `/api/v1/${path}`, status, summary });
    const entries = [
      e('PUT', 'policy'), e('POST', 'user', { name: 'x' }), e('POST', 'user'), e('POST', 'user/1/rename/new%20name'), e('DELETE', 'user/7'),
      e('POST', 'node/1/rename/web'), e('POST', 'node/1/tags', { tags: ['tag:a', 'tag:b'] }), e('POST', 'node/1/tags', { tags: [] }), e('POST', 'node/1/tags'),
      e('POST', 'node/2/approve_routes', { routes: ['10.0.0.0/8'] }), e('POST', 'node/2/approve_routes', { routes: [] }), e('POST', 'node/2/approve_routes'),
      e('POST', 'node/3/expire', { disableExpiry: true }), e('POST', 'node/3/expire', { expiry: '2030-01-01' }), e('POST', 'node/3/expire'),
      e('DELETE', 'node/4'), e('POST', 'node/register', { user: 'bob' }), e('POST', 'node/register'), e('POST', 'node/backfillips'),
      e('POST', 'auth/register', { user: 'bob' }), e('POST', 'auth/register'), e('POST', 'auth/approve'), e('POST', 'auth/reject'),
      e('POST', 'preauthkey', { user: '1', reusable: true, ephemeral: true }), e('POST', 'preauthkey'),
      e('POST', 'preauthkey/expire', { id: '5' }), e('POST', 'preauthkey/expire'), e('DELETE', 'preauthkey', { id: '5' }), e('DELETE', 'preauthkey'),
      e('POST', 'apikey'), e('POST', 'apikey/expire', { prefix: 'ABC' }), e('POST', 'apikey/expire', { id: '3' }), e('POST', 'apikey/expire'),
      e('DELETE', 'apikey/ABC', { id: '4' }), e('DELETE', 'apikey/ABC'), e('POST', 'policy/check'), e('PATCH', 'something/else', {}, 403),
    ];
    await page.route('**/console/audit?*', (route) => route.fulfill({ json: { entries } }));
    await login({ to: '#/audit' });
    const text = await page.locator('tbody').innerText();
    for (const s of [
      'Updated the access control policy', 'Created user x', 'Renamed user to new name', 'Deleted user 7', 'Renamed machine 1 to web',
      'Set tags on machine 1: tag:a, tag:b', 'Set tags on machine 1: none', 'Set approved routes on machine 2: 10.0.0.0/8',
      'Set approved routes on machine 2: none', 'Disabled key expiry on machine 3', 'Set key expiry on machine 3', 'Expired the key of machine 3',
      'Removed machine 4', 'Registered a machine for bob', 'Backfilled machine IP addresses', 'Approved an authentication request',
      'Rejected an authentication request', 'Created an auth key for user 1 (reusable) (ephemeral)', 'Revoked auth key 5', 'Deleted auth key 5',
      'Created an API key', 'Expired API key ABC', 'Expired API key 3', 'Deleted API key 4', 'Deleted API key ABC', 'Validated a policy',
      'PATCH /api/v1/something/else',
    ]) expect(text).toContain(s);
  });

  test('is explained when it is off, and a failed load can be retried', async ({ login, page }) => {
    await login({ server: 'open', to: '#/audit' });
    await expect(page.locator('.callout')).toContainText('The audit log is off');

    let fail = true;
    await page.route('**/console/audit?*', (route) => (fail
      ? route.fulfill({ status: 500, json: { message: 'audit unavailable' } })
      : route.fulfill({ json: {} })));
    await login({ to: '#/audit' });
    await expect(page.locator('.callout-error')).toContainText('audit unavailable');
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.empty-title')).toHaveText('No changes yet');
  });
});
