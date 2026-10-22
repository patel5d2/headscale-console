import { expect, test } from '../support/fixtures.js';

test.describe('machines list', () => {
  test('search, filter, sort and copy addresses', async ({ login, page }) => {
    await login({ to: '#/machines' });
    const rows = page.locator('tbody tr');
    await expect(page.locator('.list-meta')).toHaveText('4 machines · 2 connected');
    await expect(rows).toHaveCount(4);
    const badges = page.locator('tr', { hasText: 'router' }).locator('.badges');
    await expect(badges).toContainText('Exit Node');
    await expect(badges).toContainText('Subnets');
    await expect(badges).toContainText('1 pending');
    await expect(badges).toContainText('Expiry disabled');
    await expect(badges).toContainText('tag:router');
    await expect(page.locator('tr', { hasText: 'old-phone' })).toContainText('Expired');
    await expect(page.locator('tr', { hasText: 'old-phone' })).toContainText('Ephemeral');
    await expect(page.locator('tr', { hasText: 'server' }).first()).toContainText(/Expires in \d days/);

    const search = page.getByRole('searchbox', { name: 'Search machines' });
    await search.fill('192.168.1.0');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('.list-meta')).toHaveText('Showing 1 of 4 machines');
    await search.fill('nothing-matches');
    await expect(page.locator('.empty-title')).toHaveText('No matching machines');
    await search.fill('');

    const filter = async (label: string): Promise<void> => {
      await page.getByRole('button', { name: 'Filters' }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    };
    const expectNames = async (names: string[]): Promise<void> => {
      await expect(page.locator('tbody .machine-name a')).toHaveText(names);
    };
    await filter('Connected'); await expectNames(['laptop', 'router']);
    await filter('Connected'); // toggles off
    for (const [label, names] of [
      ['Disconnected', ['old-phone', 'server']], ['Key expired', ['old-phone']], ['Expiring soon', ['server']],
    ] as const) { await filter(label); await expectNames([...names]); await filter(label); }
    for (const [label, names] of [
      ['Exit nodes', ['router']], ['Subnet routers', ['router']], ['Pending route approval', ['router']],
      ['Key expiry disabled', ['router']], ['Ephemeral', ['old-phone']],
    ] as const) { await filter(label); await expectNames([...names]); await filter(label); }
    await filter('Alice Doe'); await expectNames(['laptop']);
    await expect(page.locator('.filter-chips')).toContainText('Owner: Alice Doe');
    await page.getByRole('button', { name: 'Remove filter Owner: Alice Doe' }).click();
    await filter('tag:router'); await filter('Key expired');
    await expect(page.locator('.empty-title')).toHaveText('No matching machines');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows).toHaveCount(4);

    const sortBy = (label: string) => page.getByRole('button', { name: label, exact: true }).click();
    await sortBy('Machine'); await expectNames(['server', 'router', 'old-phone', 'laptop']);
    await sortBy('Addresses'); await expectNames(['laptop', 'router', 'server', 'old-phone']);
    await sortBy('Registered via');
    await sortBy('Last seen'); await expect(page.locator('tbody .machine-name a').first()).toHaveText('server');
    await sortBy('Last seen'); await expect(page.locator('tbody .machine-name a').first()).toHaveText(/laptop|router/);

    await page.locator('tr', { hasText: 'laptop' }).getByRole('button', { name: 'Copy addresses' }).click();
    await expect(page.getByRole('menu')).toContainText('fd7a:115c:a1e0::1');
    await page.getByRole('menuitem', { name: '100.64.0.1' }).click();
    await expect(page.locator('.toast')).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('100.64.0.1');

    await page.locator('tr', { hasText: 'laptop' }).locator('td').nth(4).click();
    await expect(page.locator('h1')).toHaveText('laptop');
    await page.goBack();
    await page.locator('tr', { hasText: 'server' }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('h1')).toHaveText('server');
  });

  test('MagicDNS names and an empty tailnet', async ({ login, page, mock }) => {
    await login({ to: '#/dns' });
    await page.getByLabel('MagicDNS base domain').fill('tail.example.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.evaluate(() => { location.hash = '#/machines'; });
    await page.locator('tr', { hasText: 'laptop' }).getByRole('button', { name: 'Copy addresses' }).click();
    await expect(page.getByRole('menu')).toContainText('laptop.tail.example.com');
    await page.getByRole('menuitem', { name: /laptop short/ }).click();
    await mock('set', { nodes: [] });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.empty-title')).toHaveText('No machines yet');
    await page.locator('.empty').getByRole('button', { name: 'Add device' }).click();
    await expect(page.getByRole('dialog', { name: 'Add device' })).toBeVisible();
  });

  test('a failed refresh offers to try again', async ({ login, page, mock }) => {
    await login({ to: '#/machines' });
    await mock('fail', { path: '^/api/v1/node$', status: 500, message: 'database is locked' });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.callout-error')).toContainText('database is locked');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(4);
  });
});

