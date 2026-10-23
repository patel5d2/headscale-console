// Browser SSH against the fake WebAssembly client in tests/support/fake-ssh/.
import { expect, test } from '../support/fixtures.js';
import type { Page } from '@playwright/test';

const screen = (page: Page) => page.locator('.ssh-pane:not([hidden]) .xterm-rows');
const status = (page: Page) => page.getByRole('status');
const scenario = (page: Page, opt: Record<string, boolean>) => page.addInitScript((o) => { (window as unknown as { __fakeSsh: unknown }).__fakeSsh = o; }, opt);

test.describe('browser SSH', () => {
  test('connects, types, uses tabs and tools, and cleans up after itself', async ({ login, page, mock }) => {
    const { nodes } = await mock('state');
    await login({ to: '#/machines' });
    // A machine left by an earlier session is removed when the client starts.
    const stale = { ...nodes[3], id: '77', givenName: 'hsconsole-ssh-old', online: false, preAuthKey: { id: '1', key: '', ephemeral: true } };
    await mock('set', { nodes: [...nodes, stale] });
    await page.locator('tr', { hasText: 'laptop' }).getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'SSH…' }).click();
    await expect(page.locator('h1')).toHaveText('SSH to laptop');

    await page.getByLabel('Linux user').fill('Bad User!');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.callout-error')).toContainText('Enter a valid Linux user name.');
    await page.getByLabel('Linux user').fill('alice');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(status(page)).toHaveText('Connected as alice');
    await expect(screen(page)).toContainText('Welcome alice@100.64.0.1');
    const st = await mock('state');
    expect(st.nodes.some((n: { id: string }) => n.id === '77')).toBe(false);
    const temp = st.nodes.find((n: { givenName: string }) => n.givenName.startsWith('hsconsole-ssh-'));
    expect(temp).toBeTruthy();
    expect(st.keys.at(-1)).toMatchObject({ reusable: false, ephemeral: true });

    // The fake shell echoes what is typed and pasted.
    await page.keyboard.type('echo hi');
    await expect(screen(page)).toContainText('echo hi');
    await page.evaluate(() => navigator.clipboard.writeText('pasted-text'));
    await page.getByRole('button', { name: 'Paste' }).click();
    await expect(screen(page)).toContainText('pasted-text');
    await page.keyboard.press('Control+Shift+V');
    await page.keyboard.press('Control+Shift+C');
    await page.getByRole('button', { name: 'Copy' }).click();
    await page.evaluate(() => { navigator.clipboard.readText = () => Promise.reject(new Error('denied')); });
    await page.getByRole('button', { name: 'Paste' }).click();
    await expect(status(page)).toContainText('The browser blocked clipboard access');

    // Search and text size.
    const find = page.getByRole('searchbox', { name: 'Find in terminal' });
    await find.press('Enter'); // empty: nothing to find
    await find.fill('Welcome');
    await find.press('Enter');
    await expect(status(page)).toHaveText('');
    await find.press('Shift+Enter');
    await find.fill('no-such-text');
    await find.press('Enter');
    await expect(status(page)).toHaveText('"no-such-text" not found');
    await page.getByRole('button', { name: 'A+' }).click();
    await page.getByRole('button', { name: 'A−' }).click();
    expect(await page.evaluate(() => localStorage.getItem('hsconsole:ssh.fontSize'))).toContain('13');
    // Stubbed: real fullscreen would hide the rest of the page from the test.
    await page.evaluate(() => { Element.prototype.requestFullscreen = function () { document.body.dataset.fs = this.className; return Promise.resolve(); }; });
    await page.getByRole('button', { name: 'Fullscreen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-fs', 'ssh-term');

    // Tabs: a second session, switching, disconnect, reconnect, close.
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(screen(page)).toContainText('Welcome alice');
    await page.getByRole('tab').first().getByRole('button', { name: 'alice@laptop #1', exact: true }).click();
    await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(screen(page)).toContainText('[Session ended');
    await expect(status(page)).toHaveText('Session ended');
    await page.getByRole('button', { name: 'Disconnect' }).click(); // already closed
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(status(page)).toHaveText('Connected as alice');
    await page.getByRole('button', { name: 'Close alice@laptop #2' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
    await page.setViewportSize({ width: 900, height: 600 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fakeSshSize?: number[] }).__fakeSshSize)).toBeTruthy();

    // Switching the Headscale user needs a fresh client.
    await page.getByLabel('Connect as Headscale user').selectOption({ label: 'bob' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.callout-info')).toContainText('Reload to switch users');
    await page.getByLabel('Connect as Headscale user').selectOption({ label: 'Alice Doe' });
    await page.getByRole('button', { name: 'Close alice@laptop #1' }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);

    // A second visit reuses the running client.
    await page.getByRole('link', { name: 'Machine details' }).click();
    await page.evaluate(() => { location.hash = '#/ssh/1'; });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(status(page)).toHaveText('Connected as alice');
    await page.evaluate(() => { location.hash = '#/machines'; }); // closes the sessions

    // Leaving the page removes the temporary machine. (Fired directly: a real reload
    // would discard this page's coverage.)
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(async () => (await mock('state')).nodes.some((n: { givenName: string }) => n.givenName === temp.givenName)).toBe(false);
  });

  test('switching users reloads the page', async ({ login, page }) => {
    await login({ to: '#/ssh/1' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(status(page)).toHaveText('Connected as root');
    await page.getByLabel('Connect as Headscale user').selectOption({ label: 'bob' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Reload page' }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
  });

  for (const [name, opt, message] of [
    ['a crash', { panic: true }, 'The SSH client crashed: boom'],
    ['a rejected key', { rejectKey: true }, 'Headscale rejected the temporary key.'],
    ['machine approval', { machineAuth: true }, 'holding the temporary machine for approval'],
    ['an unreachable machine', { noPeers: true }, 'isn\'t visible to that user'],
    ['SSH turned off', { sshDisabled: true }, 'Tailscale SSH isn\'t turned on'],
  ] as const) {
    test(`explains ${name}`, async ({ login, page }) => {
      await scenario(page, opt);
      await login({ to: '#/ssh/1' });
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(page.locator('.callout-error')).toContainText(message);
    });
  }

  test('a refused SSH session and a client that exits', async ({ login, page }) => {
    await scenario(page, { sshError: true, exit: true });
    await login({ to: '#/ssh/1' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(screen(page)).toContainText('permission denied');
    await expect(status(page)).toHaveText('Session ended');
  });

  test('machines without an address, missing machines, and consoles without SSH', async ({ login, page, mock }) => {
    const { nodes } = await mock('state');
    await login({ to: '#/machines' });
    await mock('set', { nodes: [{ ...nodes[0], ipAddresses: [] }, ...nodes.slice(1)] });
    await page.evaluate(() => { location.hash = '#/ssh/1'; });
    await expect(page.locator('h1')).toHaveText('SSH to laptop');
    await expect(page.locator('#main')).toContainText('No IPv4 address');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.callout-error')).toContainText('This machine has no IPv4 address.');
    await page.evaluate(() => { location.hash = '#/ssh/404'; });
    await expect(page.locator('.callout-error')).toBeVisible();

    await login({ server: 'open', to: '#/ssh/1' });
    await expect(page.locator('#main')).toContainText('Browser SSH is not enabled');
    await expect(page.locator('#main')).toContainText('HEADSCALE_URL: "http://127.0.0.1:18281"');
    await login({ server: 'broken', to: '#/ssh/1' });
    await expect(page.locator('#main')).toContainText('Browser SSH is not enabled');
    await expect(page.locator('#main')).not.toContainText('HEADSCALE_URL:');
  });
});
