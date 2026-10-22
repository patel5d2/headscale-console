// Small DOM toolkit: element builder, icons, toasts, modals, menus.
import { avatarHue, copyText, initials } from './util.js';
const SVGNS = 'http://www.w3.org/2000/svg';
const isAttrs = (a) => !!a && typeof a === 'object' && !(a instanceof Node) && !Array.isArray(a);
/** Creates an element: h('div', { class: 'x', onclick }, child, …) or h('span', 'text'). */
export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (!isAttrs(attrs))
        children.unshift(attrs);
    else {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false)
                continue;
            if (k === 'class')
                el.className = String(v);
            else if (k === 'style')
                Object.assign(el.style, v);
            else if (k === 'dataset')
                Object.assign(el.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function')
                el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'value')
                el.value = String(v);
            else if (k === 'checked')
                el.checked = !!v;
            else
                el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    append(el, children);
    return el;
}
function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false)
            continue;
        el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}
/** Appends children, skipping null/false (DOM append() would render "null"). */
export function put(el, ...children) {
    append(el, children);
    return el;
}
export function clear(el) {
    el.replaceChildren();
    return el;
}
// ------------------------------------------------------------------- icons --
const ICONS = {
    machines: 'M4 5h16v10H4z M8 19h8 M12 15v4',
    users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1 M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M22 19v-1a4 4 0 0 0-3-3.9 M16 4.1a3 3 0 0 1 0 5.8',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    dns: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
    key: 'M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l2.1-2.1A4 4 0 0 1 15 7z M16 8h.01',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    routes: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
    more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
    plus: 'M12 5v14 M5 12h14',
    copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
    check: 'M20 6 9 17l-5-5',
    x: 'M18 6 6 18 M6 6l12 12',
    chevronDown: 'M6 9l6 6 6-6',
    chevronRight: 'M9 18l6-6-6-6',
    chevronLeft: 'M15 18l-6-6 6-6',
    refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8 M21 3v5h-5',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
    trash: 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6',
    edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z M7 7h.01',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
    exit: 'M14 3h7v7 M10 14 21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01',
    alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
    filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
    server: 'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01',
    lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
    unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.9-1',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    terminal: 'M4 17l6-6-6-6 M12 19h8',
    code: 'M16 18l6-6-6-6 M8 6l-6 6 6 6',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l4 2',
    maximize: 'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3',
};
export function icon(name, size = 16, cls = '') {
    const svg = document.createElementNS(SVGNS, 'svg');
    for (const [k, v] of Object.entries({
        viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `icon ${cls}`,
    }))
        svg.setAttribute(k, v);
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[name]);
    svg.appendChild(p);
    return svg;
}
/** 3×3 dot grid, a nod to the Tailscale mark. */
export function logo(size = 22) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    [4, 12, 20].forEach((y, r) => [4, 12, 20].forEach((x, c) => {
        const dot = document.createElementNS(SVGNS, 'circle');
        for (const [k, v] of Object.entries({ cx: x, cy: y, r: 2.6, fill: 'currentColor', opacity: r === 1 || (r === 2 && c === 1) ? 1 : 0.28 }))
            dot.setAttribute(k, String(v));
        svg.appendChild(dot);
    }));
    return h('span', { class: 'logo', 'aria-hidden': 'true' }, svg);
}
export function button(label, { variant = 'secondary', icon: ic, onClick, size, title, disabled, type = 'button', cls = '' } = {}) {
    return h('button', {
        type, class: `btn btn-${variant}${size ? ' btn-' + size : ''} ${cls}`, onclick: onClick, title, disabled,
    }, ic ? icon(ic, size === 'sm' ? 14 : 16) : null, label ? h('span', label) : null);
}
export function badge(text, kind = 'neutral', ic, title) {
    return h('span', { class: `badge badge-${kind}`, title }, ic ? icon(ic, 12) : null, text);
}
export function avatar(name, url, size = 28) {
    if (url) {
        const img = h('img', { class: 'avatar', src: url, alt: '', width: size, height: size, referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => img.replaceWith(avatar(name, null, size)));
        return img;
    }
    const el = h('span', { class: 'avatar', style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' } }, initials(name));
    el.style.setProperty('--hue', String(avatarHue(name)));
    return el;
}
export const statusDot = (online, title) => h('span', { class: `dot ${online ? 'dot-on' : 'dot-off'}`, title: title || (online ? 'Connected' : 'Offline') });
export function copyButton(text, label) {
    const b = h('button', { class: 'copy-btn', type: 'button', title: 'Copy to clipboard', 'aria-label': 'Copy' }, icon('copy', 13), label ? h('span', label) : null);
    b.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const ok = await copyText(typeof text === 'function' ? text() : text);
        b.classList.add('copied');
        b.firstChild.replaceWith(icon(ok ? 'check' : 'x', 13));
        setTimeout(() => { b.classList.remove('copied'); b.firstChild.replaceWith(icon('copy', 13)); }, 1400);
        if (ok)
            toast('Copied to clipboard', 'success', 1600);
    });
    return b;
}
export const copyable = (text, { mono = true, display } = {}) => h('span', { class: `copyable${mono ? ' mono' : ''}` }, h('span', { class: 'copyable-text' }, display ?? text), copyButton(text));
export const spinner = (size = 18) => h('span', { class: 'spinner', style: { width: size + 'px', height: size + 'px' }, role: 'status', 'aria-label': 'Loading' });
export const emptyState = (ic, title, text, action) => h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(ic, 22)), h('div', { class: 'empty-title' }, title), text ? h('div', { class: 'empty-text' }, text) : null, action || null);
export const errorState = (err, retry) => h('div', { class: 'callout callout-error' }, icon('alert', 18), h('div', { class: 'callout-body' }, h('strong', 'Something went wrong'), h('div', String(err?.message || err)), retry ? h('div', { class: 'mt-2' }, button('Try again', { size: 'sm', icon: 'refresh', onClick: retry })) : null));
export const callout = (kind, title, body, ic) => h('div', { class: `callout callout-${kind}` }, icon(ic || { warning: 'alert', error: 'alert', success: 'check', info: 'info' }[kind], 18), h('div', { class: 'callout-body' }, title ? h('strong', title) : null, body ? h('div', body) : null));
export const skeletonRows = (n = 5, cols = 4) => Array.from({ length: n }, () => h('tr', { class: 'skeleton-row' }, Array.from({ length: cols }, () => h('td', h('span', { class: 'skeleton' })))));
export function toggle(checked, onChange, { disabled, label, ariaLabel } = {}) {
    const input = h('input', { type: 'checkbox', checked, disabled, role: 'switch', 'aria-label': ariaLabel ?? label });
    input.addEventListener('change', () => onChange(input.checked, input));
    return h('label', { class: 'switch' + (disabled ? ' disabled' : '') }, input, h('span', { class: 'switch-track' }), label ? h('span', { class: 'switch-label' }, label) : null);
}
// ------------------------------------------------------------------ toasts --
let toastRoot;
export function toast(message, kind = 'info', ms = 3500) {
    if (!toastRoot || !toastRoot.isConnected) {
        toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite' });
        document.body.appendChild(toastRoot);
    }
    const ic = { success: 'check', error: 'alert', info: 'info', warning: 'alert' }[kind];
    const dismiss = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 200); };
    const t = h('div', { class: `toast toast-${kind}` }, icon(ic, 16), h('span', message), h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onclick: dismiss }, icon('x', 14)));
    toastRoot.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(dismiss, kind === 'error' ? Math.max(ms, 6000) : ms);
}
export function modal({ title, subtitle, body, footer, size = 'md', onClose, dismissible = true }) {
    const prevFocus = document.activeElement;
    const dialog = h('div', { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
    let closed = false;
    const close = (result) => {
        if (closed)
            return;
        closed = true;
        backdrop.classList.remove('show');
        document.removeEventListener('keydown', onKey, true);
        setTimeout(() => backdrop.remove(), 160);
        prevFocus?.focus?.();
        onClose?.(result);
    };
    const onKey = (e) => {
        if (e.key === 'Escape' && dismissible) {
            e.stopPropagation();
            close();
        }
    };
    dialog.appendChild(h('div', { class: 'modal-head' }, h('div', h('h2', title), subtitle ? h('p', { class: 'muted' }, subtitle) : null), dismissible ? h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('x', 18)) : null));
    const bodyEl = h('div', { class: 'modal-body' });
    const footEl = h('div', { class: 'modal-foot' });
    dialog.append(bodyEl, footEl);
    const api = {
        close, dialog, bodyEl, footEl,
        setBody(...c) { put(clear(bodyEl), ...c); },
        setFooter(...c) { put(clear(footEl), ...c); footEl.style.display = footEl.childElementCount ? '' : 'none'; },
    };
    api.setBody(typeof body === 'function' ? body(api) : body);
    api.setFooter(typeof footer === 'function' ? footer(api) : footer);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && dismissible)
        close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => {
        backdrop.classList.add('show');
        const f = dialog.querySelector('[autofocus], input:not([type=hidden]):not([disabled]), textarea, select');
        (f || dialog.querySelector('.btn-primary') || dialog).focus();
    });
    return api;
}
/** Confirmation dialog → Promise<boolean>. onConfirm (optional, async) runs with the button loading; errors stay in the dialog. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, requireText, onConfirm }) {
    return new Promise((resolve) => {
        let input;
        const errBox = h('div');
        const confirmBtn = button(confirmLabel, { variant: danger ? 'danger' : 'primary' });
        const m = modal({
            title,
            size: 'sm',
            body: () => h('div', { class: 'stack' }, typeof message === 'string' ? h('p', message) : message, requireText ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type ', h('code', requireText), ' to confirm'), input = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false' })) : null, errBox),
            footer: (api) => [button('Cancel', { onClick: () => api.close(false) }), confirmBtn],
            onClose: (r) => resolve(!!r),
        });
        const go = async () => {
            if (!onConfirm) {
                m.close(true);
                return;
            }
            clear(errBox);
            confirmBtn.disabled = true;
            confirmBtn.classList.add('loading');
            try {
                await onConfirm();
                m.close(true);
            }
            catch (e) {
                errBox.appendChild(callout('error', null, e.message || String(e)));
                confirmBtn.disabled = false;
            }
            finally {
                confirmBtn.classList.remove('loading');
            }
        };
        confirmBtn.addEventListener('click', go);
        if (input) {
            const field = input;
            confirmBtn.disabled = true;
            field.addEventListener('input', () => { confirmBtn.disabled = field.value.trim() !== requireText; });
            field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !confirmBtn.disabled)
                void go(); });
        }
    });
}
/** Generic form modal. onSubmit may throw to show an error; its return value closes the dialog with it. */
export function formDialog({ title, subtitle, fields, submitLabel = 'Save', danger, onSubmit, size = 'sm', extra }) {
    return new Promise((resolve) => {
        const inputs = {};
        const errorBox = h('div');
        const submit = button(submitLabel, { variant: danger ? 'danger' : 'primary', type: 'submit' });
        const form = h('form', { class: 'stack', novalidate: true });
        for (const f of fields) {
            let el;
            if (f.type === 'select') {
                el = h('select', { class: 'input', name: f.name }, (f.options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
            }
            else if (f.type === 'checkbox') {
                el = h('input', { type: 'checkbox', name: f.name, checked: !!f.value });
                form.appendChild(h('label', { class: 'check' }, el, h('span', h('span', { class: 'check-label' }, f.label), f.help ? h('span', { class: 'help' }, f.help) : null)));
                inputs[f.name] = el;
                continue;
            }
            else if (f.type === 'textarea') {
                el = h('textarea', { class: 'input mono', name: f.name, rows: f.rows || 4, placeholder: f.placeholder, spellcheck: 'false' });
                el.value = String(f.value ?? '');
            }
            else {
                el = h('input', {
                    class: 'input' + (f.mono ? ' mono' : ''), name: f.name, type: f.type || 'text', value: f.value ?? '',
                    placeholder: f.placeholder, autocomplete: 'off', spellcheck: 'false', required: f.required, min: f.min, max: f.max,
                });
            }
            inputs[f.name] = el;
            form.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label, f.optional ? h('span', { class: 'muted' }, ' (optional)') : null), el, f.help ? h('span', { class: 'help' }, f.help) : null));
        }
        if (extra)
            form.appendChild(extra);
        form.appendChild(errorBox);
        const m = modal({
            title, size, body: form,
            ...(subtitle ? { subtitle } : {}),
            footer: (api) => [button('Cancel', { onClick: () => api.close(null) }), submit],
            onClose: (r) => resolve(r ?? null),
        });
        submit.addEventListener('click', (e) => { e.preventDefault(); form.requestSubmit(); });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            clear(errorBox);
            const values = {};
            for (const [k, el] of Object.entries(inputs))
                values[k] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value.trim();
            const missing = fields.find((f) => f.required && !values[f.name]);
            if (missing) {
                errorBox.appendChild(callout('error', null, `${missing.label} is required.`));
                inputs[missing.name].focus();
                return;
            }
            submit.disabled = true;
            submit.classList.add('loading');
            try {
                const r = await onSubmit(values, m);
                m.close(r === undefined ? true : r);
            }
            catch (err) {
                errorBox.appendChild(callout('error', null, err.message || String(err)));
            }
            finally {
                submit.disabled = false;
                submit.classList.remove('loading');
            }
        });
    });
}
// ------------------------------------------------------------------- menus --
let openMenu = null;
export function closeMenus() {
    if (openMenu)
        console.log('closeMenus called from:\n', new Error().stack);
    openMenu?.remove();
    openMenu = null;
}
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target))
    closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape')
    closeMenus(); });
