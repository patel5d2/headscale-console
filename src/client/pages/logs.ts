// Logs: Headscale's journald log (served by host.js) with level counts, grouped
// errors/warnings and search.
import { h, put, button, badge, callout, clear, spinner, errorState, codeBlock } from '../ui.js';
import { download, debounce } from '../util.js';
import { serverUrl } from './actions.js';

const RANGES = [['15m', 'Last 15 minutes'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days']];
const LINES = [['500', '500 lines'], ['2000', '2,000 lines'], ['10000', '10,000 lines']];
const LEVELS = { error: ['Errors', 'danger'], warn: ['Warnings', 'warning'], info: ['Info', 'info'], debug: ['Debug', 'neutral'] };
const TEXT_LEVEL = { TRC: 'debug', DBG: 'debug', INF: 'info', WRN: 'warn', ERR: 'error', FTL: 'error', PNC: 'error' };
const JSON_LEVEL = { trace: 'debug', debug: 'debug', info: 'info', warn: 'warn', warning: 'warn', error: 'error', fatal: 'error', panic: 'error' };
const MAX_ROWS = 1000;

// Headscale logs zerolog console text ("2025-01-01T00:00:00Z INF msg k=v") or JSON;
// fall back to the journald priority when neither carries a level.
export function parseEntry({ t, p, m }) {
  let level;
  let msg = m;
  if (m.startsWith('{')) {
    try {
      const { level: lv, time: _t, message, ...rest } = JSON.parse(m);
      level = JSON_LEVEL[String(lv).toLowerCase()];
      msg = [message ?? '', ...Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)].join(' ').trim();
    } catch { /* plain text */ }
  } else {
    const x = m.match(/^(?:\S+\s+)?(TRC|DBG|INF|WRN|ERR|FTL|PNC)\s+([\s\S]*)$/);
    if (x) { level = TEXT_LEVEL[x[1]]; msg = x[2]; }
  }
  level ||= p <= 3 ? 'error' : p === 4 ? 'warn' : p === 7 ? 'debug' : 'info';
  return { t, level, msg };
}

// Similar messages share a pattern: values, long hex ids and numbers are masked.
export const pattern = (s) => s.replace(/=("[^"]*"|\S+)/g, '=…').replace(/\b[0-9a-f]{12,}\b/gi, '…').replace(/\d+(?:[.:]\d+)*/g, 'N').slice(0, 240);

const select = (opts, value) => h('select', { class: 'input input-sm' }, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const time = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export async function render(ctx, _params, root) {
  root.append(h('div', { class: 'page-head' },
    h('div', h('h1', 'Logs'), h('p', { class: 'muted' }, 'Headscale server logs, with errors and warnings grouped so problems stand out.'))));
  if (!ctx.config.hostActions) { root.append(setupHelp(ctx)); return; }

  let entries = [];
  let hint = null;
  let level = '';
  const since = select(RANGES, '1h');
  const lines = select(LINES, '2000');
  const search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Search logs…', 'data-search': true, 'aria-label': 'Search logs' });
  const refreshBtn = button('Refresh', { size: 'sm', icon: 'refresh', onClick: () => load() });
  const dlBtn = button('Download', {
    size: 'sm', icon: 'download',
    onClick: () => download(`headscale-${new Date().toISOString().slice(0, 19)}.log`,
      entries.map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase()} ${e.msg}`).join('\n'), 'text/plain'),
  });
  const body = h('div', h('div', { class: 'center pad-y' }, spinner(24)));
  root.append(h('div', { class: 'toolbar' }, since, lines, search, refreshBtn, dlBtn), body);

  async function load() {
    refreshBtn.classList.add('loading');
    try {
      const r = await ctx.api.hostLogs({ since: since.value, lines: lines.value });
      entries = (r.entries || []).map(parseEntry);
      hint = r.hint;
      draw();
    } catch (e) {
      clear(body).appendChild(errorState(e, load));
    } finally { refreshBtn.classList.remove('loading'); }
  }

  function draw() {
    const counts = { error: 0, warn: 0, info: 0, debug: 0 };
    const groups = new Map();
    for (const e of entries) {
      counts[e.level]++;
      if (e.level !== 'error' && e.level !== 'warn') continue;
      const k = e.level + pattern(e.msg);
      const g = groups.get(k);
      if (g) { g.n++; g.last = e; } else groups.set(k, { n: 1, level: e.level, last: e });
    }
    const top = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 10);
    const q = search.value.trim().toLowerCase();
    const shown = entries.filter((e) => (!level || e.level === level) && (!q || e.msg.toLowerCase().includes(q))).reverse();

    const stat = (id, label, n) => h('button', {
      class: `stat stat-link${level === id ? ' active' : ''}`, type: 'button', 'aria-pressed': String(level === id),
      onclick: () => { level = id; draw(); },
    }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label));

    put(clear(body),
      hint && !entries.length ? callout('warning', 'No log entries visible', hint) : null,
      h('div', { class: 'stat-row' }, stat('', 'All entries', entries.length),
        Object.entries(LEVELS).map(([id, [label]]) => stat(id, label, counts[id]))),
      h('section', { class: 'section mt-2' }, h('div', { class: 'section-head' }, h('h2', 'Top issues')),
        top.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', h('tr', h('th', 'Level'), h('th', 'Message'), h('th', 'Count'), h('th', 'Last seen'))),
          h('tbody', top.map((g) => h('tr', {
            class: 'row-link', tabindex: '0', title: 'Show these entries',
            onkeydown: (ev) => { if (ev.key === 'Enter') ev.currentTarget.click(); },
            onclick: () => { level = g.level; search.value = g.last.msg.split('=')[0].replace(/\s+\S*$/, '').slice(0, 80); draw(); },
          }, h('td', badge(LEVELS[g.level][0].replace(/s$/, ''), LEVELS[g.level][1])), h('td', { class: 'log-msg' }, g.last.msg),
          h('td', String(g.n)), h('td', { class: 'nowrap muted' }, time(g.last.t))))))) :
          h('p', { class: 'help' }, 'No errors or warnings in this range.')),
      h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', 'Entries'),
        h('span', { class: 'muted small' }, shown.length > MAX_ROWS ? `Newest ${MAX_ROWS} of ${shown.length} — narrow with search` : `${shown.length} shown, newest first`)),
        shown.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' },
          h('tbody', shown.slice(0, MAX_ROWS).map((e) => h('tr',
            h('td', { class: 'nowrap muted small' }, time(e.t)),
            h('td', badge(e.level, LEVELS[e.level][1])),
            h('td', { class: 'log-msg' }, e.msg)))))) :
          h('p', { class: 'help' }, 'No matching entries.')));
  }

  search.addEventListener('input', debounce(draw, 150));
  since.addEventListener('change', load);
  lines.addEventListener('change', load);
  load();
}

function setupHelp(ctx) {
  return h('div', { class: 'stack' },
    callout('info', 'Logs need access to the Headscale host',
      'Headscale has no API for its logs. Install this console on the same VM as Headscale with host actions enabled to read them here. The console only gets read access to the journal.'),
    h('p', { class: 'help' }, 'On the Headscale VM, from the console\'s folder:'),
    codeBlock(`sudo ./deploy/install-vm.sh ${serverUrl(ctx) || 'https://headscale.example.com'} --host-actions`),
    h('p', { class: 'help' }, 'Until then, read them on the server:'),
    codeBlock('sudo journalctl -u headscale --since "1 hour ago"\n# Docker:\ndocker logs --since 1h headscale'));
}
