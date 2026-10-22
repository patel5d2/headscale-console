// Audit log: every change made through this console — who (API key prefix), what and
// when — recorded by the server (src/server/store.ts). Searchable and exportable.
import type { AuditEntry } from '../api.js';
import type { Ctx } from '../types.js';
import { badge, button, callout, clear, emptyState, errorState, h, spinner } from '../ui.js';
import { debounce, download, fmtDate, relTime } from '../util.js';

/** A plain-English description of a change, from its method and API path. */
export function describe(e: Pick<AuditEntry, 'method' | 'path' | 'summary'>): string {
  const s = e.summary;
  const p = e.path.replace(/^\/api\/v1\//, '');
  const id = (re: RegExp): string => decodeURIComponent(p.match(re)?.[1] || '');
  const rules: Array<[RegExp, string, string]> = [
    [/^policy$/, 'PUT', 'Updated the access control policy'],
    [/^user$/, 'POST', `Created user ${s.name ?? ''}`],
    [/^user\/[^/]+\/rename\//, 'POST', `Renamed user to ${id(/rename\/(.+)$/)}`],
    [/^user\/[^/]+$/, 'DELETE', `Deleted user ${id(/^user\/(.+)$/)}`],
    [/^node\/[^/]+\/rename\//, 'POST', `Renamed machine ${id(/^node\/([^/]+)/)} to ${id(/rename\/(.+)$/)}`],
    [/^node\/[^/]+\/tags$/, 'POST', `Set tags on machine ${id(/^node\/([^/]+)/)}: ${Array.isArray(s.tags) ? s.tags.join(', ') || 'none' : ''}`],
    [/^node\/[^/]+\/approve_routes$/, 'POST', `Set approved routes on machine ${id(/^node\/([^/]+)/)}: ${Array.isArray(s.routes) ? s.routes.join(', ') || 'none' : ''}`],
    [/^node\/[^/]+\/expire$/, 'POST', s.disableExpiry ? `Disabled key expiry on machine ${id(/^node\/([^/]+)/)}` : s.expiry ? `Set key expiry on machine ${id(/^node\/([^/]+)/)}` : `Expired the key of machine ${id(/^node\/([^/]+)/)}`],
    [/^node\/[^/]+$/, 'DELETE', `Removed machine ${id(/^node\/(.+)$/)}`],
    [/^node\/register$/, 'POST', `Registered a machine for ${s.user ?? ''}`],
    [/^node\/backfillips$/, 'POST', 'Backfilled machine IP addresses'],
    [/^auth\/register$/, 'POST', `Registered a machine for ${s.user ?? ''}`],
    [/^auth\/approve$/, 'POST', 'Approved an authentication request'],
    [/^auth\/reject$/, 'POST', 'Rejected an authentication request'],
    [/^preauthkey$/, 'POST', `Created an auth key${s.user ? ` for user ${s.user}` : ''}${s.reusable ? ' (reusable)' : ''}${s.ephemeral ? ' (ephemeral)' : ''}`],
    [/^preauthkey\/expire$/, 'POST', `Revoked auth key ${s.id ?? ''}`],
    [/^preauthkey$/, 'DELETE', `Deleted auth key ${s.id ?? ''}`],
    [/^apikey$/, 'POST', 'Created an API key'],
    [/^apikey\/expire$/, 'POST', `Expired API key ${s.prefix ?? s.id ?? ''}`],
    [/^apikey\//, 'DELETE', `Deleted API key ${s.id ?? id(/^apikey\/(.+)$/)}`],
    [/^policy\/check$/, 'POST', 'Validated a policy'],
  ];
  const hit = rules.find(([re, m]) => m === e.method && re.test(p));
  return (hit ? hit[2] : `${e.method} ${e.path}`).trim();
}

const csvCell = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: AuditEntry[]): string =>
  ['time,actor,ip,method,path,status,change,details', ...rows.map((e) =>
    [e.at, e.actor, e.ip, e.method, e.path, e.status, describe(e), e.summary].map(csvCell).join(','))].join('\n');

export async function render(ctx: Ctx, _params: unknown, root: HTMLElement): Promise<void> {
  root.append(h('div', { class: 'page-head' },
    h('div', h('h1', 'Audit log'), h('p', { class: 'muted' }, 'Every change made through this console: who, what and when.'))));
  if (!ctx.config.auditLog) {
    root.append(callout('info', 'The audit log is off',
      h('span', 'It needs the console locked to your Headscale server (HEADSCALE_URL) and a writable data directory (DATA_DIR; in Docker, the ', h('code', 'console-data'), ' volume). Changes made with the headscale CLI or other tools aren\'t seen by the console.')));
    return;
  }
  let rows: AuditEntry[] = [];
  const search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Search changes, users, machines…', 'data-search': true, 'aria-label': 'Search the audit log' });
  const failedOnly = h('input', { type: 'checkbox', 'aria-label': 'Only failed changes' });
  const body = h('div', h('div', { class: 'center pad-y' }, spinner(24)));
  const exportBtn = button('Export CSV', { size: 'sm', icon: 'download', onClick: () => download(`headscale-audit-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv') });
  root.append(h('div', { class: 'toolbar' }, search, h('label', { class: 'inline-label' }, failedOnly, 'Failed only'),
    button('Refresh', { size: 'sm', icon: 'refresh', onClick: () => void load() }), exportBtn), body);

  async function load(): Promise<void> {
    try {
      rows = await ctx.api.audit(search.value.trim(), 1000);
      draw();
    } catch (e) { clear(body).append(errorState(e, () => void load())); }
  }

  function draw(): void {
    const shown = failedOnly.checked ? rows.filter((r) => r.status >= 400) : rows;
    clear(body);
    if (!shown.length) { body.append(emptyState('history', search.value || failedOnly.checked ? 'No matching changes' : 'No changes yet', 'Changes made through this console appear here.')); return; }
    body.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' },
      h('thead', h('tr', h('th', 'When'), h('th', 'Change'), h('th', { class: 'hide-sm' }, 'By API key'), h('th', 'Result'))),
      h('tbody', shown.map((r) => h('tr',
        h('td', { class: 'nowrap', title: fmtDate(r.at) }, relTime(r.at)),
        h('td', h('div', describe(r)), h('div', { class: 'muted small mono' }, `${r.method} ${r.path}`)),
        h('td', { class: 'mono hide-sm' }, r.actor, h('div', { class: 'muted small' }, r.ip)),
        h('td', r.status < 400 ? badge(String(r.status), 'success') : badge(String(r.status), 'danger'))))))));
  }

  search.addEventListener('input', debounce(() => void load(), 250));
  failedOnly.addEventListener('change', draw);
  await load();
}
