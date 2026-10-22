import { expect, test } from '../support/fixtures.js';
test('probe', async ({ login, page }) => {
  page.on('console', (m) => console.log('PAGE:', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('PAGEERR:', e.message));
  await login({ to: '#/acls' });
  await page.getByLabel('Policy file editor').fill('');
  await page.getByRole('tab', { name: 'Visual editor', exact: true }).click();
  const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Hosts', exact: true }) });
  await card.getByRole('button', { name: 'Add host' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Name', { exact: true }).fill('nas');
  await d.getByLabel('Address or subnet').fill('10.0.0.1');
  await d.getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('tab', { name: 'Policy file', exact: true }).click(); console.log('EDITOR', JSON.stringify(await page.getByLabel('Policy file editor').inputValue()));
  console.log('DIALOGS', await page.getByRole('dialog').count(), await page.locator('#main').innerText());
});
