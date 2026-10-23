// App shell: connection state, data cache, router, header/navigation.
import { ConsoleAPI } from './api.js';
import * as acls from './pages/acls.js';
import * as audit from './pages/audit.js';
import * as dns from './pages/dns.js';
import * as login from './pages/login.js';
import * as logs from './pages/logs.js';
import * as machine from './pages/machine.js';
import * as machines from './pages/machines.js';
import * as overview from './pages/overview.js';
import * as routesPage from './pages/routes.js';
import * as settings from './pages/settings.js';
import * as ssh from './pages/ssh.js';
import * as users from './pages/users.js';
import type { AppCtx, ConsoleConfig, Conn, Ctx, PageRender } from './types.js';
import { clear, closeModals, h, icon, logo, showMenu, spinner, toast } from './ui.js';
import { applyTheme, hostOf, store } from './util.js';

const root = document.getElementById('app')!;

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
applyTheme();

// --------------------------------------------------------------------- ctx --
let loading: Promise<{ users: NonNullable<AppCtx['data']['users']>; nodes: NonNullable<AppCtx['data']['nodes']> }> | null = null;

const ctx: AppCtx = {
  config: { lockedUrl: null, allowedHosts: [] },
  api: null,
  conn: null,
  server: { version: null },
  data: { users: null, nodes: null, loadedAt: 0 },
  prefs: {
    get baseDomain() { return store.get('baseDomain', ''); },
    set baseDomain(v: string) { store.set('baseDomain', v); },
  },
  /** Loads (or reuses) users + nodes. force=true always refetches. */
  async load(force = false) {
    const { users: u, nodes: n, loadedAt } = this.data;
    if (!force && u && n && Date.now() - loadedAt < 4000) return { users: u, nodes: n };
    loading ??= (async () => {
      try {
        const [users, nodes] = await Promise.all([this.api!.listUsers(), this.api!.listNodes()]);
        this.data = { users, nodes, loadedAt: Date.now() };
        updateNavCounts();
        return { users, nodes };
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  invalidate() { this.data.loadedAt = 0; },
  navigate(hash) { if (location.hash !== hash) location.hash = hash; else void route(); },
  rerender() { void route(); },
  disconnect,
  connect,
};

function makeApi(conn: Conn): ConsoleAPI {
  const api: ConsoleAPI = new ConsoleAPI({
    key: conn.key,
    ...(ctx.config.lockedUrl ? {} : { url: conn.url }),
    onUnauthorized: (msg) => {
      // Only sign out a session that was connected; login attempts show their own error.
      if (ctx.api !== api) return;
      toast(msg, 'error');
      disconnect(true);
    },
  });
  return api;
}

async function connect(conn: Conn): Promise<void> {
  const api = makeApi(conn);
  await api.listUsers(); // validates the key
  ctx.api = api;
  ctx.conn = conn;
  store.set('conn', conn, !!conn.remember); // localStorage if remembered, else this tab only
  store.set('lastUrl', conn.url);
  store.set('recentUrls', [conn.url, ...store.get<string[]>('recentUrls', []).filter((u) => u !== conn.url)].slice(0, 5));
  ctx.server.version = await api.version();
  ctx.data = { users: null, nodes: null, loadedAt: 0 };
}

function disconnect(expired = false): void {
  store.del('conn');
  ctx.api = null;
  ctx.conn = expired && ctx.conn ? { ...ctx.conn, key: '' } : null;
  ctx.data = { users: null, nodes: null, loadedAt: 0 };
  location.hash = '#/login';
  void route();
}

// ------------------------------------------------------------------ router --
interface Route { re: RegExp; page: { render: PageRender }; nav?: string; params?: string[]; public?: boolean }
const ROUTES: Route[] = [
  { re: /^\/login$/, page: login, public: true },
  { re: /^\/overview$/, page: overview, nav: 'overview' },
  { re: /^\/machines$/, page: machines, nav: 'machines' },
  { re: /^\/machines\/([^/]+)$/, page: machine, nav: 'machines', params: ['id'] },
  { re: /^\/routes$/, page: routesPage, nav: 'routes' },
  { re: /^\/users$/, page: users, nav: 'users' },
  { re: /^\/acls$/, page: acls, nav: 'acls' },
  { re: /^\/dns$/, page: dns, nav: 'dns' },
  { re: /^\/logs(?:\/(server|devices|activity))?$/, page: logs, nav: 'logs', params: ['tab'] },
  { re: /^\/audit$/, page: audit, nav: 'audit' },
  { re: /^\/ssh\/([^/]+)$/, page: ssh, nav: 'machines', params: ['id'] },
  { re: /^\/settings(?:\/([a-z-]+))?$/, page: settings, nav: 'settings', params: ['section'] },
];

const NAV = [
  { id: 'overview', label: 'Overview', href: '#/overview' },
  { id: 'machines', label: 'Machines', href: '#/machines' },
  { id: 'routes', label: 'Routes', href: '#/routes' },
  { id: 'users', label: 'Users', href: '#/users' },
  { id: 'acls', label: 'Access controls', href: '#/acls' },
  { id: 'dns', label: 'DNS', href: '#/dns' },
  { id: 'logs', label: 'Logs', href: '#/logs' },
  { id: 'audit', label: 'Audit', href: '#/audit' },
  { id: 'settings', label: 'Settings', href: '#/settings' },
];

let shell: { main: HTMLElement; navLinks: Record<string, HTMLAnchorElement> } | null = null;
let cleanup: (() => void) | null = null;
let routeToken = 0;

function updateNavCounts(): void {
  const el = shell?.navLinks.routes?.querySelector<HTMLElement>('.nav-badge');
  if (!el) return;
  const pending = (ctx.data.nodes || []).reduce((n, x) => n + (x.availableRoutes || []).filter((r) => !(x.approvedRoutes || []).includes(r)).length, 0);
  el.textContent = pending ? String(pending) : '';
  el.hidden = !pending;
  el.title = pending ? `${pending} route${pending === 1 ? '' : 's'} awaiting approval` : '';
}

function buildShell(): NonNullable<typeof shell> {
  const navLinks: Record<string, HTMLAnchorElement> = {};
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    NAV.map((n) => (navLinks[n.id] = h('a', { href: n.href, class: 'nav-link' }, n.label,
      n.id === 'routes' ? h('span', { class: 'nav-badge', hidden: true }) : null))));

  const themeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Theme', 'aria-label': 'Change theme' });
  const setThemeIcon = (): void => { clear(themeBtn).appendChild(icon(document.documentElement.dataset.theme === 'dark' ? 'moon' : 'sun', 18)); };
  setThemeIcon();
  themeBtn.addEventListener('click', () => {
    const cur = store.get<string>('theme', 'system');
    const pick = (t: string) => (): void => { store.set('theme', t); applyTheme(); setThemeIcon(); };
    showMenu(themeBtn, [
      { header: 'Appearance' },
      { label: 'Light', icon: cur === 'light' ? 'check' : null, onClick: pick('light') },
      { label: 'Dark', icon: cur === 'dark' ? 'check' : null, onClick: pick('dark') },
      { label: 'System', icon: cur === 'system' ? 'check' : null, onClick: pick('system') },
    ]);
  });

  const host = hostOf(ctx.config.lockedUrl || ctx.conn!.url);
  const acct = h('button', { class: 'account-btn', type: 'button', 'aria-label': 'Account' },
    h('span', { class: 'account-avatar' }, icon('server', 15)), h('span', { class: 'account-host' }, host), icon('chevronDown', 14));
  acct.addEventListener('click', () => {
    const v = ctx.server.version?.version;
    showMenu(acct, [
      { header: host },
      v ? { label: `Headscale ${v}`, icon: 'info', disabled: true } : null,
      { label: 'Server settings', icon: 'settings', onClick: () => ctx.navigate('#/settings') },
      { label: 'API keys', icon: 'key', onClick: () => ctx.navigate('#/settings/api-keys') },
      { divider: true },
      { label: 'Disconnect', icon: 'logout', danger: true, onClick: () => { disconnect(); toast('Disconnected', 'info'); } },
    ]);
  });

  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  clear(root).append(
    h('a', { class: 'skip-link', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'Skip to content'),
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar-inner' },
        h('a', { class: 'brand', href: '#/overview' }, logo(22),
          h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, 'Headscale'), h('span', { class: 'brand-tailnet' }, host))),
        h('div', { class: 'topbar-actions' }, themeBtn, acct)),
      h('div', { class: 'nav-wrap' }, nav)),
    main,
    h('footer', { class: 'footer' },
      h('span', 'Headscale Console'),
      ctx.server.version?.version ? h('span', `Server ${ctx.server.version.version}`) : '',
      h('a', { href: 'https://headscale.net/stable/', target: '_blank', rel: 'noopener' }, 'Headscale docs')));
  return { main, navLinks };
}

