import type { Node, User } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import { h, icon, button, badge, avatar, moreButton, emptyState, errorState, clear, toast, confirmDialog, formDialog, skeletonRows } from '../ui.js';
import { userLabel, relTime, fmtDate, parseTime, debounce, pluralize, nodeName, store } from '../util.js';
import { addDevice } from './actions.js';

export async function render(ctx: Ctx, _params: unknown, root: HTMLElement): Promise<() => void> {
  let q = '';
  let destroyed = false;
  const content = h('div');
  const countEl = h('span', { class: 'muted' });
  const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Search users…', 'data-search': true, 'aria-label': 'Search users' });

  root.append(
    h('div', { class: 'page-head' },
      h('div', h('h1', 'Users'), h('p', { class: 'muted' }, 'Manage the people who can join devices to your tailnet.')),
      h('div', { class: 'page-actions' }, button('Add user', { variant: 'primary', icon: 'plus', onClick: () => void createUser(ctx, () => void refresh(true)) }))),
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', 16), search, h('kbd', { class: 'kbd-hint' }, '/'))),
    h('div', { class: 'list-meta' }, countEl),
    content);

  async function refresh(force: boolean): Promise<void> {
    try {
      await ctx.load(force);
      if (!destroyed) draw();
    } catch (e) {
      if (!destroyed) clear(content).appendChild(errorState(e, () => void refresh(true)));
    }
  }

  function draw(): void {
    const users = ctx.data.users || [];
    const nodes = ctx.data.nodes || [];
    const byUser = new Map<string, Node[]>();
    for (const n of nodes) {
      if (!n.user) continue;
      const k = String(n.user.id);
      byUser.set(k, [...(byUser.get(k) || []), n]);
    }
    const list = users.filter((u) => {
      if (!q) return true;
      return [u.name, u.displayName, u.email, u.provider].join(' ').toLowerCase().includes(q.toLowerCase());
    }).sort((a, b) => userLabel(a).localeCompare(userLabel(b)));

    countEl.textContent = list.length === users.length ? pluralize(users.length, 'user') : `Showing ${list.length} of ${users.length}`;
    clear(content);
    if (!users.length) {
      content.appendChild(emptyState('users', 'No users yet', 'Create a user, then add devices for them with an auth key.',
        button('Add user', { variant: 'primary', icon: 'plus', onClick: () => void createUser(ctx, () => void refresh(true)) })));
      return;
    }
    if (!list.length) { content.appendChild(emptyState('search', 'No matching users')); return; }

    const rows = list.map((u) => {
      const own = byUser.get(String(u.id)) || [];
      const online = own.filter((n) => n.online).length;
      const last = own.reduce((m, n) => {
        if (n.online) return Infinity;
        const t = parseTime(n.lastSeen)?.getTime() || 0;
        return Math.max(m, t);
      }, 0);
      const oidc = u.provider && u.provider !== 'cli' && u.providerId;
      return h('tr',
        h('td', h('div', { class: 'user-cell' }, avatar(userLabel(u), u.profilePicUrl, 32),
          h('div',
            h('div', { class: 'user-name' }, userLabel(u)),
            h('div', { class: 'muted small' }, u.email || u.name)))),
        h('td', { class: 'mono hide-sm' }, u.name),
        h('td', { class: 'hide-md' }, oidc ? badge(u.provider === 'oidc' ? 'OIDC' : String(u.provider), 'info', 'link') : badge('Local', 'neutral')),
        h('td', own.length
          ? h('a', { href: '#/machines', onclick: (e) => { e.preventDefault(); goToMachines(ctx, u.name); } }, pluralize(own.length, 'machine'),
            online ? h('span', { class: 'muted' }, ` · ${online} online`) : null)
          : h('span', { class: 'muted' }, 'None')),
        h('td', { class: 'hide-md', title: fmtDate(u.createdAt) }, relTime(u.createdAt)),
        h('td', { class: 'hide-sm' }, last === Infinity ? h('span', { class: 'seen' }, h('span', { class: 'dot dot-on' }), 'Now') : last ? relTime(new Date(last)) : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'col-actions' }, moreButton(() => [
          { label: 'Add device for user…', icon: 'plus', onClick: () => addDevice(ctx, () => void refresh(true), { userId: u.id }) },
          { label: 'Create auth key…', icon: 'key', onClick: () => { store.set('newKeyUser', String(u.id), false); ctx.navigate('#/settings/keys'); } },
          { label: 'View machines', icon: 'machines', onClick: () => goToMachines(ctx, u.name), disabled: !own.length },
          { divider: true },
          { label: 'Rename user…', icon: 'edit', onClick: () => void renameUser(ctx, u, () => void refresh(true)) },
          { label: 'Delete user…', icon: 'trash', danger: true, onClick: () => void deleteUser(ctx, u, own, () => void refresh(true)) },
        ])));
    });

    content.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', h('tr', h('th', 'User'), h('th', { class: 'hide-sm' }, 'Username'), h('th', { class: 'hide-md' }, 'Provider'),
        h('th', 'Machines'), h('th', { class: 'hide-md' }, 'Joined'), h('th', { class: 'hide-sm' }, 'Last active'), h('th', { class: 'col-actions' }))),
      h('tbody', rows))));
  }

  search.addEventListener('input', debounce(() => { q = search.value.trim(); draw(); }, 100));
  if (!ctx.data.users) {
    content.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', skeletonRows(4, 5)))));
  }
  await refresh(true);
  return () => { destroyed = true; };
}

