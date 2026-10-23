// Node actions shared by the Machines list, machine detail and Routes pages, plus the
// Add device dialog and its join-command builder.
import { joinCommand, joinScript, OS_LABELS, type JoinOptions, type JoinOS } from '../../shared/join.js';
import type { Node, Policy } from '../../shared/types.js';
import type { AppCtx, Ctx } from '../types.js';
import type { MenuItem } from '../ui.js';
import { logTarget } from './logs-collect.js';
import { button, callout, chipInput, clear, codeBlock, confirmDialog, formDialog, h, modal, tabs, toast, toggle } from '../ui.js';
import {
  download, EXIT_ROUTES, expiryState, hostOf, isExitRoute, isoInDays, nodeName, nodeTags, parseHuJSON, routeInfo, userLabel, validCIDR,
} from '../util.js';

type After = (() => void) | undefined;

/** MagicDNS label rules: lowercase letters, digits, hyphens; max 63 chars. */
export function validLabel(s: string): string | null {
  if (!s) return 'Name is required.';
  if (s.length > 63) return 'Name must be 63 characters or fewer.';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) return 'Use lowercase letters, numbers and hyphens; it can\'t start or end with a hyphen.';
  return null;
}

export const magicName = (ctx: AppCtx, n: Node): string => (ctx.prefs.baseDomain ? `${nodeName(n)}.${ctx.prefs.baseDomain}` : nodeName(n));
export const serverUrl = (ctx: AppCtx): string => ctx.config.lockedUrl || ctx.conn?.url || '';

const TAG_RE = /^tag:[a-z0-9][a-z0-9-_]*$/;
export const tagNormalize = (s: string): string => (s.startsWith('tag:') ? s : `tag:${s}`).toLowerCase();

async function policyTags(ctx: Ctx): Promise<string[]> {
  try {
    const p = await ctx.api.getPolicy();
    const parsed = parseHuJSON<Policy>(p.policy || '{}');
    return parsed.ok ? Object.keys(parsed.value.tagOwners || {}) : [];
  } catch { return []; }
}

function done(ctx: AppCtx, msg: string, after: After): void {
  toast(msg, 'success');
  ctx.invalidate();
  after?.();
}

// ------------------------------------------------------------------- rename --
export async function renameNode(ctx: Ctx, n: Node, after?: After): Promise<void> {
  const r = await formDialog({
    title: 'Edit machine name',
    subtitle: 'This name is used for MagicDNS and shown across the console.',
    fields: [{
      name: 'name', label: 'Machine name', value: nodeName(n), mono: true,
      help: `Lowercase letters, numbers and hyphens. Hostname reported by the device: ${n.name || '—'}`,
    }],
    onSubmit: async (v) => {
      const name = String(v.name).toLowerCase();
      const err = validLabel(name);
      if (err) throw new Error(err);
      if (name !== nodeName(n)) await ctx.api.renameNode(n.id, name);
      return true;
    },
  });
  if (r) done(ctx, 'Machine renamed', after);
}

// --------------------------------------------------------------------- tags --
export async function editTags(ctx: Ctx, n: Node, after?: After): Promise<void> {
  const known = await policyTags(ctx);
  const chips = chipInput(nodeTags(n), {
    placeholder: 'tag:server',
    suggestions: known,
    normalize: tagNormalize,
    validate: (s) => (TAG_RE.test(s) ? null : `"${s}" is not a valid tag (use tag:name).`),
  });
  const r = await formDialog({
    title: 'Edit ACL tags',
    subtitle: nodeName(n),
    size: 'md',
    fields: [],
    extra: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Tags'), chips.el,
        h('span', { class: 'help' }, known.length
          ? `Tags defined in your policy: ${known.join(', ')}`
          : 'Tags must be listed under tagOwners in your access control policy.')),
      n.user ? callout('info', 'Tagging changes ownership',
        'Like Tailscale, a tagged device is owned by its tags instead of a user. Its identity in ACLs becomes the tags.') : null),
    onSubmit: async () => { await ctx.api.setTags(n.id, chips.get()); return true; },
    submitLabel: 'Save tags',
  });
  if (r) done(ctx, 'Tags updated', after);
}

