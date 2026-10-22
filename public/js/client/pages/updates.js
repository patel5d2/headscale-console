import { badge, button, callout, clear, codeBlock, confirmDialog, h, kv, spinner, tabs, toast } from '../ui.js';
import { cmpVersion, fmtDate, relTime, semver } from '../util.js';
import { serverUrl } from './actions.js';
const notesUrl = (v) => `https://github.com/juanfont/headscale/releases/tag/v${v}`;
const card = (title, ...body) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', title)), h('div', { class: 'card-body stack' }, body));
export const installCmd = (ctx) => `sudo ./deploy/install-vm.sh --url ${serverUrl(ctx) || 'https://headscale.example.com'} --host-actions`;
export async function updates(ctx, panel) {
    panel.appendChild(h('div', { class: 'center pad-y' }, spinner(22)));
    const [version, releases] = await Promise.all([ctx.api.version(), ctx.api.releases().catch((e) => e)]);
    const current = semver(version?.version);
    let timer;
    let watching = 0; // when the update we asked for was queued
    clear(panel);
    if (releases instanceof Error) {
        panel.append(card('Headscale version', callout('error', 'Could not check for updates', releases.message)));
        return () => { };
    }
    const latest = releases[0];
    const newer = current ? releases.filter((r) => cmpVersion(r.version, current) > 0) : [];
    panel.append(card('Headscale version', kv([
        ['Running', current ? h('span', { class: 'mono' }, current) : h('span', { class: 'muted' }, version?.version || 'Unknown')],
        ['Latest release', latest ? h('span', h('a', { href: notesUrl(latest.version), target: '_blank', rel: 'noopener' }, latest.version), latest.publishedAt ? h('span', { class: 'muted small' }, ` · ${fmtDate(latest.publishedAt, false)}`) : null) : '—'],
        ['Status', !current ? badge('Unknown', 'neutral')
                : newer.length ? badge(`${newer.length} newer release${newer.length === 1 ? '' : 's'}`, 'warning', 'alert')
                    : badge('Up to date', 'success', 'check')],
    ])));
    const progress = h('div', { class: 'stack' });
    if (newer.length) {
        const target = h('select', { class: 'input', 'aria-label': 'Version' }, newer.map((r) => h('option', { value: r.version }, r.version)));
        const notes = h('a', { target: '_blank', rel: 'noopener' });
        const steps = h('div');
        const sync = () => {
            notes.href = notesUrl(target.value);
            notes.textContent = `Release notes for ${target.value}`;
            clear(steps).append(ctx.config.hostActions ? oneClick(target.value) : manual(ctx, target.value));
        };
        target.addEventListener('change', sync);
        panel.append(card('Update Headscale', h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Version'), target), callout('warning', 'Read the release notes first', h('span', 'Releases can rename or remove config options. Check the notes for every version you skip. ', notes)), steps));
        sync();
    }
    if (ctx.config.hostActions)
        panel.append(progress);
    function oneClick(v) {
        const go = button(`Update to ${v}`, { variant: 'primary', icon: 'download' });
        go.addEventListener('click', async () => {
            const ok = await confirmDialog({
                title: `Update Headscale to ${v}?`,
                message: 'Headscale is stopped, its database is backed up, the official package is installed and verified, and it starts again. Devices stay connected but can\'t log in or change routes for a few seconds. If it doesn\'t start, the previous version and database are restored.',
                confirmLabel: 'Update', requireText: v,
            });
            if (!ok)
                return;
            go.disabled = true;
            try {
                await ctx.api.requestUpdate(v);
                watching = Date.now();
                await poll();
            }
            catch (e) {
                toast(e.message, 'error');
                go.disabled = false;
            }
        });
        return h('div', go);
    }
    function showStatus(s) {
        const ui = {
            queued: ['info', 'Update queued — waiting for the update helper…'],
            running: ['info', `Updating to ${s.to}: ${s.message || 'working'}…`],
            done: ['success', `${s.message} — ${s.from || '?'} → ${s.to}`],
            failed: ['error', String(s.message)],
            stale: ['warning', 'The last update stopped responding. Check the log below and the server.'],
        }[s.state];
        clear(progress);
        if (!ui)
            return;
        if (s.state === 'queued' && watching && Date.now() - watching > 60000) {
            progress.append(callout('warning', 'The update helper hasn\'t started', h('span', 'Check it on the server: ', h('code', 'systemctl status headscale-console-update.path'))));
        }
        progress.append(card(s.state === 'done' || s.state === 'failed' ? 'Last update' : 'Update in progress', callout(ui[0], null, h('span', ui[1], s.at ? h('span', { class: 'muted small' }, ` · ${relTime(s.at)}`) : null)), s.log ? h('details', { open: s.state !== 'done' }, h('summary', { class: 'small' }, 'Update log'), codeBlock(s.log.trim())) : null));
    }
    async function poll() {
        clearTimeout(timer);
        try {
            const s = await ctx.api.updateStatus();
            showStatus(s);
            if (s.state === 'queued' || s.state === 'running') {
                timer = setTimeout(() => void poll(), 3000);
                return;
            }
            if (watching) {
                watching = 0;
                toast(s.state === 'done' ? 'Headscale updated' : 'Headscale update failed', s.state === 'done' ? 'success' : 'error');
                ctx.server.version = await ctx.api.version();
                ctx.rerender();
            }
        }
        catch (e) {
            if (!watching || e.status === 401) {
                clear(progress).append(callout('error', 'Could not read update status', e.message));
                return;
            }
            clear(progress).append(callout('info', null, 'Waiting for Headscale to come back…'));
            timer = setTimeout(() => void poll(), 3000); // Headscale restarts mid-update
        }
    }
    if (ctx.config.hostActions)
        await poll();
    return () => clearTimeout(timer);
}
function manual(ctx, v) {
    const deb = `headscale_${v}_linux_amd64.deb`;
    const steps = {
        deb: ['Debian/Ubuntu package (use arm64 instead of amd64 on ARM):',
            `curl -fLO https://github.com/juanfont/headscale/releases/download/v${v}/${deb}\nsudo systemctl stop headscale\nsudo cp -a /var/lib/headscale/db.sqlite /var/lib/headscale/db.sqlite.bak\nsudo apt install ./${deb}\nsudo systemctl start headscale`],
        docker: [`Set the image to headscale/headscale:${v} in docker-compose.yml, back up your database, then:`, 'docker compose pull headscale\ndocker compose up -d headscale'],
    };
    const box = h('div', { class: 'stack-sm' });
    const show = (id) => { clear(box).append(h('p', { class: 'help' }, steps[id][0]), codeBlock(steps[id][1])); };
    show('deb');
    return h('div', { class: 'stack' }, tabs([{ id: 'deb', label: 'Debian / Ubuntu' }, { id: 'docker', label: 'Docker' }], 'deb', show), box, h('p', { class: 'help' }, 'For one-click updates, install this console on the Headscale VM with ', h('code', installCmd(ctx)), '.'));
}
//# sourceMappingURL=updates.js.map