function goToMachines(ctx: Ctx, username: string): void {
  store.set('machines.q', username, false);
  ctx.navigate('#/machines');
}

export async function createUser(ctx: Ctx, after?: (u: User) => void): Promise<void> {
  const r = await formDialog({
    title: 'Add user',
    subtitle: 'Users own devices. With OIDC enabled, users are also created automatically on first login.',
    fields: [
      { name: 'name', label: 'Username', placeholder: 'jane', required: true, mono: true, help: 'Used in ACLs as username@ (e.g. jane@). Letters, numbers, dots, hyphens.' },
      { name: 'displayName', label: 'Display name', placeholder: 'Jane Doe', optional: true },
      { name: 'email', label: 'Email', type: 'email', placeholder: 'jane@example.com', optional: true },
      { name: 'pictureUrl', label: 'Profile picture URL', type: 'url', placeholder: 'https://…', optional: true },
    ],
    submitLabel: 'Add user',
    onSubmit: async (v) => {
      const name = String(v.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(name)) throw new Error('Username may contain letters, numbers, dots, hyphens, @ and +.');
      return ctx.api.createUser({
        name,
        ...(v.displayName ? { displayName: String(v.displayName) } : {}),
        ...(v.email ? { email: String(v.email) } : {}),
        ...(v.pictureUrl ? { pictureUrl: String(v.pictureUrl) } : {}),
      });
    },
  });
  if (r) { toast(`User ${userLabel(r)} created`, 'success'); ctx.invalidate(); after?.(r); }
}

async function renameUser(ctx: Ctx, u: User, after?: () => void): Promise<void> {
  const r = await formDialog({
    title: 'Rename user',
    fields: [{ name: 'name', label: 'Username', value: u.name, mono: true, required: true, help: 'ACL rules that reference the old name (e.g. old@) must be updated too.' }],
    submitLabel: 'Rename',
    onSubmit: async (v) => {
      if (v.name !== u.name) await ctx.api.renameUser(u.id, String(v.name));
      return true;
    },
  });
  if (r) { toast('User renamed', 'success'); ctx.invalidate(); after?.(); }
}

async function deleteUser(ctx: Ctx, u: User, own: Node[], after?: () => void): Promise<void> {
  if (own.length) {
    const ok = await confirmDialog({
      title: `${userLabel(u)} still owns machines`,
      message: h('div', { class: 'stack-sm' },
        h('p', `Headscale won't delete a user that owns machines. Remove ${pluralize(own.length, 'machine')} first?`),
        h('ul', { class: 'plain-list' }, own.slice(0, 8).map((n) => h('li', { class: 'mono' }, nodeName(n)))),
        own.length > 8 ? h('p', { class: 'muted' }, `…and ${own.length - 8} more`) : null),
      confirmLabel: `Remove machines and delete user`,
      danger: true,
      requireText: u.name,
      onConfirm: async () => {
        for (const n of own) await ctx.api.deleteNode(n.id);
        await ctx.api.deleteUser(u.id);
      },
    });
    ctx.invalidate();
    if (ok) toast(`${userLabel(u)} deleted`, 'success');
    after?.(); // refresh even if only some machines were removed
    return;
  }
  const ok = await confirmDialog({
    title: 'Delete user?',
    message: `This permanently deletes ${userLabel(u)} (${u.name}). Their unused auth keys are removed too.`,
    confirmLabel: 'Delete user',
    danger: true,
    onConfirm: () => ctx.api.deleteUser(u.id),
  });
  if (ok) {
    toast(`${userLabel(u)} deleted`, 'success');
    ctx.invalidate();
    after?.();
  }
}