// ------------------------------------------------------------------- routes --
export function editRoutes(ctx: Ctx, n: Node, after?: After): void {
  const info = routeInfo(n);
  const approved = new Set(info.approved);
  const subnets = [...info.subnets];

  const list = h('div', { class: 'route-list' });
  const addInput = h('input', { class: 'input mono', placeholder: '10.0.0.0/24', spellcheck: 'false', 'aria-label': 'Route to approve' });
  const addErr = h('div', { class: 'help error-text' });

  const renderList = (): void => {
    clear(list);
    if (!subnets.length) {
      list.appendChild(h('div', { class: 'muted small pad-y' }, 'This machine is not advertising any subnet routes.',
        h('br'), 'Advertise with ', h('code', 'tailscale set --advertise-routes=192.168.1.0/24'), '.'));
    }
    for (const r of subnets) {
      const cb = h('input', { type: 'checkbox', checked: approved.has(r) });
      cb.addEventListener('change', () => { if (cb.checked) approved.add(r); else approved.delete(r); });
      list.appendChild(h('label', { class: 'route-row' }, cb,
        h('span', { class: 'mono' }, r),
        info.primary.includes(r) ? h('span', { class: 'badge badge-success' }, 'Primary') : null,
        !info.available.includes(r) ? h('span', { class: 'badge badge-neutral', title: 'Approved ahead of time; the device is not currently advertising it' }, 'Not advertised') : null));
    }
  };
  renderList();

  const exitRow = h('div', { class: 'setting-row' },
    h('div', h('div', { class: 'setting-title' }, 'Use as exit node'),
      h('div', { class: 'help' }, info.exitAdvertised
        ? 'Allow other devices to route all internet traffic through this machine.'
        : 'This machine is not advertising itself as an exit node (tailscale set --advertise-exit-node). You can still pre-approve it.')),
    toggle(EXIT_ROUTES.some((r) => approved.has(r)), (v) => { for (const r of EXIT_ROUTES) { if (v) approved.add(r); else approved.delete(r); } }, { label: 'Exit node' }));

  const addRoute = (): void => {
    const v = addInput.value.trim();
    if (!v) return;
    if (!validCIDR(v)) { addErr.textContent = 'Enter a valid CIDR, e.g. 192.168.1.0/24'; return; }
    if (isExitRoute(v)) { addErr.textContent = 'Use the exit node toggle for 0.0.0.0/0 and ::/0.'; return; }
    addErr.textContent = '';
    if (!subnets.includes(v)) subnets.push(v);
    approved.add(v);
    addInput.value = '';
    renderList();
  };
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addRoute(); } });

  const save = button('Save', { variant: 'primary' });
  const errBox = h('div');
  const m = modal({
    title: 'Edit route settings',
    subtitle: nodeName(n),
    size: 'md',
    body: h('div', { class: 'stack' },
      h('section', h('h3', { class: 'section-title' }, 'Subnet routes'),
        h('p', { class: 'help' }, 'Approve the subnets this machine may route traffic for.'), list,
        h('div', { class: 'inline-form' }, addInput, button('Approve route', { onClick: addRoute, icon: 'plus' })), addErr),
      h('section', h('h3', { class: 'section-title' }, 'Exit node'), exitRow),
      errBox),
    footer: (api) => [button('Cancel', { onClick: () => api.close() }), save],
  });
  save.addEventListener('click', async () => {
    clear(errBox);
    save.disabled = true;
    save.classList.add('loading');
    try {
      await ctx.api.setApprovedRoutes(n.id, [...approved]);
      m.close(true);
      done(ctx, 'Route settings saved', after);
    } catch (e) {
      errBox.appendChild(callout('error', null, (e as Error).message));
    } finally { save.disabled = false; save.classList.remove('loading'); }
  });
}

