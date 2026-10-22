// Node actions shared by the Machines list, machine detail and Routes pages.
import { h, modal, button, toast, confirmDialog, formDialog, chipInput, callout, toggle, clear, codeBlock, tabs } from '../ui.js';
import {
  nodeName, nodeTags, expiryState, routeInfo, isExitRoute, EXIT_ROUTES, validCIDR, parseHuJSON,
  isoInDays, userLabel, hostOf,
} from '../util.js';

// MagicDNS label rules (lowercase letters, digits, hyphens; max 63 chars)
export function validLabel(s) {
  if (!s) return 'Name is required.';
  if (s.length > 63) return 'Name must be 63 characters or fewer.';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) return 'Use lowercase letters, numbers and hyphens; it can\'t start or end with a hyphen.';
  return null;
}

export function magicName(ctx, n) {
  const base = ctx.prefs.baseDomain;
  return base ? `${nodeName(n)}.${base}` : nodeName(n);
}

export function serverUrl(ctx) {
  return ctx.config.lockedUrl || ctx.conn?.url || '';
}

async function policyTags(ctx) {
  try {
    const p = await ctx.api.getPolicy();
    const parsed = p.policy ? parseHuJSON(p.policy) : null;
    return parsed?.ok ? Object.keys(parsed.value.tagOwners || {}) : [];
  } catch { return []; }
}

function done(ctx, msg, after) {
  toast(msg, 'success');
  ctx.invalidate();
  after?.();
}

// ------------------------------------------------------------------ rename --
export async function renameNode(ctx, n, after) {
  const r = await formDialog({
    title: 'Edit machine name',
    subtitle: 'This name is used for MagicDNS and shown across the console.',
    fields: [{
      name: 'name', label: 'Machine name', value: nodeName(n), mono: true,
      help: `Lowercase letters, numbers and hyphens. Hostname reported by the device: ${n.name || '—'}`,
    }],
    onSubmit: async (v) => {
      const name = v.name.toLowerCase();
      const err = validLabel(name);
      if (err) throw new Error(err);
      if (name === nodeName(n)) return true;
      await ctx.api.renameNode(n.id, name);
      return true;
    },
  });
  if (r) done(ctx, 'Machine renamed', after);
}

// -------------------------------------------------------------------- tags --
export async function editTags(ctx, n, after) {
  const current = nodeTags(n);
  const known = await policyTags(ctx);
  const chips = chipInput(current, {
    placeholder: 'tag:server',
    suggestions: known,
    normalize: (s) => (s.startsWith('tag:') ? s : `tag:${s}`).toLowerCase(),
    validate: (s) => (/^tag:[a-z0-9][a-z0-9-_]*$/.test(s) ? null : `"${s}" is not a valid tag (use tag:name).`),
  });
  const wasUserOwned = !!n.user;
  await formDialog({
    title: 'Edit ACL tags',
    subtitle: nodeName(n),
    size: 'md',
    fields: [],
    extra: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Tags'), chips.el,
        h('span', { class: 'help' }, known.length
          ? `Tags defined in your policy: ${known.join(', ')}`
          : 'Tags must be listed under tagOwners in your access control policy.')),
      wasUserOwned ? callout('info', 'Tagging changes ownership',
        'Like Tailscale, a tagged device is owned by its tags instead of a user. Its identity in ACLs becomes the tags.') : null),
    onSubmit: async () => {
      const tags = chips.get();
      await ctx.api.setTags(n.id, tags);
      return true;
    },
    submitLabel: 'Save tags',
  }).then((r) => { if (r) done(ctx, 'Tags updated', after); });
}

