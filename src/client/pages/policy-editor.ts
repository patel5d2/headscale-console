// Visual policy editor and access checker for the Access controls page. Both work on
// the text in the policy editor; nothing is applied until the page's Save button.
import { checkAccess, checkSsh, machineOf, splitDst, type Proto } from '../../shared/policy-check.js';
import type { AclRule, Policy, SshRule } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import type { Child } from '../ui.js';
import { badge, button, callout, chipInput, clear, confirmDialog, h, modal, moreButton, put } from '../ui.js';
import { hasComments, nodeName, nodeTags, parseHuJSON, userLabel, userRef } from '../util.js';

const asArr = <T>(v: T | T[] | null | undefined): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Names the chip inputs suggest: users, groups, tags, hosts and autogroups. */
function vocabulary(ctx: Ctx, p: Policy): { users: string[]; groups: string[]; sources: string[]; dests: string[]; sshDests: string[] } {
  const tags = [...new Set([...Object.keys(p.tagOwners || {}), ...(ctx.data.nodes || []).flatMap(nodeTags)])];
  const users = (ctx.data.users || []).map(userRef);
  const sources = ['*', 'autogroup:member', 'autogroup:tagged', ...Object.keys(p.groups || {}), ...tags, ...users, ...Object.keys(p.hosts || {})];
  return {
    users,
    groups: Object.keys(p.groups || {}),
    sources,
    dests: [...sources.filter((s) => s !== 'autogroup:member'), 'autogroup:self', 'autogroup:internet'].map((s) => (s === '*' ? '*:*' : `${s}:*`)),
    sshDests: ['autogroup:self', 'autogroup:member', 'autogroup:tagged', ...tags, ...users],
  };
}

/** A destination without a port gets ":*" — Headscale rejects one with no port. */
export const withPort = (d: string): string => (d === '*' ? '*:*' : splitDst(d).alias === d ? `${d}:*` : d);
const nonEmpty = (label: string) => (v: string[]): string[] => { if (!v.length) throw new Error(`${label} needs at least one entry.`); return v; };

type Field =
  | { kind: 'chips'; name: string; label: string; value?: string[] | undefined; suggestions?: string[]; placeholder?: string; help?: string; normalize?: (s: string) => string; check?: (v: string[]) => string[] }
  | { kind: 'text'; name: string; label: string; value?: string | undefined; placeholder?: string; help?: string; check: (v: string) => string }
  | { kind: 'select'; name: string; label: string; value: string; options: Array<[string, string]> };
type Values = Record<string, string | string[]>;

/** One modal for every entry type. */
function entryDialog(title: string, fields: Field[], onSave: (v: Values) => void): void {
  const get: Record<string, () => string | string[]> = {};
  const err = h('div');
  const rows = fields.map((f) => {
    let el: HTMLElement;
    if (f.kind === 'chips') {
      const c = chipInput(f.value || [], { ...(f.placeholder ? { placeholder: f.placeholder } : {}), suggestions: f.suggestions || [], ...(f.normalize ? { normalize: f.normalize } : {}) });
      get[f.name] = () => (f.check ?? ((v) => v))(c.get());
      el = c.el;
    } else if (f.kind === 'select') {
      const s = h('select', { class: 'input', 'aria-label': f.label }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
      get[f.name] = () => s.value;
      el = s;
    } else {
      const i = h('input', { class: 'input mono', value: f.value || '', placeholder: f.placeholder, spellcheck: 'false', 'aria-label': f.label });
      get[f.name] = () => f.check(i.value.trim());
      el = i;
    }
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, f.label), el, 'help' in f && f.help ? h('span', { class: 'help' }, f.help) : null);
  });
  const m = modal({
    title, size: 'md',
    body: h('div', { class: 'stack' }, rows, err),
    footer: (api) => [button('Cancel', { onClick: () => api.close() }), button('Apply', {
      variant: 'primary',
      onClick: () => {
        clear(err);
        try {
          onSave(Object.fromEntries(Object.entries(get).map(([k, g]) => [k, g()])));
          m.close();
        } catch (e) { err.append(callout('error', null, (e as Error).message)); }
      },
    })],
  });
}

const chips = (items: unknown): HTMLDivElement =>
  h('div', { class: 'badges' }, asArr(items).map((s) => badge(String(s), /^(tag:|group:|autogroup:)/.test(String(s)) ? 'tag' : 'neutral')));