export async function setRouteApproved(ctx: Ctx, n: Node, route: string, on: boolean, after?: After): Promise<void> {
  const set = new Set(n.approvedRoutes || []);
  for (const r of isExitRoute(route) ? EXIT_ROUTES : [route]) { if (on) set.add(r); else set.delete(r); }
  const what = isExitRoute(route) ? 'exit node' : route;
  try {
    await ctx.api.setApprovedRoutes(n.id, [...set]);
    done(ctx, on ? `Approved ${what}` : `Removed approval for ${what}`, after);
  } catch (e) {
    toast((e as Error).message, 'error');
    after?.();
  }
}

// ------------------------------------------------------------------- expiry --
export async function disableExpiry(ctx: Ctx, n: Node, after?: After): Promise<void> {
  try {
    await ctx.api.disableNodeExpiry(n.id);
    done(ctx, 'Key expiry disabled', after);
  } catch (e) { toast((e as Error).message, 'error'); }
}

export async function setExpiry(ctx: Ctx, n: Node, after?: After): Promise<void> {
  const st = expiryState(n);
  const r = await formDialog({
    title: st.disabled ? 'Enable key expiry' : 'Change key expiry',
    subtitle: `${nodeName(n)} will need to re-authenticate after this date.`,
    fields: [{
      name: 'preset', label: 'Expires in', type: 'select', value: '180',
      options: [
        { value: '1', label: '1 day' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' },
        { value: '90', label: '90 days' }, { value: '180', label: '180 days (Tailscale default)' }, { value: '365', label: '1 year' },
        { value: 'custom', label: 'Custom date…' },
      ],
    }, {
      name: 'date', label: 'Custom date', type: 'date', optional: true,
      value: new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10), help: 'Only used when "Custom date" is selected.',
    }],
    submitLabel: 'Save expiry',
    onSubmit: async (v) => {
      let iso: string;
      if (v.preset === 'custom') {
        if (!v.date) throw new Error('Pick a date.');
        const dt = new Date(`${v.date}T23:59:59`);
        if (dt <= new Date()) throw new Error('The date must be in the future. Use "Expire key" to expire it now.');
        iso = dt.toISOString();
      } else iso = isoInDays(Number(v.preset));
      await ctx.api.setNodeExpiry(n.id, iso);
      return true;
    },
  });
  if (r) done(ctx, 'Key expiry updated', after);
}

export async function expireNow(ctx: Ctx, n: Node, after?: After): Promise<void> {
  const ok = await confirmDialog({
    title: 'Expire machine key?',
    message: `${nodeName(n)} will be disconnected from the tailnet until it re-authenticates (tailscale up). This cannot be undone.`,
    confirmLabel: 'Expire key',
    danger: true,
    onConfirm: () => ctx.api.expireNode(n.id),
  });
  if (ok) done(ctx, 'Machine key expired', after);
}

export async function deleteNode(ctx: Ctx, n: Node, after?: After): Promise<void> {
  const ok = await confirmDialog({
    title: 'Remove machine?',
    message: h('p', 'This permanently removes ', h('strong', nodeName(n)), ' from the tailnet. Its IP addresses are released and it will need to be registered again to rejoin.'),
    confirmLabel: 'Remove machine',
    danger: true,
    onConfirm: () => ctx.api.deleteNode(n.id),
  });
  if (ok) done(ctx, `${nodeName(n)} removed`, after);
}

