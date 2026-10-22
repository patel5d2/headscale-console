// Evaluates a Headscale/Tailscale policy for one connection: can machine A reach
// machine B on a port, and may it SSH in as a given user. Pure functions, so they
// run against unsaved edits in the browser and in the CLI. Headscale remains the
// final authority.
//
// ponytail: covers acls, grants (ip), ssh, groups, hosts, tags, autogroups and IPv4
// CIDRs. IPv6 prefixes match exact addresses only; via/app grants and posture
// conditions are ignored. Extend matchesAlias() if those start to matter.
import { nodeTags } from './model.js';
import type { Node, Policy } from './types.js';

export interface Machine { user: { name: string; email?: string } | null; tags: string[]; ips: string[] }
export type Proto = 'tcp' | 'udp' | 'icmp';
export interface AccessResult { allowed: boolean; reason: string; index?: number; section?: 'acls' | 'grants' }
export interface SshResult { allowed: boolean; reason: string; action?: 'accept' | 'check'; index?: number }

const asArr = <T>(v: T | T[] | null | undefined): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const PROTOS: Record<Proto, number> = { tcp: 6, udp: 17, icmp: 1 };

function ipv4ToInt(ip: string): number | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((x) => x >= 0 && x <= 255) ? ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]! : null;
}

/** Does `cidr` (an address or prefix) contain any of `ips`? */
export function cidrContains(cidr: string, ips: string[]): boolean {
  const [base = '', bits] = cidr.split('/');
  const b = ipv4ToInt(base);
  if (b === null) return ips.includes(base) && (!bits || bits === '128');
  const n = bits === undefined ? 32 : +bits;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ips.some((ip) => { const v = ipv4ToInt(ip); return v !== null && ((v & mask) >>> 0) === ((b & mask) >>> 0); });
}

const userRefs = (u: Machine['user']): string[] =>
  (u ? [u.name.includes('@') ? u.name : `${u.name}@`, u.email].filter((x): x is string => !!x) : []);

function matchesAlias(alias: string, m: Machine, policy: Policy, other: Machine): boolean {
  if (alias === '*') return true;
  const tagged = m.tags.length > 0;
  if (alias === 'autogroup:member') return !tagged && !!m.user;
  if (alias === 'autogroup:tagged') return tagged;
  if (alias === 'autogroup:self') return !tagged && !other.tags.length && !!m.user && m.user.name === other.user?.name;
  if (alias.startsWith('tag:')) return m.tags.includes(alias);
  if (alias.startsWith('group:')) return !tagged && asArr(policy.groups?.[alias]).some((r) => userRefs(m.user).includes(r));
  if (alias.startsWith('autogroup:')) return false; // internet, nonroot, … never name a tailnet machine
  const host = policy.hosts?.[alias];
  if (host) return cidrContains(host, m.ips);
  if (/^[\d.]+(\/\d+)?$/.test(alias) || alias.includes('::')) return cidrContains(alias, m.ips);
  return !tagged && userRefs(m.user).includes(alias); // a user reference such as "alice@"
}

/** "tag:web:80,443" → { alias: "tag:web", ports: "80,443" } */
export function splitDst(dst: string): { alias: string; ports: string } {
  const i = dst.lastIndexOf(':');
  const ports = dst.slice(i + 1);
  return i > 0 && /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)$/.test(ports) ? { alias: dst.slice(0, i), ports } : { alias: dst, ports: '*' };
}

const portIn = (spec: string, port: number): boolean => spec === '*' || spec.split(',').some((r) => {
  const [a = 0, b = a] = r.split('-').map(Number);
  return port >= a && port <= b;
});

function protoOk(ruleProto: string | number | undefined, proto: Proto): boolean {
  if (ruleProto === undefined || ruleProto === '') return true; // default: tcp, udp and icmp
  const p = String(ruleProto).toLowerCase();
  return p === proto || p === String(PROTOS[proto]);
}

export function checkAccess(policy: Policy, src: Machine, dst: Machine, port: number, proto: Proto = 'tcp'): AccessResult {
  const acls = asArr(policy.acls);
  const grants = asArr(policy.grants);
  if (!acls.length && !grants.length) return { allowed: true, reason: 'The policy has no rules, so all traffic is allowed.' };
  for (const [i, r] of acls.entries()) {
    if (r.action && r.action !== 'accept') continue;
    if (!protoOk(r.proto, proto)) continue;
    if (!asArr(r.src).some((a) => matchesAlias(a, src, policy, dst))) continue;
    const hit = asArr(r.dst).some((d) => {
      const { alias, ports } = splitDst(d);
      return matchesAlias(alias, dst, policy, src) && (proto === 'icmp' || portIn(ports, port));
    });
    if (hit) return { allowed: true, index: i, section: 'acls', reason: `Allowed by access rule #${i + 1}.` };
  }
  for (const [i, g] of grants.entries()) {
    if (!asArr(g.src).some((a) => matchesAlias(a, src, policy, dst))) continue;
    if (!asArr(g.dst).some((a) => matchesAlias(a, dst, policy, src))) continue;
    const ok = asArr(g.ip).some((spec) => {
      if (spec === '*') return true;
      const [p, ports = ''] = spec.includes(':') ? spec.split(':') : [null, spec];
      return (!p || p === proto) && (proto === 'icmp' || portIn(ports, port));
    });
    if (ok) return { allowed: true, index: i, section: 'grants', reason: `Allowed by grant #${i + 1}.` };
  }
  return { allowed: false, reason: 'No rule allows this connection, so it is blocked.' };
}

export function checkSsh(policy: Policy, src: Machine, dst: Machine, sshUser: string): SshResult {
  for (const [i, r] of asArr(policy.ssh).entries()) {
    if (!asArr(r.src).some((a) => matchesAlias(a, src, policy, dst))) continue;
    if (!asArr(r.dst).some((a) => matchesAlias(a, dst, policy, src))) continue;
    const users = asArr(r.users);
    const userOk = users.includes(sshUser) || (sshUser !== 'root' && users.includes('autogroup:nonroot')) ||
      (users.includes('localpart:*@*') && !!src.user?.email && src.user.email.split('@')[0] === sshUser);
    if (!userOk) continue;
    const action = r.action === 'check' ? 'check' : 'accept';
    return { allowed: true, action, index: i, reason: `Allowed by SSH rule #${i + 1}${action === 'check' ? ' (check mode: re-authentication required)' : ''}.` };
  }
  return { allowed: false, reason: 'No SSH rule lets this machine log in as that user.' };
}

/** A Headscale API node → the machine shape used above. */
export const machineOf = (n: Node): Machine => ({
  user: n.user ? { name: n.user.name, ...(n.user.email ? { email: n.user.email } : {}) } : null,
  tags: nodeTags(n),
  ips: n.ipAddresses || [],
});
