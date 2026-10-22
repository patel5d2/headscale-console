// App shell: connection state, data cache, router, header/navigation.
import { HeadscaleAPI } from './api.js';
import { h, clear, icon, logo, showMenu, toast, spinner } from './ui.js';
import { store, hostOf, applyTheme } from './util.js';
import * as login from './pages/login.js';
import * as machines from './pages/machines.js';
import * as machine from './pages/machine.js';
import * as routesPage from './pages/routes.js';
import * as users from './pages/users.js';
import * as acls from './pages/acls.js';
import * as dns from './pages/dns.js';
import * as logs from './pages/logs.js';
import * as settings from './pages/settings.js';

const root = document.getElementById('app');

// ----------------------------------------------------------------- theme --
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
applyTheme();

// ------------------------------------------------------------------- ctx --
const ctx = {
  config: { lockedUrl: null },
  api: null,
  conn: null, // { url, key, remember }
  server: { version: null },
  data: {
    users: null,
    nodes: null,
    loadedAt: 0,
  },
  prefs: {
    get baseDomain() { return store.get('baseDomain', ''); },
    set baseDomain(v) { store.set('baseDomain', v); },
  },
  // Load (or reuse) users + nodes. force=true always refetches.
  async load(force = false) {
    if (!force && this.data.nodes && this.data.users && Date.now() - this.data.loadedAt < 4000) return this.data;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const [users, nodes] = await Promise.all([this.api.listUsers(), this.api.listNodes()]);
        this.data.users = users;
        this.data.nodes = nodes;
        this.data.loadedAt = Date.now();
        updateNavCounts();
        return this.data;
      } finally {
        this._loading = null;
      }
    })();
    return this._loading;
  },
  invalidate() { this.data.loadedAt = 0; },
  navigate(hash) { if (location.hash !== hash) location.hash = hash; else route(); },
  rerender() { route(); },
  disconnect,
  connect,
};

function makeApi(conn) {
  const api = new HeadscaleAPI({
    url: ctx.config.lockedUrl ? '' : conn.url,
    key: conn.key,
    onUnauthorized: (msg) => {
      // Only sign out a session that was connected; login attempts show their own error.
      if (ctx.api !== api) return;
      toast(msg, 'error');
      disconnect(true);
    },
  });
  return api;
}

async function connect(conn) {
  const api = makeApi(conn);
  // Validate credentials: listing users needs a valid API key.
  await api.listUsers();
  ctx.api = api;
  ctx.conn = conn;
  store.set('conn', conn, !!conn.remember); // localStorage if remembered, else this tab only
  store.set('lastUrl', conn.url);
  ctx.server.version = await api.version();
  ctx.data = { users: null, nodes: null, loadedAt: 0 };
}

function disconnect(expired = false) {
  store.del('conn');
  ctx.api = null;
  ctx.conn = expired ? { ...(ctx.conn || {}), key: '' } : null;
  ctx.data = { users: null, nodes: null, loadedAt: 0 };
  if (expired && ctx.conn?.url) store.set('lastUrl', ctx.conn.url);
  location.hash = '#/login';
  route();
}

// ---------------------------------------------------------------- router --
const ROUTES = [
  { re: /^\/login$/, page: login, public: true },
  { re: /^\/machines$/, page: machines, nav: 'machines' },
  { re: /^\/machines\/([^/]+)$/, page: machine, nav: 'machines', params: ['id'] },
  { re: /^\/routes$/, page: routesPage, nav: 'routes' },
  { re: /^\/users$/, page: users, nav: 'users' },
  { re: /^\/acls$/, page: acls, nav: 'acls' },
  { re: /^\/dns$/, page: dns, nav: 'dns' },
  { re: /^\/logs$/, page: logs, nav: 'logs' },
  { re: /^\/settings(?:\/([a-z-]+))?$/, page: settings, nav: 'settings', params: ['section'] },
];

const NAV = [
  { id: 'machines', label: 'Machines', href: '#/machines' },
  { id: 'routes', label: 'Routes', href: '#/routes' },
  { id: 'users', label: 'Users', href: '#/users' },
  { id: 'acls', label: 'Access controls', href: '#/acls' },
  { id: 'dns', label: 'DNS', href: '#/dns' },
  { id: 'logs', label: 'Logs', href: '#/logs' },
  { id: 'settings', label: 'Settings', href: '#/settings' },
];

let shell = null; // { header, main, navLinks }
let cleanup = null;
let routeToken = 0;

function updateNavCounts() {
  if (!shell) return;
  const pending = (ctx.data.nodes || []).reduce((n, x) =>
    n + (x.availableRoutes || []).filter((r) => !(x.approvedRoutes || []).includes(r)).length, 0);
  const el = shell.navLinks.routes?.querySelector('.nav-badge');
  if (el) {
    el.textContent = pending || '';
    el.hidden = !pending;
    el.title = pending ? `${pending} route${pending === 1 ? '' : 's'} awaiting approval` : '';
  }
}

