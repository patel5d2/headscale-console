// Shared helpers: time formatting, node helpers, HuJSON parsing, storage.

export const ZERO_TIME = '0001-01-01T00:00:00Z';

export function parseTime(t) {
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d) || d.getUTCFullYear() <= 1) return null;
  return d;
}

export function relTime(t, { future = true } = {}) {
  const d = t instanceof Date ? t : parseTime(t);
  if (!d) return '—';
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  if (abs < 45) return diff < 0 || !future ? 'just now' : 'in a few seconds';
  for (const [u, s] of units) {
    if (abs >= s) {
      const n = Math.round(abs / s);
      const label = `${n} ${u}${n === 1 ? '' : 's'}`;
      return diff < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  const n = Math.max(1, Math.round(abs / 60));
  return diff < 0 ? `${n} minute${n === 1 ? '' : 's'} ago` : `in ${n} minute${n === 1 ? '' : 's'}`;
}

export function fmtDate(t, withTime = true) {
  const d = t instanceof Date ? t : parseTime(t);
  if (!d) return '—';
  return d.toLocaleString(undefined, withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function isoInDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// ------------------------------------------------------------------ nodes --

export function nodeName(n) {
  return n.givenName || n.name || `node-${n.id}`;
}

export function nodeTags(n) {
  if (Array.isArray(n.tags) && n.tags.length) return [...n.tags];
  // pre-0.28 servers exposed forced/valid tags separately
  const s = new Set([...(n.forcedTags || []), ...(n.validTags || [])]);
  return [...s];
}

export function nodeIPv4(n) {
  return (n.ipAddresses || []).find((a) => a.includes('.')) || '';
}

export function nodeIPv6(n) {
  return (n.ipAddresses || []).find((a) => a.includes(':')) || '';
}

export function expiryState(n) {
  const d = parseTime(n.expiry);
  if (!d) return { disabled: true, expired: false, date: null };
  return { disabled: false, expired: d.getTime() <= Date.now(), date: d };
}

export const EXIT_ROUTES = ['0.0.0.0/0', '::/0'];
export const isExitRoute = (r) => EXIT_ROUTES.includes(r);

export function routeInfo(n) {
  const available = n.availableRoutes || [];
  const approved = n.approvedRoutes || [];
  const primary = n.subnetRoutes || [];
  const all = [...new Set([...available, ...approved])];
  const subnets = all.filter((r) => !isExitRoute(r));
  const exitAdvertised = available.some(isExitRoute);
  const exitApproved = EXIT_ROUTES.every((r) => approved.includes(r)) ||
    (approved.some(isExitRoute) && !available.some((r) => isExitRoute(r) && !approved.includes(r)));
  const pendingSubnets = subnets.filter((r) => available.includes(r) && !approved.includes(r));
  return {
    available, approved, primary, subnets, exitAdvertised,
    exitApproved: exitApproved && approved.some(isExitRoute),
    exitPending: exitAdvertised && !approved.some(isExitRoute),
    pendingSubnets,
    hasAny: all.length > 0,
  };
}

export function ownerLabel(n) {
  const tags = nodeTags(n);
  if (!n.user && tags.length) return { tagged: true, label: 'Tagged device', sub: tags.join(', ') };
  const u = n.user || {};
  return {
    tagged: false,
    label: u.displayName || u.name || 'Unknown',
    sub: u.email || u.name || '',
  };
}

export const REGISTER_METHOD = {
  REGISTER_METHOD_AUTH_KEY: 'Auth key',
  REGISTER_METHOD_CLI: 'CLI / API',
  REGISTER_METHOD_OIDC: 'OIDC',
  REGISTER_METHOD_UNSPECIFIED: 'Unknown',
};

export function userLabel(u) {
  if (!u) return 'Unknown';
  return u.displayName || u.name || u.email || `user-${u.id}`;
}

export function initials(s) {
  const parts = String(s || '?').replace(/[@._-]+/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatarHue(s) {
  let h = 0;
  for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// ------------------------------------------------------------------- CIDR --

export function validCIDR(s) {
  s = String(s || '').trim();
  const m4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (m4) return m4.slice(1, 5).every((o) => +o <= 255) && +m4[5] <= 32;
  const m6 = s.match(/^([0-9a-fA-F:]+)\/(\d{1,3})$/);
  if (m6) return m6[1].includes(':') && +m6[2] <= 128;
  return false;
}

// ----------------------------------------------------------------- HuJSON --
// Headscale policies are HuJSON (JSON + comments + trailing commas).

export function stripHuJSON(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
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
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // drop trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

export function parseHuJSON(src) {
  const clean = stripHuJSON(src);
  try {
    return { ok: true, value: JSON.parse(clean) };
  } catch (e) {
    let line = null;
    let col = null;
    const m = String(e.message).match(/position (\d+)/);
    if (m) {
      const pos = +m[1];
      const before = clean.slice(0, pos);
      line = before.split('\n').length;
      col = pos - before.lastIndexOf('\n');
    }
    const lc = String(e.message).match(/line (\d+) column (\d+)/);
    if (lc) { line = +lc[1]; col = +lc[2]; }
    return { ok: false, error: e.message, line, col };
  }
}

// True when the source contains // or /* */ comments outside of strings.
export function hasComments(src) {
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

// ---------------------------------------------------------------- storage --

const NS = 'hsconsole:';
export const store = {
  get(k, def = null) {
    try {
      const v = localStorage.getItem(NS + k) ?? sessionStorage.getItem(NS + k);
      return v == null ? def : JSON.parse(v);
    } catch { return def; }
  },
  set(k, v, persist = true) {
    try {
      (persist ? localStorage : sessionStorage).setItem(NS + k, JSON.stringify(v));
      (persist ? sessionStorage : localStorage).removeItem(NS + k);
    } catch { /* storage unavailable */ }
  },
  del(k) {
    try { localStorage.removeItem(NS + k); sessionStorage.removeItem(NS + k); } catch { /* */ }
  },
};

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* */ }
    ta.remove();
    return ok;
  }
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function pluralize(n, word, plural) {
  return `${n} ${n === 1 ? word : (plural || word + 's')}`;
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Line diff of a → b as [{ op: ' ' | '-' | '+', line }], via longest common subsequence.
// ponytail: O(n·m) memory; returns null past ~4M cells (Myers' algorithm if that ever matters).
export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4e6) return null;
  const L = new Uint32Array((n + 1) * (m + 1)); // L[i*(m+1)+j] = LCS length of x[i..], y[j..]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * (m + 1) + j] = x[i] === y[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', line: x[i] }); i++; j++; } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) out.push({ op: '-', line: x[i++] });
    else out.push({ op: '+', line: y[j++] });
  }
  while (i < n) out.push({ op: '-', line: x[i++] });
  while (j < m) out.push({ op: '+', line: y[j++] });
  return out;
}

// ------------------------------------------------------------------ theme --
export function applyTheme(t) {
  const mode = t || store.get('theme', 'system');
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
