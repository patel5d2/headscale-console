import {
  h, icon, button, badge, statusDot, moreButton, showMenu, emptyState, errorState, skeletonRows, clear, toast, avatar,
} from '../ui.js';
import {
  nodeName, nodeTags, nodeIPv4, nodeIPv6, expiryState, routeInfo, ownerLabel, relTime, fmtDate, parseTime,
  REGISTER_METHOD, debounce, copyText, pluralize, store, userLabel,
} from '../util.js';
import { nodeMenuItems, addDevice, magicName } from './actions.js';

const FILTERS = {
  status: { label: 'Status', options: [['online', 'Connected'], ['offline', 'Disconnected'], ['expired', 'Key expired'], ['expiring', 'Expiring soon']] },
  feature: { label: 'Features', options: [['exit', 'Exit nodes'], ['subnet', 'Subnet routers'], ['pending', 'Pending route approval'], ['noexpiry', 'Key expiry disabled'], ['ephemeral', 'Ephemeral']] },
};

export function nodeBadges(n, { compact = false } = {}) {
  const out = [];
  const ri = routeInfo(n);
  const st = expiryState(n);
  if (ri.exitApproved) out.push(badge('Exit Node', 'info', 'exit'));
  else if (ri.exitPending) out.push(badge('Exit Node', 'warning', 'alert', 'Advertised as exit node — awaiting approval'));
  const approvedSubnets = ri.subnets.filter((r) => ri.approved.includes(r));
  if (approvedSubnets.length) out.push(badge('Subnets', 'info', 'routes', approvedSubnets.join(', ')));
  if (ri.pendingSubnets.length) out.push(badge(compact ? 'Subnets' : `${ri.pendingSubnets.length} pending`, 'warning', 'alert', `Awaiting approval: ${ri.pendingSubnets.join(', ')}`));
  if (st.disabled) out.push(badge('Expiry disabled', 'neutral', 'unlock'));
  else if (st.expired) out.push(badge('Expired', 'danger', 'clock', `Key expired ${fmtDate(st.date)}`));
  else if (st.date.getTime() - Date.now() < 14 * 86400000) out.push(badge(`Expires ${relTime(st.date)}`, 'warning', 'clock', fmtDate(st.date)));
  if (n.preAuthKey?.ephemeral) out.push(badge('Ephemeral', 'neutral'));
  for (const t of nodeTags(n)) out.push(badge(t, 'tag'));
  return out;
}

export function addressMenu(ctx, anchor, n) {
  const items = [];
  const v4 = nodeIPv4(n);
  const v6 = nodeIPv6(n);
  const dnsName = magicName(ctx, n);
  const cp = (t) => async () => { if (await copyText(t)) toast('Copied to clipboard', 'success', 1500); };
  items.push({ header: 'Copy address' });
  if (dnsName) items.push({ label: dnsName, icon: 'globe', onClick: cp(dnsName) });
  if (ctx.prefs.baseDomain) items.push({ label: nodeName(n), icon: 'globe', hint: 'short', onClick: cp(nodeName(n)) });
  if (v4) items.push({ label: v4, icon: 'copy', hint: 'IPv4', onClick: cp(v4) });
  if (v6) items.push({ label: v6, icon: 'copy', hint: 'IPv6', onClick: cp(v6) });
  showMenu(anchor, items, { align: 'left' });
}

