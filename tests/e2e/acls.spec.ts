import fs from 'node:fs/promises';
import { expect, test } from '../support/fixtures.js';
import type { Page } from '@playwright/test';

const editor = (page: Page) => page.getByLabel('Policy file editor');
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
const status = (page: Page) => page.locator('.ed-status');
const save = (page: Page) => page.locator('.page-actions').getByRole('button', { name: 'Save' });
const lastToast = (page: Page) => page.locator('.toast').last();

const RICH = JSON.stringify({
  groups: { 'group:admins': ['alice@'] },
  tagOwners: { 'tag:router': ['group:admins'] },
  hosts: { nas: '192.168.1.10' },
  acls: [
    { action: 'accept', src: ['group:admins'], dst: ['*:*'] },
    { action: 'accept', src: ['tag:router'], proto: 'udp', dst: ['nas:53'] },
  ],
  grants: [
    { src: ['group:admins'], dst: ['tag:router'], ip: ['*'] },
    { src: ['alice@'], dst: ['nas'], app: { 'example.com/cap': [] }, via: ['tag:router'] },
  ],
  ssh: [{ action: 'check', src: ['group:admins'], dst: ['autogroup:self'], users: ['root'] }],
  autoApprovers: { routes: { '10.0.0.0/8': ['tag:router'] }, exitNode: ['tag:router'] },
  nodeAttrs: [{ target: ['*'], attr: ['funnel'] }],
}, null, 2);

