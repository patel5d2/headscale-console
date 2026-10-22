import type { Node } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import type { MenuItem } from '../ui.js';
import {
  avatar, badge, button, clear, emptyState, errorState, h, icon, moreButton, showMenu, skeletonRows, statusDot, toast,
} from '../ui.js';
import {
  copyText, debounce, expiryState, fmtDate, nodeIPv4, nodeIPv6, nodeName, nodeTags, ownerLabel, parseTime, pluralize,
  REGISTER_METHOD, relTime, routeInfo, store, userLabel,
} from '../util.js';
import { addDevice, magicName, nodeMenuItems } from './actions.js';
import { bulkApproveRoutes, bulkSimple, bulkTags } from './bulk.js';

type FilterGroup = 'status' | 'feature' | 'user' | 'tag';
const FILTERS: Record<'status' | 'feature', { label: string; options: Array<[string, string]> }> = {
  status: { label: 'Status', options: [['online', 'Connected'], ['offline', 'Disconnected'], ['expired', 'Key expired'], ['expiring', 'Expiring soon']] },
  feature: { label: 'Features', options: [['exit', 'Exit nodes'], ['subnet', 'Subnet routers'], ['pending', 'Pending route approval'], ['noexpiry', 'Key expiry disabled'], ['ephemeral', 'Ephemeral']] },
};
const SOON = 14 * 86400000;

export function nodeBadges(n: Node, { compact = false } = {}): HTMLElement[] {
  const out: HTMLElement[] = [];
  const ri = routeInfo(n);
  const st = expiryState(n);
  if (ri.exitApproved) out.push(badge('Exit Node', 'info', 'exit'));
  else if (ri.exitPending) out.push(badge('Exit Node', 'warning', 'alert', 'Advertised as exit node — awaiting approval'));
  const approvedSubnets = ri.subnets.filter((r) => ri.approved.includes(r));
  if (approvedSubnets.length) out.push(badge('Subnets', 'info', 'routes', approvedSubnets.join(', ')));
  if (ri.pendingSubnets.length) out.push(badge(compact ? 'Subnets' : `${ri.pendingSubnets.length} pending`, 'warning', 'alert', `Awaiting approval: ${ri.pendingSubnets.join(', ')}`));
  if (st.disabled) out.push(badge('Expiry disabled', 'neutral', 'unlock'));
  else if (st.expired) out.push(badge('Expired', 'danger', 'clock', `Key expired ${fmtDate(st.date)}`));
  else if (st.date!.getTime() - Date.now() < SOON) out.push(badge(`Expires ${relTime(st.date)}`, 'warning', 'clock', fmtDate(st.date)));
  if (n.preAuthKey?.ephemeral) out.push(badge('Ephemeral', 'neutral'));
  for (const t of nodeTags(n)) out.push(badge(t, 'tag'));
  return out;
}

export function addressMenu(ctx: Ctx, anchor: Element, n: Node): void {
  const v4 = nodeIPv4(n);
  const v6 = nodeIPv6(n);
  const dnsName = magicName(ctx, n);
  const cp = (t: string) => async (): Promise<void> => { if (await copyText(t)) toast('Copied to clipboard', 'success', 1500); };
  showMenu(anchor, [
    { header: 'Copy address' },
    { label: dnsName, icon: 'globe', onClick: cp(dnsName) },
    ctx.prefs.baseDomain ? { label: nodeName(n), icon: 'globe', hint: 'short', onClick: cp(nodeName(n)) } : null,
    v4 ? { label: v4, icon: 'copy', hint: 'IPv4', onClick: cp(v4) } : null,
    v6 ? { label: v6, icon: 'copy', hint: 'IPv6', onClick: cp(v6) } : null,
  ], { align: 'left' });
}