window.addEventListener('resize', closeMenus);
window.addEventListener('scroll', (e) => {
    if (openMenu && openMenu.contains(e.target))
        return;
    closeMenus();
}, true);
export function showMenu(anchor, items, { align = 'right' } = {}) {
    closeMenus();
    const menu = h('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
        if (!it)
            continue;
        if ('divider' in it) {
            menu.appendChild(h('div', { class: 'menu-divider' }));
            continue;
        }
        if ('header' in it) {
            menu.appendChild(h('div', { class: 'menu-header' }, it.header));
            continue;
        }
        const b = h('button', { class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem', disabled: it.disabled, type: 'button' }, it.icon ? icon(it.icon, 15) : h('span', { class: 'menu-icon-spacer' }), h('span', it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
        b.addEventListener('click', (e) => { e.stopPropagation(); closeMenus(); it.onClick?.(); });
        menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(align === 'right' ? r.right - mw : r.left, window.innerWidth - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8)
        top = Math.max(8, r.top - mh - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    openMenu = menu;
    menu.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
    menu.addEventListener('keydown', (e) => {
        const list = [...menu.querySelectorAll('.menu-item:not([disabled])')];
        const i = list.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            list[(i + 1) % list.length]?.focus();
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            list[(i - 1 + list.length) % list.length]?.focus();
        }
    });
    return menu;
}
export function moreButton(getItems, label = 'More actions') {
    const b = h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label }, icon('more', 18));
    b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (openMenu) {
            closeMenus();
            return;
        }
        showMenu(b, getItems());
    });
    return b;
}
export function chipInput(initial = [], { placeholder = 'Add…', normalize = (s) => s, validate = (_s) => null, suggestions = [] } = {}) {
    const values = [...initial];
    const input = h('input', { class: 'chip-input-field', placeholder, spellcheck: 'false', autocomplete: 'off' });
    const err = h('div', { class: 'help error-text' });
    const chips = h('div', { class: 'chips' });
    const wrap = h('div', { class: 'chip-input' }, chips, input);
    let dl = null;
    if (suggestions.length) {
        const id = 'dl' + Math.random().toString(36).slice(2);
        dl = h('datalist', { id }, suggestions.map((s) => h('option', { value: s })));
        input.setAttribute('list', id);
    }
    const render = () => {
        clear(chips);
        values.forEach((v, i) => chips.appendChild(h('span', { class: 'chip' }, v, h('button', { type: 'button', 'aria-label': `Remove ${v}`, onclick: () => { values.splice(i, 1); render(); } }, icon('x', 12)))));
    };
    const add = () => {
        const pending = input.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).map(normalize);
        // Validate the whole entry before changing the chips. A rejected later token
        // must not leave an earlier token hidden in the values sent to Headscale.
        for (const p of pending) {
            const e = validate(p);
            if (e) {
                err.textContent = e;
                return false;
            }
        }
        for (const p of pending) {
            if (!values.includes(p))
                values.push(p);
        }
        input.value = '';
        err.textContent = '';
        render();
        return true;
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
            if (input.value.trim()) {
                e.preventDefault();
                add();
            }
        }
        else if (e.key === 'Backspace' && !input.value && values.length) {
            values.pop();
            render();
        }
    });
    input.addEventListener('blur', () => { if (input.value.trim())
        add(); });
    wrap.addEventListener('click', () => input.focus());
    render();
    return {
        el: h('div', wrap, dl, err),
        get() { if (input.value.trim() && !add())
            throw new Error(err.textContent || 'Invalid value'); return [...values]; },
    };
}
export function tabs(items, active, onChange) {
    const el = h('div', { class: 'tabs', role: 'tablist' });
    const render = (cur) => {
        clear(el);
        for (const it of items) {
            el.appendChild(h('button', {
                class: `tab${it.id === cur ? ' active' : ''}`, role: 'tab', type: 'button', 'aria-selected': it.id === cur ? 'true' : 'false',
                onclick: () => { render(it.id); onChange(it.id); },
            }, it.icon ? icon(it.icon, 14) : null, it.label, it.count != null ? h('span', { class: 'tab-count' }, it.count) : null));
        }
    };
    render(active);
    return el;
}
export const codeBlock = (text, { lang, wrap } = {}) => h('div', { class: `codeblock${wrap ? ' codeblock-wrap' : ''}` }, h('pre', h('code', { 'data-lang': lang }, text)), h('div', { class: 'codeblock-copy' }, copyButton(text)));
export const kv = (rows) => h('dl', { class: 'kv' }, rows.filter((r) => !!r).map(([k, v]) => [h('dt', k), h('dd', v ?? '—')]));
//# sourceMappingURL=ui.js.map