test.describe('access controls', () => {
  test('policy file editing, validation, saving and files', async ({ login, page, mock }) => {
    await login({ to: '#/acls' });
    await expect(status(page)).toContainText('Saved · last updated');
    await expect(save(page)).toBeDisabled();

    // Keys: Enter keeps indentation, Tab indents, Shift+Tab outdents a selection.
    await editor(page).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('{');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(status(page)).toContainText('Syntax error');
    await expect(save(page)).toBeDisabled();
    await page.getByRole('button', { name: 'Go to line' }).click();
    await page.keyboard.press('Control+s'); // nothing to save while invalid
    await page.getByRole('button', { name: 'Format', exact: true }).click();
    await expect(lastToast(page)).toContainText('Fix the syntax error before formatting');
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(lastToast(page)).toContainText('Syntax error on line');
    await page.getByRole('button', { name: 'Add rules' }).click();
    await page.getByRole('button', { name: /Ping between all devices/ }).click();
    await expect(lastToast(page)).toContainText('Fix the policy\'s syntax before adding rules');
    await page.keyboard.press('Escape');
    await editor(page).fill('"just a string"');
    await expect(status(page)).toContainText('Unsaved changes');
    await page.getByRole('button', { name: 'Add rules' }).click();
    await page.getByRole('button', { name: /Ping between all devices/ }).click();
    await expect(lastToast(page)).toContainText('Fix the policy\'s syntax before adding rules');
    await page.keyboard.press('Escape');

    // Discard, then format a policy with comments (asks first).
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(status(page)).toContainText('Saved');
    await page.getByRole('button', { name: 'Format', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor(page)).toHaveValue(/\/\/ Admins/);
    await page.getByRole('button', { name: 'Format', exact: true }).click();
    await page.getByRole('button', { name: 'Format anyway' }).click();
    await expect(editor(page)).not.toHaveValue(/\/\//);
    await page.getByRole('button', { name: 'Format', exact: true }).click(); // no comments: no question
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));

    // Validation on the server.
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(lastToast(page)).toContainText('Policy is valid');
    await editor(page).fill('{"INVALID": true}');
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByRole('dialog', { name: 'Policy has errors' })).toContainText('unknown field');
    await page.getByRole('button', { name: 'OK' }).click();
    await mock('fail', { path: '/policy/check$', status: 404, message: 'not found' });
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(lastToast(page)).toContainText('cannot validate without saving');

    // Saving: rejected (file mode), rejected (other), then saved with Ctrl+S.
    await mock('fail', { path: '^/api/v1/policy$', method: 'PUT', status: 400, message: 'update is disabled for modes other than "database"' });
    await save(page).click();
    await expect(page.getByRole('dialog')).toContainText('Policy is managed by a file');
    await page.getByRole('button', { name: 'OK' }).click();
    await save(page).click();
    await expect(page.getByRole('dialog')).toContainText('unknown field');
    await expect(page.getByRole('dialog')).not.toContainText('managed by a file');
    await page.getByRole('button', { name: 'OK' }).click();
    await editor(page).fill('{ "acls": [] }');
    await page.keyboard.press('Control+s');
    await expect(lastToast(page)).toContainText('Policy saved and applied');
    expect((await mock('state')).policy).toBe('{ "acls": [] }');
    await page.keyboard.press('Control+s'); // nothing changed

    // Download and import.
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download policy' }).click();
    expect(await fs.readFile((await (await downloaded).path())!, 'utf8')).toBe('{ "acls": [] }');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import policy file' }).click();
    await (await chooser).setFiles({ name: 'mine.hujson', mimeType: 'text/plain', buffer: Buffer.from('{ "groups": {} }') });
    await expect(lastToast(page)).toContainText('Loaded mine.hujson');
    await expect(editor(page)).toHaveValue('{ "groups": {} }');
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  });

  test('templates, prebuilt rules and an empty policy', async ({ login, page, mock }) => {
    await mock('reset');
    await mock('set', { policy: null });
    await login({ to: '#/acls' });
    await expect(page.locator('.callout-info')).toContainText('No policy yet');
    await expect(status(page)).toContainText('No policy set');
    await page.getByRole('button', { name: 'Start from a template' }).click();
    await page.getByRole('button', { name: /Allow all/ }).click();
    await expect(editor(page)).toHaveValue(/"\*:\*"/);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: /Allow all/ }).click(); // same text: no question
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: /Homelab/ }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: /Homelab/ }).click();
    await page.getByRole('button', { name: 'Replace' }).click();
    await expect(editor(page)).toHaveValue(/group:admins/);

    // Prebuilt rules ask before dropping comments, and merge into the policy.
    await page.getByRole('button', { name: 'Add rules' }).click();
    await page.getByRole('button', { name: /Admins SSH into servers/ }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: /Admins SSH into servers/ }).click();
    await page.getByRole('button', { name: 'Add anyway' }).click();
    await expect(lastToast(page)).toContainText('Added "Admins SSH into servers"');
    await expect(editor(page)).toHaveValue(/"ssh"/);

    await editor(page).fill('');
    await page.getByRole('button', { name: 'Add rules' }).click();
    await page.getByRole('button', { name: /Ping between all devices/ }).click();
    await expect(editor(page)).toHaveValue(/icmp/);
  });

  test('a policy that cannot be loaded shows the error', async ({ login, page, mock }) => {
    await login({ to: '#/users' });
    await mock('fail', { path: '^/api/v1/policy$', method: 'GET', message: 'policy backend down' });
    await page.evaluate(() => { location.hash = '#/acls'; });
    await expect(page.locator('.callout-error')).toContainText('policy backend down');
  });

  test('visual editor: rules, SSH rules, groups, tag owners and hosts', async ({ login, page, mock }) => {
    await login({ to: '#/acls' });
    await tab(page, 'Visual editor');
    const card = (title: string) => page.locator('section.card', { has: page.getByRole('heading', { name: title, exact: true }) });
    const d = page.getByRole('dialog');
    const apply = () => d.getByRole('button', { name: 'Apply' }).click();

    // The first change asks before dropping comments.
    await card('Access rules').getByRole('button', { name: 'Add rule' }).click();
    await apply();
    await expect(d).toContainText('Sources needs at least one entry');
    await d.locator('.chip-input-field').nth(0).fill('group:admins');
    await apply();
    await expect(d).toContainText('Destinations needs at least one entry');
    await d.locator('.chip-input-field').nth(1).fill('tag:router');
    await d.getByLabel('Protocol').selectOption('tcp');
    await apply();
    await page.getByRole('dialog', { name: 'Remove comments?' }).getByRole('button', { name: 'Cancel' }).click(); // keep comments
    await expect(card('Access rules').locator('tbody tr')).toHaveCount(2);
    await card('Access rules').getByRole('button', { name: 'Add rule' }).click();
    await d.locator('.chip-input-field').nth(0).fill('group:admins');
    await d.locator('.chip-input-field').nth(1).fill('tag:router');
    await d.getByLabel('Protocol').selectOption('tcp');
    await apply();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(card('Access rules').locator('tbody tr')).toHaveCount(3);
    await expect(card('Access rules').locator('tbody tr').last()).toContainText('tag:router:*');
    await expect(card('Access rules').locator('tbody tr').last()).toContainText('tcp');

    const rowMenu = async (title: string, row: number, item: string) => {
      await expect(page.getByRole('dialog')).toHaveCount(0); // closing dialogs linger briefly
      await card(title).locator('tbody tr').nth(row).getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: item }).click();
    };
    await rowMenu('Access rules', 2, 'Edit…');
    await d.locator('.chip-input-field').nth(1).fill('*');
    await d.getByLabel('Protocol').selectOption('');
    await apply();
    await expect(card('Access rules').locator('tbody tr').last()).toContainText('*:*');
    await rowMenu('Access rules', 2, 'Delete');
    await expect(card('Access rules').locator('tbody tr')).toHaveCount(2);

    // SSH rules: add, switch check → accept, delete.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card('SSH rules').getByRole('button', { name: 'Add SSH rule' }).click();
    await d.getByLabel('Mode').selectOption('check');
    await d.locator('.chip-input-field').nth(0).fill('group:admins');
    await d.locator('.chip-input-field').nth(1).fill('tag:router');
    await apply();
    await expect(card('SSH rules').locator('tbody tr')).toHaveCount(2);
    await expect(card('SSH rules').locator('tbody tr').last()).toContainText('check');
    await editor(page).count(); // the editor is not on this tab
    await rowMenu('SSH rules', 1, 'Edit…');
    await d.getByLabel('Mode').selectOption('accept');
    await apply();
    await expect(card('SSH rules').locator('tbody tr').last()).toContainText('accept');
    await rowMenu('SSH rules', 1, 'Edit…');
    await d.getByLabel('Mode').selectOption('check');
    await apply();
    await rowMenu('SSH rules', 1, 'Delete');
    await rowMenu('SSH rules', 0, 'Delete');
    await expect(card('SSH rules')).toContainText('None yet.');

    // Groups: the prefix is added, names are checked, duplicates refused.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card('Groups').getByRole('button', { name: 'Add group' }).click();
    await d.getByLabel('Group name').fill('bad name');
    await apply();
    await expect(d).toContainText('Enter a group name.');
    await d.getByLabel('Group name').fill('admins');
    await d.locator('.chip-input-field').fill('bob@');
    await apply();
    await expect(d).toContainText('group:admins already exists.');
    await d.getByLabel('Group name').fill('devs');
    await apply();
    await expect(card('Groups')).toContainText('group:devs');
    await rowMenu('Groups', 1, 'Edit…');
    await d.getByLabel('Group name').fill('group:developers');
    await apply();
    await expect(card('Groups')).toContainText('group:developers');
    await expect(card('Groups')).not.toContainText('group:devs');
    await rowMenu('Groups', 1, 'Edit…');
    await apply(); // same name
    await rowMenu('Groups', 1, 'Delete');
    await expect(card('Groups').locator('tbody tr')).toHaveCount(1);

    // Tag owners may be empty.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card('Tag owners').getByRole('button', { name: 'Add tag' }).click();
    await d.getByLabel('Tag').fill('web');
    await apply();
    await expect(card('Tag owners')).toContainText('tag:web');
    await rowMenu('Tag owners', 1, 'Delete');
    await rowMenu('Tag owners', 0, 'Delete');
    await expect(card('Tag owners')).toContainText('None yet.');

    // Hosts take one address.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card('Hosts').getByRole('button', { name: 'Add host' }).click();
    await d.getByLabel('Name', { exact: true }).fill('nas');
    await apply();
    await expect(d).toContainText('Enter an address or subnet.');
    await d.getByLabel('Address or subnet').fill('192.168.1.10');
    await apply();
    await expect(card('Hosts')).toContainText('192.168.1.10');
    for (const title of ['Hosts', 'Hosts', 'Groups', 'Access rules', 'Access rules']) await rowMenu(title, 0, 'Delete');
    await tab(page, 'Policy file');
    await expect(editor(page)).toHaveValue('{}\n');

    // Grants are kept; a syntax error blocks the visual editor.
    await editor(page).fill('{"grants": [{"src": ["*"], "dst": ["*"], "ip": ["*"]}]}');
    await tab(page, 'Visual editor');
    await expect(page.locator('.callout-info')).toContainText('1 grant(s)');
    await tab(page, 'Policy file');
    await editor(page).fill('{\n  "acls": [\n}');
    await tab(page, 'Visual editor');
    await expect(page.locator('.callout-error')).toContainText('Fix the syntax error in the policy file');
    await tab(page, 'Policy file');
    await editor(page).fill('{\n "a": 1 2\n}');
    await tab(page, 'Visual editor');
    await expect(page.locator('.callout-error')).toContainText('Fix the syntax error on line 2');
    await tab(page, 'Policy file');
    await editor(page).fill('');
    await tab(page, 'Visual editor');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card('Hosts').getByRole('button', { name: 'Add host' }).click();
    await d.getByLabel('Name', { exact: true }).fill('nas');
    await d.getByLabel('Address or subnet').fill('10.0.0.1');
    await apply();
    await expect(card('Hosts')).toContainText('10.0.0.1');
    expect((await mock('state')).policy).toContain('Admins reach everything'); // nothing saved
  });

  test('access checker, preview, tags and changes', async ({ login, page }) => {
    await login({ to: '#/acls' });
    await tab(page, 'Access checker');
    const out = page.locator('#main .callout');
    await expect(out.first()).toContainText('laptop can reach router on TCP 22');
    await expect(out.nth(1)).toContainText('SSH as root: not allowed');
    await page.getByLabel('From', { exact: true }).selectOption({ label: 'server — bob' });
    await page.getByLabel('To', { exact: true }).selectOption({ label: 'router — tag:router' });
    await expect(out.first()).toContainText('Blocked');
    await page.getByLabel('Port', { exact: true }).fill('');
    await page.getByLabel('Protocol', { exact: true }).selectOption('icmp');
    await page.getByLabel('SSH as').fill('');
    await expect(out.nth(1)).toContainText('SSH as root');
    await page.getByLabel('From', { exact: true }).selectOption({ label: 'laptop — Alice Doe' });
    await page.getByLabel('To', { exact: true }).selectOption({ label: 'laptop — Alice Doe' });
    await page.getByLabel('SSH as').fill('alice');
    await expect(out.nth(1)).toContainText('SSH as alice: allowed');

    // SSH allowed by a check rule, but no network rule opens port 22.
    await tab(page, 'Policy file');
    await editor(page).fill(JSON.stringify({ ssh: [{ action: 'accept', src: ['alice@'], dst: ['tag:router'], users: ['root'] }] }));
    await tab(page, 'Access checker');
    await page.getByLabel('To', { exact: true }).selectOption({ label: 'router — tag:router' });
    await expect(out.nth(1)).toContainText('allowed by SSH rules, but TCP 22 is blocked');
    await tab(page, 'Policy file');
    await editor(page).fill(JSON.stringify({ acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }], ssh: [{ action: 'check', src: ['alice@'], dst: ['autogroup:self'], users: ['root'] }] }));
    await tab(page, 'Access checker');
    await page.getByLabel('To', { exact: true }).selectOption({ label: 'laptop — Alice Doe' });
    await expect(page.locator('#main .callout-warning')).toContainText('SSH as root: allowed');
    await tab(page, 'Policy file');
    await editor(page).fill('');
    await tab(page, 'Access checker');
    await expect(out.first()).toContainText('can reach');
    await tab(page, 'Policy file');
    await editor(page).fill('{');
    await tab(page, 'Access checker');
    await expect(page.locator('.callout-error')).toContainText('Can\'t check');

    // Preview.
    await tab(page, 'Preview rules');
    await expect(page.locator('.callout-error')).toContainText('Can\'t preview');
    await tab(page, 'Policy file');
    await editor(page).fill('  ');
    await tab(page, 'Preview rules');
    await expect(page.locator('.callout-info')).toContainText('No policy');
    await tab(page, 'Policy file');
    await editor(page).fill(RICH);
    await tab(page, 'Preview rules');
    const main = page.locator('#main');
    for (const s of ['Network access rules', 'Grants', 'Tailscale SSH', 'Groups', 'Hosts', 'Auto approvers', 'Node attributes', 'app: example.com/cap', 'via: tag:router', 'Exit node', 'funnel']) {
      await expect(main).toContainText(s);
    }
    const show = page.getByLabel('Show rules for');
    await show.selectOption('u:bob');
    await expect(main).toContainText('No ACL rules apply.');
    await expect(main).toContainText('No grants apply.');
    await expect(main).toContainText('No SSH rules.');
    await show.selectOption('u:alice');
    await expect(main.locator('section', { hasText: 'Network access rules' }).locator('tbody tr')).toHaveCount(1);
    await show.selectOption('t:tag:router');
    await expect(main.locator('section', { hasText: 'Network access rules' })).toContainText('nas:53');
    await tab(page, 'Policy file');
    await editor(page).fill('{"acls": [{"action": "accept", "src": ["autogroup:member"], "dst": ["*:*"]}]}');
    await tab(page, 'Preview rules');
    await expect(main).toContainText('No SSH rules.');
    await page.getByLabel('Show rules for').selectOption('u:bob');
    await expect(main.locator('tbody tr')).toHaveCount(1);
    await tab(page, 'Policy file');
    await editor(page).fill('{}');
    await tab(page, 'Preview rules');
    await expect(main).toContainText('No ACL rules defined.');

    // Tags: one in use but missing from tagOwners, one defined but unused.
    await tab(page, 'Policy file');
    await editor(page).fill('{"tagOwners": {"tag:web": []}}');
    await tab(page, 'Tags');
    await expect(page.locator('tr', { hasText: 'tag:router' })).toContainText('Not in policy');
    await expect(page.locator('tr', { hasText: 'tag:web' })).toContainText('None');
    await tab(page, 'Policy file');
    await editor(page).fill('{');
    await tab(page, 'Tags');
    await page.locator('tr', { hasText: 'tag:router' }).getByRole('link', { name: '1 machine' }).click();
    await expect(page.locator('h1')).toHaveText('Machines');
    await expect(page.getByRole('searchbox', { name: 'Search machines' })).toHaveValue('tag:router');

    // Changes.
    await page.goBack();
    await tab(page, 'Changes');
    await expect(page.locator('.callout-info')).toContainText('No changes');
    await tab(page, 'Policy file');
    const long = Array.from({ length: 40 }, (_, i) => `// line ${i}`).join('\n');
    await editor(page).fill(`${long}\n{}\n${long}\n// changed`);
    await tab(page, 'Changes');
    await expect(page.locator('.diff')).toContainText('+ // changed');
    await expect(page.locator('.diff-gap').first()).toBeVisible();
    await tab(page, 'Policy file');
    await editor(page).fill(Array.from({ length: 2100 }, (_, i) => `// ${i}`).join('\n'));
    await tab(page, 'Changes');
    await expect(page.locator('.callout-info')).toContainText('Too large to compare here');
  });

  test('with no machines, the checker and tags explain why they are empty', async ({ login, page, mock }) => {
    await mock('reset');
    await mock('set', { nodes: [] });
    await login({ to: '#/acls' });
    await tab(page, 'Access checker');
    await expect(page.locator('.callout-info')).toContainText('No machines');
    await tab(page, 'Policy file');
    await editor(page).fill('{}');
    await tab(page, 'Tags');
    await expect(page.locator('.empty-title')).toHaveText('No tags defined');
  });

  test('history: versions, diff and restore', async ({ login, page, mock }) => {
    await login({ to: '#/acls' });
    await editor(page).fill('{ "acls": [] }');
    await save(page).click();
    await expect(lastToast(page)).toContainText('Policy saved');
    await page.waitForTimeout(100);
    await editor(page).fill('{ "acls": [], "groups": {} }');
    await save(page).click();
    await expect(lastToast(page)).toContainText('Policy saved');
    await page.waitForTimeout(100);
    await tab(page, 'History');
    await expect(page.locator('#main')).toContainText('saved versions, newest first');
    await expect(page.locator('tbody tr').first()).toContainText('Latest');
    await page.locator('tbody tr').first().getByRole('button', { name: 'View' }).click();
    await expect(page.locator('#main')).toContainText('This version matches the editor.');
    await page.locator('tbody tr').last().getByRole('button', { name: 'View' }).click();
    await expect(page.locator('#main')).toContainText('Admins reach everything');
    await page.getByRole('button', { name: 'Restore into editor' }).click();
    await expect(lastToast(page)).toContainText('Restored the version from');
    await expect(editor(page)).toHaveValue(/Admins reach everything/);
    expect((await mock('state')).policy).toBe('{ "acls": [], "groups": {} }');

    await page.route('**/console/policy-history/*', (route) => route.fulfill({ status: 404, json: { message: 'version not found' } }));
    await tab(page, 'History');
    await page.locator('tbody tr').first().getByRole('button', { name: 'View' }).click();
    await expect(page.locator('.callout-error')).toContainText('version not found');
    await page.route('**/console/policy-history', (route) => route.fulfill({ json: {} }));
    await tab(page, 'Policy file');
    await tab(page, 'History');
    await expect(page.locator('.empty-title')).toHaveText('No saved versions yet');
    await page.unroute('**/console/policy-history');
    await page.route('**/console/policy-history', (route) => route.fulfill({ status: 500, json: { message: 'history unavailable' } }));
    await tab(page, 'Policy file');
    await tab(page, 'History');
    await expect(page.locator('.callout-error')).toContainText('history unavailable');
  });

  test('history is off without a locked server', async ({ login, page }) => {
    await login({ server: 'open', to: '#/acls' });
    await tab(page, 'History');
    await expect(page.locator('.callout-info')).toContainText('Policy history is off');
  });
});