type Change = (mutate: (p: Policy) => void) => Promise<void>;
type Section = (title: string, desc: string, addLabel: string, onAdd: () => void, head: string[], rows: HTMLTableRowElement[]) => HTMLElement;
type Actions = (onEdit: () => void, onDelete: () => void) => HTMLTableCellElement;

export function visualEditor(ctx: Ctx, { get, set, readOnly }: { get: () => string; set: (t: string) => void; readOnly: boolean }): HTMLDivElement {
  const root = h('div', { class: 'stack' });
  let warned = false;

  /** Applies a change to the parsed policy and writes it back to the editor as JSON. */
  const change: Change = async (mutate) => {
    if (!warned && hasComments(get())) {
      const ok = await confirmDialog({ title: 'Remove comments?', message: 'The visual editor rewrites the policy as plain JSON, which removes comments. Download a copy first to keep them.', confirmLabel: 'Continue' });
      if (!ok) return;
      warned = true;
    }
    const parsed = parseHuJSON<Policy>(get().trim() ? get() : '{}');
    const p: Policy = parsed.ok && parsed.value ? parsed.value : {};
    mutate(p);
    for (const k of ['acls', 'ssh', 'groups', 'tagOwners', 'hosts'] as const) {
      const v = p[k];
      if (v && !Object.keys(v).length) delete p[k];
    }
    set(JSON.stringify(p, null, 2) + '\n');
    draw();
  };

  const section: Section = (title, desc, addLabel, onAdd, head, rows) => h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', h('h2', title), h('p', { class: 'help' }, desc)),
      readOnly ? null : button(addLabel, { size: 'sm', icon: 'plus', onClick: onAdd })),
    rows.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' }, h('thead', h('tr', head.map((x) => h('th', x)), h('th', { class: 'col-actions' }))), h('tbody', rows)))
      : h('p', { class: 'help card-body' }, 'None yet.'));

  const actions: Actions = (onEdit, onDelete) => (readOnly ? h('td') : h('td', { class: 'col-actions' }, moreButton(() => [
    { label: 'Edit…', icon: 'edit', onClick: onEdit },
    { label: 'Delete', icon: 'trash', danger: true, onClick: onDelete },
  ])));

  function draw(): void {
    clear(root);
    const parsed = parseHuJSON<Policy>(get().trim() ? get() : '{}');
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      root.append(callout('error', 'Can\'t edit visually', `Fix the syntax error${!parsed.ok && parsed.line ? ` on line ${parsed.line}` : ''} in the policy file first.`));
      return;
    }
    const p = parsed.value;
    const v = vocabulary(ctx, p);

    const ruleFields = (r: Partial<AclRule> = {}): Field[] => [
      { name: 'src', label: 'Sources', kind: 'chips', value: r.src, suggestions: v.sources, placeholder: 'group:admins, tag:server, alice@, *', check: nonEmpty('Sources') },
      { name: 'dst', label: 'Destinations', kind: 'chips', value: r.dst, suggestions: v.dests, normalize: withPort, placeholder: 'tag:web:80,443', help: 'Add :port or :80,443 or :1000-2000. Without a port, all ports (:*) are allowed.', check: nonEmpty('Destinations') },
      { name: 'proto', label: 'Protocol', kind: 'select', value: String(r.proto || ''), options: [['', 'Any (TCP, UDP, ICMP)'], ['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP']] },
    ];
    const toRule = (x: Values): AclRule => ({ action: 'accept', src: x.src as string[], ...(x.proto ? { proto: x.proto as string } : {}), dst: x.dst as string[] });

    const sshFields = (r: Partial<SshRule> = {}): Field[] => [
      { name: 'action', label: 'Mode', kind: 'select', value: r.action || 'accept', options: [['accept', 'Accept'], ['check', 'Check (re-authenticate periodically)']] },
      { name: 'src', label: 'Who', kind: 'chips', value: r.src, suggestions: v.sources.filter((s) => s !== '*'), placeholder: 'group:admins, autogroup:member', check: nonEmpty('Who') },
      { name: 'dst', label: 'Into', kind: 'chips', value: r.dst, suggestions: v.sshDests, placeholder: 'tag:server, autogroup:self', check: nonEmpty('Into') },
      { name: 'users', label: 'As Linux users', kind: 'chips', value: r.users || ['autogroup:nonroot'], suggestions: ['root', 'autogroup:nonroot', 'localpart:*@*'], check: nonEmpty('Linux users') },
    ];
    const toSsh = (x: Values): SshRule => ({ action: x.action as string, src: x.src as string[], dst: x.dst as string[], users: x.users as string[] });

    put(root,
      section('Access rules', 'Who can connect to what. Anything not allowed here is blocked.', 'Add rule',
        () => entryDialog('Add access rule', ruleFields(), (x) => void change((q) => { q.acls = [...asArr(q.acls), toRule(x)]; })),
        ['#', 'Sources', 'Destinations', 'Protocol'],
        asArr(p.acls).map((r, i) => h('tr', h('td', { class: 'muted' }, i + 1), h('td', chips(r.src)), h('td', chips(r.dst)), h('td', r.proto ? String(r.proto) : h('span', { class: 'muted' }, 'any')),
          actions(() => entryDialog('Edit access rule', ruleFields(r), (x) => void change((q) => { q.acls![i] = toRule(x); })),
            () => void change((q) => { q.acls!.splice(i, 1); }))))),
      section('SSH rules', 'Who may use Tailscale SSH, into which machines, as which Linux users.', 'Add SSH rule',
        () => entryDialog('Add SSH rule', sshFields(), (x) => void change((q) => { q.ssh = [...asArr(q.ssh), toSsh(x)]; })),
        ['Mode', 'Who', 'Into', 'As'],
        asArr(p.ssh).map((r, i) => h('tr', h('td', badge(r.action || 'accept', r.action === 'check' ? 'warning' : 'success')), h('td', chips(r.src)), h('td', chips(r.dst)), h('td', chips(r.users)),
          actions(() => entryDialog('Edit SSH rule', sshFields(r), (x) => void change((q) => {
            const next: SshRule = { ...q.ssh![i]!, ...toSsh(x) };
            if (next.action !== 'check') delete next.checkPeriod;
            q.ssh![i] = next;
          })),
          () => void change((q) => { q.ssh!.splice(i, 1); }))))),
      mapSection('Groups', 'Named sets of users that rules can refer to.', 'group', p.groups, change, {
        key: 'groups', keyLabel: 'Group name', prefix: 'group:', valueLabel: 'Members', suggestions: v.users, placeholder: 'alice@',
      }, section, actions),
      mapSection('Tag owners', 'Tags must be listed here before machines can use them. Owners may assign the tag.', 'tag', p.tagOwners, change, {
        key: 'tagOwners', keyLabel: 'Tag', prefix: 'tag:', valueLabel: 'Owners', suggestions: [...v.groups, ...v.users, 'autogroup:admin'], placeholder: 'group:admins', allowEmpty: true,
      }, section, actions),
      mapSection('Hosts', 'Names for IP addresses or subnets, usable in rules.', 'host', p.hosts, change, {
        key: 'hosts', keyLabel: 'Name', valueLabel: 'Address or subnet', single: true, placeholder: '192.168.1.0/24',
      }, section, actions),
      asArr(p.grants).length ? callout('info', `${asArr(p.grants).length} grant(s)`, 'Grants are kept as they are; edit them in the policy file.') : null);
  }

  draw();
  return root;
}

