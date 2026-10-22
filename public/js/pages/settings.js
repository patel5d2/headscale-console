import {
  h, icon, button, badge, callout, clear, toast, confirmDialog, modal, tabs, errorState, spinner, kv, copyable,
  moreButton, emptyState, chipInput, codeBlock, avatar,
} from '../ui.js';
import { fmtDate, relTime, parseTime, userLabel, store, hostOf, isoInDays, routeInfo, applyTheme } from '../util.js';
import { keyResult, serverUrl } from './actions.js';
import { updates } from './updates.js';

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'keys', label: 'Auth keys', icon: 'key' },
  { id: 'api-keys', label: 'API keys', icon: 'lock' },
  { id: 'devices', label: 'Device approval', icon: 'check' },
  { id: 'updates', label: 'Updates', icon: 'download' },
];

export async function render(ctx, { section = 'general' }, root) {
  if (!SECTIONS.find((s) => s.id === section)) section = 'general';
  const panel = h('div', { class: 'settings-panel' });
  root.append(
    h('div', { class: 'page-head' }, h('div', h('h1', 'Settings'), h('p', { class: 'muted' }, 'Manage your Headscale server, keys and this console.'))),
    h('div', { class: 'settings-layout' },
      h('nav', { class: 'subnav', 'aria-label': 'Settings' },
        SECTIONS.map((s) => h('a', { href: `#/settings/${s.id}`, class: `subnav-link${s.id === section ? ' active' : ''}` }, icon(s.icon, 15), s.label))),
      panel));
  const fn = { general, keys: authKeys, 'api-keys': apiKeys, devices, updates }[section];
  return fn(ctx, panel);
}

// ================================================================ General ==
async function general(ctx, panel) {
  panel.appendChild(h('div', { class: 'center pad-y' }, spinner(22)));
  const [health, version] = await Promise.all([ctx.api.health(), ctx.api.version()]);
  let data = { users: [], nodes: [] };
  try { data = await ctx.load(true); } catch { /* shown below */ }
  const nodes = data.nodes || [];
  const routes = nodes.reduce((a, n) => a + routeInfo(n).subnets.length, 0);
  const exits = nodes.filter((n) => routeInfo(n).exitApproved).length;

  const domain = h('input', { class: 'input mono', value: ctx.prefs.baseDomain, placeholder: 'tail.example.com', spellcheck: 'false' });
  const theme = h('select', { class: 'input' }, ['system', 'light', 'dark'].map((t) =>
    h('option', { value: t, selected: store.get('theme', 'system') === t }, t[0].toUpperCase() + t.slice(1))));
  theme.addEventListener('change', () => { store.set('theme', theme.value); applyTheme(); });
  const saveDomain = button('Save', { size: 'sm', onClick: () => { ctx.prefs.baseDomain = domain.value.trim().toLowerCase(); toast('Saved', 'success'); } });

  const dbOk = health && health.databaseConnectivity;
  clear(panel).append(
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Server')),
      kv([
        ['Server URL', copyable(serverUrl(ctx))],
        ['Version', version?.version ? h('span', version.version, version.commit ? h('span', { class: 'muted mono small' }, ` (${version.commit.slice(0, 7)})`) : null) : h('span', { class: 'muted' }, 'Unknown')],
        version?.buildTime ? ['Built', fmtDate(version.buildTime)] : null,
        ['Health', health?.error ? badge('Unavailable', 'neutral') : dbOk ? badge('Database connected', 'success', 'check') : badge('Database unreachable', 'danger', 'alert')],
        ['Console access', ctx.config.lockedUrl ? badge('Locked to this server', 'info', 'lock') : badge('Any server', 'neutral')],
      ])),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Tailnet overview')),
      h('div', { class: 'card-body' }, h('div', { class: 'stat-row' },
        stat('Users', (data.users || []).length, '#/users'),
        stat('Machines', nodes.length, '#/machines'),
        stat('Connected', nodes.filter((n) => n.online).length, '#/machines'),
        stat('Subnet routes', routes, '#/routes'),
        stat('Exit nodes', exits, '#/routes')))),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Console preferences')),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'setting-row' }, h('div', h('div', { class: 'setting-title' }, 'Appearance'), h('div', { class: 'help' }, 'Light, dark, or follow your system.')), theme),
        h('div', { class: 'setting-row' },
          h('div', h('div', { class: 'setting-title' }, 'MagicDNS base domain'), h('div', { class: 'help' }, 'Matches dns.base_domain in your Headscale config; used to show full machine names.')),
          h('div', { class: 'inline-form' }, domain, saveDomain)))),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Maintenance')),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'setting-row' },
          h('div', h('div', { class: 'setting-title' }, 'Backfill IP addresses'),
            h('div', { class: 'help' }, 'Gives machines missing an IPv4 or IPv6 address one from your configured prefixes. Useful after enabling a new address family.')),
          button('Backfill…', { onClick: () => backfill(ctx) })))),

    h('section', { class: 'card card-danger' },
      h('div', { class: 'card-head' }, h('h2', 'Session')),
      h('div', { class: 'card-body setting-row' },
        h('div', h('div', { class: 'setting-title' }, `Connected to ${hostOf(serverUrl(ctx))}`),
          h('div', { class: 'help' }, ctx.conn?.remember ? 'Your API key is remembered on this device.' : 'Your API key is kept only for this browser tab.')),
        button('Disconnect', { variant: 'danger', icon: 'logout', onClick: () => ctx.disconnect() }))));
}

