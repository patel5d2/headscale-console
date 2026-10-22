// Overview: tailnet stats plus a "needs attention" list of things an admin should act on.
import type { Policy } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import type { IconName } from '../ui.js';
import { badge, clear, errorState, h, icon, put, spinner } from '../ui.js';
import { cmpVersion, expiryState, nodeName, nodeTags, parseHuJSON, parseTime, pluralize, relTime, routeInfo, semver } from '../util.js';

const DAY = 86400000;
const SOON = 14 * DAY;

type Kind = 'danger' | 'warning' | 'info' | 'neutral';
interface Item { kind: Kind; text: string; href: string; detail?: string }
const ICONS: Record<Kind, IconName> = { danger: 'alert', warning: 'alert', info: 'info', neutral: 'clock' };

export async function render(ctx: Ctx, _params: unknown, root: HTMLElement): Promise<void> {
  root.append(h('div', { class: 'page-head' }, h('div', h('h1', 'Overview'), h('p', { class: 'muted' }, 'Your tailnet at a glance, and what needs attention.'))));
  const body = h('div', h('div', { class: 'center pad-y' }, spinner(24)));
  root.append(body);

  let data: Awaited<ReturnType<Ctx['load']>>;
  let policy, apiKeys, releases, version;
  try {
    [data, [policy, apiKeys, releases, version]] = await Promise.all([ctx.load(true), Promise.all([
      ctx.api.getPolicy().catch(() => null),
      ctx.api.listApiKeys().catch(() => []),
      ctx.api.releases().catch(() => []),
      ctx.api.version(),
    ])]);
  } catch (e) { clear(body).append(errorState(e)); return; }
  const { nodes, users } = data;
  const now = Date.now();

  // -------------------------------------------------------------- attention --
  const items: Item[] = [];
  const add = (kind: Kind, text: string, href: string, detail?: string): void => { items.push({ kind, text, href, ...(detail ? { detail } : {}) }); };

  const pending = nodes.filter((n) => { const r = routeInfo(n); return r.pendingSubnets.length || r.exitPending; });
  if (pending.length) add('warning', `${pluralize(pending.length, 'machine')} waiting for route approval`, '#/routes', pending.map(nodeName).join(', '));

  for (const n of nodes) {
    const e = expiryState(n);
    if (e.expired) add('danger', `${nodeName(n)}: key expired`, `#/machines/${n.id}`, 'It can\'t connect until it re-authenticates.');
    else if (e.date && e.date.getTime() - now < SOON) add('warning', `${nodeName(n)}: key expires ${relTime(e.date)}`, `#/machines/${n.id}`, 'Extend or disable its key expiry.');
  }

  const stale = nodes.filter((n) => { const seen = parseTime(n.lastSeen); return !n.online && !!seen && now - seen.getTime() > 30 * DAY; });
  if (stale.length) add('neutral', `${pluralize(stale.length, 'machine')} not seen for over 30 days`, '#/machines', stale.map(nodeName).join(', '));

  const parsed = parseHuJSON<Policy>(policy?.policy || '{}');
  if (parsed.ok) {
    const owners = parsed.value?.tagOwners || {};
    const undefinedTags = [...new Set(nodes.flatMap(nodeTags))].filter((t) => !(t in owners));
    if (undefinedTags.length) add('warning', `${pluralize(undefinedTags.length, 'tag')} in use but not in tagOwners`, '#/acls', `${undefinedTags.join(', ')} — no rule can match them.`);
  }

  const current = ctx.conn?.key || '';
  const myKey = apiKeys.find((k) => { const pfx = (k.prefix || '').replace(/\*+$/, '').replace(/-$/, ''); return !!pfx && current.startsWith(pfx); });
  const myExp = parseTime(myKey?.expiration);
  if (myExp && myExp.getTime() - now < SOON) add('warning', `This console's API key expires ${relTime(myExp)}`, '#/settings/api-keys', 'Create a new key before it runs out.');

  const running = semver(version?.version);
  const latest = releases[0]?.version;
  if (running && latest && cmpVersion(latest, running) > 0) {
    add('info', `Headscale ${latest} is available (running ${running})`, '#/settings/updates', 'Read the release notes before updating.');
  }

  // ----------------------------------------------------------------- render --
  const online = nodes.filter((n) => n.online).length;
  const routes = nodes.reduce((a, n) => a + routeInfo(n).subnets.length, 0);
  const exits = nodes.filter((n) => routeInfo(n).exitApproved).length;
  const tagged = nodes.filter((n) => nodeTags(n).length).length;
  const stat = (label: string, value: number, href: string, sub?: string | null): HTMLAnchorElement => h('a', { class: 'stat stat-link', href },
    h('div', { class: 'stat-n' }, String(value)), h('div', { class: 'stat-l' }, label), sub ? h('div', { class: 'muted small' }, sub) : null);

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
          icon(ICONS[it.kind], 16), h('div', h('div', { class: 'attention-title' }, it.text), it.detail ? h('div', { class: 'muted small' }, it.detail) : null),
          icon('chevronRight', 16, 'faint'))))
        : h('div', { class: 'callout callout-success' }, icon('check', 18), h('div', 'Nothing needs attention. Everything is approved, current and in policy.'))));
}