interface MapOpts {
  key: 'groups' | 'tagOwners' | 'hosts'; keyLabel: string; valueLabel: string; prefix?: string;
  suggestions?: string[]; placeholder: string; allowEmpty?: boolean; single?: boolean;
}

/** Groups, tag owners and hosts share one shape: name → value(s). */
function mapSection(title: string, desc: string, noun: string, map: Record<string, string | string[]> | undefined, change: Change, o: MapOpts, section: Section, actions: Actions): HTMLElement {
  const fields = (name = '', value?: string | string[]): Field[] => [
    {
      name: 'name', label: o.keyLabel, kind: 'text', value: name, placeholder: o.prefix ? `${o.prefix}example` : 'nas',
      check: (s) => {
        const n = o.prefix && s && !s.startsWith(o.prefix) ? o.prefix + s : s;
        if (!/^[a-z0-9:_.-]+$/i.test(n)) throw new Error(`Enter a ${o.keyLabel.toLowerCase()}.`);
        return n;
      },
    },
    o.single
      ? { name: 'value', label: o.valueLabel, kind: 'text', value: value as string | undefined, placeholder: o.placeholder, check: (s) => { if (!s) throw new Error(`Enter an ${o.valueLabel.toLowerCase()}.`); return s; } }
      : { name: 'value', label: o.valueLabel, kind: 'chips', value: value as string[] | undefined, suggestions: o.suggestions || [], placeholder: o.placeholder, ...(o.allowEmpty ? {} : { check: nonEmpty(o.valueLabel) }) },
  ];
  const save = (oldName: string | null) => ({ name, value }: Values): void => {
    const n = name as string;
    if (n !== oldName && n in (map || {})) throw new Error(`${n} already exists.`);
    void change((q) => {
      const next: Record<string, unknown> = { ...(q[o.key] || {}) };
      if (oldName && oldName !== n) delete next[oldName];
      next[n] = value;
      (q as Record<string, unknown>)[o.key] = next;
    });
  };
  return section(title, desc, `Add ${noun}`, () => entryDialog(`Add ${noun}`, fields(), save(null)),
    [o.keyLabel, o.valueLabel],
    Object.entries(map || {}).map(([name, value]) => h('tr', h('td', { class: 'mono' }, name), h('td', o.single ? h('span', { class: 'mono' }, String(value)) : chips(value)),
      actions(() => entryDialog(`Edit ${noun}`, fields(name, value), save(name)), () => void change((q) => { delete (q[o.key] as Record<string, unknown>)[name]; })))));
}