// ------------------------------------------------------------------ routes --
export function editRoutes(ctx, n, after) {
  const info = routeInfo(n);
  const approved = new Set(info.approved);
  let subnets = [...info.subnets];

  const list = h('div', { class: 'route-list' });
  const exitWrap = h('div');
  const addInput = h('input', { class: 'input mono', placeholder: '10.0.0.0/24', spellcheck: 'false' });
  const addErr = h('div', { class: 'help error-text' });

  const renderList = () => {
    clear(list);
    if (!subnets.length) {
      list.appendChild(h('div', { class: 'muted small pad-y' }, 'This machine is not advertising any subnet routes.',
        h('br'), 'Advertise with ', h('code', 'tailscale set --advertise-routes=192.168.1.0/24'), '.'));
    }
    for (const r of subnets) {
      const advertised = info.available.includes(r);
      const cb = h('input', { type: 'checkbox', checked: approved.has(r) });
      cb.addEventListener('change', () => { cb.checked ? approved.add(r) : approved.delete(r); });
      list.appendChild(h('label', { class: 'route-row' }, cb,
        h('span', { class: 'mono' }, r),
        info.primary.includes(r) ? h('span', { class: 'badge badge-success' }, 'Primary') : null,
        !advertised ? h('span', { class: 'badge badge-neutral', title: 'Approved ahead of time; the device is not currently advertising it' }, 'Not advertised') : null));
    }
  };
  renderList();

  const exitOn = EXIT_ROUTES.some((r) => approved.has(r));
  clear(exitWrap).appendChild(h('div', { class: 'setting-row' },
    h('div', h('div', { class: 'setting-title' }, 'Use as exit node'),
      h('div', { class: 'help' }, info.exitAdvertised
        ? 'Allow other devices to route all internet traffic through this machine.'
        : 'This machine is not advertising itself as an exit node (tailscale set --advertise-exit-node). You can still pre-approve it.')),
    toggle(exitOn, (v) => { EXIT_ROUTES.forEach((r) => (v ? approved.add(r) : approved.delete(r))); })));

  const addRoute = () => {
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
      h('section', h('h3', { class: 'section-title' }, 'Exit node'), exitWrap),
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
      errBox.appendChild(callout('error', null, e.message));
    } finally { save.disabled = false; save.classList.remove('loading'); }
  });
}

export async function setRouteApproved(ctx, n, route, on, after) {
  const set = new Set(n.approvedRoutes || []);
  const targets = isExitRoute(route) ? EXIT_ROUTES : [route];
  targets.forEach((r) => (on ? set.add(r) : set.delete(r)));
  try {
    await ctx.api.setApprovedRoutes(n.id, [...set]);
    done(ctx, on ? `Approved ${isExitRoute(route) ? 'exit node' : route}` : `Removed approval for ${isExitRoute(route) ? 'exit node' : route}`, after);
  } catch (e) {
    toast(e.message, 'error');
    after?.();
  }
}

// ------------------------------------------------------------------ expiry --
export async function disableExpiry(ctx, n, after) {
  try {
    await ctx.api.disableNodeExpiry(n.id);
    done(ctx, 'Key expiry disabled', after);
  } catch (e) { toast(e.message, 'error'); }
}

export async function setExpiry(ctx, n, after) {
  const st = expiryState(n);
  const d = new Date(Date.now() + 180 * 86400000);
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
      value: d.toISOString().slice(0, 10), help: 'Only used when "Custom date" is selected.',
    }],
    submitLabel: 'Save expiry',
    onSubmit: async (v) => {
      let iso;
      if (v.preset === 'custom') {
        if (!v.date) throw new Error('Pick a date.');
        const dt = new Date(v.date + 'T23:59:59');
        if (dt <= new Date()) throw new Error('The date must be in the future. Use "Expire key" to expire it now.');
        iso = dt.toISOString();
      } else iso = isoInDays(+v.preset);
      await ctx.api.setNodeExpiry(n.id, iso);
      return true;
    },
  });
  if (r) done(ctx, 'Key expiry updated', after);
}

export async function expireNow(ctx, n, after) {
  const ok = await confirmDialog({
    title: 'Expire machine key?',
    message: `${nodeName(n)} will be disconnected from the tailnet until it re-authenticates (tailscale up). This cannot be undone.`,
    confirmLabel: 'Expire key',
    danger: true,
    onConfirm: () => ctx.api.expireNode(n.id),
  });
  if (ok) done(ctx, 'Machine key expired', after);
}

// ------------------------------------------------------------------ delete --
export async function deleteNode(ctx, n, after) {
  const ok = await confirmDialog({
    title: 'Remove machine?',
    message: h('div', { class: 'stack-sm' },
      h('p', 'This permanently removes ', h('strong', nodeName(n)), ' from the tailnet. Its IP addresses are released and it will need to be registered again to rejoin.')),
    confirmLabel: 'Remove machine',
    danger: true,
    onConfirm: () => ctx.api.deleteNode(n.id),
  });
  if (ok) done(ctx, `${nodeName(n)} removed`, after);
}

