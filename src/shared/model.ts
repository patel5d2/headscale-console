// Pure helpers over Headscale data: names, tags, routes, expiry, time, CIDRs, HuJSON, diffs.
// No DOM and no Node APIs, so the browser, the CLI and the tests share them.
import type { Node, User } from './types.js';

export const ZERO_TIME = '0001-01-01T00:00:00Z';

export function parseTime(t: string | Date | null | undefined): Date | null {
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime()) || d.getUTCFullYear() <= 1) return null;
  return d;
}

export function relTime(t: string | Date | null | undefined, { future = true } = {}): string {
  const d = t instanceof Date ? t : parseTime(t);
  if (!d) return '—';
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff < 0 || !future ? 'just now' : 'in a few seconds';
  const units: Array<[string, number]> = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const [u, s] = units.find(([, secs]) => abs >= secs) ?? ['minute', 60]; // 45–59 s rounds to a minute
  const n = Math.max(1, Math.round(abs / s));
  const label = `${n} ${u}${n === 1 ? '' : 's'}`;
  return diff < 0 ? `${label} ago` : `in ${label}`;
}

export const isoInDays = (days: number): string => new Date(Date.now() + days * 86400000).toISOString();

export const nodeName = (n: Node): string => n.givenName || n.name || `node-${n.id}`;

export function nodeTags(n: Node): string[] {
  if (Array.isArray(n.tags) && n.tags.length) return [...n.tags];
  // pre-0.28 servers exposed forced/valid tags separately
  return [...new Set([...(n.forcedTags || []), ...(n.validTags || [])])];
}

export const nodeIPv4 = (n: Node): string => (n.ipAddresses || []).find((a) => a.includes('.')) || '';
export const nodeIPv6 = (n: Node): string => (n.ipAddresses || []).find((a) => a.includes(':')) || '';

export interface Expiry { disabled: boolean; expired: boolean; date: Date | null }
export function expiryState(n: Node): Expiry {
  const d = parseTime(n.expiry);
  if (!d) return { disabled: true, expired: false, date: null };
  return { disabled: false, expired: d.getTime() <= Date.now(), date: d };
}

export const EXIT_ROUTES = ['0.0.0.0/0', '::/0'];
export const isExitRoute = (r: string): boolean => EXIT_ROUTES.includes(r);

export interface RouteInfo {
  available: string[]; approved: string[]; primary: string[]; subnets: string[];
  exitAdvertised: boolean; exitApproved: boolean; exitPending: boolean; pendingSubnets: string[]; hasAny: boolean;
}
export function routeInfo(n: Node): RouteInfo {
  const available = n.availableRoutes || [];
  const approved = n.approvedRoutes || [];
  const all = [...new Set([...available, ...approved])];
  const subnets = all.filter((r) => !isExitRoute(r));
  const exitAdvertised = available.some(isExitRoute);
  return {
    available, approved, primary: n.subnetRoutes || [], subnets, exitAdvertised,
    exitApproved: approved.some(isExitRoute) && !available.some((r) => isExitRoute(r) && !approved.includes(r)),
    exitPending: exitAdvertised && !approved.some(isExitRoute),
    pendingSubnets: subnets.filter((r) => available.includes(r) && !approved.includes(r)),
    hasAny: all.length > 0,
  };
}

export function ownerLabel(n: Node): { tagged: boolean; label: string; sub: string } {
  const tags = nodeTags(n);
  if (!n.user && tags.length) return { tagged: true, label: 'Tagged device', sub: tags.join(', ') };
  const u: Partial<User> = n.user || {};
  return { tagged: false, label: u.displayName || u.name || 'Unknown', sub: u.email || u.name || '' };
}

export const REGISTER_METHOD: Record<string, string> = {
  REGISTER_METHOD_AUTH_KEY: 'Auth key',
  REGISTER_METHOD_CLI: 'CLI / API',
  REGISTER_METHOD_OIDC: 'OIDC',
  REGISTER_METHOD_UNSPECIFIED: 'Unknown',
};

