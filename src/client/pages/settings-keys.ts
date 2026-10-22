// Settings → Auth keys and Settings → API keys.
import type { ApiKey, PreAuthKey } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import {
  avatar, badge, button, callout, chipInput, clear, codeBlock, confirmDialog, emptyState, errorState, h, modal, moreButton, spinner, tabs, toast,
} from '../ui.js';
import { fmtDate, isoInDays, parseTime, relTime, store, userLabel } from '../util.js';
import { keyResult, serverUrl, tagNormalize } from './actions.js';

type KeyState = 'active' | 'used' | 'expired';
const created = (k: { createdAt?: string }): number => parseTime(k.createdAt)?.getTime() || 0;

export function keyStatus(k: PreAuthKey): KeyState {
  const exp = parseTime(k.expiration);
  if (exp && exp <= new Date()) return 'expired';
  if (k.used && !k.reusable) return 'used';
  return 'active';
}

export function maskKey(k: string | undefined): string {
  if (!k) return '—';
  if (k.includes('***')) return k.replace('***', '••••••');
  return k.length > 20 ? `${k.slice(0, 16)}••••••` : k;
}

// ---------------------------------------------------------------- auth keys --
export async function authKeys(ctx: Ctx, panel: HTMLElement): Promise<void> {
  let filter: KeyState | 'all' = 'active';
  let keys: PreAuthKey[] = [];
  const list = h('div');
  const tabsHost = h('div');
  const refresh = async (): Promise<void> => {
    clear(list).appendChild(h('div', { class: 'center pad-y' }, spinner(22)));
    try {
      const { users } = await ctx.load();
      keys = await ctx.api.listPreAuthKeys(users);
      draw();
    } catch (e) {
      clear(list).appendChild(errorState(e, () => void refresh()));
    }
  };
  const create = (): void => createAuthKey(ctx, () => void refresh());
  panel.append(
    h('div', { class: 'panel-head' },
      h('div', h('h2', 'Auth keys'), h('p', { class: 'help' }, 'Pre-authentication keys let you add devices without an interactive login.')),
      button('Generate auth key', { variant: 'primary', icon: 'plus', onClick: create })),
    tabsHost, list);

  function draw(): void {
    const counts: Record<KeyState, number> = { active: 0, used: 0, expired: 0 };
    keys.forEach((k) => counts[keyStatus(k)]++);
    clear(tabsHost).appendChild(tabs<KeyState | 'all'>([
      { id: 'active', label: 'Active', count: counts.active },
      { id: 'used', label: 'Used', count: counts.used },
      { id: 'expired', label: 'Expired', count: counts.expired },
      { id: 'all', label: 'All', count: keys.length },
    ], filter, (f) => { filter = f; draw(); }));

    const shown = keys.filter((k) => filter === 'all' || keyStatus(k) === filter).sort((a, b) => created(b) - created(a));
    clear(list);
    if (!shown.length) {
      list.appendChild(filter === 'active'
        ? emptyState('key', 'No active auth keys', 'Generate a key to add devices from the command line.', button('Generate auth key', { variant: 'primary', icon: 'plus', onClick: create }))
        : emptyState('key', 'Nothing here'));
      return;
    }
    list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', h('tr', h('th', 'Key'), h('th', 'Owner'), h('th', 'Type'), h('th', { class: 'hide-sm' }, 'Created'), h('th', 'Expires'), h('th', { class: 'col-actions' }))),
      h('tbody', shown.map((k) => {
        const st = keyStatus(k);
        const exp = parseTime(k.expiration);
        return h('tr', { class: st !== 'active' ? 'row-muted' : '' },
          h('td', { class: 'nowrap' }, h('div', { class: 'mono small' }, maskKey(k.key)), h('div', { class: 'muted small' }, `ID ${k.id}`)),
          h('td', { class: 'nowrap' }, k.user ? h('span', { class: 'owner-inline' }, avatar(userLabel(k.user), k.user.profilePicUrl, 18), userLabel(k.user)) : h('span', { class: 'muted' }, 'Tagged')),
          h('td', h('div', { class: 'badges' },
            badge(k.reusable ? 'Reusable' : 'One-off', 'neutral'),
            k.ephemeral ? badge('Ephemeral', 'info') : null,
            (k.aclTags || []).map((t) => badge(t, 'tag')),
            st === 'used' ? badge('Used', 'neutral', 'check') : null,
            st === 'expired' ? badge('Expired', 'danger') : null)),
          h('td', { class: 'hide-sm nowrap', title: fmtDate(k.createdAt) }, relTime(k.createdAt)),
          h('td', { class: 'nowrap', title: fmtDate(exp) }, exp ? relTime(exp) : 'Never'),
          h('td', { class: 'col-actions' }, moreButton(() => [
            st === 'active' ? { label: 'Revoke (expire now)', icon: 'lock', onClick: () => void keyAction(ctx, k, 'expire', refresh) } : null,
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => void keyAction(ctx, k, 'delete', refresh) },
          ])));
      })))));
  }

  await refresh();
  const preselect = store.get<string | null>('newKeyUser', null);
  if (preselect) { store.del('newKeyUser'); createAuthKey(ctx, () => void refresh(), preselect); }
}

