// Visual policy editor and access checker for the Access controls page. Both work on
// the text in the policy editor; nothing is applied until the page's Save button.
import { h, put, button, badge, callout, clear, modal, chipInput, confirmDialog, moreButton } from '../ui.js';
import { parseHuJSON, hasComments, userLabel, nodeName, nodeTags } from '../util.js';
import { checkAccess, checkSsh, machineOf, splitDst } from './policy-check.js';

const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const userRef = (u) => (u.name.includes('@') ? u.name : `${u.name}@`);

// Names the chip inputs suggest: users, groups, tags, hosts and autogroups.
function vocabulary(ctx, p) {
  const tags = [...new Set([...Object.keys(p.tagOwners || {}), ...(ctx.data.nodes || []).flatMap(nodeTags)])];
  const sources = ['*', 'autogroup:member', 'autogroup:tagged', ...Object.keys(p.groups || {}), ...tags,
    ...(ctx.data.users || []).map(userRef), ...Object.keys(p.hosts || {})];
  return {
    users: (ctx.data.users || []).map(userRef),
    groups: Object.keys(p.groups || {}),
    tags,
    sources,
    dests: [...sources.filter((s) => s !== 'autogroup:member'), 'autogroup:self', 'autogroup:internet'].map((s) => (s === '*' ? '*:*' : `${s}:*`)),
    sshDests: ['autogroup:self', 'autogroup:member', 'autogroup:tagged', ...tags, ...(ctx.data.users || []).map(userRef)],
  };
}

// A destination without a port gets ":*" — Headscale rejects one with no port.
const withPort = (d) => (splitDst(d).alias === d && d !== '*' ? `${d}:*` : d === '*' ? '*:*' : d);
const nonEmpty = (label) => (v) => { if (!v.length) throw new Error(`${label} needs at least one entry.`); return v; };

// One modal for every entry type. fields: [{ name, label, kind: chips|text|select, value, ... }]
function entryDialog(title, fields, onSave) {
  const get = {};
  const err = h('div');
  const rows = fields.map((f) => {
    let el;
    if (f.kind === 'chips') {
      const c = chipInput(asArr(f.value), { placeholder: f.placeholder, suggestions: f.suggestions || [], normalize: f.normalize });
      get[f.name] = () => (f.check || ((v) => v))(c.get());
      el = c.el;
    } else if (f.kind === 'select') {
      el = h('select', { class: 'input' }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
      get[f.name] = () => el.value;
    } else {
      el = h('input', { class: 'input mono', value: f.value || '', placeholder: f.placeholder, spellcheck: 'false' });
      get[f.name] = () => (f.check || ((v) => v))(el.value.trim());
    }
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, f.label), el, f.help ? h('span', { class: 'help' }, f.help) : null);
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
        } catch (e) { err.append(callout('error', null, e.message)); }
      },
    })],
  });
}

const chips = (items) => h('div', { class: 'badges' }, asArr(items).map((s) => badge(String(s), /^(tag:|group:|autogroup:)/.test(s) ? 'tag' : 'neutral')));