// --------------------------------------------------------------------- menu --
export function nodeMenuItems(ctx: Ctx, n: Node, after?: After, { includeView = true } = {}): MenuItem[] {
  const st = expiryState(n);
  const ri = routeInfo(n);
  return [
    includeView ? { label: 'View machine details', icon: 'eye', onClick: () => ctx.navigate(`#/machines/${n.id}`) } : null,
    ctx.config.browserSsh ? { label: 'SSH…', icon: 'terminal', onClick: () => ctx.navigate(`#/ssh/${n.id}`) } : null,
    includeView || ctx.config.browserSsh ? { divider: true } : null,
    { label: 'Edit machine name…', icon: 'edit', onClick: () => void renameNode(ctx, n, after) },
    { label: 'Edit route settings…', icon: 'routes', hint: ri.pendingSubnets.length || ri.exitPending ? 'Pending' : null, onClick: () => editRoutes(ctx, n, after) },
    { label: 'Edit ACL tags…', icon: 'tag', onClick: () => void editTags(ctx, n, after) },
    { divider: true },
    st.disabled
      ? { label: 'Enable key expiry…', icon: 'clock', onClick: () => void setExpiry(ctx, n, after) }
      : { label: 'Disable key expiry', icon: 'unlock', onClick: () => void disableExpiry(ctx, n, after) },
    !st.disabled ? { label: 'Change key expiry…', icon: 'clock', onClick: () => void setExpiry(ctx, n, after) } : null,
    { label: 'Expire key', icon: 'lock', onClick: () => void expireNow(ctx, n, after) },
    { divider: true },
    { label: 'Remove…', icon: 'trash', danger: true, onClick: () => void deleteNode(ctx, n, after) },
  ];
}

// --------------------------------------------------------------- add device --
export function addDevice(ctx: Ctx, after?: After, { initialTab = 'key', userId }: { initialTab?: 'key' | 'register'; userId?: string } = {}): void {
  const users = ctx.data.users || [];
  const url = serverUrl(ctx);
  let current = initialTab;
  const paneEl = h('div');
  const tabBar = tabs<'key' | 'register'>([
    { id: 'key', label: 'Generate auth key', icon: 'key' },
    { id: 'register', label: 'Register with auth ID', icon: 'link' },
  ], current, (id) => { current = id; renderPane(); });

  function keyPane(): HTMLElement {
    const owner = h('select', { class: 'input', 'aria-label': 'Owner' },
      h('option', { value: '' }, 'No user (tagged device)'),
      users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(userId ?? users[0]?.id) }, `${userLabel(u)}${u.email ? ' — ' + u.email : ''}`)));
    const reusable = h('input', { type: 'checkbox' });
    const ephemeral = h('input', { type: 'checkbox' });
    const exp = h('select', { class: 'input', 'aria-label': 'Key valid for' },
      [['1', '1 hour'], ['24', '1 day'], ['168', '7 days'], ['720', '30 days'], ['2160', '90 days']].map(([v, l]) => h('option', { value: v, selected: v === '24' }, l)));
    const tagChips = chipInput([], { placeholder: 'tag:server', normalize: tagNormalize, validate: (s) => (TAG_RE.test(s) ? null : `"${s}" is not a valid tag.`) });
    const out = h('div');
    const gen = button('Generate install command', { variant: 'primary', icon: 'sparkle' });
    gen.addEventListener('click', async () => {
      clear(out);
      gen.disabled = true;
      gen.classList.add('loading');
      try {
        const tags = tagChips.get();
        if (!owner.value && !tags.length) throw new Error('A key without a user must have at least one tag.');
        const k = await ctx.api.createPreAuthKey({
          ...(owner.value ? { user: owner.value } : {}),
          reusable: reusable.checked,
          ephemeral: ephemeral.checked,
          expiration: new Date(Date.now() + Number(exp.value) * 3600000).toISOString(),
          aclTags: tags,
        });
        ctx.invalidate();
        // With automatic collection on, the commands also send the device's log here.
        const st = ctx.config.auditLog ? await ctx.api.collector().catch(() => null) : null;
        out.appendChild(keyResult(url, k.key, tags, logTarget(ctx, st, `k${k.id}`)));
      } catch (e) {
        out.appendChild(callout('error', null, (e as Error).message));
      } finally { gen.disabled = false; gen.classList.remove('loading'); }
    });
    return h('div', { class: 'stack' },
      h('p', { class: 'help' }, 'Create a pre-authentication key and run the command on the device you want to add. No browser login needed.'),
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Owner'), owner),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Key valid for'), exp)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Tags', h('span', { class: 'muted' }, ' (optional)')), tagChips.el),
      h('div', { class: 'grid-2' },
        h('label', { class: 'check' }, reusable, h('span', h('span', { class: 'check-label' }, 'Reusable'), h('span', { class: 'help' }, 'Use this key to add multiple devices.'))),
        h('label', { class: 'check' }, ephemeral, h('span', h('span', { class: 'check-label' }, 'Ephemeral'), h('span', { class: 'help' }, 'Devices are removed automatically when they go offline.')))),
      h('div', gen),
      out);
  }

  function registerPane(): HTMLElement {
    const input = h('input', { class: 'input mono', placeholder: `${url}/register/hskey-authreq-…`, spellcheck: 'false', 'aria-label': 'Registration URL or auth ID' });
    const owner = h('select', { class: 'input', 'aria-label': 'Assign to user' }, users.map((u) => h('option', { value: u.name }, `${userLabel(u)}${u.email ? ' — ' + u.email : ''}`)));
    const out = h('div');
    const go = button('Register device', { variant: 'primary', icon: 'check' });
    go.addEventListener('click', async () => {
      clear(out);
      const raw = input.value.trim();
      const found = raw.match(/hskey-authreq-[A-Za-z0-9_-]+/) || raw.match(/(?:register\/|key=)([A-Za-z0-9_:-]+)/);
      const id = found ? (found[1] || found[0]) : raw;
      if (!id) { out.appendChild(callout('error', null, 'Paste the registration URL or auth ID shown by the device.')); return; }
      if (!owner.value) { out.appendChild(callout('error', null, 'Create a user first.')); return; }
      go.disabled = true;
      go.classList.add('loading');
      try {
        const node = await ctx.api.registerAuth(owner.value, id);
        m.close(true);
        done(ctx, `${node ? nodeName(node) : 'Device'} registered`, after);
      } catch (e) {
        out.appendChild(callout('error', 'Registration failed', (e as Error).message));
      } finally { go.disabled = false; go.classList.remove('loading'); }
    });
    return h('div', { class: 'stack' },
      h('p', { class: 'help' }, 'On the device, run the command below. It prints a login URL — paste that URL here to approve the device.'),
      commandBuilder(url),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Registration URL or auth ID'), input),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Assign to user'), owner),
      h('div', go), out);
  }

  const renderPane = (): void => { clear(paneEl).appendChild(current === 'key' ? keyPane() : registerPane()); };
  const m = modal({ title: 'Add device', subtitle: `Connect a new device to ${hostOf(url)}`, size: 'lg', body: h('div', { class: 'stack' }, tabBar, paneEl), footer: [] });
  m.setFooter();
  renderPane();
}