async function keyAction(ctx: Ctx, k: PreAuthKey, kind: 'expire' | 'delete', after: () => Promise<void>): Promise<void> {
  const ok = await confirmDialog(kind === 'expire'
    ? { title: 'Revoke auth key?', message: 'The key can no longer be used to add devices. Devices already added stay connected.', confirmLabel: 'Revoke', danger: true }
    : { title: 'Delete auth key?', message: 'The key is removed permanently. Devices already added stay connected.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await (kind === 'expire' ? ctx.api.expirePreAuthKey(k) : ctx.api.deletePreAuthKey(k));
    toast(kind === 'expire' ? 'Auth key revoked' : 'Auth key deleted', 'success');
    await after();
  } catch (e) { toast((e as Error).message, 'error'); }
}

export function createAuthKey(ctx: Ctx, after?: () => void, userId?: string): void {
  const users = ctx.data.users || [];
  const owner = h('select', { class: 'input', 'aria-label': 'Owner' },
    h('option', { value: '' }, 'No user — tagged devices only'),
    users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(userId ?? users[0]?.id) }, `${userLabel(u)}${u.email ? ' — ' + u.email : ''}`)));
  const reusable = h('input', { type: 'checkbox' });
  const ephemeral = h('input', { type: 'checkbox' });
  const preapproved = h('input', { type: 'checkbox', checked: true, disabled: true });
  const exp = h('select', { class: 'input', 'aria-label': 'Expiration' },
    [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['custom', 'Exact date and time…']].map(([v, l]) => h('option', { value: v, selected: v === '90' }, l)));
  const expAt = h('input', { class: 'input', type: 'datetime-local', hidden: true, 'aria-label': 'Expires at' });
  exp.addEventListener('change', () => { expAt.hidden = exp.value !== 'custom'; if (!expAt.hidden) expAt.focus(); });
  const expiration = (): string => {
    if (exp.value !== 'custom') return isoInDays(Number(exp.value));
    const d = new Date(expAt.value); // datetime-local is the browser's local time
    if (isNaN(d.getTime()) || d <= new Date()) throw new Error('Pick an expiry date and time in the future.');
    return d.toISOString();
  };
  const tagChips = chipInput([], {
    placeholder: 'tag:server', normalize: tagNormalize,
    validate: (s) => (/^tag:[a-z0-9][a-z0-9-_]*$/.test(s) ? null : `"${s}" is not a valid tag.`),
  });
  const err = h('div');
  const gen = button('Generate key', { variant: 'primary' });
  const m = modal({
    title: 'Generate auth key',
    subtitle: 'Use this key to add devices with tailscale up --auth-key.',
    size: 'md',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Owner'), owner,
        h('span', { class: 'help' }, 'Devices added with this key are owned by this user, or by the tags below.')),
      h('div', { class: 'stack-sm' },
        h('label', { class: 'check' }, reusable, h('span', h('span', { class: 'check-label' }, 'Reusable'), h('span', { class: 'help' }, 'Use this key to authenticate more than one device. Be careful with reusable keys!'))),
        h('label', { class: 'check' }, ephemeral, h('span', h('span', { class: 'check-label' }, 'Ephemeral'), h('span', { class: 'help' }, 'Devices are automatically removed after going offline. Great for containers and CI.'))),
        h('label', { class: 'check' }, preapproved, h('span', h('span', { class: 'check-label' }, 'Pre-approved'), h('span', { class: 'help' }, 'Headscale always pre-approves devices added with an auth key.')))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Tags', h('span', { class: 'muted' }, ' (optional)')), tagChips.el,
        h('span', { class: 'help' }, 'Devices will be tagged, and owned by these tags. Tags must be in tagOwners.')),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Expiration'), exp, expAt,
        h('span', { class: 'help' }, 'The key itself expires; devices added with it follow their own key expiry.')),
      err),
    footer: (api) => [button('Cancel', { onClick: () => api.close() }), gen],
  });
  gen.addEventListener('click', async () => {
    clear(err);
    gen.disabled = true;
    gen.classList.add('loading');
    try {
      const tags = tagChips.get();
      if (!owner.value && !tags.length) throw new Error('A key without an owner needs at least one tag.');
      const k = await ctx.api.createPreAuthKey({
        ...(owner.value ? { user: owner.value } : {}), reusable: reusable.checked, ephemeral: ephemeral.checked, expiration: expiration(), aclTags: tags,
      });
      m.setBody(keyResult(serverUrl(ctx), k.key, tags));
      m.setFooter(button('Done', { variant: 'primary', onClick: () => m.close() }));
      after?.();
    } catch (e) {
      err.appendChild(callout('error', null, (e as Error).message));
    } finally { gen.disabled = false; gen.classList.remove('loading'); }
  });
}

