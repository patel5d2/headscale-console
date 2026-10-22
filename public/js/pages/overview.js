// Overview: tailnet stats plus a "needs attention" list of things an admin should act on.
import { h, put, icon, badge, spinner, errorState, clear } from '../ui.js';
import { nodeName, nodeTags, routeInfo, expiryState, parseTime, relTime, parseHuJSON, pluralize } from '../util.js';

const DAY = 86400000;
const SOON = 14 * DAY;

const semver = (v) => String(v || '').replace(/^v/, '').match(/^\d+\.\d+\.\d+/)?.[0] || null;
const newer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0; };

export async function render(ctx, _params, root) {
  root.append(h('div', { class: 'page-head' }, h('div', h('h1', 'Overview'), h('p', { class: 'muted' }, 'Your tailnet at a glance, and what needs attention.'))));
  const body = h('div', h('div', { class: 'center pad-y' }, spinner(24)));
  root.append(body);

  let data;
  let extra;
  try {
    [data, extra] = await Promise.all([ctx.load(true), Promise.all([
      ctx.api.getPolicy().catch(() => null),
      ctx.api.listApiKeys().catch(() => []),
      ctx.api.releases().catch(() => []),
      ctx.api.version(),
    ])]);
  } catch (e) { clear(body).append(errorState(e)); return; }
  const [policy, apiKeys, releases, version] = extra;
  const nodes = data.nodes || [];
  const users = data.users || [];
  const now = Date.now();

  // ------------------------------------------------------------ attention --
  const items = [];
  const add = (kind, text, href, detail) => items.push({ kind, text, href, detail });

  const pending = nodes.filter((n) => { const r = routeInfo(n); return r.pendingSubnets.length || r.exitPending; });
  if (pending.length) add('warning', `${pluralize(pending.length, 'machine')} waiting for route approval`, '#/routes', pending.map(nodeName).join(', '));

  for (const n of nodes) {
    const e = expiryState(n);
    if (e.expired) add('danger', `${nodeName(n)}: key expired`, `#/machines/${n.id}`, 'It can\'t connect until it re-authenticates.');
    else if (e.date && e.date - now < SOON) add('warning', `${nodeName(n)}: key expires ${relTime(e.date)}`, `#/machines/${n.id}`, 'Extend or disable its key expiry.');
  }

  const stale = nodes.filter((n) => !n.online && parseTime(n.lastSeen) && now - parseTime(n.lastSeen) > 30 * DAY);
  if (stale.length) add('neutral', `${pluralize(stale.length, 'machine')} not seen for over 30 days`, '#/machines', stale.map(nodeName).join(', '));

  const parsed = policy?.policy ? parseHuJSON(policy.policy) : null;
  if (parsed?.ok) {
    const owners = parsed.value?.tagOwners || {};
    const undefinedTags = [...new Set(nodes.flatMap(nodeTags))].filter((t) => !(t in owners));
    if (undefinedTags.length) add('warning', `${pluralize(undefinedTags.length, 'tag')} in use but not in tagOwners`, '#/acls', `${undefinedTags.join(', ')} — no rule can match them.`);
  }

  const current = ctx.conn?.key || '';
  const myKey = apiKeys.find((k) => { const pfx = (k.prefix || '').replace(/\*+$/, '').replace(/-$/, ''); return pfx && current.startsWith(pfx); });
  const myExp = parseTime(myKey?.expiration);
  if (myExp && myExp - now < SOON) add('warning', `This console's API key expires ${relTime(myExp)}`, '#/settings/api-keys', 'Create a new key before it runs out.');

  const running = semver(version?.version);
  if (running && releases[0] && newer(releases[0].version, running)) {
    add('info', `Headscale ${releases[0].version} is available (running ${running})`, '#/settings/updates', 'Read the release notes before updating.');
  }

  // --------------------------------------------------------------- render --
  const online = nodes.filter((n) => n.online).length;
  const routes = nodes.reduce((a, n) => a + routeInfo(n).subnets.length, 0);
  const exits = nodes.filter((n) => routeInfo(n).exitApproved).length;
  const tagged = nodes.filter((n) => nodeTags(n).length).length;
  const stat = (label, value, href, sub) => h('a', { class: 'stat stat-link', href },
    h('div', { class: 'stat-n' }, String(value)), h('div', { class: 'stat-l' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);
  const icons = { danger: 'alert', warning: 'alert', info: 'info', neutral: 'clock' };

  put(clear(body),
    h('div', { class: 'stat-row' },
      stat('Machines', nodes.length, '#/machines', `${online} connected`),
      stat('Users', users.length, '#/users'),
      stat('Tagged machines', tagged, '#/machines'),
      stat('Subnet routes', routes, '#/routes', pending.length ? `${pending.length} pending` : null),
      stat('Exit nodes', exits, '#/routes')),
    h('section', { class: 'section mt-2' },
      h('div', { class: 'section-head' }, h('h2', 'Needs attention'), items.length ? badge(String(items.length), 'warning') : null),
      items.length
        ? h('div', { class: 'attention-list' }, items.map((it) => h('a', { class: `attention attention-${it.kind}`, href: it.href },
          icon(icons[it.kind], 16), h('div', h('div', { class: 'attention-title' }, it.text), it.detail ? h('div', { class: 'muted small' }, it.detail) : null),
          icon('chevronRight', 16, 'faint'))))
        : h('div', { class: 'callout callout-success' }, icon('check', 18), h('div', 'Nothing needs attention. Everything is approved, current and in policy.'))));
}
