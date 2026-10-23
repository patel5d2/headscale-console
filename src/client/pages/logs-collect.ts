// Automatic log collection on the Logs page: the on/off switch, device logs and network
// activity. The server side is src/server/collector.ts and ingest.ts.
import { logStep, OS_LABELS, type JoinOS } from '../../shared/join.js';
import type { Node } from '../../shared/types.js';
import type { Activity, CollectorStatus, DeviceLabel } from '../api.js';
import type { Ctx } from '../types.js';
import type { BadgeKind } from '../ui.js';
import { badge, button, callout, clear, codeBlock, confirmDialog, emptyState, errorState, h, modal, put, spinner, tabs, toast } from '../ui.js';
import { debounce, download, fmtDate, nodeName, relTime, store } from '../util.js';

/** The address devices send their logs to: set on this page, else PUBLIC_URL, else what this browser uses. */
export const deviceBase = (ctx: Ctx): string => store.get('logs.deviceUrl', ctx.config.publicUrl || location.origin).replace(/\/+$/, '');

/** A device's log address, or undefined while collection is off. */
export const logTarget = (ctx: Ctx, st: CollectorStatus | null, label: string): string | undefined =>
  st?.enabled && st.ingestPath ? `${deviceBase(ctx)}/${st.ingestPath}/${label}` : undefined;

/** Why devices might not reach `base`, or null if it looks fine. */
export function addressProblem(base: string): string | null {
  let u: URL;
  try { u = new URL(base); } catch { return 'Enter the full address, e.g. https://hs.example.com:8090.'; }
  if (/^(localhost|127\.|\[::1\])/.test(u.host)) return 'Devices can\'t reach "localhost". Use this machine\'s LAN, tailnet or public address.';
  const tailnetOrLan = /^(100\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[fd)/.test(u.hostname) || u.hostname.endsWith('.ts.net');
  if (u.protocol === 'http:' && !tailnetOrLan) return 'Logs would cross the internet unencrypted. Use an https:// address (see "Behind a reverse proxy" in the README) or the console\'s tailnet address.';
  return null;
}

/** The on/off switch and its state. `changed` re-renders the page. */
export function collectionCard(ctx: Ctx, st: CollectorStatus | null, changed: () => void): HTMLElement {
  if (!ctx.config.auditLog) {
    return callout('info', 'Automatic collection is not available',
      h('span', 'It needs the console locked to your Headscale server (HEADSCALE_URL) and a data volume (DATA_DIR). Installing the console on the Headscale server with ', h('code', 'install-vm.sh --url … --host-actions'), ' does both.'));
  }
  if (!st?.enabled) {
    const on = button('Turn on automatic collection', { variant: 'primary', icon: 'activity' });
    on.addEventListener('click', async () => {
      on.disabled = true;
      on.classList.add('loading');
      try {
        // The console gets an API key of its own (valid 1 year), so collection keeps
        // running when nobody is signed in.
        const key = await ctx.api.createApiKey(new Date(Date.now() + 365 * 86400000).toISOString());
        await ctx.api.enableCollector(key);
        toast('Automatic collection is on', 'success');
        changed();
      } catch (e) {
        toast((e as Error).message, 'error');
        on.disabled = false;
        on.classList.remove('loading');
      }
    });
    return callout('info', 'Collect logs automatically',
      h('div', { class: 'stack-sm' },
        h('span', 'Records network activity (machines joining, leaving, going online and offline, route, tag and owner changes) in the background, and receives the Tailscale log of every device set up to send it. One click; nothing to install.'),
        h('div', on)));
  }
  const off = button('Turn off', { size: 'sm' });
  off.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Turn off automatic collection?', message: 'Network activity stops being recorded and devices\' logs are refused. What was collected is kept. The console\'s API key is expired.', confirmLabel: 'Turn off', danger: true });
    if (!ok) return;
    try {
      const r = await ctx.api.disableCollector();
      const k = r.prefix ? (await ctx.api.listApiKeys()).find((x) => x.prefix?.includes(r.prefix!)) : undefined;
      if (k) await ctx.api.expireApiKey(k).catch(() => undefined);
      toast('Automatic collection is off', 'success');
      changed();
    } catch (e) { toast((e as Error).message, 'error'); }
  });
  const line = st.error
    ? callout('error', 'Collection has a problem', st.error)
    : callout('success', null, h('span', `Collecting since ${fmtDate(st.since)}`, st.lastPoll ? ` · last check ${relTime(st.lastPoll)}` : ''));
  return h('div', { class: 'row-gap collect-status' }, line, off);
}

// ---------------------------------------------------------------- devices --
const labelsFor = (n: Node): string[] => [`n${n.id}`, ...(n.preAuthKey?.id ? [`k${n.preAuthKey.id}`] : [])];

