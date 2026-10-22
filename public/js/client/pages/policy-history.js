import { button, callout, clear, codeBlock, emptyState, errorState, h, spinner } from '../ui.js';
import { fmtDate, relTime } from '../util.js';
import { diffView } from './policy-views.js';
export function historyView(ctx, { get, restore }) {
    const root = h('div', { class: 'stack' }, h('div', { class: 'center pad-y' }, spinner(22)));
    if (!ctx.config.auditLog) {
        return callout('info', 'Policy history is off', h('span', 'It needs the console locked to your server (HEADSCALE_URL) and a writable data directory (DATA_DIR, a volume in Docker). Every save is then kept here.'));
    }
    const detail = h('div', { class: 'stack' });
    async function open(v, btn) {
        btn.classList.add('loading');
        try {
            const text = await ctx.api.policyVersion(v.id);
            const label = `${fmtDate(v.at)} by ${v.actor}`;
            clear(detail).append(h('div', { class: 'section-head' }, h('h2', `Version from ${label}`), h('div', { class: 'row-gap' }, button('Restore into editor', { variant: 'primary', size: 'sm', icon: 'history', onClick: () => restore(text, label) }))), diffView(get(), text, { what: 'the editor', none: 'This version matches the editor.' }), h('details', h('summary', { class: 'small' }, 'Full text'), codeBlock(text)));
            detail.scrollIntoView({ block: 'nearest' });
        }
        catch (e) {
            clear(detail).append(errorState(e));
        }
        finally {
            btn.classList.remove('loading');
        }
    }
    void (async () => {
        try {
            const versions = await ctx.api.policyHistory();
            if (!versions.length) {
                clear(root).append(emptyState('history', 'No saved versions yet', 'Each time the policy is saved through the console, the new version is kept here.'));
                return;
            }
            clear(root).append(h('p', { class: 'help' }, `${versions.length} saved version${versions.length === 1 ? '' : 's'}, newest first. Restoring puts a version in the editor; save to apply it.`), h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', h('tr', h('th', 'Saved'), h('th', 'By API key'), h('th', 'Size'), h('th', { class: 'col-actions' }))), h('tbody', versions.map((v, i) => {
                const btn = button('View', { size: 'sm' });
                btn.addEventListener('click', () => void open(v, btn));
                return h('tr', h('td', h('span', { title: fmtDate(v.at) }, relTime(v.at)), i === 0 ? h('span', { class: 'badge badge-success ml-1' }, 'Latest') : null), h('td', { class: 'mono' }, v.actor), h('td', { class: 'muted' }, `${(v.bytes / 1024).toFixed(1)} KB`), h('td', { class: 'col-actions' }, btn));
            })))), detail);
        }
        catch (e) {
            clear(root).append(errorState(e));
        }
    })();
    return root;
}
//# sourceMappingURL=policy-history.js.map