function buildShell() {
  const navLinks = {};
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    NAV.map((n) => (navLinks[n.id] = h('a', { href: n.href, class: 'nav-link' }, n.label,
      n.id === 'routes' ? h('span', { class: 'nav-badge', hidden: true }) : null))));

  const themeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Theme', 'aria-label': 'Change theme' });
  const setThemeIcon = () => {
    clear(themeBtn).appendChild(icon(document.documentElement.dataset.theme === 'dark' ? 'moon' : 'sun', 18));
  };
  setThemeIcon();
  themeBtn.addEventListener('click', () => {
    const cur = store.get('theme', 'system');
    showMenu(themeBtn, [
      { header: 'Appearance' },
      { label: 'Light', icon: cur === 'light' ? 'check' : null, onClick: () => { store.set('theme', 'light'); applyTheme(); setThemeIcon(); } },
      { label: 'Dark', icon: cur === 'dark' ? 'check' : null, onClick: () => { store.set('theme', 'dark'); applyTheme(); setThemeIcon(); } },
      { label: 'System', icon: cur === 'system' ? 'check' : null, onClick: () => { store.set('theme', 'system'); applyTheme(); setThemeIcon(); } },
    ]);
  });

  const host = ctx.config.lockedUrl ? hostOf(ctx.config.lockedUrl) : hostOf(ctx.conn.url);
  const acct = h('button', { class: 'account-btn', type: 'button', 'aria-label': 'Account' },
    h('span', { class: 'account-avatar' }, icon('server', 15)),
    h('span', { class: 'account-host' }, host), icon('chevronDown', 14));
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

  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: '#/machines' }, logo(22),
        h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, 'Headscale'), h('span', { class: 'brand-tailnet' }, host))),
      h('div', { class: 'topbar-actions' }, themeBtn, acct)),
    h('div', { class: 'nav-wrap' }, nav));

  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const footer = h('footer', { class: 'footer' },
    h('span', 'Headscale Console'),
    ctx.server.version?.version ? h('span', `Server ${ctx.server.version.version}`) : null,
    h('a', { href: 'https://headscale.net/stable/', target: '_blank', rel: 'noopener' }, 'Headscale docs'));

  clear(root);
  root.appendChild(h('a', { class: 'skip-link', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'Skip to content'));
  root.appendChild(header);
  root.appendChild(main);
  root.appendChild(footer);
  shell = { header, main, navLinks };
}

export async function route() {
  const token = ++routeToken;
  const path = (location.hash || '#/machines').replace(/^#/, '') || '/machines';
  let match = null;
  let params = {};
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) {
      match = r;
      (r.params || []).forEach((p, i) => { params[p] = m[i + 1] ? decodeURIComponent(m[i + 1]) : undefined; });
      break;
    }
  }
  if (!match) { location.replace('#/machines'); return; }

  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }

  if (!ctx.api && !match.public) { location.replace('#/login'); return; }
  if (ctx.api && match.public) { location.replace('#/machines'); return; }

  if (match.public) {
    shell = null;
    clear(root);
    cleanup = await match.page.render(ctx, params, root);
    return;
  }

  if (!shell) buildShell();
  for (const [id, a] of Object.entries(shell.navLinks)) {
    a.classList.toggle('active', id === match.nav);
    if (id === match.nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const main = shell.main;
  clear(main);
  const pageEl = h('div', { class: 'page' });
  main.appendChild(pageEl);
  window.scrollTo(0, 0);
  try {
    const c = await match.page.render(ctx, params, pageEl);
    if (token !== routeToken) { if (typeof c === 'function') c(); return; }
    cleanup = typeof c === 'function' ? c : null;
  } catch (e) {
    console.error(e);
    pageEl.appendChild(h('div', { class: 'callout callout-error' }, icon('alert', 18), h('div', String(e.message || e))));
  }
  document.title = `${NAV.find((n) => n.id === match.nav)?.label || 'Headscale'} · Headscale Console`;
}

window.addEventListener('hashchange', route);

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
    const s = document.querySelector('[data-search]');
    if (s) { e.preventDefault(); s.focus(); }
  }
  if (!ctx.api || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'g') { ctx._g = Date.now(); return; }
  if (ctx._g && Date.now() - ctx._g < 800) {
    const map = { m: '#/machines', u: '#/users', a: '#/acls', d: '#/dns', l: '#/logs', s: '#/settings', r: '#/routes', k: '#/settings/keys' };
    if (map[e.key]) { ctx.navigate(map[e.key]); ctx._g = 0; }
  }
});

// ----------------------------------------------------------------- boot --
(async function boot() {
  clear(root).appendChild(h('div', { class: 'boot' }, spinner(28)));
  try {
    const r = await fetch('console-config.json', { cache: 'no-store' });
    if (r.ok) ctx.config = await r.json();
  } catch { /* running without server config */ }

  const saved = store.get('conn');
  if (saved?.key && (saved.url || ctx.config.lockedUrl)) {
    try {
      await connect(saved);
    } catch (e) {
      ctx.conn = { ...saved, key: '' };
      ctx.loginError = `Could not reconnect: ${e.message}`;
    }
  }
  route();
})();

export { ctx };