// ------------------------------------------------------------------- menu --
export function nodeMenuItems(ctx, n, after, { includeView = true } = {}) {
  const st = expiryState(n);
  const ri = routeInfo(n);
  return [
    includeView ? { label: 'View machine details', icon: 'eye', onClick: () => ctx.navigate(`#/machines/${n.id}`) } : null,
    includeView ? { divider: true } : null,
    { label: 'Edit machine name…', icon: 'edit', onClick: () => renameNode(ctx, n, after) },
    { label: 'Edit route settings…', icon: 'routes', hint: ri.pendingSubnets.length || ri.exitPending ? 'Pending' : null, onClick: () => editRoutes(ctx, n, after) },
    { label: 'Edit ACL tags…', icon: 'tag', onClick: () => editTags(ctx, n, after) },
    { divider: true },
    st.disabled
      ? { label: 'Enable key expiry…', icon: 'clock', onClick: () => setExpiry(ctx, n, after) }
      : { label: 'Disable key expiry', icon: 'unlock', onClick: () => disableExpiry(ctx, n, after) },
    !st.disabled ? { label: 'Change key expiry…', icon: 'clock', onClick: () => setExpiry(ctx, n, after) } : null,
    { label: 'Expire key', icon: 'lock', onClick: () => expireNow(ctx, n, after) },
    { divider: true },
    { label: 'Remove…', icon: 'trash', danger: true, onClick: () => deleteNode(ctx, n, after) },
  ];
}

// ------------------------------------------------------------- add device --
export function addDevice(ctx, after, { initialTab = 'key', userId } = {}) {
  const users = ctx.data.users || [];
  const url = serverUrl(ctx);
  const body = h('div', { class: 'stack' });
  let current = initialTab;

  const panes = {
    key: () => keyPane(),
    register: () => registerPane(),
  };

  const tabBar = tabs([
    { id: 'key', label: 'Generate auth key', icon: 'key' },
    { id: 'register', label: 'Register with auth ID', icon: 'link' },
  ], current, (id) => { current = id; renderPane(); });
  const paneEl = h('div');
  body.append(tabBar, paneEl);

  const renderPane = () => { clear(paneEl).appendChild(panes[current]()); m.setFooter(); };

  function keyPane() {
    const owner = h('select', { class: 'input' },
      h('option', { value: '' }, 'No user (tagged device)'),
      users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(userId ?? users[0]?.id) }, `${userLabel(u)}${u.email ? ' — ' + u.email : ''}`)));
    const reusable = h('input', { type: 'checkbox' });
    const ephemeral = h('input', { type: 'checkbox' });
    const exp = h('select', { class: 'input' },
      [['1', '1 hour'], ['24', '1 day'], ['168', '7 days'], ['720', '30 days'], ['2160', '90 days']].map(([v, l]) =>
        h('option', { value: v, selected: v === '24' }, l)));
    const tagChips = chipInput([], {
      placeholder: 'tag:server',
      normalize: (s) => (s.startsWith('tag:') ? s : `tag:${s}`).toLowerCase(),
      validate: (s) => (/^tag:[a-z0-9][a-z0-9-_]*$/.test(s) ? null : `"${s}" is not a valid tag.`),
    });
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
          user: owner.value || undefined,
          reusable: reusable.checked,
          ephemeral: ephemeral.checked,
          expiration: new Date(Date.now() + +exp.value * 3600000).toISOString(),
          aclTags: tags,
        });
        ctx.invalidate();
        out.appendChild(keyResult(url, k.key, tags));
      } catch (e) {
        out.appendChild(callout('error', null, e.message));
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

  function registerPane() {
    const input = h('input', { class: 'input mono', placeholder: `${url}/register/hskey-authreq-…`, spellcheck: 'false' });
    const owner = h('select', { class: 'input' }, users.map((u) => h('option', { value: u.name }, `${userLabel(u)}${u.email ? ' — ' + u.email : ''}`)));
    const out = h('div');
    const go = button('Register device', { variant: 'primary', icon: 'check' });
    go.addEventListener('click', async () => {
      clear(out);
      const raw = input.value.trim();
      const m2 = raw.match(/hskey-authreq-[A-Za-z0-9_-]+/) || raw.match(/(?:register\/|key=)([A-Za-z0-9_:-]+)/);
      const id = m2 ? (m2[1] || m2[0]) : raw;
      if (!id) { out.appendChild(callout('error', null, 'Paste the registration URL or auth ID shown by the device.')); return; }
      if (!owner.value) { out.appendChild(callout('error', null, 'Create a user first.')); return; }
      go.disabled = true;
      go.classList.add('loading');
      try {
        const node = await ctx.api.registerAuth(owner.value, id);
        m.close(true);
        done(ctx, `${node ? nodeName(node) : 'Device'} registered`, after);
      } catch (e) {
        out.appendChild(callout('error', 'Registration failed', e.message));
      } finally { go.disabled = false; go.classList.remove('loading'); }
    });
    return h('div', { class: 'stack' },
      h('p', { class: 'help' }, 'On the device, run the command below. It prints a login URL — paste that URL here to approve the device.'),
      commandBuilder(url),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Registration URL or auth ID'), input),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Assign to user'), owner),
      h('div', go), out);
  }

  const m = modal({ title: 'Add device', subtitle: `Connect a new device to ${hostOf(url)}`, size: 'lg', body, footer: [] });
  renderPane();
  return m;
}