function stat(label, n, href) {
  return h('a', { class: 'stat stat-link', href }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label));
}

async function backfill(ctx) {
  const ok = await confirmDialog({
    title: 'Backfill IP addresses?',
    message: 'Headscale will assign missing addresses to every machine. Clients pick up the change on their next map update.',
    confirmLabel: 'Backfill',
  });
  if (!ok) return;
  try {
    const r = await ctx.api.backfillIPs();
    const changes = r.changes || [];
    modal({
      title: 'Backfill complete', size: 'md',
      body: changes.length ? h('ul', { class: 'plain-list mono small' }, changes.map((c) => h('li', c))) : h('p', 'All machines already had addresses. Nothing changed.'),
      footer: (api) => [button('Done', { variant: 'primary', onClick: () => api.close() })],
    });
    ctx.invalidate();
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================== Auth keys ==
function keyStatus(k) {
  const exp = parseTime(k.expiration);
  if (exp && exp <= new Date()) return 'expired';
  if (k.used && !k.reusable) return 'used';
  return 'active';
}

async function authKeys(ctx, panel) {
  let filter = 'active';
  const list = h('div');
  const genBtn = button('Generate auth key', { variant: 'primary', icon: 'plus', onClick: () => createAuthKey(ctx, refresh) });
  const tabsHost = h('div');
  panel.append(
    h('div', { class: 'panel-head' },
      h('div', h('h2', 'Auth keys'), h('p', { class: 'help' }, 'Pre-authentication keys let you add devices without an interactive login.')),
      genBtn),
    tabsHost, list);

  let keys = [];
  async function refresh() {
    clear(list).appendChild(h('div', { class: 'center pad-y' }, spinner(22)));
    try {
      const { users } = await ctx.load();
      keys = await ctx.api.listPreAuthKeys(users);
      draw();
    } catch (e) {
      clear(list).appendChild(errorState(e, refresh));
    }
  }

  function draw() {
    const counts = { active: 0, used: 0, expired: 0 };
    keys.forEach((k) => counts[keyStatus(k)]++);
    clear(tabsHost).appendChild(tabs([
      { id: 'active', label: 'Active', count: counts.active },
      { id: 'used', label: 'Used', count: counts.used },
      { id: 'expired', label: 'Expired', count: counts.expired },
      { id: 'all', label: 'All', count: keys.length },
    ], filter, (f) => { filter = f; draw(); }));

    const shown = keys.filter((k) => filter === 'all' || keyStatus(k) === filter)
      .sort((a, b) => (parseTime(b.createdAt) || 0) - (parseTime(a.createdAt) || 0));
    clear(list);
    if (!shown.length) {
      list.appendChild(emptyState('key', filter === 'active' ? 'No active auth keys' : 'Nothing here',
        filter === 'active' ? 'Generate a key to add devices from the command line.' : null,
        filter === 'active' ? button('Generate auth key', { variant: 'primary', icon: 'plus', onClick: () => createAuthKey(ctx, refresh) }) : null));
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
            st === 'active' ? { label: 'Revoke (expire now)', icon: 'lock', onClick: () => expireKey(ctx, k, refresh) } : null,
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteKey(ctx, k, refresh) },
          ])));
      })))));
  }

  await refresh();
  const preselect = store.get('newKeyUser');
  if (preselect) { store.del('newKeyUser'); createAuthKey(ctx, refresh, preselect); }
}

