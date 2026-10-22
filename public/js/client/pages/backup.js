// Settings → Backup: export the tailnet's configuration to a file, and restore users and
// the policy from one. Machines can't be restored — they re-join with their own keys.
import { buildBackup, parseBackup, restorePlan } from '../../shared/backup.js';
import { button, callout, clear, confirmDialog, h, kv, put, toast } from '../ui.js';
import { download, fmtDate, hostOf, pluralize } from '../util.js';
import { serverUrl } from './actions.js';
import { diffView } from './policy-views.js';
export async function exportBackup(ctx) {
    const { users, nodes } = await ctx.load(true);
    const [preAuthKeys, apiKeys, policy, version] = await Promise.all([
        ctx.api.listPreAuthKeys(users), ctx.api.listApiKeys(), ctx.api.getPolicy(), ctx.api.version(),
    ]);
    return buildBackup({ server: serverUrl(ctx), headscaleVersion: version?.version ?? null, users, nodes, preAuthKeys, apiKeys, policy: policy.policy || '' });
}
export function backup(ctx, panel) {
    const exportBtn = button('Download backup', { variant: 'primary', icon: 'download' });
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Backup file to restore' });
    const restoreBtn = button('Restore from file…', { icon: 'upload', onClick: () => fileInput.click() });
    const out = h('div', { class: 'stack' });
    exportBtn.addEventListener('click', async () => {
        exportBtn.classList.add('loading');
        try {
            const b = await exportBackup(ctx);
            download(`headscale-backup-${hostOf(b.server)}-${b.exportedAt.slice(0, 10)}.json`, JSON.stringify(b, null, 2));
            toast(`Backup saved: ${pluralize(b.users.length, 'user')}, ${pluralize(b.nodes.length, 'machine')} and the policy`, 'success');
        }
        catch (e) {
            toast(e.message, 'error');
        }
        finally {
            exportBtn.classList.remove('loading');
        }
    });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (!f)
            return;
        clear(out);
        let b;
        try {
            b = parseBackup(await f.text());
        }
        catch (e) {
            out.append(callout('error', 'Can\'t restore this file', e.message));
            return;
        }
        const [{ users }, current] = await Promise.all([ctx.load(true), ctx.api.getPolicy()]);
        const plan = restorePlan(b, users, current.policy || '');
        put(out, kv([
            ['From server', b.server],
            ['Exported', fmtDate(b.exportedAt)],
            ['Headscale', b.headscaleVersion || '—'],
            ['Contains', `${pluralize(b.users.length, 'user')}, ${pluralize(b.nodes.length, 'machine')} (reference only), the policy`],
        ]), plan.createUsers.length || plan.policyChanged
            ? callout('info', 'Restoring will:', h('ul', { class: 'plain-list' }, plan.createUsers.length ? h('li', `Create ${pluralize(plan.createUsers.length, 'missing user')}: ${plan.createUsers.map((u) => u.name).join(', ')}`) : null, plan.policyChanged ? h('li', 'Replace the policy (changes below)') : null))
            : callout('success', 'Nothing to restore', 'Every user in the backup exists and the policy is the same.'), plan.policyChanged ? diffView(current.policy || '', b.policy, { what: 'the current policy' }) : null, plan.createUsers.length || plan.policyChanged ? h('div', button('Restore', { variant: 'primary', onClick: () => void restore(b, plan) })) : null);
    });
    async function restore(b, plan) {
        const ok = await confirmDialog({
            title: 'Restore from backup?',
            message: 'Missing users are created first, then the policy is replaced. Existing users and machines are not changed.',
            confirmLabel: 'Restore',
            onConfirm: async () => {
                for (const u of plan.createUsers) {
                    await ctx.api.createUser({ name: u.name, ...(u.displayName ? { displayName: u.displayName } : {}), ...(u.email ? { email: u.email } : {}) });
                }
                if (plan.policyChanged)
                    await ctx.api.setPolicy(b.policy);
            },
        });
        if (!ok)
            return;
        ctx.invalidate();
        clear(out).append(callout('success', 'Restored', `${pluralize(plan.createUsers.length, 'user')} created${plan.policyChanged ? ' and the policy replaced' : ''}.`));
    }
    panel.append(h('div', { class: 'panel-head' }, h('div', h('h2', 'Backup and restore'), h('p', { class: 'help' }, 'Save your users, machine list, key metadata and policy to a file, and restore users and the policy from one.'))), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Back up')), h('div', { class: 'card-body stack' }, h('p', { class: 'help' }, 'The file holds no secrets: auth keys appear by ID and API keys by prefix only. Keep it private anyway — it lists your machines and their addresses.'), h('div', exportBtn))), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Restore')), h('div', { class: 'card-body stack' }, h('p', { class: 'help' }, 'Restoring creates users that are missing and replaces the policy. Machines re-join on their own; they can\'t be recreated from a backup.'), h('div', restoreBtn, fileInput), out)));
}
//# sourceMappingURL=backup.js.map