function setupDialog(ctx: Ctx, st: CollectorStatus, n: Node): void {
  let os: JoinOS = 'linux';
  const box = h('div');
  const show = (): void => {
    const step = logStep(os, logTarget(ctx, st, `n${n.id}`));
    clear(box).append(os === 'docker' || os === 'compose'
      ? h('p', { class: 'help' }, 'Add this environment variable to the Tailscale container and recreate it:', codeBlock(step))
      : codeBlock(step));
  };
  show();
  modal({
    title: `Send ${nodeName(n)}'s log`, size: 'lg',
    body: h('div', { class: 'stack' },
      h('p', { class: 'help' }, 'Run once on the device. It tells Tailscale to send its log to this console and restarts it (the connection drops for a moment). Devices added with the Add device dialog do this as they join.'),
      tabs((Object.entries(OS_LABELS) as Array<[JoinOS, string]>).map(([id, label]) => ({ id, label })), os, (id) => { os = id; show(); }),
      box),
    footer: (api) => [button('Done', { variant: 'primary', onClick: () => api.close() })],
  });
}

function logViewer(ctx: Ctx, label: string, title: string): HTMLElement {
  const search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Search this log…', 'aria-label': 'Search device log' });
  const body = h('div', h('div', { class: 'center pad-y' }, spinner(22)));
  let rows: Array<{ t: number; id: string; m: string }> = [];
  const load = async (): Promise<void> => {
    try {
      rows = await ctx.api.deviceLog(label, search.value.trim());
      clear(body).append(rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' }, h('tbody', rows.map((r) => h('tr',
          h('td', { class: 'nowrap muted small', title: fmtDate(new Date(r.t)) }, relTime(new Date(r.t))),
          h('td', { class: 'mono small muted hide-sm', title: 'Device log ID' }, r.id),
          h('td', { class: 'log-msg' }, r.m))))))
        : h('p', { class: 'help' }, search.value ? 'No matching lines.' : 'No lines yet.'));
    } catch (e) { clear(body).append(errorState(e, () => void load())); }
  };
  search.addEventListener('input', debounce(() => void load(), 250));
  void load();
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', `Log: ${title}`),
      h('div', { class: 'row-gap' }, search,
        button('Refresh', { size: 'sm', icon: 'refresh', onClick: () => void load() }),
        button('Download', { size: 'sm', icon: 'download', onClick: () => download(`${title}.log`, rows.slice().reverse().map((r) => `${new Date(r.t).toISOString()} ${r.m}`).join('\n'), 'text/plain') }))),
    body);
}

export async function devicesView(ctx: Ctx, st: CollectorStatus | null, root: HTMLElement, changed: () => void): Promise<void> {
  if (!st?.enabled) { root.append(emptyState('server', 'Device logs are off', 'Turn on automatic collection above first.')); return; }
  const permission = st.headscaleLogtail === 'on' ? null : headscalePermission(ctx, st, changed);
  const address = h('input', { class: 'input mono', value: deviceBase(ctx), spellcheck: 'false', 'aria-label': 'Address devices use to reach this console' });
  const addressNote = h('div');
  const checkAddress = (): void => { const p = addressProblem(address.value.trim()); clear(addressNote).append(p ? callout('warning', null, p) : ''); };
  address.addEventListener('change', () => { store.set('logs.deviceUrl', address.value.trim().replace(/\/+$/, '')); checkAddress(); });
  checkAddress();
  const list = h('div', h('div', { class: 'center pad-y' }, spinner(22)));
  const viewer = h('div');
  put(root, permission,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Address devices use to reach this console'), address,
      h('span', { class: 'help' }, 'Put in the join commands. It must be reachable from every device: the console\'s public https address or its tailnet address.')),
    addressNote, list, viewer);

  let labels: DeviceLabel[];
  let nodes: Node[];
  try {
    [labels, { nodes }] = await Promise.all([ctx.api.deviceLabels(), ctx.load().then((d) => ({ nodes: d.nodes || [] }))]);
  } catch (e) { clear(list).append(errorState(e)); return; }
  const byLabel = new Map(labels.map((l) => [l.label, l]));
  const open = (label: string, title: string): void => { clear(viewer).append(logViewer(ctx, label, title)); viewer.scrollIntoView({ block: 'nearest' }); };
  const known = new Set<string>();
  const rows = nodes.map((n) => {
    const mine = labelsFor(n).map((l) => byLabel.get(l)).filter((x): x is DeviceLabel => !!x);
    mine.forEach((l) => known.add(l.label));
    const last = Math.max(0, ...mine.map((l) => l.last || 0));
    return h('tr',
      h('td', h('a', { href: `#/machines/${n.id}` }, nodeName(n))),
      h('td', mine.length ? badge(last && Date.now() - last < 3600000 ? 'Receiving' : 'Quiet', last && Date.now() - last < 3600000 ? 'success' : 'neutral') : badge('Not sending', 'warning')),
      h('td', { class: 'muted hide-sm' }, last ? relTime(new Date(last)) : '—'),
      h('td', { class: 'col-actions' }, mine.length
        ? h('div', { class: 'row-gap' }, mine.map((l) => button(mine.length > 1 ? `View ${l.label}` : 'View log', { size: 'sm', onClick: () => open(l.label, nodeName(n)) })))
        : button('Set up…', { size: 'sm', onClick: () => setupDialog(ctx, st, n) })));
  });
  const others = labels.filter((l) => !known.has(l.label)).map((l) => h('tr',
    h('td', { class: 'muted' }, `Removed machine (${l.label})`), h('td', badge('Old', 'neutral')),
    h('td', { class: 'muted hide-sm' }, l.last ? relTime(new Date(l.last)) : '—'),
    h('td', { class: 'col-actions' }, button('View log', { size: 'sm', onClick: () => open(l.label, l.label) }))));
  clear(list).append(nodes.length || others.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', h('tr', h('th', 'Machine'), h('th', 'Log'), h('th', { class: 'hide-sm' }, 'Last line'), h('th', { class: 'col-actions' }))),
      h('tbody', rows, others)))
    : emptyState('machines', 'No machines yet', 'Devices added with the Add device dialog send their log automatically.'));
}