export function visualEditor(ctx, { get, set, readOnly }) {
  const root = h('div', { class: 'stack' });
  let warned = false;

  // Apply a change to the parsed policy and write it back to the editor as JSON.
  async function change(mutate) {
    if (!warned && hasComments(get())) {
      const ok = await confirmDialog({ title: 'Remove comments?', message: 'The visual editor rewrites the policy as plain JSON, which removes comments. Download a copy first to keep them.', confirmLabel: 'Continue' });
      if (!ok) return;
      warned = true;
    }
    const p = parseHuJSON(get().trim() ? get() : '{}').value || {};
    mutate(p);
    for (const k of ['acls', 'ssh', 'groups', 'tagOwners', 'hosts']) {
      if (p[k] && !Object.keys(p[k]).length) delete p[k];
    }
    set(JSON.stringify(p, null, 2) + '\n');
    draw();
  }

  function section(title, desc, addLabel, onAdd, head, rows) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', h('h2', title), h('p', { class: 'help' }, desc)),
        readOnly ? null : button(addLabel, { size: 'sm', icon: 'plus', onClick: onAdd })),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' }, h('thead', h('tr', head.map((x) => h('th', x)), h('th', { class: 'col-actions' }))), h('tbody', rows)))
        : h('p', { class: 'help card-body' }, 'None yet.'));
  }

  const actions = (onEdit, onDelete) => (readOnly ? h('td') : h('td', { class: 'col-actions' }, moreButton(() => [
    { label: 'Edit…', icon: 'edit', onClick: onEdit },
    { label: 'Delete', icon: 'trash', danger: true, onClick: onDelete },
  ])));

  function draw() {
    clear(root);
    const parsed = parseHuJSON(get().trim() ? get() : '{}');
    if (!parsed.ok || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      root.append(callout('error', 'Can\'t edit visually', `Fix the syntax error${parsed.line ? ` on line ${parsed.line}` : ''} in the policy file first.`));
      return;
    }
    const p = parsed.value || {};
    const v = vocabulary(ctx, p);

    const ruleFields = (r = {}) => [
      { name: 'src', label: 'Sources', kind: 'chips', value: r.src, suggestions: v.sources, placeholder: 'group:admins, tag:server, alice@, *', check: nonEmpty('Sources') },
      { name: 'dst', label: 'Destinations', kind: 'chips', value: r.dst, suggestions: v.dests, normalize: withPort, placeholder: 'tag:web:80,443', help: 'Add :port or :80,443 or :1000-2000. Without a port, all ports (:*) are allowed.', check: nonEmpty('Destinations') },
      { name: 'proto', label: 'Protocol', kind: 'select', value: r.proto || '', options: [['', 'Any (TCP, UDP, ICMP)'], ['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP']] },
    ];
    const toRule = ({ src, dst, proto }) => ({ action: 'accept', src, ...(proto ? { proto } : {}), dst });

    const sshFields = (r = {}) => [
      { name: 'action', label: 'Mode', kind: 'select', value: r.action || 'accept', options: [['accept', 'Accept'], ['check', 'Check (re-authenticate periodically)']] },
      { name: 'src', label: 'Who', kind: 'chips', value: r.src, suggestions: v.sources.filter((s) => s !== '*'), placeholder: 'group:admins, autogroup:member', check: nonEmpty('Who') },
      { name: 'dst', label: 'Into', kind: 'chips', value: r.dst, suggestions: v.sshDests, placeholder: 'tag:server, autogroup:self', check: nonEmpty('Into') },
      { name: 'users', label: 'As Linux users', kind: 'chips', value: r.users || ['autogroup:nonroot'], suggestions: ['root', 'autogroup:nonroot', 'localpart:*@*'], check: nonEmpty('Linux users') },
    ];

    const acls = asArr(p.acls);
    const ssh = asArr(p.ssh);
    put(root,
      readOnly ? callout('info', 'Read-only', 'This server loads its policy from a file.') : null,
      section('Access rules', 'Who can connect to what. Anything not allowed here is blocked.', 'Add rule',
        () => entryDialog('Add access rule', ruleFields(), (x) => change((q) => { q.acls = [...asArr(q.acls), toRule(x)]; })),
        ['#', 'Sources', 'Destinations', 'Protocol'],
        acls.map((r, i) => h('tr', h('td', { class: 'muted' }, i + 1), h('td', chips(r.src)), h('td', chips(r.dst)), h('td', r.proto || h('span', { class: 'muted' }, 'any')),
          actions(() => entryDialog('Edit access rule', ruleFields(r), (x) => change((q) => { q.acls[i] = toRule(x); })),
            () => change((q) => { q.acls.splice(i, 1); }))))),
      section('SSH rules', 'Who may use Tailscale SSH, into which machines, as which Linux users.', 'Add SSH rule',
        () => entryDialog('Add SSH rule', sshFields(), (x) => change((q) => { q.ssh = [...asArr(q.ssh), x]; })),
        ['Mode', 'Who', 'Into', 'As'],
        ssh.map((r, i) => h('tr', h('td', badge(r.action || 'accept', r.action === 'check' ? 'warning' : 'success')), h('td', chips(r.src)), h('td', chips(r.dst)), h('td', chips(r.users)),
          actions(() => entryDialog('Edit SSH rule', sshFields(r), (x) => change((q) => {
            q.ssh[i] = { ...q.ssh[i], ...x };
            if (x.action !== 'check') delete q.ssh[i].checkPeriod;
          })),
            () => change((q) => { q.ssh.splice(i, 1); }))))),
      mapSection('Groups', 'Named sets of users that rules can refer to.', 'group', p.groups, change, {
        key: 'groups', keyLabel: 'Group name', prefix: 'group:', valueLabel: 'Members', suggestions: v.users, placeholder: 'alice@', readOnly,
      }, section, actions),
      mapSection('Tag owners', 'Tags must be listed here before machines can use them. Owners may assign the tag.', 'tag', p.tagOwners, change, {
        key: 'tagOwners', keyLabel: 'Tag', prefix: 'tag:', valueLabel: 'Owners', suggestions: [...v.groups, ...v.users, 'autogroup:admin'], placeholder: 'group:admins', allowEmpty: true, readOnly,
      }, section, actions),
      mapSection('Hosts', 'Names for IP addresses or subnets, usable in rules.', 'host', p.hosts, change, {
        key: 'hosts', keyLabel: 'Name', valueLabel: 'Address or subnet', single: true, placeholder: '192.168.1.0/24', readOnly,
      }, section, actions),
      asArr(p.grants).length ? callout('info', `${asArr(p.grants).length} grant(s)`, 'Grants are kept as they are; edit them in the policy file.') : null);
  }

  draw();
  return root;
}