test.describe('bulk actions', () => {
  const select = async (page: import('@playwright/test').Page, names: string[]): Promise<void> => {
    for (const n of names) await page.getByRole('checkbox', { name: `Select ${n}` }).check();
  };

  test('approve routes, tag, expire and remove several machines', async ({ login, page, mock }) => {
    await login({ to: '#/machines' });
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar).toBeHidden();
    await select(page, ['laptop', 'router']);
    await expect(bar).toContainText('2 machines selected');
    await expect(page.getByRole('checkbox', { name: 'Select all shown machines' })).toHaveJSProperty('indeterminate', true);

    await bar.getByRole('button', { name: 'Approve routes' }).click();
    await expect(page.getByRole('dialog')).toContainText('router: 10.0.0.0/8');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('.toast').first()).toContainText('Routes approved on 1 machine');
    expect((await mock('state')).nodes[1].approvedRoutes).toEqual(['192.168.1.0/24', '10.0.0.0/8', '0.0.0.0/0', '::/0']);

    await select(page, ['laptop', 'router']);
    await bar.getByRole('button', { name: 'Approve routes' }).click();
    await expect(page.locator('.toast').last()).toContainText('None of the selected machines');
    await bar.getByRole('button', { name: 'Tags…' }).click();
    const dlg = page.getByRole('dialog', { name: /Tags on 2 machines/ });
    await dlg.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.toast').last()).toContainText('Add at least one tag');
    await dlg.locator('.chip-input-field').fill('Bad Tag!');
    await dlg.getByRole('button', { name: 'Apply' }).click();
    await expect(dlg).toContainText('is not a valid tag');
    await dlg.locator('.chip-input-field').fill('web');
    await dlg.locator('.chip-input-field').press('Enter');
    await dlg.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.toast').last()).toContainText('Tags added on 2 machines');
    expect((await mock('state')).nodes[0].tags).toEqual(['tag:web']);

    await select(page, ['laptop']);
    await bar.getByRole('button', { name: 'Tags…' }).click();
    await page.getByRole('dialog').locator('select').selectOption('remove');
    await page.getByRole('dialog').locator('.chip-input-field').fill('tag:web');
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.toast').last()).toContainText('Tags removed on 1 machine');

    await page.getByRole('checkbox', { name: 'Select all shown machines' }).check();
    await expect(bar).toContainText('4 machines selected');
    await page.getByRole('checkbox', { name: 'Select all shown machines' }).uncheck();
    await expect(bar).toBeHidden();

    await select(page, ['server']);
    await bar.getByRole('button', { name: 'Disable expiry' }).click();
    await page.getByRole('button', { name: 'Disable expiry', exact: true }).last().click();
    await expect(page.locator('.toast').last()).toContainText('Key expiry disabled on 1 machine');

    await select(page, ['server', 'laptop']);
    await mock('fail', { path: '^/api/v1/node/3/expire$', status: 500, message: 'nope' });
    await bar.getByRole('button', { name: 'Expire keys' }).click();
    await page.getByRole('button', { name: 'Expire', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Failed on 1' })).toContainText('server: nope');

    await select(page, ['old-phone']);
    await bar.getByRole('button', { name: 'Remove…' }).click();
    await page.getByRole('dialog').locator('input').fill('1');
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(3);

    await select(page, ['laptop']);
    await bar.getByRole('button', { name: 'Clear selection' }).click();
    await expect(bar).toBeHidden();
  });
});
