// Read-only views of a policy for the Access controls page: rule preview, tags, changes.
import type { Policy } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import type { Child } from '../ui.js';
import { badge, callout, clear, h, icon } from '../ui.js';
import { lineDiff, nodeTags, parseHuJSON, store, userLabel } from '../util.js';

const asArr = <T>(v: T | T[] | null | undefined): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

export const chipList = (items: unknown): HTMLDivElement =>
  h('div', { class: 'badges' }, asArr(items).map((s) => badge(String(s), /^(tag:|group:|autogroup:)/.test(String(s)) ? 'tag' : 'neutral')));

const stat = (label: string, n: number): HTMLDivElement => h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label));
const section = (title: string, el: Child): HTMLElement => h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', title)), el);
const table = (head: string[], rows: Child): HTMLDivElement => h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' },
  h('thead', h('tr', head.map((x) => h('th', x)))), h('tbody', rows)));

/** The policy's rules as tables, filterable to one user or tag. */
export function preview(ctx: Ctx, text: string): HTMLElement {
  if (!text.trim()) return callout('info', 'No policy', 'With no policy, all devices can reach each other.');
  const parsed = parseHuJSON<Policy>(text);
  if (!parsed.ok) return callout('error', 'Can\'t preview', `The policy has a syntax error${parsed.line ? ` on line ${parsed.line}` : ''}.`);
  const p = parsed.value || {};
  const users = ctx.data.users || [];
  const groups = p.groups || {};
  const tagNames = Object.keys(p.tagOwners || {});

  const sel = h('select', { class: 'input input-sm', 'aria-label': 'Show rules for' },
    h('option', { value: '' }, 'Everyone'),
    h('optgroup', { label: 'Users' }, users.map((u) => h('option', { value: 'u:' + u.name }, userLabel(u)))),
    tagNames.length ? h('optgroup', { label: 'Tags' }, tagNames.map((t) => h('option', { value: 't:' + t }, t))) : null);
  const body = h('div', { class: 'stack' });

  const appliesTo = (src: string[]): boolean => {
    const v = sel.value;
    if (!v || src.includes('*')) return true;
    if (v.startsWith('u:')) {
      const name = v.slice(2);
      const ids = [name, `${name}@`, users.find((x) => x.name === name)?.email].filter((x): x is string => !!x);
      return src.some((s) => ids.includes(s) || s === 'autogroup:member' || (s.startsWith('group:') && asArr(groups[s]).some((m) => ids.includes(m))));
    }
    return src.some((s) => s === v.slice(2) || s === 'autogroup:tagged');
  };

  const draw = (): void => {
    const acls = asArr(p.acls).filter((r) => appliesTo(asArr(r.src)));
    const grants = asArr(p.grants).filter((r) => appliesTo(asArr(r.src)));
    const ssh = asArr(p.ssh).filter((r) => appliesTo(asArr(r.src)));
    const aa = p.autoApprovers || {};
    const aaRows = [
      ...Object.entries(aa.routes || {}).map(([r, who]) => h('tr', h('td', { class: 'mono' }, r), h('td', chipList(who)))),
      ...(aa.exitNode ? [h('tr', h('td', 'Exit node'), h('td', chipList(aa.exitNode)))] : []),
    ];
    clear(body).append(
      h('div', { class: 'stat-row' },
        stat('ACL rules', asArr(p.acls).length), stat('Grants', asArr(p.grants).length), stat('SSH rules', asArr(p.ssh).length),
        stat('Groups', Object.keys(groups).length), stat('Tags', tagNames.length), stat('Hosts', Object.keys(p.hosts || {}).length)),
      section('Network access rules', acls.length
        ? table(['#', 'Source', 'Destination', 'Protocol'], acls.map((r, i) => h('tr',
          h('td', { class: 'muted' }, i + 1), h('td', chipList(r.src)), h('td', chipList(r.dst)), h('td', r.proto ? String(r.proto) : h('span', { class: 'muted' }, 'any')))))
        : h('p', { class: 'help' }, sel.value ? 'No ACL rules apply.' : 'No ACL rules defined.')),
      ...(asArr(p.grants).length ? [section('Grants', grants.length
        ? table(['#', 'Source', 'Destination', 'Access'], grants.map((r, i) => h('tr',
          h('td', { class: 'muted' }, i + 1), h('td', chipList(r.src)), h('td', chipList(r.dst)),
          h('td', r.ip ? chipList(r.ip) : null, r.app ? h('div', { class: 'muted small' }, 'app: ' + Object.keys(r.app).join(', ')) : null,
            r.via ? h('div', { class: 'muted small' }, 'via: ' + asArr(r.via).join(', ')) : null))))
        : h('p', { class: 'help' }, 'No grants apply.'))] : []),
      section('Tailscale SSH', ssh.length
        ? table(['Action', 'Source', 'Destination', 'As users'], ssh.map((r) => h('tr',
          h('td', badge(r.action || 'accept', r.action === 'check' ? 'warning' : 'success')), h('td', chipList(r.src)), h('td', chipList(r.dst)), h('td', chipList(r.users)))))
        : h('p', { class: 'help' }, 'No SSH rules.')),
      ...(Object.keys(groups).length ? [section('Groups', table(['Group', 'Members'], Object.entries(groups).map(([g, m]) => h('tr', h('td', { class: 'mono' }, g), h('td', chipList(m))))))] : []),
      ...(Object.keys(p.hosts || {}).length ? [section('Hosts', table(['Name', 'Address'], Object.entries(p.hosts || {}).map(([n, a]) => h('tr', h('td', { class: 'mono' }, n), h('td', { class: 'mono' }, a)))))] : []),
      ...(aaRows.length ? [section('Auto approvers', table(['Route', 'Approved for'], aaRows))] : []),
      ...(asArr(p.nodeAttrs).length ? [section('Node attributes', table(['Target', 'Attributes'], asArr(p.nodeAttrs).map((r) => h('tr', h('td', chipList(r.target)), h('td', chipList(r.attr))))))] : []));
  };
  sel.addEventListener('change', draw);
  draw();
  return h('div', { class: 'stack' },
    h('div', { class: 'toolbar' }, h('label', { class: 'inline-label' }, 'Show rules for', sel),
      h('span', { class: 'muted small' }, 'Preview of the policy in the editor (including unsaved changes).')),
    body);
}