// Groups, tag owners and hosts share one shape: name → value(s).
function mapSection(title, desc, noun, map, change, o, section, actions) {
  const { key } = o;
  const fields = (name = '', value) => [
    { name: 'name', label: o.keyLabel, kind: 'text', value: name, placeholder: o.prefix ? `${o.prefix}example` : 'nas',
      check: (s) => {
        const n = o.prefix && s && !s.startsWith(o.prefix) ? o.prefix + s : s;
        if (!/^[a-z0-9:_.-]+$/i.test(n || '')) throw new Error(`Enter a ${o.keyLabel.toLowerCase()}.`);
        return n;
      } },
    o.single
      ? { name: 'value', label: o.valueLabel, kind: 'text', value, placeholder: o.placeholder, check: (s) => { if (!s) throw new Error(`Enter an ${o.valueLabel.toLowerCase()}.`); return s; } }
      : { name: 'value', label: o.valueLabel, kind: 'chips', value, suggestions: o.suggestions, placeholder: o.placeholder, check: o.allowEmpty ? undefined : nonEmpty(o.valueLabel) },
  ];
  const save = (oldName) => ({ name, value }) => {
    if (name !== oldName && name in (map || {})) throw new Error(`${name} already exists.`);
    change((q) => {
      q[key] = { ...(q[key] || {}) };
      if (oldName && oldName !== name) delete q[key][oldName];
      q[key][name] = value;
    });
  };
  return section(title, desc, `Add ${noun}`, () => entryDialog(`Add ${noun}`, fields(), save(null)),
    [o.keyLabel, o.valueLabel],
    Object.entries(map || {}).map(([name, value]) => h('tr', h('td', { class: 'mono' }, name), h('td', o.single ? h('span', { class: 'mono' }, value) : chips(value)),
      actions(() => entryDialog(`Edit ${noun}`, fields(name, value), save(name)), () => change((q) => { delete q[key][name]; })))));
}

// "Can A reach B?" for the policy in the editor, including SSH as a Linux user.
export function accessChecker(ctx, text) {
  const parsed = parseHuJSON(text.trim() ? text : '{}');
  if (!parsed.ok) return callout('error', 'Can\'t check', 'Fix the policy\'s syntax error first.');
  const policy = parsed.value || {};
  const nodes = ctx.data.nodes || [];
  if (nodes.length < 1) return callout('info', 'No machines', 'Add machines to the tailnet to check access between them.');
  const label = (n) => `${nodeName(n)} — ${n.user ? userLabel(n.user) : nodeTags(n).join(', ')}`;
  const pick = (sel) => h('select', { class: 'input' }, nodes.map((n, i) => h('option', { value: n.id, selected: i === sel }, label(n))));
  const from = pick(0);
  const to = pick(Math.min(1, nodes.length - 1));
  const port = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: 22, style: { width: '110px' } });
  const proto = h('select', { class: 'input', style: { width: '110px' } }, ['tcp', 'udp', 'icmp'].map((p) => h('option', { value: p }, p.toUpperCase())));
  const sshUser = h('input', { class: 'input mono', value: 'root', style: { width: '140px' }, spellcheck: 'false' });
  const out = h('div', { class: 'stack' });

  const run = () => {
    clear(out);
    const a = nodes.find((n) => String(n.id) === from.value);
    const b = nodes.find((n) => String(n.id) === to.value);
    const n = Math.max(1, Math.min(65535, parseInt(port.value, 10) || 1));
    const net = checkAccess(policy, machineOf(a), machineOf(b), n, proto.value);
    const ssh = checkSsh(policy, machineOf(a), machineOf(b), sshUser.value.trim() || 'root');
    out.append(
      callout(net.allowed ? 'success' : 'error', net.allowed ? `${nodeName(a)} can reach ${nodeName(b)} on ${proto.value.toUpperCase()}${proto.value === 'icmp' ? '' : ` ${n}`}` : 'Blocked', net.reason),
      callout(ssh.allowed && net.allowed ? (ssh.action === 'check' ? 'warning' : 'success') : 'error',
        `SSH as ${sshUser.value.trim() || 'root'}: ${ssh.allowed ? (net.allowed || n !== 22 ? 'allowed' : 'allowed by SSH rules, but port 22 is blocked') : 'not allowed'}`, ssh.reason));
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