export const userLabel = (u: Partial<User> | null | undefined): string =>
  (u ? u.displayName || u.name || u.email || `user-${u.id}` : 'Unknown');

/** How a policy refers to a user: "alice@" (or the name itself if it already has an @). */
export const userRef = (u: Pick<User, 'name'>): string => (u.name.includes('@') ? u.name : `${u.name}@`);

export function initials(s: string | null | undefined): string {
  const parts = String(s || '?').replace(/[@._-]+/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatarHue(s: string | null | undefined): number {
  let h = 0;
  for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function validCIDR(s: string): boolean {
  s = String(s || '').trim();
  const m4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (m4) return m4.slice(1, 5).every((o) => +o <= 255) && +m4[5]! <= 32;
  const m6 = s.match(/^([0-9a-fA-F:]+)\/(\d{1,3})$/);
  return !!m6 && m6[1]!.includes(':') && +m6[2]! <= 128;
}

export const pluralize = (n: number, word: string, plural?: string): string => `${n} ${n === 1 ? word : (plural || word + 's')}`;

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function semver(v: string | null | undefined): string | null {
  return String(v || '').replace(/^v/, '').match(/^\d+\.\d+\.\d+/)?.[0] || null;
}
/** Compares "X.Y.Z" versions: negative, zero or positive. */
export function cmpVersion(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}

// ------------------------------------------------------------------ HuJSON --
// Headscale policies are HuJSON (JSON + comments + trailing commas).

export function stripHuJSON(src: string): string {
  let out = '';
  const commas = new Set<number>();
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === ',') commas.add(out.length);
    out += c;
    i++;
  }
  // A comma followed by a closing bracket can also occur inside a JSON string.
  // Only remove commas that the scanner encountered outside strings/comments.
  return out.replace(/,(\s*[}\]])/g, (match: string, closing: string, offset: number) => commas.has(offset) ? ` ${closing}` : match);
}

export type Parsed<T = unknown> = { ok: true; value: T } | { ok: false; error: string; line: number | null; col: number | null };

export function parseHuJSON<T = unknown>(src: string): Parsed<T> {
  const clean = stripHuJSON(src);
  try {
    return { ok: true, value: JSON.parse(clean) as T };
  } catch (e) {
    const msg = String((e as Error).message);
    let line: number | null = null;
    let col: number | null = null;
    const lc = msg.match(/line (\d+) column (\d+)/);
    const m = msg.match(/position (\d+)/);
    if (lc) { line = +lc[1]!; col = +lc[2]!; } else if (m) {
      const before = clean.slice(0, +m[1]!);
      line = before.split('\n').length;
      col = +m[1]! - before.lastIndexOf('\n');
    }
    return { ok: false, error: msg, line, col };
  }
}

/** True when the source contains // or /* comments outside of strings. */
export function hasComments(src: string): boolean {
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) return true;
  }
  return false;
}

// -------------------------------------------------------------------- diff --
export interface DiffLine { op: ' ' | '-' | '+'; line: string }

/** Line diff a → b via longest common subsequence. */
// ponytail: O(n·m) memory; returns null past ~4M cells (Myers' algorithm if that ever matters).
export function lineDiff(a: string, b: string): DiffLine[] | null {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4e6) return null;
  const L = new Uint32Array((n + 1) * (m + 1)); // L[i*(m+1)+j] = LCS length of x[i..], y[j..]
  const at = (i: number, j: number): number => L[i * (m + 1) + j]!;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', line: x[i]! }); i++; j++; } else if (at(i + 1, j) >= at(i, j + 1)) out.push({ op: '-', line: x[i++]! });
    else out.push({ op: '+', line: y[j++]! });
  }
  while (i < n) out.push({ op: '-', line: x[i++]! });
  while (j < m) out.push({ op: '+', line: y[j++]! });
  return out;
}