export async function route(): Promise<void> {
  const token = ++routeToken;
  const path = location.hash.replace(/^#/, '') || '/overview';
  let match: Route | undefined;
  const params: Record<string, string | undefined> = {};
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (!m) continue;
    match = r;
    (r.params || []).forEach((p, i) => { params[p] = m[i + 1] ? decodeURIComponent(m[i + 1]!) : undefined; });
    break;
  }
  if (!match) { location.replace('#/overview'); return; }

  if (cleanup) { try { cleanup(); } catch { /* a page's cleanup must not block navigation */ } cleanup = null; }
  closeModals(); // a dialog belongs to the page it was opened on
  if (!ctx.api && !match.public) { location.replace('#/login'); return; }
  if (ctx.api && match.public) { location.replace('#/overview'); return; }

  if (match.public) {
    shell = null;
    cleanup = (await match.page.render(ctx as Ctx, params, clear(root))) || null;
    return;
  }

  shell ??= buildShell();
  for (const [id, a] of Object.entries(shell.navLinks)) {
    a.classList.toggle('active', id === match.nav);
    if (id === match.nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const pageEl = h('div', { class: 'page' });
  clear(shell.main).appendChild(pageEl);
  window.scrollTo(0, 0);
  document.title = `${NAV.find((n) => n.id === match!.nav)?.label || 'Headscale'} · Headscale Console`;
  try {
    const c = await match.page.render(ctx as Ctx, params, pageEl);
    if (token !== routeToken) { if (typeof c === 'function') c(); return; }
    cleanup = typeof c === 'function' ? c : null;
  } catch (e) {
    console.error(e);
    pageEl.appendChild(h('div', { class: 'callout callout-error' }, icon('alert', 18), h('div', String((e as Error).message || e))));
  }
}

window.addEventListener('hashchange', () => void route());

// Global keyboard shortcuts: "/" focuses search, "g" then a letter navigates.
const GO: Record<string, string> = {
  o: '#/overview', m: '#/machines', u: '#/users', a: '#/acls', d: '#/dns', l: '#/logs', s: '#/settings', r: '#/routes', k: '#/settings/keys', h: '#/audit',
};
let gPressed = 0;
document.addEventListener('keydown', (e) => {
  if ((e.target as Element).closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
    const s = document.querySelector<HTMLElement>('[data-search]');
    if (s) { e.preventDefault(); s.focus(); }
  }
  if (!ctx.api || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'g') { gPressed = Date.now(); return; }
  const to = GO[e.key];
  if (to && Date.now() - gPressed < 800) { ctx.navigate(to); gPressed = 0; }
});

// ------------------------------------------------------------------- boot --
void (async function boot() {
  clear(root).appendChild(h('div', { class: 'boot' }, spinner(28)));
  try {
    const r = await fetch('console-config.json', { cache: 'no-store' });
    if (r.ok) ctx.config = await r.json() as ConsoleConfig;
  } catch { /* running without server config */ }

  const saved = store.get<Conn | null>('conn', null);
  if (saved?.key && (saved.url || ctx.config.lockedUrl)) {
    try {
      await connect(saved);
    } catch (e) {
      ctx.conn = { ...saved, key: '' };
      ctx.loginError = `Could not reconnect: ${(e as Error).message}`;
    }
  }
  await route();
})();

export { ctx };