function maskKey(k) {
  if (!k) return '—';
  if (k.includes('***')) return k.replace('***', '••••••');
  return k.length > 20 ? `${k.slice(0, 16)}••••••` : k;
}

async function expireKey(ctx, k, after) {
  const ok = await confirmDialog({ title: 'Revoke auth key?', message: 'The key can no longer be used to add devices. Devices already added stay connected.', confirmLabel: 'Revoke', danger: true });
  if (!ok) return;
  try { await ctx.api.expirePreAuthKey(k); toast('Auth key revoked', 'success'); after(); } catch (e) { toast(e.message, 'error'); }
}

async function deleteKey(ctx, k, after) {
  const ok = await confirmDialog({ title: 'Delete auth key?', message: 'The key is removed permanently. Devices already added stay connected.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try { await ctx.api.deletePreAuthKey(k); toast('Auth key deleted', 'success'); after(); } catch (e) { toast(e.message, 'error'); }
}

export function createAuthKey(ctx, after, userId) {
  const users = ctx.data.users || [];
  const url = serverUrl(ctx);
  const owner = h('select', { class: 'input' },
    h('option', { value: '' }, 'No user — tagged devices only'),
    users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(userId ?? users[0]?.id) }, `${userLabel(u)}${u.email ? ' — ' + u.email : ''}`)));
  const reusable = h('input', { type: 'checkbox' });
  const ephemeral = h('input', { type: 'checkbox' });
  const preapproved = h('input', { type: 'checkbox', checked: true, disabled: true });
  const exp = h('select', { class: 'input' },
    [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']].map(([v, l]) => h('option', { value: v, selected: v === '90' }, l)));
  const tagChips = chipInput([], {
    placeholder: 'tag:server',
    normalize: (s) => (s.startsWith('tag:') ? s : `tag:${s}`).toLowerCase(),
    validate: (s) => (/^tag:[a-z0-9][a-z0-9-_]*$/.test(s) ? null : `"${s}" is not a valid tag.`),
  });
  const err = h('div');
  const gen = button('Generate key', { variant: 'primary' });
  const m = modal({
    title: 'Generate auth key',
    subtitle: 'Use this key to add devices with tailscale up --authkey.',
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
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Expiration'), exp,
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
        user: owner.value || undefined, reusable: reusable.checked, ephemeral: ephemeral.checked,
        expiration: isoInDays(+exp.value), aclTags: tags,
      });
      m.setBody(keyResult(url, k.key, tags));
      m.setFooter(button('Done', { variant: 'primary', onClick: () => m.close() }));
      after?.();
    } catch (e) {
      err.appendChild(callout('error', null, e.message));
    } finally { gen.disabled = false; gen.classList.remove('loading'); }
  });
}

