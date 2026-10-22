import { button, chipInput, confirmDialog, h, modal, toast } from '../ui.js';
import { nodeName, nodeTags, pluralize } from '../util.js';
/** Runs `op` on each machine in turn; returns the names that failed. */
export async function runEach(nodes, op) {
    const failed = [];
    for (const n of nodes) {
        try {
            await op(n);
        }
        catch (e) {
            failed.push(`${nodeName(n)}: ${e.message}`);
        }
    }
    return failed;
}
function report(done, nodes, failed) {
    const ok = nodes.length - failed.length;
    if (ok)
        toast(`${done} on ${pluralize(ok, 'machine')}`, 'success');
    if (failed.length)
        toast(`Failed on ${failed.length}: ${failed.join('; ')}`, 'error', 8000);
}
export async function bulkApproveRoutes(ctx, nodes, after) {
    const pending = nodes.filter((n) => (n.availableRoutes || []).some((r) => !(n.approvedRoutes || []).includes(r)));
    if (!pending.length) {
        toast('None of the selected machines has routes waiting for approval', 'info');
        return;
    }
    const routes = pending.flatMap((n) => (n.availableRoutes || []).filter((r) => !(n.approvedRoutes || []).includes(r)).map((r) => `${nodeName(n)}: ${r}`));
    const ok = await confirmDialog({
        title: `Approve routes on ${pluralize(pending.length, 'machine')}?`,
        message: h('div', { class: 'stack-sm' }, h('p', 'These advertised routes will be approved:'), h('ul', { class: 'plain-list mono small' }, routes.map((r) => h('li', r)))),
        confirmLabel: 'Approve',
    });
    if (!ok)
        return;
    report('Routes approved', pending, await runEach(pending, (n) => ctx.api.setApprovedRoutes(n.id, [...new Set([...(n.approvedRoutes || []), ...(n.availableRoutes || [])])])));
    after();
}
export function bulkTags(ctx, nodes, after) {
    const mode = h('select', { class: 'input' }, h('option', { value: 'add' }, 'Add these tags'), h('option', { value: 'remove' }, 'Remove these tags'));
    const chips = chipInput([], {
        placeholder: 'tag:server',
        normalize: (s) => (s.startsWith('tag:') ? s : `tag:${s}`).toLowerCase(),
        validate: (s) => (/^tag:[a-z0-9][a-z0-9-_]*$/.test(s) ? null : `"${s}" is not a valid tag.`),
        suggestions: [...new Set((ctx.data.nodes || []).flatMap(nodeTags))],
    });
    const apply = button('Apply', { variant: 'primary' });
    const m = modal({
        title: `Tags on ${pluralize(nodes.length, 'machine')}`,
        body: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Action'), mode), h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Tags'), chips.el), h('p', { class: 'help' }, 'Tags must be listed under tagOwners in the policy, or Headscale rejects them.')),
        footer: (api) => [button('Cancel', { onClick: () => api.close() }), apply],
    });
    apply.addEventListener('click', async () => {
        let tags;
        try {
            tags = chips.get();
        }
        catch {
            return;
        }
        if (!tags.length) {
            toast('Add at least one tag', 'error');
            return;
        }
        m.close();
        const add = mode.value === 'add';
        report(add ? 'Tags added' : 'Tags removed', nodes, await runEach(nodes, (n) => {
            const cur = nodeTags(n);
            return ctx.api.setTags(n.id, add ? [...new Set([...cur, ...tags])] : cur.filter((t) => !tags.includes(t)));
        }));
        after();
    });
}
export async function bulkSimple(ctx, nodes, kind, after) {
    const what = {
        expire: { title: 'Expire keys', verb: 'Expire', msg: 'These machines are disconnected until they re-authenticate (tailscale up).', op: (n) => ctx.api.expireNode(n.id), done: 'Keys expired' },
        noexpiry: { title: 'Disable key expiry', verb: 'Disable expiry', msg: 'These machines will never need to re-authenticate.', op: (n) => ctx.api.disableNodeExpiry(n.id), done: 'Key expiry disabled' },
        remove: { title: 'Remove machines', verb: 'Remove', msg: 'These machines are removed from the tailnet. They must be re-registered to join again.', op: (n) => ctx.api.deleteNode(n.id), done: 'Removed' },
    }[kind];
    const ok = await confirmDialog({
        title: `${what.title}: ${pluralize(nodes.length, 'machine')}?`,
        message: h('div', { class: 'stack-sm' }, h('p', what.msg), h('p', { class: 'muted small' }, nodes.map(nodeName).join(', '))),
        confirmLabel: what.verb, danger: kind !== 'noexpiry',
        ...(kind === 'remove' ? { requireText: String(nodes.length) } : {}),
    });
    if (!ok)
        return;
    report(what.done, nodes, await runEach(nodes, what.op));
    after();
}
//# sourceMappingURL=bulk.js.map