function headscalePermission(ctx: Ctx, st: CollectorStatus, changed: () => void): HTMLElement {
  const snippet = 'logtail:\n  enabled: true';
  if (!st.hostActions) {
    return callout('warning', 'Headscale must allow device logs',
      h('div', { class: 'stack-sm' },
        h('span', 'Headscale tells devices not to send their logs unless this is in its config.yaml (then restart Headscale). Installing the console on the Headscale server with host actions lets it make this change for you.'),
        codeBlock(snippet)));
  }
  const failed = st.headscaleLogtail === 'failed';
  const allow = button(failed ? 'Try again' : 'Allow device logs', { variant: 'primary', icon: 'check' });
  allow.addEventListener('click', async () => {
    allow.disabled = true;
    allow.classList.add('loading');
    try {
      await ctx.api.requestLogtail();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await ctx.api.collector();
        if (s.headscaleLogtail === 'on') { toast('Headscale now allows device logs', 'success'); changed(); return; }
        if (s.headscaleLogtail === 'failed') throw new Error('Headscale did not start with the change; its previous config was restored.');
      }
      throw new Error('No answer from the update helper. Re-run install-vm.sh with --host-actions.');
    } catch (e) {
      toast((e as Error).message, 'error');
      allow.disabled = false;
      allow.classList.remove('loading');
    }
  });
  return callout(failed ? 'error' : 'warning', 'Headscale must allow device logs',
    h('div', { class: 'stack-sm' },
      h('span', 'Headscale tells devices not to send their logs until ', h('code', 'logtail.enabled'), ' is turned on. The console can change it and restart Headscale (a few seconds; the previous config is kept and restored if anything goes wrong).'),
      h('div', allow)));
}

// ------------------------------------------------------- network activity --
const KIND: Record<string, [string, BadgeKind]> = {
  joined: ['Joined', 'success'], removed: ['Removed', 'danger'], online: ['Online', 'success'], offline: ['Offline', 'neutral'],
  renamed: ['Renamed', 'info'], owner: ['Owner', 'info'], addresses: ['Addresses', 'info'], tags: ['Tags', 'tag'],
  routes: ['Routes', 'info'], 'key-expired': ['Key expired', 'warning'],
};

export async function activityView(ctx: Ctx, st: CollectorStatus | null, root: HTMLElement): Promise<void> {
  if (!st?.enabled) { root.append(emptyState('activity', 'Network activity is off', 'Turn on automatic collection above first.')); return; }
  const search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Search machines and events…', 'data-search': true, 'aria-label': 'Search network activity' });
  const body = h('div', h('div', { class: 'center pad-y' }, spinner(22)));
  let rows: Activity[] = [];
  const load = async (): Promise<void> => {
    try {
      rows = await ctx.api.activity(search.value.trim());
      clear(body).append(rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', h('tr', h('th', 'When'), h('th', 'Machine'), h('th', 'Event'), h('th', { class: 'hide-sm' }, 'Details'))),
          h('tbody', rows.map((r) => {
            const [label, kind] = KIND[r.kind] || [r.kind, 'neutral' as BadgeKind];
            return h('tr',
              h('td', { class: 'nowrap', title: fmtDate(r.at) }, relTime(r.at)),
              h('td', r.kind === 'removed' ? r.name : h('a', { href: `#/machines/${r.node}` }, r.name)),
              h('td', badge(label, kind)),
              h('td', { class: 'muted hide-sm' }, r.detail));
          }))))
        : emptyState('activity', search.value ? 'No matching activity' : 'Nothing yet', 'Changes appear here within a minute of happening.'));
    } catch (e) { clear(body).append(errorState(e, () => void load())); }
  };
  search.addEventListener('input', debounce(() => void load(), 250));
  root.append(h('div', { class: 'toolbar' }, search,
    button('Refresh', { size: 'sm', icon: 'refresh', onClick: () => void load() }),
    button('Download', { size: 'sm', icon: 'download', onClick: () => download(`tailnet-activity-${new Date().toISOString().slice(0, 10)}.log`, rows.slice().reverse().map((r) => `${r.at} ${r.kind} ${r.name}: ${r.detail}`).join('\n'), 'text/plain') })),
  body);
  await load();
}