// =============================================================== API keys ==
async function apiKeys(ctx, panel) {
  const list = h('div');
  panel.append(
    h('div', { class: 'panel-head' },
      h('div', h('h2', 'API keys'), h('p', { class: 'help' }, 'API keys grant full admin access to the Headscale API — this console uses one.')),
      button('Generate API key', { variant: 'primary', icon: 'plus', onClick: () => createApiKey(ctx, refresh) })),
    list);

  const current = ctx.conn?.key || '';
  const isCurrent = (k) => {
    const pfx = (k.prefix || '').replace(/\*+$/, '').replace(/-$/, '');
    return pfx && current.startsWith(pfx);
  };

  async function refresh() {
    clear(list).appendChild(h('div', { class: 'center pad-y' }, spinner(22)));
    try {
      const keys = await ctx.api.listApiKeys();
      draw(keys);
    } catch (e) { clear(list).appendChild(errorState(e, refresh)); }
  }

  function draw(keys) {
    clear(list);
    if (!keys.length) { list.appendChild(emptyState('lock', 'No API keys')); return; }
    keys.sort((a, b) => (parseTime(b.createdAt) || 0) - (parseTime(a.createdAt) || 0));
    list.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', h('tr', h('th', 'Key'), h('th', { class: 'hide-sm' }, 'Created'), h('th', 'Expires'), h('th', { class: 'hide-sm' }, 'Last used'), h('th', { class: 'col-actions' }))),
      h('tbody', keys.map((k) => {
        const exp = parseTime(k.expiration);
        const expired = exp && exp <= new Date();
        const cur = isCurrent(k);
        return h('tr', { class: expired ? 'row-muted' : '' },
          h('td', { class: 'nowrap' }, h('div', { class: 'mono small' }, maskKey(k.prefix)),
            h('div', { class: 'badges' }, cur ? badge('This session', 'info') : null, expired ? badge('Expired', 'danger') : null)),
          h('td', { class: 'hide-sm', title: fmtDate(k.createdAt) }, relTime(k.createdAt)),
          h('td', { title: fmtDate(exp) }, exp ? (expired ? fmtDate(exp, false) : relTime(exp)) : 'Never'),
          h('td', { class: 'hide-sm' }, parseTime(k.lastSeen) ? relTime(k.lastSeen) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'col-actions' }, moreButton(() => [
            !expired ? { label: 'Expire', icon: 'lock', onClick: () => expireApi(ctx, k, cur, refresh) } : null,
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteApi(ctx, k, cur, refresh) },
          ])));
      })))));
  }
  await refresh();
}

async function createApiKey(ctx, after) {
  const exp = h('select', { class: 'input' },
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
      const key = await ctx.api.createApiKey(isoInDays(+exp.value));
      m.setBody(h('div', { class: 'stack' },
        callout('success', 'API key created', 'Copy it now — it won\'t be shown again.'),
        codeBlock(key, { wrap: true })));
      m.setFooter(button('Done', { variant: 'primary', onClick: () => m.close() }));
      after();
    } catch (e) { err.appendChild(callout('error', null, e.message)); gen.disabled = false; }
  });
}

