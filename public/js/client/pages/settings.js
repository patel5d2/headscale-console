import { badge, button, callout, clear, confirmDialog, copyable, h, icon, kv, modal, spinner, toast } from '../ui.js';
import { applyTheme, fmtDate, hostOf, routeInfo, store, userLabel } from '../util.js';
import { serverUrl } from './actions.js';
import { backup } from './backup.js';
import { apiKeys, authKeys } from './settings-keys.js';
import { updates } from './updates.js';
const SECTIONS = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'keys', label: 'Auth keys', icon: 'key' },
    { id: 'api-keys', label: 'API keys', icon: 'lock' },
    { id: 'devices', label: 'Device approval', icon: 'check' },
    { id: 'backup', label: 'Backup', icon: 'file' },
    { id: 'updates', label: 'Updates', icon: 'download' },
];
const RENDER = {
    general, keys: authKeys, 'api-keys': apiKeys, devices, backup, updates,
};
export function render(ctx, { section = 'general' }, root) {
    const id = (SECTIONS.find((s) => s.id === section)?.id ?? 'general');
    const panel = h('div', { class: 'settings-panel' });
    root.append(h('div', { class: 'page-head' }, h('div', h('h1', 'Settings'), h('p', { class: 'muted' }, 'Manage your Headscale server, keys and this console.'))), h('div', { class: 'settings-layout' }, h('nav', { class: 'subnav', 'aria-label': 'Settings' }, SECTIONS.map((s) => h('a', { href: `#/settings/${s.id}`, class: `subnav-link${s.id === id ? ' active' : ''}` }, icon(s.icon, 15), s.label))), panel));
    return RENDER[id](ctx, panel);
}
// ------------------------------------------------------------------ General --
async function general(ctx, panel) {
    panel.appendChild(h('div', { class: 'center pad-y' }, spinner(22)));
    const [health, version, data] = await Promise.all([ctx.api.health(), ctx.api.version(), ctx.load(true).catch(() => ({ users: [], nodes: [] }))]);
    const { users, nodes } = data;
    const stat = (label, n, href) => h('a', { class: 'stat stat-link', href }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label));
    const domain = h('input', { class: 'input mono', value: ctx.prefs.baseDomain, placeholder: 'tail.example.com', spellcheck: 'false', 'aria-label': 'MagicDNS base domain' });
    const theme = h('select', { class: 'input', 'aria-label': 'Appearance' }, ['system', 'light', 'dark'].map((t) => h('option', { value: t, selected: store.get('theme', 'system') === t }, t[0].toUpperCase() + t.slice(1))));
    theme.addEventListener('change', () => { store.set('theme', theme.value); applyTheme(); });
    const saveDomain = button('Save', { size: 'sm', onClick: () => { ctx.prefs.baseDomain = domain.value.trim().toLowerCase(); toast('Saved', 'success'); } });
    clear(panel).append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Server')), kv([
        ['Server URL', copyable(serverUrl(ctx))],
        ['Version', version?.version ? h('span', version.version, version.commit ? h('span', { class: 'muted mono small' }, ` (${version.commit.slice(0, 7)})`) : null) : h('span', { class: 'muted' }, 'Unknown')],
        version?.buildTime ? ['Built', fmtDate(version.buildTime)] : null,
        ['Health', health.error ? badge('Unavailable', 'neutral') : health.databaseConnectivity ? badge('Database connected', 'success', 'check') : badge('Database unreachable', 'danger', 'alert')],
        ['Console access', ctx.config.lockedUrl ? badge('Locked to this server', 'info', 'lock') : badge('Any server', 'neutral')],
        ['Audit log', ctx.config.auditLog ? badge('On', 'success', 'check') : badge('Off', 'neutral')],
    ])), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Tailnet overview')), h('div', { class: 'card-body' }, h('div', { class: 'stat-row' }, stat('Users', users.length, '#/users'), stat('Machines', nodes.length, '#/machines'), stat('Connected', nodes.filter((n) => n.online).length, '#/machines'), stat('Subnet routes', nodes.reduce((a, n) => a + routeInfo(n).subnets.length, 0), '#/routes'), stat('Exit nodes', nodes.filter((n) => routeInfo(n).exitApproved).length, '#/routes')))), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Console preferences')), h('div', { class: 'card-body stack' }, h('div', { class: 'setting-row' }, h('div', h('div', { class: 'setting-title' }, 'Appearance'), h('div', { class: 'help' }, 'Light, dark, or follow your system.')), theme), h('div', { class: 'setting-row' }, h('div', h('div', { class: 'setting-title' }, 'MagicDNS base domain'), h('div', { class: 'help' }, 'Matches dns.base_domain in your Headscale config; used to show full machine names.')), h('div', { class: 'inline-form' }, domain, saveDomain)))), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Maintenance')), h('div', { class: 'card-body stack' }, h('div', { class: 'setting-row' }, h('div', h('div', { class: 'setting-title' }, 'Backfill IP addresses'), h('div', { class: 'help' }, 'Gives machines missing an IPv4 or IPv6 address one from your configured prefixes. Useful after enabling a new address family.')), button('Backfill…', { onClick: () => void backfill(ctx) })))), h('section', { class: 'card card-danger' }, h('div', { class: 'card-head' }, h('h2', 'Session')), h('div', { class: 'card-body setting-row' }, h('div', h('div', { class: 'setting-title' }, `Connected to ${hostOf(serverUrl(ctx))}`), h('div', { class: 'help' }, ctx.conn?.remember ? 'Your API key is remembered on this device.' : 'Your API key is kept only for this browser tab.')), button('Disconnect', { variant: 'danger', icon: 'logout', onClick: () => ctx.disconnect() }))));
}
async function backfill(ctx) {
    const ok = await confirmDialog({
        title: 'Backfill IP addresses?',
        message: 'Headscale will assign missing addresses to every machine. Clients pick up the change on their next map update.',
        confirmLabel: 'Backfill',
    });
    if (!ok)
        return;
    try {
        const changes = (await ctx.api.backfillIPs()).changes || [];
        modal({
            title: 'Backfill complete', size: 'md',
            body: changes.length ? h('ul', { class: 'plain-list mono small' }, changes.map((c) => h('li', c))) : h('p', 'All machines already had addresses. Nothing changed.'),
            footer: (api) => [button('Done', { variant: 'primary', onClick: () => api.close() })],
        });
        ctx.invalidate();
    }
    catch (e) {
        toast(e.message, 'error');
    }
}
// ---------------------------------------------------------- Device approval --
/** The auth ID inside a registration URL, or the raw text. */
export function parseAuthId(raw) {
    const m = raw.match(/hskey-authreq-[A-Za-z0-9_-]+/) || raw.match(/(?:register\/|auth\/|key=)([A-Za-z0-9_:-]+)/);
    return m ? (m[1] || m[0]) : raw.trim();
}
async function devices(ctx, panel) {
    const { users } = await ctx.load();
    const url = serverUrl(ctx);
    const regInput = h('input', { class: 'input mono', placeholder: `${url}/register/hskey-authreq-…`, spellcheck: 'false', 'aria-label': 'Login URL or auth ID' });
    const regUser = h('select', { class: 'input', 'aria-label': 'Owner' }, users.map((u) => h('option', { value: u.name }, userLabel(u))));
    const regOut = h('div');
    const regBtn = button('Register device', { variant: 'primary', icon: 'check' });
    const authInput = h('input', { class: 'input mono', placeholder: 'hskey-authreq-…', spellcheck: 'false', 'aria-label': 'Auth request URL or ID' });
    const authOut = h('div');
    const approveBtn = button('Approve', { variant: 'primary', icon: 'check' });
    const rejectBtn = button('Reject', { variant: 'danger', icon: 'x' });
    regBtn.addEventListener('click', async () => {
        clear(regOut);
        const id = parseAuthId(regInput.value);
        if (!id) {
            regOut.appendChild(callout('error', null, 'Paste the registration URL or auth ID.'));
            return;
        }
        regBtn.disabled = true;
        try {
            const node = await ctx.api.registerAuth(regUser.value, id);
            ctx.invalidate();
            regInput.value = '';
            regOut.appendChild(callout('success', 'Device registered', h('span', node ? h('a', { href: `#/machines/${node.id}` }, node.givenName || node.name) : 'The device', ' joined the tailnet.')));
        }
        catch (e) {
            regOut.appendChild(callout('error', 'Registration failed', e.message));
        }
        finally {
            regBtn.disabled = false;
        }
    });
    const decide = (approve) => async () => {
        clear(authOut);
        const id = parseAuthId(authInput.value);
        if (!id) {
            authOut.appendChild(callout('error', null, 'Paste the auth request URL or ID.'));
            return;
        }
        try {
            await (approve ? ctx.api.approveAuth(id) : ctx.api.rejectAuth(id));
            authInput.value = '';
            authOut.appendChild(callout('success', null, approve ? 'Request approved.' : 'Request rejected.'));
        }
        catch (e) {
            authOut.appendChild(callout('error', null, e.message));
        }
    };
    approveBtn.addEventListener('click', decide(true));
    rejectBtn.addEventListener('click', decide(false));
    panel.append(h('div', { class: 'panel-head' }, h('div', h('h2', 'Device approval'), h('p', { class: 'help' }, 'Approve devices and sign-ins that are waiting on an administrator.'))), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Register a new device')), h('div', { class: 'card-body stack' }, h('p', { class: 'help' }, 'When a device runs ', h('code', `tailscale up --login-server ${url}`), ' without an auth key, it prints a login URL. Paste it here and choose who owns the device.'), users.length ? null : callout('warning', null, h('span', 'You need a user first. ', h('a', { href: '#/users' }, 'Create one'), '.')), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Login URL or auth ID'), regInput), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Owner'), regUser), h('div', regBtn), regOut)), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Pending authentication requests')), h('div', { class: 'card-body stack' }, h('p', { class: 'help' }, 'Approve or reject a pending request by its ID — for example a Tailscale SSH check-mode prompt or a web sign-in waiting for approval.'), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Auth request URL or ID'), authInput), h('div', { class: 'row-gap' }, approveBtn, rejectBtn), authOut)), callout('info', null, h('span', 'Headscale doesn\'t list pending requests through its API, so they are approved by ID. Devices added with an auth key are pre-approved automatically. ', h('a', { href: '#/settings/keys' }, 'Manage auth keys'), '.')));
}
//# sourceMappingURL=settings.js.map