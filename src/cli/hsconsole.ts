#!/usr/bin/env node
/**
 * hsconsole — the console's features from the command line, straight against the
 * Headscale API. Configure with --url/--key or HEADSCALE_URL / HEADSCALE_API_KEY.
 * Run `hsconsole help` for the commands.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { HeadscaleAPI } from '../shared/api.js';
import { buildBackup } from '../shared/backup.js';
import { joinCommand, type JoinOS } from '../shared/join.js';
import {
  expiryState, lineDiff, nodeIPv4, nodeName, nodeTags, parseHuJSON, relTime, routeInfo, userLabel,
} from '../shared/model.js';
import { checkAccess, checkSsh, machineOf, type Proto } from '../shared/policy-check.js';
import type { Node, Policy, User } from '../shared/types.js';

export const HELP = `hsconsole — manage a Headscale server from the command line

Usage: hsconsole [--url URL] [--key API_KEY] [--json] <command> [args]
  --url / HEADSCALE_URL          Headscale server, e.g. https://hs.example.com
  --key / HEADSCALE_API_KEY      API key (headscale apikeys create)

Machines
  machines [--search TEXT]                    List machines
  machine <machine>                           Show one machine (id or name)
  rename <machine> <new-name>                 Rename a machine
  tags <machine> <tag:a,tag:b|"">             Replace a machine's tags
  expire <machine>                            Expire a machine's key now
  remove <machine> --yes                      Remove a machine
Routes
  routes [--pending]                          List advertised and approved routes
  approve <machine> [route ...]               Approve routes (all advertised if none given)
Users
  users                                       List users
  user add <name> [--display-name N] [--email E]
  user rm <user> --yes                        Delete a user (it must own no machines)
Keys and joining
  keys                                        List auth keys
  key add [--user U] [--reusable] [--ephemeral] [--expires 24h] [--tags tag:a,tag:b]
  join [--user U] [--os linux|mac|win|docker|compose] [--tags ...] [--expires 1h]
                                              Create a single-use key and print the join command
Policy
  policy get [--out FILE]                     Print or save the policy
  policy set <FILE> [--yes]                   Show the diff, then replace the policy
  policy check <FILE>                         Validate a policy file on the server
  check <from> <to> [--port 22] [--proto tcp] [--ssh-user root]
                                              Can one machine reach another under the current policy?
Server
  status                                      Version, health and what needs attention
  backup [--out FILE]                         Export users, machines, key metadata and the policy

Exit codes: 0 success, 1 error, 2 usage error.`;

export class UsageError extends Error {}

const OPTIONS = {
  url: { type: 'string' }, key: { type: 'string' }, json: { type: 'boolean' }, yes: { type: 'boolean' },
  search: { type: 'string' }, pending: { type: 'boolean' }, user: { type: 'string' }, os: { type: 'string' },
  tags: { type: 'string' }, expires: { type: 'string' }, reusable: { type: 'boolean' }, ephemeral: { type: 'boolean' },
  out: { type: 'string' }, port: { type: 'string' }, proto: { type: 'string' }, 'ssh-user': { type: 'string' },
  'display-name': { type: 'string' }, email: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} as const;

/** "90d", "24h", "30m" → milliseconds. */
export function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(m|h|d|w)$/);
  if (!m) throw new UsageError(`Invalid duration "${s}" (use e.g. 30m, 24h, 90d, 2w)`);
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] as 'm' | 'h' | 'd' | 'w'];
}

/** Left-aligned columns, two spaces apart. */
export function table(head: string[], rows: string[][]): string {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? '').padEnd(widths[i]!))).join('  ').trimEnd()).join('\n');
}

const splitList = (s: string | undefined): string[] => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

export interface Io { out: (s: string) => void; err: (s: string) => void }