export async function render(ctx, _params, root) {
  const state = {
    q: store.get('machines.q', ''),
    filters: { status: new Set(), feature: new Set(), user: new Set(), tag: new Set() },
    sort: store.get('machines.sort', { key: 'name', dir: 1 }),
  };
  let timer = null;
  let destroyed = false;

  const countEl = h('span', { class: 'muted' });
  const search = h('input', {
    class: 'input search-input', type: 'search', placeholder: 'Search by name, owner, tag, IP or route…',
    value: state.q, 'data-search': true, 'aria-label': 'Search machines',
  });
  const filterBtn = button('Filters', { icon: 'filter' });
  const chipsEl = h('div', { class: 'filter-chips' });
  const refreshBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Refresh', 'aria-label': 'Refresh' }, icon('refresh', 17));
  const tbody = h('tbody');
  const tableWrap = h('div', { class: 'table-wrap' });
  const table = h('table', { class: 'table table-hover' });
  tableWrap.appendChild(table);
  const contentEl = h('div');

  const headers = [
    { key: 'name', label: 'Machine' },
    { key: 'ip', label: 'Addresses' },
    { key: 'method', label: 'Registered via', cls: 'hide-md' },
    { key: 'seen', label: 'Last seen' },
    { key: null, label: '', cls: 'col-actions' },
  ];
  const thead = h('thead');
  const renderHead = () => {
    clear(thead).appendChild(h('tr', headers.map((c) => {
      if (!c.key) return h('th', { class: c.cls });
      const active = state.sort.key === c.key;
      return h('th', { class: c.cls, 'aria-sort': active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null },
        h('button', {
          class: `th-sort${active ? ' active' : ''}`, type: 'button',
          onclick: () => {
            state.sort = { key: c.key, dir: active ? -state.sort.dir : 1 };
            store.set('machines.sort', state.sort);
            renderHead(); renderRows();
          },
        }, c.label, icon('chevronDown', 12, active ? (state.sort.dir > 0 ? 'flip' : '') : 'faint')));
    })));
  };
  renderHead();
  table.append(thead, tbody);

  root.append(
    h('div', { class: 'page-head' },
      h('div', h('h1', 'Machines'), h('p', { class: 'muted' }, 'Manage the devices connected to your tailnet.')),
      h('div', { class: 'page-actions' }, button('Add device', { variant: 'primary', icon: 'plus', onClick: () => addDevice(ctx, () => refresh(true)) }))),
    h('div', { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search', 16), search, h('kbd', { class: 'kbd-hint' }, '/')),
      filterBtn, refreshBtn),
    chipsEl,
    h('div', { class: 'list-meta' }, countEl),
    contentEl);

  const matches = (n) => {
    const f = state.filters;
    const st = expiryState(n);
    const ri = routeInfo(n);
    if (f.status.size) {
      const ok = (f.status.has('online') && n.online) || (f.status.has('offline') && !n.online) ||
        (f.status.has('expired') && st.expired) ||
        (f.status.has('expiring') && !st.disabled && !st.expired && st.date - Date.now() < 14 * 86400000);
      if (!ok) return false;
    }
    if (f.feature.size) {
      const ok = (f.feature.has('exit') && (ri.exitApproved || ri.exitAdvertised)) ||
        (f.feature.has('subnet') && ri.subnets.length > 0) ||
        (f.feature.has('pending') && (ri.pendingSubnets.length > 0 || ri.exitPending)) ||
        (f.feature.has('noexpiry') && st.disabled) ||
        (f.feature.has('ephemeral') && n.preAuthKey?.ephemeral);
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

  const sortVal = (n) => {
    switch (state.sort.key) {
      case 'ip': return (nodeIPv4(n) || '').split('.').map((x) => x.padStart(3, '0')).join('.');
      case 'method': return n.registerMethod || '';
      case 'seen': return n.online ? Infinity : (parseTime(n.lastSeen)?.getTime() || 0);
      default: return nodeName(n).toLowerCase();
    }
  };

  function renderChips() {
    clear(chipsEl);
    const users = ctx.data.users || [];
    const add = (group, val, label) => chipsEl.appendChild(h('span', { class: 'filter-chip' }, label,
      h('button', { type: 'button', 'aria-label': `Remove filter ${label}`, onclick: () => { state.filters[group].delete(val); renderChips(); renderRows(); } }, icon('x', 12))));
    for (const [g, def] of Object.entries(FILTERS)) {
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
    const item = (g, v, label) => ({
      label, icon: state.filters[g].has(v) ? 'check' : null,
      onClick: () => { state.filters[g].has(v) ? state.filters[g].delete(v) : state.filters[g].add(v); renderChips(); renderRows(); },
    });
    showMenu(filterBtn, [
      ...Object.entries(FILTERS).flatMap(([g, def]) => [{ header: def.label }, ...def.options.map(([v, l]) => item(g, v, l))]),
      users.length ? { header: 'Owner' } : null,
      ...users.map((u) => item('user', String(u.id), userLabel(u))),
      allTags.length ? { header: 'Tags' } : null,
      ...allTags.map((t) => item('tag', t, t)),
    ], { align: 'left' });
  });

  function rowFor(n) {
    const owner = ownerLabel(n);
    const v4 = nodeIPv4(n);
    const seen = parseTime(n.lastSeen);
    const ipBtn = h('button', { class: 'ip-btn mono', type: 'button', title: 'Copy addresses' }, v4 || '—', icon('chevronDown', 12, 'faint'));
    ipBtn.addEventListener('click', (e) => { e.stopPropagation(); addressMenu(ctx, ipBtn, n); });
    const tr = h('tr', { tabindex: '0', class: 'clickable', 'data-id': n.id },
      h('td', h('div', { class: 'machine-cell' },
        h('div', { class: 'machine-name' },
          h('a', { href: `#/machines/${n.id}`, onclick: (e) => e.stopPropagation() }, nodeName(n)),
          nodeName(n) !== n.name && n.name ? h('span', { class: 'muted small', title: 'Hostname reported by device' }, n.name) : null),
        h('div', { class: 'machine-owner' },
          owner.tagged ? icon('tag', 12, 'faint') : avatar(owner.label, n.user?.profilePicUrl, 16),
          h('span', owner.tagged ? 'Tagged device' : owner.sub || owner.label)),
        h('div', { class: 'badges' }, nodeBadges(n)))),
      h('td', ipBtn),
      h('td', { class: 'hide-md muted' }, REGISTER_METHOD[n.registerMethod] || '—'),
      h('td', h('span', { class: 'seen' }, statusDot(n.online),
        h('span', { title: seen ? fmtDate(seen) : '' }, n.online ? 'Connected' : (seen ? relTime(seen) : 'Never')))),
      h('td', { class: 'col-actions', onclick: (e) => e.stopPropagation() }, moreButton(() => nodeMenuItems(ctx, n, () => refresh(true)))));
    tr.addEventListener('click', () => ctx.navigate(`#/machines/${n.id}`));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ctx.navigate(`#/machines/${n.id}`); });
    return tr;
  }

  function renderRows() {
    const nodes = ctx.data.nodes || [];
    const list = nodes.filter(matches).sort((a, b) => {
      const x = sortVal(a); const y = sortVal(b);
      return (x > y ? 1 : x < y ? -1 : 0) * state.sort.dir;
    });
    const online = nodes.filter((n) => n.online).length;
    countEl.textContent = list.length === nodes.length
      ? `${pluralize(nodes.length, 'machine')} · ${online} connected`
      : `Showing ${list.length} of ${pluralize(nodes.length, 'machine')}`;
    clear(contentEl);
    if (!nodes.length) {
      contentEl.appendChild(emptyState('machines', 'No machines yet',
        'Add your first device to the tailnet with an auth key or by approving its login URL.',
        button('Add device', { variant: 'primary', icon: 'plus', onClick: () => addDevice(ctx, () => refresh(true)) })));
      return;
    }
    if (!list.length) {
      contentEl.appendChild(emptyState('search', 'No matching machines', 'Try a different search or clear your filters.'));
      return;
    }
    clear(tbody);
    list.forEach((n) => tbody.appendChild(rowFor(n)));
    contentEl.appendChild(tableWrap);
  }

  async function refresh(force = false) {
    if (destroyed) return;
    refreshBtn.classList.add('spinning');
    try {
      await ctx.load(force);
      if (destroyed) return;
      renderChips();
      renderRows();
    } catch (e) {
      clear(contentEl).appendChild(errorState(e, () => refresh(true)));
    } finally {
      refreshBtn.classList.remove('spinning');
    }
  }

  search.addEventListener('input', debounce(() => { state.q = search.value.trim(); store.set('machines.q', state.q, false); renderRows(); }, 120));
  refreshBtn.addEventListener('click', () => refresh(true));

  if (!ctx.data.nodes) {
    clear(tbody);
    skeletonRows(6, 5).forEach((r) => tbody.appendChild(r));
    contentEl.appendChild(tableWrap);
  }
  await refresh(!ctx.data.nodes);

  // Live refresh while the tab is visible
  timer = setInterval(() => { if (!document.hidden) refresh(true); }, 15000);
  return () => { destroyed = true; clearInterval(timer); };
}