// -------------------------------------------------------- command builder --
const defaultOS = (): JoinOS => (/Mac/i.test(navigator.platform) ? 'mac' : /Win/i.test(navigator.platform) ? 'win' : 'linux');
// Values end up in a shell; join.ts quotes them too, this just keeps them readable.
const safe = (re: RegExp) => (s: string): string => s.replace(re, '');

/** OS tabs + option toggles that rebuild the join command live. */
export function commandBuilder(url: string, key?: string, tags: string[] = [], logsTo?: string): HTMLDivElement {
  let os = defaultOS();
  const o: JoinOptions & { oneLine?: boolean } = { acceptRoutes: true, acceptDns: true, install: true, verify: true, ...(logsTo ? { logTarget: logsTo } : {}) };
  const box = h('div');
  const actions = h('div', { class: 'row-gap' });
  const command = (): string => {
    const text = joinCommand(os, url, key, tags, o);
    return o.oneLine && os !== 'docker' && os !== 'compose' ? text.split('\n').join(os === 'win' ? '; ' : ' && ') : text;
  };
  const show = (): void => {
    clear(box).appendChild(codeBlock(command()));
    clear(actions);
    if (os === 'mac' || os === 'linux') {
      actions.appendChild(button('Download as script', {
        size: 'sm', icon: 'download',
        onClick: () => download(`join-${hostOf(url)}.sh`, joinScript(os as 'mac' | 'linux', url, key, tags, o), 'text/x-shellscript'),
      }));
    }
  };
  const check = (prop: keyof typeof o, label: string, help: string): HTMLLabelElement => {
    const cb = h('input', { type: 'checkbox', checked: !!o[prop], 'aria-label': label });
    cb.addEventListener('change', () => { (o as Record<string, unknown>)[prop] = cb.checked; show(); });
    return h('label', { class: 'check' }, cb, h('span', h('span', { class: 'check-label' }, label), h('span', { class: 'help' }, help)));
  };
  const sendLogs = (): HTMLLabelElement => {
    const cb = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Send logs to the console' });
    cb.addEventListener('change', () => { if (cb.checked) o.logTarget = logsTo; else delete o.logTarget; show(); });
    return h('label', { class: 'check' }, cb, h('span', h('span', { class: 'check-label' }, 'Send logs to the console'), h('span', { class: 'help' }, 'The device sends its Tailscale log to this console\'s Logs page.')));
  };
  const text = (prop: 'hostname' | 'useExitNode' | 'operator' | 'routes', label: string, placeholder: string, parse: (s: string) => string | string[]): HTMLLabelElement => {
    const inp = h('input', { class: 'input mono', placeholder, spellcheck: 'false', 'aria-label': label });
    inp.addEventListener('input', () => { (o as Record<string, unknown>)[prop] = parse(inp.value.trim()); show(); });
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label, h('span', { class: 'muted' }, ' (optional)')), inp);
  };
  show();
  return h('div', { class: 'stack' },
    tabs((Object.entries(OS_LABELS) as Array<[JoinOS, string]>).map(([id, label]) => ({ id, label })), os, (id) => { os = id; show(); }),
    box,
    actions,
    h('details', h('summary', { class: 'small' }, 'Command options'),
      h('div', { class: 'stack pad-y' },
        h('div', { class: 'grid-2' },
          logsTo ? sendLogs() : null,
          check('install', 'Install Tailscale', 'Include the step that installs Tailscale.'),
          check('verify', 'Show status afterwards', 'Run tailscale status once connected.'),
          check('oneLine', 'Single line', 'Join the steps into one command.'),
          check('acceptRoutes', 'Accept routes', 'Use subnet routes advertised by other devices.'),
          check('acceptDns', 'Accept DNS', 'Use MagicDNS and the tailnet\'s DNS settings.'),
          check('exitNode', 'Advertise exit node', 'Offer this device as an exit node (approve it afterwards).'),
          check('ssh', 'Tailscale SSH', 'Run the SSH server (Linux; not the macOS App Store app).'),
          check('reset', 'Reset settings', 'Clear flags from a previous tailscale up on this device.'),
          check('shieldsUp', 'Shields up', 'Block all incoming connections to this device.'),
          check('exitLan', 'Allow LAN with exit node', 'Keep local network access while using an exit node.'),
          check('forceReauth', 'Force re-authentication', 'Log in again even if the device is already connected.'),
          check('qr', 'Show QR code', 'Print the login URL as a QR code (for interactive login).')),
        h('div', { class: 'grid-2' },
          text('hostname', 'Hostname', 'my-laptop', (s) => safe(/[^a-z0-9-]/g)(s.toLowerCase())),
          text('routes', 'Advertise routes', '192.168.1.0/24, 10.0.0.0/8', (s) => s.split(/[\s,]+/).filter(validCIDR)),
          text('useExitNode', 'Use exit node', '100.64.0.5 or exit-node-name', safe(/[^A-Za-z0-9.:-]/g)),
          text('operator', 'Operator (Linux user)', 'alice', safe(/[^a-z0-9_-]/gi))))));
}

export function keyResult(url: string, key: string, tags: string[] = [], logsTo?: string): HTMLDivElement {
  return h('div', { class: 'stack key-result' },
    callout('success', 'Auth key created', 'Copy it now — for security it won\'t be shown in full again.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Auth key'), codeBlock(key, { wrap: true })),
    commandBuilder(url, key, tags, logsTo));
}