// ----------------------------------------------------------------- API keys --
/** Whether `k` is the key this console is signed in with (its prefix starts the key). */
export function isCurrentKey(k: ApiKey, current: string): boolean {
  const pfx = (k.prefix || '').replace(/\*+$/, '').replace(/-$/, '');
  return !!pfx && current.startsWith(pfx);
}

export async function apiKeys(ctx: Ctx, panel: HTMLElement): Promise<void> {
  const list = h('div');
  const refresh = async (): Promise<void> => {
    clear(list).appendChild(h('div', { class: 'center pad-y' }, spinner(22)));
    try { draw(await ctx.api.listApiKeys()); } catch (e) { clear(list).appendChild(errorState(e, () => void refresh())); }
  };
  panel.append(
    h('div', { class: 'panel-head' },
      h('div', h('h2', 'API keys'), h('p', { class: 'help' }, 'API keys grant full admin access to the Headscale API — this console uses one.')),
      button('Generate API key', { variant: 'primary', icon: 'plus', onClick: () => createApiKey(ctx, () => void refresh()) })),
    list);

  function draw(keys: ApiKey[]): void {
    clear(list);
    if (!keys.length) { list.appendChild(emptyState('lock', 'No API keys')); return; }
    keys.sort((a, b) => created(b) - created(a));
    list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', h('tr', h('th', 'Key'), h('th', { class: 'hide-sm' }, 'Created'), h('th', 'Expires'), h('th', { class: 'hide-sm' }, 'Last used'), h('th', { class: 'col-actions' }))),
      h('tbody', keys.map((k) => {
        const exp = parseTime(k.expiration);
        const expired = !!exp && exp <= new Date();
        const cur = isCurrentKey(k, ctx.conn?.key || '');
        return h('tr', { class: expired ? 'row-muted' : '' },
          h('td', { class: 'nowrap' }, h('div', { class: 'mono small' }, maskKey(k.prefix)),
            h('div', { class: 'badges' }, cur ? badge('This session', 'info') : null, expired ? badge('Expired', 'danger') : null)),
          h('td', { class: 'hide-sm', title: fmtDate(k.createdAt) }, relTime(k.createdAt)),
          h('td', { title: fmtDate(exp) }, exp ? (expired ? fmtDate(exp, false) : relTime(exp)) : 'Never'),
          h('td', { class: 'hide-sm' }, parseTime(k.lastSeen) ? relTime(k.lastSeen) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'col-actions' }, moreButton(() => [
            !expired ? { label: 'Expire', icon: 'lock', onClick: () => void apiKeyAction(ctx, k, cur, 'expire', refresh) } : null,
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => void apiKeyAction(ctx, k, cur, 'delete', refresh) },
          ])));
      })))));
  }
  await refresh();
}

function createApiKey(ctx: Ctx, after: () => void): void {
  const exp = h('select', { class: 'input', 'aria-label': 'Expiration' },
    [['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', '1 year']].map(([v, l]) => h('option', { value: v, selected: v === '90' }, l)));
  const err = h('div');
  const gen = button('Generate key', { variant: 'primary' });
  const m = modal({
    title: 'Generate API key', size: 'sm',
    body: h('div', { class: 'stack' },
      callout('warning', null, 'API keys have full admin access to your Headscale server. Store them securely.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Expiration'), exp), err),
    footer: (api) => [button('Cancel', { onClick: () => api.close() }), gen],
  });
  gen.addEventListener('click', async () => {
    clear(err);
    gen.disabled = true;
    try {
      const key = await ctx.api.createApiKey(isoInDays(Number(exp.value)));
      m.setBody(h('div', { class: 'stack' }, callout('success', 'API key created', 'Copy it now — it won\'t be shown again.'), codeBlock(key, { wrap: true })));
      m.setFooter(button('Done', { variant: 'primary', onClick: () => m.close() }));
      after();
    } catch (e) { err.appendChild(callout('error', null, (e as Error).message)); gen.disabled = false; }
  });
}

async function apiKeyAction(ctx: Ctx, k: ApiKey, cur: boolean, kind: 'expire' | 'delete', after: () => Promise<void>): Promise<void> {
  const ok = await confirmDialog({
    title: kind === 'expire' ? 'Expire API key?' : 'Delete API key?',
    message: cur ? 'This is the key this console is using. You will be signed out immediately.' : 'Anything using this key will lose access.',
    confirmLabel: kind === 'expire' ? 'Expire key' : 'Delete key', danger: true,
    ...(cur ? { requireText: kind } : {}),
  });
  if (!ok) return;
  try {
    await (kind === 'expire' ? ctx.api.expireApiKey(k) : ctx.api.deleteApiKey(k));
    toast(kind === 'expire' ? 'API key expired' : 'API key deleted', 'success');
    if (cur) ctx.disconnect(); else await after();
  } catch (e) { toast((e as Error).message, 'error'); }
}