export async function render(ctx: Ctx, _params: unknown, root: HTMLElement): Promise<() => void> {
  const state = {
    q: store.get('machines.q', ''),
    filters: { status: new Set<string>(), feature: new Set<string>(), user: new Set<string>(), tag: new Set<string>() } as Record<FilterGroup, Set<string>>,
    sort: store.get('machines.sort', { key: 'name', dir: 1 }),
    selected: new Set<string>(),
  };
  let destroyed = false;
  let visible: Node[] = [];

  const countEl = h('span', { class: 'muted' });
  const search = h('input', {
    class: 'input search-input', type: 'search', placeholder: 'Search by name, owner, tag, IP or route…',
    value: state.q, 'data-search': true, 'aria-label': 'Search machines',
  });
  const filterBtn = button('Filters', { icon: 'filter' });
  const chipsEl = h('div', { class: 'filter-chips' });
  const bulkBar = h('div', { class: 'bulk-bar', hidden: true, role: 'region', 'aria-label': 'Bulk actions' });
  const refreshBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Refresh', 'aria-label': 'Refresh' }, icon('refresh', 17));
  const tbody = h('tbody');
  const thead = h('thead');
  const table = h('table', { class: 'table table-hover' }, thead, tbody);
  const tableWrap = h('div', { class: 'table-wrap' }, table);
  const contentEl = h('div');
  const selectAll = h('input', { type: 'checkbox', 'aria-label': 'Select all shown machines' });

  const headers: Array<{ key: string | null; label: string; cls?: string }> = [
    { key: 'name', label: 'Machine' },
    { key: 'ip', label: 'Addresses' },
    { key: 'method', label: 'Registered via', cls: 'hide-md' },
    { key: 'seen', label: 'Last seen' },
    { key: null, label: '', cls: 'col-actions' },
  ];
  const renderHead = (): void => {
    clear(thead).appendChild(h('tr', h('th', { class: 'col-check' }, selectAll), headers.map((c) => {
      if (!c.key) return h('th', { class: c.cls });
      const key = c.key;
      const active = state.sort.key === key;
      return h('th', { class: c.cls, 'aria-sort': active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null },
        h('button', {
          class: `th-sort${active ? ' active' : ''}`, type: 'button',
          onclick: () => {
            state.sort = { key, dir: active ? -state.sort.dir : 1 };
            store.set('machines.sort', state.sort);
            renderHead(); renderRows();
          },
        }, c.label, icon('chevronDown', 12, active ? (state.sort.dir > 0 ? 'flip' : '') : 'faint')));
    })));
  };
  renderHead();

  root.append(
    h('div', { class: 'page-head' },
      h('div', h('h1', 'Machines'), h('p', { class: 'muted' }, 'Manage the devices connected to your tailnet.')),
      h('div', { class: 'page-actions' }, button('Add device', { variant: 'primary', icon: 'plus', onClick: () => addDevice(ctx, () => refresh(true)) }))),
    h('div', { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search', 16), search, h('kbd', { class: 'kbd-hint' }, '/')),
      filterBtn, refreshBtn),
    chipsEl,
    bulkBar,
    h('div', { class: 'list-meta' }, countEl),
    contentEl);

  const matches = (n: Node): boolean => {
    const f = state.filters;
    const st = expiryState(n);
    const ri = routeInfo(n);
    if (f.status.size) {
      const ok = (f.status.has('online') && n.online) || (f.status.has('offline') && !n.online) ||
        (f.status.has('expired') && st.expired) ||
        (f.status.has('expiring') && !!st.date && !st.expired && st.date.getTime() - Date.now() < SOON);
      if (!ok) return false;
    }
    if (f.feature.size) {
      const ok = (f.feature.has('exit') && (ri.exitApproved || ri.exitAdvertised)) ||
        (f.feature.has('subnet') && ri.subnets.length > 0) ||
        (f.feature.has('pending') && (ri.pendingSubnets.length > 0 || ri.exitPending)) ||
        (f.feature.has('noexpiry') && st.disabled) ||
        (f.feature.has('ephemeral') && !!n.preAuthKey?.ephemeral);
      if (!ok) return false;
    }
    if (f.user.size && !(n.user && f.user.has(String(n.user.id)))) return false;
    if (f.tag.size && !nodeTags(n).some((t) => f.tag.has(t))) return false;
    if (state.q) {
      const hay = [nodeName(n), n.name, ...(n.ipAddresses || []), n.user?.name, n.user?.email, n.user?.displayName,
        ...nodeTags(n), ...(n.approvedRoutes || []), ...(n.availableRoutes || []), n.id].join(' ').toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    return true;
  };

  const sortVal = (n: Node): string | number => {
    switch (state.sort.key) {
      case 'ip': return nodeIPv4(n).split('.').map((x) => x.padStart(3, '0')).join('.');
      case 'method': return n.registerMethod || '';
      case 'seen': return n.online ? Infinity : (parseTime(n.lastSeen)?.getTime() || 0);
      default: return nodeName(n).toLowerCase();
    }
  };

  function renderChips(): void {
    clear(chipsEl);
    const users = ctx.data.users || [];
    const add = (group: FilterGroup, val: string, label: string): void => void chipsEl.appendChild(h('span', { class: 'filter-chip' }, label,
      h('button', { type: 'button', 'aria-label': `Remove filter ${label}`, onclick: () => { state.filters[group].delete(val); renderChips(); renderRows(); } }, icon('x', 12))));
    for (const [g, def] of Object.entries(FILTERS) as Array<['status' | 'feature', typeof FILTERS.status]>) {
      for (const v of state.filters[g]) add(g, v, `${def.label}: ${def.options.find((o) => o[0] === v)?.[1]}`);
    }
    for (const v of state.filters.user) add('user', v, `Owner: ${userLabel(users.find((u) => String(u.id) === v))}`);
    for (const v of state.filters.tag) add('tag', v, `Tag: ${v}`);
    const any = Object.values(state.filters).some((s) => s.size);
    if (any) {
      chipsEl.appendChild(h('button', {
        class: 'link-btn', type: 'button',
        onclick: () => { Object.values(state.filters).forEach((s) => s.clear()); renderChips(); renderRows(); },
      }, 'Clear filters'));
    }
    filterBtn.classList.toggle('btn-active', any);
  }

  filterBtn.addEventListener('click', () => {
    const users = ctx.data.users || [];
    const allTags = [...new Set((ctx.data.nodes || []).flatMap(nodeTags))].sort();
    const item = (g: FilterGroup, v: string, label: string): MenuItem => ({
      label, icon: state.filters[g].has(v) ? 'check' : null,
      onClick: () => { if (!state.filters[g].delete(v)) state.filters[g].add(v); renderChips(); renderRows(); },
    });
    showMenu(filterBtn, [
      ...(Object.entries(FILTERS) as Array<['status' | 'feature', typeof FILTERS.status]>).flatMap(([g, def]) => [{ header: def.label }, ...def.options.map(([v, l]) => item(g, v, l))]),
      users.length ? { header: 'Owner' } : null,
      ...users.map((u) => item('user', String(u.id), userLabel(u))),
      allTags.length ? { header: 'Tags' } : null,
      ...allTags.map((t) => item('tag', t, t)),
    ], { align: 'left' });
  });

  // ------------------------------------------------------------- selection --
  const selectedNodes = (): Node[] => (ctx.data.nodes || []).filter((n) => state.selected.has(n.id));
  const afterBulk = (): void => { state.selected.clear(); ctx.invalidate(); void refresh(true); };
  function renderBulk(): void {
    const sel = selectedNodes();
    bulkBar.hidden = !sel.length;
    selectAll.checked = !!visible.length && visible.every((n) => state.selected.has(n.id));
    selectAll.indeterminate = !selectAll.checked && visible.some((n) => state.selected.has(n.id));
    clear(bulkBar).append(
      h('strong', `${pluralize(sel.length, 'machine')} selected`),
      button('Approve routes', { size: 'sm', icon: 'routes', onClick: () => void bulkApproveRoutes(ctx, sel, afterBulk) }),
      button('Tags…', { size: 'sm', icon: 'tag', onClick: () => bulkTags(ctx, sel, afterBulk) }),
      button('Expire keys', { size: 'sm', icon: 'lock', onClick: () => void bulkSimple(ctx, sel, 'expire', afterBulk) }),
      button('Disable expiry', { size: 'sm', icon: 'unlock', onClick: () => void bulkSimple(ctx, sel, 'noexpiry', afterBulk) }),
      button('Remove…', { size: 'sm', icon: 'trash', variant: 'danger', onClick: () => void bulkSimple(ctx, sel, 'remove', afterBulk) }),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { state.selected.clear(); renderRows(); } }, 'Clear selection'));
  }
  selectAll.addEventListener('change', () => {
    for (const n of visible) { if (selectAll.checked) state.selected.add(n.id); else state.selected.delete(n.id); }
    renderRows();
  });

  function rowFor(n: Node): HTMLTableRowElement {
    const owner = ownerLabel(n);
    const v4 = nodeIPv4(n);
    const seen = parseTime(n.lastSeen);
    const ipBtn = h('button', { class: 'ip-btn mono', type: 'button', 'aria-label': 'Copy addresses', title: 'Copy addresses' }, v4 || '—', icon('chevronDown', 12, 'faint'));
    ipBtn.addEventListener('click', (e) => { e.stopPropagation(); addressMenu(ctx, ipBtn, n); });
    const check = h('input', { type: 'checkbox', checked: state.selected.has(n.id), 'aria-label': `Select ${nodeName(n)}` });
    check.addEventListener('change', () => { if (check.checked) state.selected.add(n.id); else state.selected.delete(n.id); renderBulk(); });
    const tr = h('tr', { tabindex: '0', class: 'clickable', 'data-id': n.id },
      h('td', { class: 'col-check', onclick: (e) => e.stopPropagation() }, check),
      h('td', h('div', { class: 'machine-cell' },
        h('div', { class: 'machine-name' },
          h('a', { href: `#/machines/${n.id}`, onclick: (e) => e.stopPropagation() }, nodeName(n)),
          n.name && nodeName(n) !== n.name ? h('span', { class: 'muted small', title: 'Hostname reported by device' }, n.name) : null),
        h('div', { class: 'machine-owner' },
          owner.tagged ? icon('tag', 12, 'faint') : avatar(owner.label, n.user?.profilePicUrl, 16),
          h('span', owner.tagged ? 'Tagged device' : owner.sub || owner.label)),
        h('div', { class: 'badges' }, nodeBadges(n)))),
      h('td', ipBtn),
      h('td', { class: 'hide-md muted' }, REGISTER_METHOD[n.registerMethod || ''] || '—'),
      h('td', h('span', { class: 'seen' }, statusDot(n.online),
        h('span', { title: seen ? fmtDate(seen) : '' }, n.online ? 'Connected' : (seen ? relTime(seen) : 'Never')))),
      h('td', { class: 'col-actions', onclick: (e) => e.stopPropagation() }, moreButton(() => nodeMenuItems(ctx, n, () => refresh(true)))));
    tr.addEventListener('click', () => ctx.navigate(`#/machines/${n.id}`));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) ctx.navigate(`#/machines/${n.id}`); });
    return tr;
  }

  function renderRows(): void {
    const nodes = ctx.data.nodes || [];
    for (const id of state.selected) if (!nodes.some((n) => n.id === id)) state.selected.delete(id); // removed machines
    visible = nodes.filter(matches).sort((a, b) => {
      const x = sortVal(a); const y = sortVal(b);
      return (x > y ? 1 : x < y ? -1 : 0) * state.sort.dir;
    });
    const online = nodes.filter((n) => n.online).length;
    countEl.textContent = visible.length === nodes.length
      ? `${pluralize(nodes.length, 'machine')} · ${online} connected`
      : `Showing ${visible.length} of ${pluralize(nodes.length, 'machine')}`;
    clear(contentEl);
    renderBulk();
    if (!nodes.length) {
      contentEl.appendChild(emptyState('machines', 'No machines yet',
        'Add your first device to the tailnet with an auth key or by approving its login URL.',
        button('Add device', { variant: 'primary', icon: 'plus', onClick: () => addDevice(ctx, () => refresh(true)) })));
      return;
    }
    if (!visible.length) {
      contentEl.appendChild(emptyState('search', 'No matching machines', 'Try a different search or clear your filters.'));
      return;
    }
    clear(tbody).append(...visible.map(rowFor));
    contentEl.appendChild(tableWrap);
  }

  async function refresh(force = false): Promise<void> {
    if (destroyed) return;
    refreshBtn.classList.add('spinning');
    try {
      await ctx.load(force);
      if (destroyed) return;
      renderChips();
      renderRows();
    } catch (e) {
      clear(contentEl).appendChild(errorState(e, () => void refresh(true)));
    } finally {
      refreshBtn.classList.remove('spinning');
    }
  }

  search.addEventListener('input', debounce(() => { state.q = search.value.trim(); store.set('machines.q', state.q, false); renderRows(); }, 120));
  refreshBtn.addEventListener('click', () => void refresh(true));

  if (!ctx.data.nodes) {
    clear(tbody).append(...skeletonRows(6, 6));
    contentEl.appendChild(tableWrap);
  }
  await refresh(!ctx.data.nodes);

  // Live refresh while the tab is visible
  const timer = setInterval(() => { if (!document.hidden) void refresh(true); }, 15000);
  return () => { destroyed = true; clearInterval(timer); };
}