const OS_LABELS = { mac: 'macOS', linux: 'Linux', win: 'Windows', docker: 'Docker' };
// The macOS app doesn't put `tailscale` on PATH, so call the bundled CLI directly.
const TS_CLI = { mac: 'sudo /Applications/Tailscale.app/Contents/MacOS/Tailscale', linux: 'sudo tailscale', win: 'tailscale' };
const defaultOS = () => (/Mac/i.test(navigator.platform) ? 'mac' : /Win/i.test(navigator.platform) ? 'win' : 'linux');

// Flags shared by every platform; `o` holds the toggles from the key result UI.
function upFlags(url, key, tags, o) {
  return [
    key && `--auth-key=${key}`,
    `--login-server=${url}`,
    o.acceptRoutes && '--accept-routes',
    o.acceptDns === false && '--accept-dns=false',
    o.exitNode && '--advertise-exit-node',
    o.routes?.length && `--advertise-routes=${o.routes.join(',')}`,
    tags.length && `--advertise-tags=${tags.join(',')}`,
    o.hostname && `--hostname=${o.hostname}`,
    o.ssh && '--ssh',
    o.reset && '--reset',
  ].filter(Boolean);
}

export function upCommand(os, url, key, tags = [], o = {}) {
  const flags = upFlags(url, key, tags, o);
  if (os === 'docker') {
    const extra = flags.filter((f) => !f.startsWith('--auth-key'));
    return `docker run -d --name tailscaled --cap-add NET_ADMIN --device /dev/net/tun \\\n  ${key ? `-e TS_AUTHKEY=${key} \\\n  ` : ''}-e TS_EXTRA_ARGS="${extra.join(' ')}" \\\n  -e TS_STATE_DIR=/var/lib/tailscale -v tailscale-state:/var/lib/tailscale \\\n  tailscale/tailscale:latest`;
  }
  if (os === 'win') flags.push('--unattended');
  const up = `${TS_CLI[os]} up ${flags.join(' ')}`;
  return os === 'linux' ? `curl -fsSL https://tailscale.com/install.sh | sh\n${up}` : up;
}

// OS tabs + option toggles that rebuild the `tailscale up` command live.
export function commandBuilder(url, key, tags = []) {
  let os = defaultOS();
  const o = { acceptRoutes: true, acceptDns: true };
  const box = h('div');
  const show = () => clear(box).appendChild(codeBlock(upCommand(os, url, key, tags, o)));
  const check = (prop, label, help) => {
    const cb = h('input', { type: 'checkbox', checked: !!o[prop], onchange: () => { o[prop] = cb.checked; show(); } });
    return h('label', { class: 'check' }, cb, h('span', h('span', { class: 'check-label' }, label), h('span', { class: 'help' }, help)));
  };
  const text = (prop, placeholder, parse) => {
    const inp = h('input', { class: 'input mono', placeholder, spellcheck: 'false' });
    inp.addEventListener('input', () => { o[prop] = parse(inp.value.trim()); show(); });
    return inp;
  };
  show();
  return h('div', { class: 'stack' },
    tabs(Object.entries(OS_LABELS).map(([id, label]) => ({ id, label })), os, (id) => { os = id; show(); }),
    box,
    h('details', h('summary', { class: 'small' }, 'Command options'),
      h('div', { class: 'stack pad-y' },
        h('div', { class: 'grid-2' },
          check('acceptRoutes', 'Accept routes', 'Use subnet routes advertised by other devices.'),
          check('acceptDns', 'Accept DNS', 'Use MagicDNS and the tailnet\'s DNS settings.'),
          check('exitNode', 'Advertise exit node', 'Offer this device as an exit node (approve it afterwards).'),
          check('ssh', 'Tailscale SSH', 'Run the SSH server (Linux; not the macOS App Store app).'),
          check('reset', 'Reset settings', 'Clear flags from a previous tailscale up on this device.')),
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Hostname', h('span', { class: 'muted' }, ' (optional)')),
            text('hostname', 'my-laptop', (s) => s.toLowerCase().replace(/[^a-z0-9-]/g, ''))),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Advertise routes', h('span', { class: 'muted' }, ' (optional)')),
            text('routes', '192.168.1.0/24, 10.0.0.0/8', (s) => s.split(/[\s,]+/).filter(validCIDR)))))));
}

export function keyResult(url, key, tags = []) {
  return h('div', { class: 'stack key-result' },
    callout('success', 'Auth key created', 'Copy it now — for security it won\'t be shown in full again.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Auth key'), codeBlock(key, { wrap: true })),
    commandBuilder(url, key, tags));
}