/** Every tag: who owns it and how many machines carry it. */
export function tagsView(ctx: Ctx, text: string): HTMLElement {
  const parsed = parseHuJSON<Policy>(text || '{}');
  const owners = parsed.ok ? parsed.value?.tagOwners || {} : {};
  const inUse = new Map<string, number>();
  for (const n of ctx.data.nodes || []) for (const t of nodeTags(n)) inUse.set(t, (inUse.get(t) || 0) + 1);
  const all = [...new Set([...Object.keys(owners), ...inUse.keys()])].sort();
  if (!all.length) {
    return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('tag', 22)), h('div', { class: 'empty-title' }, 'No tags defined'),
      h('div', { class: 'empty-text' }, 'Add tags under "tagOwners" in the policy file, then assign them to machines.'));
  }
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', h('tr', h('th', 'Tag'), h('th', 'Owners'), h('th', 'Machines'))),
    h('tbody', all.map((t) => {
      const count = inUse.get(t) || 0;
      return h('tr',
        h('td', badge(t, 'tag')),
        h('td', owners[t] ? chipList(owners[t]) : h('span', { class: 'badge badge-warning', title: 'In use on a machine but not defined in tagOwners' }, 'Not in policy')),
        h('td', count ? h('a', { href: '#/machines', onclick: (e) => { e.preventDefault(); store.set('machines.q', t, false); ctx.navigate('#/machines'); } }, `${count} machine${count === 1 ? '' : 's'}`) : h('span', { class: 'muted' }, 'None')));
    }))));
}

/** A diff of `before` → `after` with 3 lines of context around each change. */
export function diffView(before: string, after: string, { what = 'the saved policy', none = 'The editor matches the saved policy.' } = {}): HTMLElement {
  if (before === after) return callout('info', 'No changes', none);
  const d = lineDiff(before, after);
  if (!d) return callout('info', 'Too large to compare here', 'Download the policy to compare it locally.');
  const near = (k: number): boolean => d.slice(Math.max(0, k - 3), k + 4).some((x) => x.op !== ' ');
  const rows: HTMLDivElement[] = [];
  let gap = false;
  d.forEach((r, k) => {
    if (!near(k)) { if (!gap) rows.push(h('div', { class: 'diff-gap' }, '⋯')); gap = true; return; }
    gap = false;
    rows.push(h('div', { class: `diff-line diff-${({ '+': 'add', '-': 'del', ' ': 'ctx' } as const)[r.op]}` }, `${r.op} ${r.line}`));
  });
  const count = (op: string): number => d.filter((r) => r.op === op).length;
  return h('div', { class: 'stack' },
    h('p', { class: 'help' }, `${count('+')} lines added and ${count('-')} removed, compared with ${what}.`),
    h('div', { class: 'diff' }, rows));
}
