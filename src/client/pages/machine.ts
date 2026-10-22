import type { ApiError } from '../api.js';
import type { Node } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import { h, put, icon, button, badge, statusDot, moreButton, errorState, spinner, clear, copyable, kv, toggle, avatar, callout } from '../ui.js';
import {
  nodeName, nodeTags, nodeIPv4, nodeIPv6, expiryState, routeInfo, ownerLabel, relTime, fmtDate, parseTime,
  REGISTER_METHOD,
} from '../util.js';
import { nodeMenuItems, renameNode, editRoutes, editTags, setExpiry, disableExpiry, expireNow, deleteNode, magicName, setRouteApproved } from './actions.js';
import { nodeBadges } from './machines.js';

export async function render(ctx: Ctx, { id = '' }: Record<string, string | undefined>, root: HTMLElement): Promise<() => void> {
  let destroyed = false;
  const body = h('div', h('div', { class: 'center pad-y' }, spinner(24)));
  root.append(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('a', { href: '#/machines' }, icon('chevronLeft', 14), 'All machines')),
    body);

  async function load(): Promise<void> {
    try {
      const n = await ctx.api.getNode(id);
      if (destroyed) return;
      draw(n);
    } catch (e) {
      if (destroyed) return;
      const err = e as ApiError;
      clear(body).appendChild(err.status === 404 || /not found/i.test(err.message)
        ? h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'Machine not found'),
          h('div', { class: 'empty-text' }, 'It may have been removed.'),
          button('Back to machines', { onClick: () => ctx.navigate('#/machines') }))
        : errorState(e, () => void load()));
    }
  }

  const after = (): void => { ctx.invalidate(); void load(); };

  function draw(n: Node): void {
    const st = expiryState(n);
    const ri = routeInfo(n);
    const owner = ownerLabel(n);
    const seen = parseTime(n.lastSeen);
    const v4 = nodeIPv4(n);
    const v6 = nodeIPv6(n);
    const dnsName = magicName(ctx, n);
    document.title = `${nodeName(n)} · Headscale Console`;

    const head = h('div', { class: 'page-head detail-head' },
      h('div', { class: 'detail-title' },
        h('div', { class: 'detail-icon' }, icon('machines', 22)),
        h('div',
          h('h1', nodeName(n)),
          h('div', { class: 'detail-sub' },
            statusDot(n.online), h('span', n.online ? 'Connected' : (seen ? `Last seen ${relTime(seen)}` : 'Never connected')),
            h('span', { class: 'sep' }, '·'),
            owner.tagged ? h('span', icon('tag', 12, 'faint'), ' ', nodeTags(n).join(', ')) : h('span', owner.label)),
          h('div', { class: 'badges' }, nodeBadges(n)))),
      h('div', { class: 'page-actions' },
        ctx.config.browserSsh ? button('SSH', { icon: 'terminal', onClick: () => ctx.navigate(`#/ssh/${n.id}`) }) : null,
        button('Edit name', { icon: 'edit', onClick: () => renameNode(ctx, n, after) }),
        moreButton(() => nodeMenuItems(ctx, n, after, { includeView: false }))));

    // ------------------------------------------------------------- details
    const details = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Machine details')),
      kv([
        ['Owner', owner.tagged
          ? h('span', { class: 'badges' }, nodeTags(n).map((t) => badge(t, 'tag')))
          : h('span', { class: 'owner-inline' }, avatar(owner.label, n.user?.profilePicUrl, 20), h('span', owner.label), owner.sub && owner.sub !== owner.label ? h('span', { class: 'muted' }, owner.sub) : null)],
        ['Machine name', copyable(nodeName(n))],
        ['OS hostname', n.name ? copyable(n.name) : '—'],
        ['Node ID', copyable(String(n.id))],
        ['Created', h('span', { title: fmtDate(n.createdAt) }, `${fmtDate(n.createdAt)} (${relTime(n.createdAt)})`)],
        ['Last seen', n.online ? h('span', { class: 'seen' }, statusDot(true), 'Connected now') : (seen ? `${fmtDate(seen)} (${relTime(seen)})` : 'Never')],
        ['Registered via', REGISTER_METHOD[n.registerMethod || ''] || '—'],
        n.preAuthKey ? ['Auth key', h('span', `#${n.preAuthKey.id}`, n.preAuthKey.reusable ? ' · reusable' : '', n.preAuthKey.ephemeral ? ' · ephemeral' : '')] : null,
      ]));

    const addresses = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Addresses')),
      kv([
        ['Tailscale IPv4', v4 ? copyable(v4) : '—'],
        ['Tailscale IPv6', v6 ? copyable(v6) : '—'],
        ['MagicDNS', ctx.prefs.baseDomain ? copyable(dnsName) : h('span', { class: 'muted' }, copyable(nodeName(n)), ' ',
          h('a', { href: '#/dns', class: 'small' }, 'Set your base domain'))],
      ]));

    // ------------------------------------------------------------- expiry
    const expiry = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Key expiry')),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'setting-row' },
          h('div',
            h('div', { class: 'setting-title' }, st.disabled ? 'Key expiry disabled' : st.expired ? 'Key expired' : `Expires ${relTime(st.date)}`),
            h('div', { class: 'help' }, st.disabled
              ? 'This machine never needs to re-authenticate.'
              : st.expired ? `The key expired on ${fmtDate(st.date)}. The device must run tailscale up to reconnect.`
                : `The device must re-authenticate on ${fmtDate(st.date)}.`)),
          toggle(!st.disabled, (on, input) => {
            input.checked = !on; // wait for the action to refresh
            void (on ? setExpiry(ctx, n, after) : disableExpiry(ctx, n, after));
          }, { label: 'Expiry' })),
        h('div', { class: 'row-gap' },
          !st.disabled ? button('Change expiry date', { size: 'sm', icon: 'clock', onClick: () => setExpiry(ctx, n, after) }) : null,
          button('Expire key now', { size: 'sm', icon: 'lock', onClick: () => expireNow(ctx, n, after) }))));

    // ------------------------------------------------------------- routes
    const routeRows: HTMLTableRowElement[] = [];
    for (const r of ri.subnets) {
      const approved = ri.approved.includes(r);
      routeRows.push(h('tr',
        h('td', { class: 'mono' }, r),
        h('td', ri.available.includes(r) ? 'Advertised' : h('span', { class: 'muted' }, 'Pre-approved')),
        h('td', !ri.available.includes(r) ? badge('Not advertised', 'neutral') : ri.primary.includes(r) ? badge('Primary', 'success') : (approved ? badge('Standby', 'neutral') : badge('Pending', 'warning'))),
        h('td', { class: 'col-actions' }, toggle(approved, (on) => void setRouteApproved(ctx, n, r, on, after), { label: approved ? 'Approved' : 'Approve' }))));
    }
    const routes = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Subnets & exit node'),
        button('Edit', { size: 'sm', icon: 'edit', onClick: () => editRoutes(ctx, n, after) })),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'setting-row' },
          h('div',
            h('div', { class: 'setting-title' }, 'Exit node'),
            h('div', { class: 'help' }, ri.exitApproved ? 'Other devices can route their internet traffic through this machine.'
              : ri.exitAdvertised ? 'This machine is offering to be an exit node. Approve it to allow others to use it.'
                : 'Not advertised. Run tailscale set --advertise-exit-node on the device.')),
          ri.exitAdvertised || ri.exitApproved
            ? toggle(ri.exitApproved, (on) => void setRouteApproved(ctx, n, '0.0.0.0/0', on, after), { label: ri.exitApproved ? 'Allowed' : 'Allow' })
            : badge('Not advertised', 'neutral')),
        routeRows.length
          ? h('div', { class: 'table-wrap flat' }, h('table', { class: 'table' },
            h('thead', h('tr', h('th', 'Subnet'), h('th', 'Source'), h('th', 'State'), h('th', { class: 'col-actions' }))),
            h('tbody', routeRows)))
          : h('p', { class: 'help' }, 'No subnet routes. Advertise with ', h('code', 'tailscale set --advertise-routes=10.0.0.0/24'), '.')));

    // ------------------------------------------------------------- tags
    const tagsCard = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'ACL tags'), button('Edit', { size: 'sm', icon: 'edit', onClick: () => editTags(ctx, n, after) })),
      h('div', { class: 'card-body' },
        nodeTags(n).length ? h('div', { class: 'badges' }, nodeTags(n).map((t) => badge(t, 'tag')))
          : h('p', { class: 'help' }, 'No tags. Tags let you write access rules for groups of servers instead of individual users.')));

    // ------------------------------------------------------------- keys
    const keys = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Cryptographic keys')),
      kv([
        ['Node key', copyable(n.nodeKey || '—', { display: shorten(n.nodeKey) })],
        ['Machine key', copyable(n.machineKey || '—', { display: shorten(n.machineKey) })],
        ['Disco key', n.discoKey && !/^discokey:0+$/.test(n.discoKey) ? copyable(n.discoKey, { display: shorten(n.discoKey) }) : '—'],
      ]));

    const danger = h('section', { class: 'card card-danger' },
      h('div', { class: 'card-head' }, h('h2', 'Remove machine')),
      h('div', { class: 'card-body setting-row' },
        h('p', { class: 'help' }, 'Removing the machine disconnects it and releases its IP addresses. It must be registered again to rejoin.'),
        button('Remove…', { variant: 'danger', icon: 'trash', onClick: () => void deleteNode(ctx, n, () => ctx.navigate('#/machines')) })));

    const pending = ri.pendingSubnets.length || ri.exitPending;
    put(clear(body),
      head,
      pending ? callout('warning', 'Routes awaiting approval',
        h('span', `This machine is advertising ${[...ri.pendingSubnets, ...(ri.exitPending ? ['an exit node'] : [])].join(', ')}. `,
          h('button', { class: 'link-btn', type: 'button', onclick: () => editRoutes(ctx, n, after) }, 'Review routes'))) : null,
      h('div', { class: 'detail-grid' },
        h('div', { class: 'stack' }, details, routes, tagsCard),
        h('div', { class: 'stack' }, addresses, expiry, keys, danger)));
  }

  function shorten(k?: string): string {
    if (!k) return '—';
    const [pfx, hex = ''] = k.includes(':') ? k.split(':') : ['', k];
    return `${pfx ? pfx + ':' : ''}${hex.slice(0, 8)}…${hex.slice(-6)}`;
  }

  await load();
  const t = setInterval(() => { if (!document.hidden) void load(); }, 20000);
  return () => { destroyed = true; clearInterval(t); };
}

