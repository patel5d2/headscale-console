// Logs: Headscale's journald log (served by host.ts) with level counts, grouped
// errors/warnings and search.
import { analyze, parseEntry } from '../../shared/logparse.js';
import { badge, button, callout, clear, codeBlock, errorState, h, put, spinner } from '../ui.js';
import { debounce, download } from '../util.js';
import { installCmd } from './updates.js';
const RANGES = [['15m', 'Last 15 minutes'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days']];
const LINES = [['500', '500 lines'], ['2000', '2,000 lines'], ['10000', '10,000 lines']];
const LEVELS = { error: ['Errors', 'danger'], warn: ['Warnings', 'warning'], info: ['Info', 'info'], debug: ['Debug', 'neutral'] };
const MAX_ROWS = 1000;
const select = (opts, value, label) => h('select', { class: 'input input-sm', 'aria-label': label }, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const time = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export async function render(ctx, _params, root) {
    root.append(h('div', { class: 'page-head' }, h('div', h('h1', 'Logs'), h('p', { class: 'muted' }, 'Headscale server logs, with errors and warnings grouped so problems stand out.'))));
    if (!ctx.config.hostActions) {
        root.append(setupHelp(ctx));
        return;
    }
    let entries = [];
    let hint = null;
    let level = '';
    const since = select(RANGES, '1h', 'Time range');
    const lines = select(LINES, '2000', 'Lines');
    const search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Search logs…', 'data-search': true, 'aria-label': 'Search logs' });
    const refreshBtn = button('Refresh', { size: 'sm', icon: 'refresh', onClick: () => void load() });
    const dlBtn = button('Download', {
        size: 'sm', icon: 'download',
        onClick: () => download(`headscale-${new Date().toISOString().slice(0, 19)}.log`, entries.map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase()} ${e.msg}`).join('\n'), 'text/plain'),
    });
    const body = h('div', h('div', { class: 'center pad-y' }, spinner(24)));
    root.append(h('div', { class: 'toolbar' }, since, lines, search, refreshBtn, dlBtn), body);
    async function load() {
        refreshBtn.classList.add('loading');
        try {
            const r = await ctx.api.hostLogs({ since: since.value, lines: lines.value });
            entries = r.entries.map(parseEntry);
            hint = r.hint;
            draw();
        }
        catch (e) {
            clear(body).appendChild(errorState(e, () => void load()));
        }
        finally {
            refreshBtn.classList.remove('loading');
        }
    }
    function draw() {
        const { counts, groups } = analyze(entries);
        const q = search.value.trim().toLowerCase();
        const shown = entries.filter((e) => (!level || e.level === level) && (!q || e.msg.toLowerCase().includes(q))).reverse();
        const stat = (id, label, n) => h('button', {
            class: `stat stat-link${level === id ? ' active' : ''}`, type: 'button', 'aria-pressed': String(level === id),
            onclick: () => { level = id; draw(); },
        }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label));
        put(clear(body), hint && !entries.length ? callout('warning', 'No log entries visible', hint) : null, h('div', { class: 'stat-row' }, stat('', 'All entries', entries.length), Object.entries(LEVELS).map(([id, [label]]) => stat(id, label, counts[id]))), h('section', { class: 'section mt-2' }, h('div', { class: 'section-head' }, h('h2', 'Top issues')), groups.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', h('tr', h('th', 'Level'), h('th', 'Message'), h('th', 'Count'), h('th', 'Last seen'))), h('tbody', groups.map((g) => {
            const tr = h('tr', {
                class: 'row-link', tabindex: '0', title: 'Show these entries',
                onclick: () => { level = g.level; search.value = g.last.msg.split('=')[0].replace(/\s+\S*$/, '').slice(0, 80); draw(); },
            }, h('td', badge(LEVELS[g.level][0].replace(/s$/, ''), LEVELS[g.level][1])), h('td', { class: 'log-msg' }, g.last.msg), h('td', String(g.n)), h('td', { class: 'nowrap muted' }, time(g.last.t)));
            tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
                tr.click(); });
            return tr;
        })))) :
            h('p', { class: 'help' }, 'No errors or warnings in this range.')), h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', 'Entries'), h('span', { class: 'muted small' }, shown.length > MAX_ROWS ? `Newest ${MAX_ROWS} of ${shown.length} — narrow with search` : `${shown.length} shown, newest first`)), shown.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' }, h('tbody', shown.slice(0, MAX_ROWS).map((e) => h('tr', h('td', { class: 'nowrap muted small' }, time(e.t)), h('td', badge(e.level, LEVELS[e.level][1])), h('td', { class: 'log-msg' }, e.msg)))))) :
            h('p', { class: 'help' }, 'No matching entries.')));
    }
    search.addEventListener('input', debounce(draw, 150));
    since.addEventListener('change', () => void load());
    lines.addEventListener('change', () => void load());
    await load();
}
function setupHelp(ctx) {
    return h('div', { class: 'stack' }, callout('info', 'Logs need access to the Headscale host', 'Headscale has no API for its logs. Install this console on the same VM as Headscale with host actions enabled to read them here. The console only gets read access to the journal.'), h('p', { class: 'help' }, 'On the Headscale VM, from the console\'s folder:'), codeBlock(installCmd(ctx)), h('p', { class: 'help' }, 'Until then, read them on the server:'), codeBlock('sudo journalctl -u headscale --since "1 hour ago"\n# Docker:\ndocker logs --since 1h headscale'));
}
//# sourceMappingURL=logs.js.map