/** "Can A reach B?" for the policy in the editor, including SSH as a Linux user. */
export function accessChecker(ctx: Ctx, text: string): HTMLElement {
  const parsed = parseHuJSON<Policy>(text.trim() ? text : '{}');
  if (!parsed.ok) return callout('error', 'Can\'t check', 'Fix the policy\'s syntax error first.');
  const policy = parsed.value || {};
  const nodes = ctx.data.nodes || [];
  if (!nodes.length) return callout('info', 'No machines', 'Add machines to the tailnet to check access between them.');
  const pick = (sel: number, label: string): HTMLSelectElement => h('select', { class: 'input', 'aria-label': label },
    nodes.map((n, i) => h('option', { value: n.id, selected: i === sel }, `${nodeName(n)} — ${n.user ? userLabel(n.user) : nodeTags(n).join(', ')}`)));
  const from = pick(0, 'From');
  const to = pick(Math.min(1, nodes.length - 1), 'To');
  const port = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: 22, style: { width: '110px' }, 'aria-label': 'Port' });
  const proto = h('select', { class: 'input', style: { width: '110px' }, 'aria-label': 'Protocol' }, ['tcp', 'udp', 'icmp'].map((p) => h('option', { value: p }, p.toUpperCase())));
  const sshUser = h('input', { class: 'input mono', value: 'root', style: { width: '140px' }, spellcheck: 'false', 'aria-label': 'SSH as' });
  const out = h('div', { class: 'stack' });

  const run = (): void => {
    const a = machineOf(nodes.find((n) => n.id === from.value)!);
    const b = machineOf(nodes.find((n) => n.id === to.value)!);
    const n = Math.max(1, Math.min(65535, parseInt(port.value, 10) || 1));
    const p = proto.value as Proto;
    const user = sshUser.value.trim() || 'root';
    const net = checkAccess(policy, a, b, n, p);
    const net22 = checkAccess(policy, a, b, 22, 'tcp'); // Tailscale SSH needs TCP 22 open too
    const ssh = checkSsh(policy, a, b, user);
    const [fromName, toName] = [from, to].map((s) => s.selectedOptions[0]!.textContent!.split(' — ')[0]);
    const sshText: Child = ssh.allowed ? (net22.allowed ? 'allowed' : 'allowed by SSH rules, but TCP 22 is blocked') : 'not allowed';
    clear(out).append(
      callout(net.allowed ? 'success' : 'error', net.allowed ? `${fromName} can reach ${toName} on ${p.toUpperCase()}${p === 'icmp' ? '' : ` ${n}`}` : 'Blocked', net.reason),
      callout(ssh.allowed && net22.allowed ? (ssh.action === 'check' ? 'warning' : 'success') : 'error', `SSH as ${user}: ${sshText}`, ssh.reason));
  };
  for (const el of [from, to, port, proto, sshUser]) el.addEventListener('input', run);
  run();
  return h('div', { class: 'stack' },
    h('p', { class: 'help' }, 'Checks the policy in the editor, including unsaved changes. Headscale has the final say; uncommon features such as via-grants aren\'t evaluated.'),
    h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'From'), from),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'To'), to)),
    h('div', { class: 'toolbar' },
      h('label', { class: 'inline-label' }, 'Port', port), h('label', { class: 'inline-label' }, 'Protocol', proto),
      h('label', { class: 'inline-label' }, 'SSH as', sshUser)),
    out);
}