async function expireApi(ctx, k, cur, after) {
  const ok = await confirmDialog({
    title: 'Expire API key?',
    message: cur ? 'This is the key this console is using. You will be signed out immediately.' : 'Anything using this key will lose access.',
    confirmLabel: 'Expire key', danger: true, requireText: cur ? 'expire' : undefined,
  });
  if (!ok) return;
  try {
    await ctx.api.expireApiKey(k);
    toast('API key expired', 'success');
    if (cur) ctx.disconnect(); else after();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteApi(ctx, k, cur, after) {
  const ok = await confirmDialog({
    title: 'Delete API key?',
    message: cur ? 'This is the key this console is using. You will be signed out immediately.' : 'Anything using this key will lose access.',
    confirmLabel: 'Delete key', danger: true, requireText: cur ? 'delete' : undefined,
  });
  if (!ok) return;
  try {
    await ctx.api.deleteApiKey(k);
    toast('API key deleted', 'success');
    if (cur) ctx.disconnect(); else after();
  } catch (e) { toast(e.message, 'error'); }
}

// ========================================================= Device approval ==
async function devices(ctx, panel) {
  const { users } = await ctx.load();
  const url = serverUrl(ctx);

  const regInput = h('input', { class: 'input mono', placeholder: `${url}/register/hskey-authreq-…`, spellcheck: 'false' });
  const regUser = h('select', { class: 'input' }, users.map((u) => h('option', { value: u.name }, userLabel(u))));
  const regOut = h('div');
  const regBtn = button('Register device', { variant: 'primary', icon: 'check' });

  const authInput = h('input', { class: 'input mono', placeholder: 'hskey-authreq-…', spellcheck: 'false' });
  const authOut = h('div');
  const approveBtn = button('Approve', { variant: 'primary', icon: 'check' });
  const rejectBtn = button('Reject', { variant: 'danger', icon: 'x' });

  const parseId = (raw) => {
    const m = raw.match(/hskey-authreq-[A-Za-z0-9_-]+/) || raw.match(/(?:register\/|auth\/|key=)([A-Za-z0-9_:-]+)/);
    return m ? (m[1] || m[0]) : raw.trim();
  };

  regBtn.addEventListener('click', async () => {
    clear(regOut);
    const id = parseId(regInput.value.trim());
    if (!id) { regOut.appendChild(callout('error', null, 'Paste the registration URL or auth ID.')); return; }
    regBtn.disabled = true;
    try {
      const node = await ctx.api.registerAuth(regUser.value, id);
      ctx.invalidate();
      regInput.value = '';
      regOut.appendChild(callout('success', 'Device registered', h('span', node ? h('a', { href: `#/machines/${node.id}` }, node.givenName || node.name) : 'The device', ' joined the tailnet.')));
    } catch (e) { regOut.appendChild(callout('error', 'Registration failed', e.message)); } finally { regBtn.disabled = false; }
  });

  const decide = (approve) => async () => {
    clear(authOut);
    const id = parseId(authInput.value.trim());
    if (!id) { authOut.appendChild(callout('error', null, 'Paste the auth request URL or ID.')); return; }
    try {
      if (approve) await ctx.api.approveAuth(id); else await ctx.api.rejectAuth(id);
      authInput.value = '';
      authOut.appendChild(callout('success', null, approve ? 'Request approved.' : 'Request rejected.'));
    } catch (e) { authOut.appendChild(callout('error', null, e.message)); }
  };
  approveBtn.addEventListener('click', decide(true));
  rejectBtn.addEventListener('click', decide(false));

  panel.append(
    h('div', { class: 'panel-head' }, h('div', h('h2', 'Device approval'),
      h('p', { class: 'help' }, 'Approve devices and sign-ins that are waiting on an administrator.'))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Register a new device')),
      h('div', { class: 'card-body stack' },
        h('p', { class: 'help' }, 'When a device runs ', h('code', `tailscale up --login-server ${url}`),
          ' without an auth key, it prints a login URL. Paste it here and choose who owns the device.'),
        users.length ? null : callout('warning', null, h('span', 'You need a user first. ', h('a', { href: '#/users' }, 'Create one'), '.')),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Login URL or auth ID'), regInput),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Owner'), regUser),
        h('div', regBtn), regOut)),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Pending authentication requests')),
      h('div', { class: 'card-body stack' },
        h('p', { class: 'help' }, 'Approve or reject a pending request by its ID — for example a Tailscale SSH check-mode prompt or a web sign-in waiting for approval.'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Auth request URL or ID'), authInput),
        h('div', { class: 'row-gap' }, approveBtn, rejectBtn), authOut)),
    callout('info', null, h('span', 'Headscale doesn\'t list pending requests through its API, so they are approved by ID. Devices added with an auth key are pre-approved automatically. ',
      h('a', { href: '#/settings/keys' }, 'Manage auth keys'), '.')));
}

