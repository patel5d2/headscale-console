import type { Node } from '../../shared/types.js';
import type { RouteInfo } from '../../shared/model.js';
import type { Ctx } from '../types.js';
import { h, icon, badge, statusDot, emptyState, errorState, clear, toggle, tabs, spinner } from '../ui.js';
import { nodeName, routeInfo, relTime, parseTime, ownerLabel, pluralize } from '../util.js';
import { setRouteApproved } from './actions.js';

export async function render(ctx: Ctx, _params: unknown, root: HTMLElement): Promise<() => void> {
  let view: 'all' | 'pending' = 'all';
  let destroyed = false;
  const content = h('div', h('div', { class: 'center pad-y' }, spinner(24)));
  const tabBar = h('div');

  root.append(
    h('div', { class: 'page-head' },
      h('div', h('h1', 'Routes'), h('p', { class: 'muted' }, 'Subnet routers and exit nodes advertised across your tailnet.'))),
    tabBar, content);

  async function refresh(force: boolean): Promise<void> {
    try {
      await ctx.load(force);
      if (!destroyed) draw();
    } catch (e) {
      if (!destroyed) clear(content).appendChild(errorState(e, () => void refresh(true)));
    }
  }
  const after = (): void => void refresh(true);

  function machineCell(n: Node): HTMLDivElement {
    const o = ownerLabel(n);
    return h('div', { class: 'machine-cell' },
      h('div', { class: 'machine-name' }, statusDot(n.online), h('a', { href: `#/machines/${n.id}` }, nodeName(n))),
      h('div', { class: 'machine-owner' }, h('span', o.tagged ? o.sub : o.label),
        h('span', { class: 'muted' }, ' · ', n.online ? 'connected' : `seen ${relTime(parseTime(n.lastSeen))}`)));
  }

  function draw(): void {
    const nodes = ctx.data.nodes || [];
    const exits: Array<{ n: Node; ri: RouteInfo }> = [];
    const subnets = new Map<string, Array<{ n: Node; ri: RouteInfo }>>(); // prefix → routers
    let pending = 0;
    for (const n of nodes) {
      const ri = routeInfo(n);
      if (ri.exitAdvertised || ri.exitApproved) {
        exits.push({ n, ri });
        if (ri.exitPending) pending++;
      }
      for (const r of ri.subnets) {
        subnets.set(r, [...(subnets.get(r) || []), { n, ri }]);
        if (ri.available.includes(r) && !ri.approved.includes(r)) pending++;
      }
    }

    clear(tabBar).appendChild(tabs<'all' | 'pending'>([
      { id: 'all', label: 'All routes', count: subnets.size + (exits.length ? 1 : 0) },
      { id: 'pending', label: 'Awaiting approval', count: pending },
    ], view, (v) => { view = v; draw(); }));

    clear(content);
    if (!exits.length && !subnets.size) {
      content.appendChild(emptyState('routes', 'No routes advertised',
        h('span', 'Share a local network with ', h('code', 'tailscale set --advertise-routes=192.168.1.0/24'),
          ' or offer an exit node with ', h('code', 'tailscale set --advertise-exit-node'), '.')));
      return;
    }

    const onlyPending = view === 'pending';

    // Exit nodes
    const exitRows = exits.filter(({ ri }) => !onlyPending || ri.exitPending).map(({ n, ri }) => h('tr',
      h('td', machineCell(n)),
      h('td', { class: 'mono hide-sm' }, '0.0.0.0/0, ::/0'),
      h('td', ri.exitApproved ? badge('Allowed', 'success', 'check') : ri.exitAdvertised ? badge('Awaiting approval', 'warning', 'alert') : badge('Pre-approved', 'neutral')),
      h('td', { class: 'col-actions' }, toggle(ri.exitApproved, (on) => void setRouteApproved(ctx, n, '0.0.0.0/0', on, after), { ariaLabel: 'Allow exit node' }))));

    // Subnets grouped by prefix (several routers for one prefix = HA)
    const subnetRows: HTMLTableRowElement[] = [];
    for (const [prefix, list] of [...subnets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const filtered = list.filter(({ ri }) => !onlyPending || (ri.available.includes(prefix) && !ri.approved.includes(prefix)));
      if (!filtered.length) continue;
      const ha = list.filter(({ ri }) => ri.approved.includes(prefix)).length > 1;
      filtered.forEach(({ n, ri }, i) => {
        const approved = ri.approved.includes(prefix);
        const primary = ri.primary.includes(prefix);
        subnetRows.push(h('tr', { class: i > 0 ? 'grouped' : '' },
          h('td', { class: 'mono' }, i === 0 ? h('span', prefix, ha ? h('span', { class: 'badge badge-info ml-1', title: 'Multiple approved routers — Headscale fails over automatically' }, 'HA') : null) : ''),
          h('td', machineCell(n)),
          h('td', !ri.available.includes(prefix) ? badge('Not advertised', 'neutral')
            : primary ? badge('Primary', 'success', 'check') : approved ? badge('Standby', 'neutral') : badge('Awaiting approval', 'warning', 'alert')),
          h('td', { class: 'col-actions' }, toggle(approved, (on) => void setRouteApproved(ctx, n, prefix, on, after), { ariaLabel: `Approve ${prefix}` }))));
      });
    }

    if (exitRows.length) {
      content.appendChild(h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', icon('exit', 16), ' Exit nodes'), h('span', { class: 'muted' }, pluralize(exitRows.length, 'machine'))),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', h('tr', h('th', 'Machine'), h('th', { class: 'hide-sm' }, 'Routes'), h('th', 'Status'), h('th', { class: 'col-actions' }, 'Approved'))),
          h('tbody', exitRows)))));
    }
    if (subnetRows.length) {
      content.appendChild(h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', icon('routes', 16), ' Subnet routes'), h('span', { class: 'muted' }, pluralize(subnets.size, 'subnet'))),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', h('tr', h('th', 'Subnet'), h('th', 'Router'), h('th', 'Status'), h('th', { class: 'col-actions' }, 'Approved'))),
          h('tbody', subnetRows)))));
    }
    if (!exitRows.length && !subnetRows.length) {
      content.appendChild(emptyState('check', 'All caught up', 'There are no routes waiting for approval.'));
    }
    content.appendChild(h('p', { class: 'help mt-3' }, icon('info', 13), ' Tip: add ', h('code', 'autoApprovers'),
      ' to your ', h('a', { href: '#/acls' }, 'access control policy'), ' to approve routes automatically.'));
  }

  await refresh(true);
  const t = setInterval(() => { if (!document.hidden) void refresh(true); }, 20000);
  return () => { destroyed = true; clearInterval(t); };
}

