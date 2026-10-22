// Browser helpers: storage, clipboard, downloads, dates, theme. Pure data helpers live
// in src/shared and are re-exported here so pages import from one place.
export * from '../shared/model.js';
import { parseTime } from '../shared/model.js';

export function fmtDate(t: string | Date | null | undefined, withTime = true): string {
  const d = t instanceof Date ? t : parseTime(t);
  if (!d) return '—';
  return d.toLocaleString(undefined, withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

// ----------------------------------------------------------------- storage --
const NS = 'hsconsole:';
export const store = {
  get<T>(k: string, def: T): T {
    try {
      const v = localStorage.getItem(NS + k) ?? sessionStorage.getItem(NS + k);
      return v == null ? def : JSON.parse(v) as T;
    } catch { return def; }
  },
  /** persist=false keeps the value for this tab only. */
  set(k: string, v: unknown, persist = true): void {
    try {
      (persist ? localStorage : sessionStorage).setItem(NS + k, JSON.stringify(v));
      (persist ? sessionStorage : localStorage).removeItem(NS + k);
    } catch { /* storage unavailable */ }
  },
  del(k: string): void {
    try { localStorage.removeItem(NS + k); sessionStorage.removeItem(NS + k); } catch { /* storage unavailable */ }
  },
};

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms = 200): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Insecure origins (plain http on a LAN IP) have no clipboard API.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function download(filename: string, text: string, type = 'application/json'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** Reads a file the user picked. */
export const readFile = (f: File): Promise<string> => f.text();

export function applyTheme(t?: string): void {
  const mode = t || store.get('theme', 'system');
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