/** Runs one command; returns the exit code. */
export async function run(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals: [cmd, ...args] } = parsed;
  if (!cmd || cmd === 'help' || o.help) { io.out(HELP); return cmd || o.help ? 0 : 2; }

  const url = (o.url || env.HEADSCALE_URL || '').replace(/\/+$/, '');
  const key = o.key || env.HEADSCALE_API_KEY || '';
  if (!url || !key) { io.err('Set the server and key with --url and --key, or HEADSCALE_URL and HEADSCALE_API_KEY.'); return 2; }
  const api = new HeadscaleAPI({ base: `${url}/`, key });
  const print = (human: string, data: unknown): void => io.out(o.json ? JSON.stringify(data, null, 2) : human);

  async function findNode(ref: string | undefined): Promise<Node> {
    if (!ref) throw new UsageError('Name a machine (its id or name).');
    const nodes = await api.listNodes();
    const n = nodes.find((x) => x.id === ref) || nodes.find((x) => nodeName(x) === ref || x.name === ref);
    if (!n) throw new Error(`No machine "${ref}".`);
    return n;
  }
  async function findUser(ref: string | undefined): Promise<User> {
    if (!ref) throw new UsageError('Name a user (its name or id).');
    const users = await api.listUsers();
    const u = users.find((x) => x.id === ref) || users.find((x) => x.name === ref || x.name === `${ref}@` || x.email === ref);
    if (!u) throw new Error(`No user "${ref}".`);
    return u;
  }
  const machineRow = (n: Node): string[] => [n.id, nodeName(n), nodeIPv4(n) || '-', n.user ? userLabel(n.user) : nodeTags(n).join(',') || '-', n.online ? 'online' : `seen ${relTime(n.lastSeen)}`];

  try {
    switch (cmd) {
      case 'machines': {
        const q = (o.search || '').toLowerCase();
        const nodes = (await api.listNodes()).filter((n) => !q || [nodeName(n), n.name, ...(n.ipAddresses || []), n.user?.name, ...nodeTags(n)].join(' ').toLowerCase().includes(q));
        print(table(['ID', 'NAME', 'IPV4', 'OWNER', 'STATUS'], nodes.map(machineRow)), nodes);
        return 0;
      }
      case 'machine': {
        const n = await findNode(args[0]);
        const ri = routeInfo(n);
        const e = expiryState(n);
        print([
          `${nodeName(n)} (id ${n.id}) — ${n.online ? 'online' : `last seen ${relTime(n.lastSeen)}`}`,
          `owner:     ${n.user ? userLabel(n.user) : 'tagged device'}`,
          `addresses: ${(n.ipAddresses || []).join(', ') || '-'}`,
          `tags:      ${nodeTags(n).join(', ') || '-'}`,
          `routes:    ${[
            ...ri.subnets.map((r) => `${r}${ri.approved.includes(r) ? '' : ' (pending)'}`),
            ...(ri.exitAdvertised ? [`exit node${ri.exitApproved ? '' : ' (pending)'}`] : []),
          ].join(', ') || '-'}`,
          `key:       ${e.disabled ? 'never expires' : e.expired ? 'expired' : `expires ${relTime(e.date)}`}`,
        ].join('\n'), n);
        return 0;
      }
      case 'rename': {
        const n = await findNode(args[0]);
        if (!args[1]) throw new UsageError('Give the new name.');
        const r = await api.renameNode(n.id, args[1]);
        print(`Renamed ${nodeName(n)} to ${nodeName(r)}`, r);
        return 0;
      }
      case 'tags': {
        const n = await findNode(args[0]);
        if (args[1] === undefined) throw new UsageError('Give the tags, comma-separated ("" for none).');
        const tags = splitList(args[1]).map((t) => (t.startsWith('tag:') ? t : `tag:${t}`));
        const r = await api.setTags(n.id, tags);
        print(`Tags on ${nodeName(r)}: ${nodeTags(r).join(', ') || 'none'}`, r);
        return 0;
      }
      case 'expire': {
        const n = await findNode(args[0]);
        await api.expireNode(n.id);
        print(`Expired the key of ${nodeName(n)}`, { expired: n.id });
        return 0;
      }
      case 'remove': {
        const n = await findNode(args[0]);
        if (!o.yes) throw new UsageError(`This removes ${nodeName(n)} from the tailnet. Add --yes to confirm.`);
        await api.deleteNode(n.id);
        print(`Removed ${nodeName(n)}`, { removed: n.id });
        return 0;
      }
      case 'routes': {
        const rows = (await api.listNodes()).flatMap((n) => {
          const ri = routeInfo(n);
          return [...ri.subnets, ...(ri.exitAdvertised || ri.exitApproved ? ['exit node'] : [])].map((r) => {
            const approved = r === 'exit node' ? ri.exitApproved : ri.approved.includes(r);
            return { machine: nodeName(n), id: n.id, route: r, approved, primary: ri.primary.includes(r) };
          });
        }).filter((r) => !o.pending || !r.approved);
        print(table(['MACHINE', 'ROUTE', 'STATE'], rows.map((r) => [r.machine, r.route, r.approved ? (r.primary ? 'approved, primary' : 'approved') : 'pending'])), rows);
        return 0;
      }
      case 'approve': {
        const n = await findNode(args[0]);
        const wanted = args.length > 1 ? args.slice(1).flatMap((r) => (r === 'exit' ? ['0.0.0.0/0', '::/0'] : [r])) : n.availableRoutes || [];
        if (!wanted.length) throw new Error(`${nodeName(n)} isn't advertising any routes.`);
        const r = await api.setApprovedRoutes(n.id, [...new Set([...(n.approvedRoutes || []), ...wanted])]);
        print(`Approved on ${nodeName(n)}: ${wanted.join(', ')}`, r);
        return 0;
      }
      case 'users': {
        const [users, nodes] = await Promise.all([api.listUsers(), api.listNodes()]);
        print(table(['ID', 'NAME', 'DISPLAY NAME', 'MACHINES'], users.map((u) => [u.id, u.name, u.displayName || '-', String(nodes.filter((n) => n.user?.id === u.id).length)])), users);
        return 0;
      }
      case 'user': {
        if (args[0] === 'add') {
          if (!args[1]) throw new UsageError('Give the user name.');
          const u = await api.createUser({ name: args[1], ...(o['display-name'] ? { displayName: o['display-name'] } : {}), ...(o.email ? { email: o.email } : {}) });
          print(`Created user ${u.name} (id ${u.id})`, u);
          return 0;
        }
        if (args[0] === 'rm') {
          const u = await findUser(args[1]);
          if (!o.yes) throw new UsageError(`This deletes user ${u.name}. Add --yes to confirm.`);
          await api.deleteUser(u.id);
          print(`Deleted user ${u.name}`, { deleted: u.id });
          return 0;
        }
        throw new UsageError('Use "user add <name>" or "user rm <user> --yes".');
      }
      case 'keys': {
        const keys = await api.listPreAuthKeys(await api.listUsers());
        print(table(['ID', 'USER', 'TYPE', 'TAGS', 'EXPIRES'], keys.map((k) => [
          String(k.id ?? '-'), k.user?.name || '-', [k.reusable ? 'reusable' : 'one-off', k.ephemeral ? 'ephemeral' : '', k.used ? 'used' : ''].filter(Boolean).join(','),
          (k.aclTags || []).join(',') || '-', relTime(k.expiration)])), keys);
        return 0;
      }
      case 'key':
      case 'join': {
        if (cmd === 'key' && args[0] !== 'add') throw new UsageError('Use "key add".');
        const os = (o.os || 'linux') as JoinOS;
        if (cmd === 'join' && !['linux', 'mac', 'win', 'docker', 'compose'].includes(os)) throw new UsageError('--os must be linux, mac, win, docker or compose.');
        const tags = splitList(o.tags).map((t) => (t.startsWith('tag:') ? t : `tag:${t}`));
        const user = o.user ? await findUser(o.user) : null;
        if (!user && !tags.length) throw new UsageError('Give --user or --tags (a key without a user needs a tag).');
        const k = await api.createPreAuthKey({
          ...(user ? { user: user.id } : {}),
          reusable: cmd === 'key' && !!o.reusable,
          ephemeral: !!o.ephemeral,
          expiration: new Date(Date.now() + parseDuration(o.expires || (cmd === 'join' ? '1h' : '24h'))).toISOString(),
          aclTags: tags,
        });
        if (cmd === 'key') { print(k.key, k); return 0; }
        print(joinCommand(os, url, k.key, tags, { acceptRoutes: true }), { key: k.key, command: joinCommand(os, url, k.key, tags, { acceptRoutes: true }) });
        return 0;
      }
      case 'policy': {
        if (args[0] === 'get') {
          const p = (await api.getPolicy()).policy || '';
          if (o.out) { fs.writeFileSync(o.out, p); io.out(`Saved the policy to ${o.out}`); } else io.out(p);
          return 0;
        }
        if (!args[1]) throw new UsageError('Give the policy file.');
        const text = fs.readFileSync(args[1], 'utf8');
        const parsed = parseHuJSON(text);
        if (!parsed.ok) throw new Error(`${args[1]}: syntax error${parsed.line ? ` on line ${parsed.line}` : ''}: ${parsed.error}`);
        if (args[0] === 'check') {
          const r = await api.checkPolicy(text);
          if (!r.ok) throw new Error(`Headscale rejected the policy: ${r.error}`);
          io.out(r.unsupported ? 'Syntax is valid (this Headscale version can\'t validate without saving).' : 'The policy is valid.');
          return 0;
        }
        if (args[0] === 'set') {
          const current = (await api.getPolicy()).policy || '';
          if (current === text) { io.out('The policy is unchanged.'); return 0; }
          const diff = lineDiff(current, text);
          io.out(diff ? diff.filter((d) => d.op !== ' ').map((d) => `${d.op} ${d.line}`).join('\n') : '(too large to diff)');
          if (!o.yes) throw new UsageError('Add --yes to apply these changes.');
          await api.setPolicy(text);
          io.out('Policy saved and applied.');
          return 0;
        }
        throw new UsageError('Use "policy get", "policy set <file>" or "policy check <file>".');
      }
      case 'check': {
        const [a, b] = await Promise.all([findNode(args[0]), findNode(args[1])]);
        const parsed = parseHuJSON<Policy>((await api.getPolicy()).policy || '{}');
        if (!parsed.ok) throw new Error('The server\'s policy doesn\'t parse.');
        const port = Number(o.port || 22);
        const proto = (o.proto || 'tcp') as Proto;
        if (!['tcp', 'udp', 'icmp'].includes(proto)) throw new UsageError('--proto must be tcp, udp or icmp.');
        const net = checkAccess(parsed.value || {}, machineOf(a), machineOf(b), port, proto);
        const sshNetwork = checkAccess(parsed.value || {}, machineOf(a), machineOf(b), 22, 'tcp');
        const ssh = sshNetwork.allowed
          ? checkSsh(parsed.value || {}, machineOf(a), machineOf(b), o['ssh-user'] || 'root')
          : { allowed: false, reason: 'Network policy blocks TCP port 22.' };
        print([
          `${nodeName(a)} → ${nodeName(b)} ${proto}${proto === 'icmp' ? '' : `/${port}`}: ${net.allowed ? 'ALLOWED' : 'BLOCKED'} — ${net.reason}`,
          `SSH as ${o['ssh-user'] || 'root'}: ${ssh.allowed ? 'ALLOWED' : 'NOT ALLOWED'} — ${ssh.reason}`,
        ].join('\n'), { network: net, ssh });
        return net.allowed ? 0 : 1;
      }
      case 'status': {
        const [version, health, users, nodes] = await Promise.all([api.version(), api.health(), api.listUsers(), api.listNodes()]);
        const pending = nodes.filter((n) => { const r = routeInfo(n); return r.pendingSubnets.length || r.exitPending; });
        const expired = nodes.filter((n) => expiryState(n).expired);
        const data = { version: version?.version ?? null, database: !!health.databaseConnectivity, users: users.length, machines: nodes.length, online: nodes.filter((n) => n.online).length, pendingRoutes: pending.map(nodeName), expiredKeys: expired.map(nodeName) };
        print([
          `Headscale ${data.version ?? 'unknown'} at ${url} — database ${data.database ? 'ok' : 'UNREACHABLE'}`,
          `${data.users} users, ${data.machines} machines (${data.online} online)`,
          pending.length ? `Routes awaiting approval on: ${data.pendingRoutes.join(', ')}` : 'No routes awaiting approval',
          expired.length ? `Expired keys: ${data.expiredKeys.join(', ')}` : 'No expired machine keys',
        ].join('\n'), data);
        return 0;
      }
      case 'backup': {
        const users = await api.listUsers();
        const [nodes, preAuthKeys, apiKeys, policy, version] = await Promise.all([api.listNodes(), api.listPreAuthKeys(users), api.listApiKeys(), api.getPolicy(), api.version()]);
        const b = JSON.stringify(buildBackup({ server: url, headscaleVersion: version?.version ?? null, users, nodes, preAuthKeys, apiKeys, policy: policy.policy || '' }), null, 2);
        const file = o.out || `headscale-backup-${new Date().toISOString().slice(0, 10)}.json`;
        fs.writeFileSync(file, b, { mode: 0o600 });
        io.out(`Saved ${users.length} users, ${nodes.length} machines and the policy to ${file}`);
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${cmd}".`);
    }
  } catch (e) {
    if (e instanceof UsageError) { io.err(e.message); return 2; }
    io.err(`Error: ${(e as Error).message}`);
    return 1;
  }
}

// Only when run as a program (tests import run() directly).
if (process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(process.argv[1])}`).href) {
  run(process.argv.slice(2), process.env, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((code) => { process.exitCode = code; });
}
