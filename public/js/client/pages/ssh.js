import { button, callout, clear, codeBlock, errorState, h, icon, put, spinner, statusDot } from '../ui.js';
import { copyText, nodeIPv4, nodeName, store, userLabel } from '../util.js';
import { serverUrl } from './actions.js';
const NODE_PREFIX = 'hsconsole-ssh-';
const STATE_TEXT = { NoState: 'Starting the SSH client…', NeedsLogin: 'Joining the tailnet…', Starting: 'Connecting to the tailnet…', Running: 'Connected to the tailnet' };
const LINUX_USER = /^[a-z_][a-z0-9_.-]*\$?$/i;
// One Tailscale client per page load: the WebAssembly module can't run two.
let client = null;
const loadScript = (src) => new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
    }
    document.head.appendChild(h('script', { src, onload: () => resolve(), onerror: () => reject(new Error(`Could not load ${src}`)) }));
});
/** Machines left behind by earlier sessions. Ephemeral nodes expire on their own; this keeps the list clean sooner. */
async function removeStaleNodes(ctx) {
    const nodes = await ctx.api.listNodes().catch(() => []);
    await Promise.all(nodes
        .filter((n) => n.givenName?.startsWith(NODE_PREFIX) && n.preAuthKey?.ephemeral && !n.online)
        .map((n) => ctx.api.deleteNode(n.id).catch(() => undefined)));
}
async function startClient(ctx, userId, progress) {
    progress('Loading the SSH client (about 7 MB)…');
    await Promise.all(['ssh/wasm_exec.js', 'vendor/xterm/xterm.js', 'vendor/xterm/addon-fit.js', 'vendor/xterm/addon-search.js'].map(loadScript));
    if (!document.querySelector('link[href="vendor/xterm/xterm.css"]'))
        document.head.appendChild(h('link', { rel: 'stylesheet', href: 'vendor/xterm/xterm.css' }));
    const go = new window.Go();
    const { instance } = await WebAssembly.instantiateStreaming(fetch('ssh/hp_ssh.wasm'), go.importObject);
    // Defines window.newIPN and parks forever; returning means the Go runtime died.
    void go.run(instance).then(() => { client = null; });
    await removeStaleNodes(ctx);
    progress('Creating a single-use key…');
    const key = await ctx.api.createPreAuthKey({ user: userId, reusable: false, ephemeral: true, expiration: new Date(Date.now() + 5 * 60000).toISOString() });
    const hostname = NODE_PREFIX + Math.random().toString(36).slice(2, 8);
    const ipn = window.newIPN({ controlURL: location.origin, authKey: key.key, hostname });
    let loginStarted = false;
    const c = { ipn, userId, hostname, netmap: null, state: 'NoState' };
    c.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out joining the tailnet.')), 60000);
        const fail = (msg) => { clearTimeout(timer); reject(new Error(msg)); };
        const check = () => { if (c.state === 'Running' && c.netmap) {
            clearTimeout(timer);
            resolve(c);
        } };
        ipn.run({
            notifyState: (s) => {
                c.state = s;
                progress(STATE_TEXT[s] || s);
                // The client waits at NeedsLogin until login starts; with an auth key set, login() uses it.
                if (s === 'NeedsLogin' && !loginStarted) {
                    loginStarted = true;
                    ipn.login();
                }
                if (s === 'NeedsMachineAuth')
                    fail('Headscale is holding the temporary machine for approval.');
                check();
            },
            notifyNetMap: (json) => { c.netmap = JSON.parse(json); check(); },
            notifyBrowseToURL: () => fail('Headscale rejected the temporary key.'), // only asked for when the key is refused
            notifyPanicRecover: (err) => fail(`The SSH client crashed: ${err}`),
        });
    });
    client = c;
    await c.ready;
    // Remove our temporary machine as soon as the page goes away (tab closed or reloaded).
    const nodeId = (await ctx.api.listNodes().catch(() => [])).find((x) => x.givenName === hostname)?.id;
    if (nodeId) {
        c.nodeId = nodeId;
        addEventListener('pagehide', () => void fetch(`proxy/api/v1/node/${encodeURIComponent(nodeId)}`, {
            method: 'DELETE', keepalive: true,
            headers: { Authorization: `Bearer ${ctx.api.key}`, ...(ctx.api.url ? { 'X-Headscale-Url': ctx.api.url } : {}) },
        }), { once: true });
    }
    return c;
}
export async function render(ctx, { id = '' }, root) {
    if (!ctx.config.browserSsh) {
        root.append(setupHelp(ctx));
        return;
    }
    root.append(h('div', { class: 'center pad-y' }, spinner(24)));
    let n;
    try {
        [n] = await Promise.all([ctx.api.getNode(id), ctx.load()]);
    }
    catch (e) {
        clear(root).append(errorState(e));
        return;
    }
    const users = ctx.data.users || [];
    const ip = nodeIPv4(n);
    const tabs = [];
    let active = null;
    let nextId = 1;
    let fontSize = store.get('ssh.fontSize', 13);
    const linuxUser = h('input', { class: 'input mono', value: store.get(`ssh.user.${n.id}`, 'root'), spellcheck: 'false', 'aria-label': 'Linux user' });
    const asUser = h('select', { class: 'input', 'aria-label': 'Connect as Headscale user' }, users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(client?.userId ?? store.get('ssh.as', n.user?.id ?? users[0]?.id)) }, userLabel(u))));
    const connectBtn = button('Connect', { variant: 'primary', icon: 'terminal' });
    const status = h('div', { class: 'muted small ssh-status', role: 'status' });
    const notice = h('div');
    const tabStrip = h('div', { class: 'ssh-tabs', role: 'tablist', hidden: true });
    const termArea = h('div', { class: 'ssh-term', hidden: true });
    const searchInput = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Find in terminal', 'aria-label': 'Find in terminal' });
    const tools = h('div', { class: 'ssh-tools', hidden: true }, button('New tab', { size: 'sm', icon: 'plus', onClick: () => void connect() }), button('Reconnect', { size: 'sm', icon: 'refresh', onClick: () => void reconnect() }), button('Disconnect', { size: 'sm', icon: 'x', onClick: () => active && closeSession(active) }), button('Copy', { size: 'sm', icon: 'copy', title: 'Copy selection (Ctrl+Shift+C)', onClick: () => void copySelection() }), button('Paste', { size: 'sm', icon: 'file', title: 'Paste (Ctrl+Shift+V)', onClick: () => void paste() }), button('A−', { size: 'sm', title: 'Smaller text', onClick: () => setFont(fontSize - 1) }), button('A+', { size: 'sm', title: 'Larger text', onClick: () => setFont(fontSize + 1) }), searchInput, button('Fullscreen', { size: 'sm', icon: 'maximize', onClick: () => void termArea.requestFullscreen?.() }));
    put(clear(root), h('div', { class: 'page-head' }, h('div', h('h1', 'SSH to ', nodeName(n)), h('p', { class: 'muted' }, statusDot(n.online), ' ', ip || 'No IPv4 address', ' · ', h('a', { href: `#/machines/${n.id}` }, 'Machine details')))), h('div', { class: 'toolbar' }, h('label', { class: 'inline-label' }, 'Linux user', linuxUser), h('label', { class: 'inline-label' }, 'Connect as', asUser), connectBtn, status), notice, tools, tabStrip, termArea, h('p', { class: 'help mt-2' }, 'The browser joins your tailnet as a temporary machine owned by the user above, so your policy\'s ', h('code', 'ssh'), ' rules decide whether it may log in. The machine needs Tailscale SSH (', h('code', 'tailscale set --ssh'), ').'));
    const resize = new ResizeObserver(() => active?.fit.fit());
    function renderTabs() {
        clear(tabStrip).append(...tabs.map((t) => h('div', { class: `ssh-tab${t === active ? ' active' : ''}${t.done ? ' done' : ''}`, role: 'tab', 'aria-selected': String(t === active) }, h('button', { type: 'button', class: 'ssh-tab-label', onclick: () => select(t) }, t.label), h('button', { type: 'button', class: 'ssh-tab-x', 'aria-label': `Close ${t.label}`, onclick: () => closeTab(t) }, icon('x', 12)))));
        tabStrip.hidden = tools.hidden = termArea.hidden = !tabs.length;
    }
    function select(t) {
        active = t;
        for (const x of tabs)
            x.el.hidden = x !== t;
        renderTabs();
        t.fit.fit();
        t.term.focus();
    }
    function closeSession(t) {
        try {
            t.session?.close();
        }
        catch { /* already closed */ }
        t.session = null;
    }
    function closeTab(t) {
        closeSession(t);
        t.term.dispose();
        t.el.remove();
        tabs.splice(tabs.indexOf(t), 1);
        if (active === t)
            active = tabs[tabs.length - 1] ?? null;
        if (active)
            select(active);
        else
            renderTabs();
    }
    function setFont(size) {
        fontSize = Math.min(28, Math.max(9, size));
        store.set('ssh.fontSize', fontSize);
        for (const t of tabs) {
            t.term.options.fontSize = fontSize;
            t.fit.fit();
        }
    }
    async function copySelection() {
        const text = active?.term.getSelection();
        if (text && await copyText(text))
            status.textContent = 'Copied selection';
    }
    async function paste() {
        try {
            const text = await navigator.clipboard.readText();
            if (text)
                active?.send?.(text);
        }
        catch {
            status.textContent = 'The browser blocked clipboard access; use Ctrl+Shift+V or your browser\'s paste.';
        }
    }
    searchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !active || !searchInput.value)
            return;
        const found = e.shiftKey ? active.search.findPrevious(searchInput.value) : active.search.findNext(searchInput.value);
        status.textContent = found ? '' : `"${searchInput.value}" not found`;
    });
    /** Opens a session in tab `t`, replacing any previous one. */
    function start(c, t) {
        const user = linuxUser.value.trim();
        t.done = false;
        t.term.write(`\x1b[90mConnecting to ${user}@${nodeName(n)}…\x1b[0m\r\n`);
        t.session = c.ipn.ssh(ip, user, {
            writeFn: (s) => t.term.write(s),
            writeErrorFn: (s) => t.term.write(`\x1b[31m${s}\x1b[0m`),
            setReadFn: (fn) => { t.send = fn; },
            rows: t.term.rows,
            cols: t.term.cols,
            termType: 'xterm-256color',
            timeoutSeconds: 30,
            onConnectionProgress: (m) => { if (t === active)
                status.textContent = m; },
            onConnected: () => { if (t === active) {
                status.textContent = `Connected as ${user}`;
                t.term.focus();
            } },
            onDone: () => {
                t.done = true;
                t.session = null;
                t.term.write('\r\n\x1b[90m[Session ended — use Reconnect to start again]\x1b[0m\r\n');
                if (t === active)
                    status.textContent = 'Session ended';
                renderTabs();
            },
        });
        renderTabs();
    }
    function newTab(c) {
        const el = h('div', { class: 'ssh-pane' });
        termArea.appendChild(el);
        const term = new window.Terminal({ cursorBlink: true, fontSize, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#0b0d10' } });
        const fit = new window.FitAddon.FitAddon();
        const search = new window.SearchAddon.SearchAddon();
        term.loadAddon(fit);
        term.loadAddon(search);
        term.open(el);
        const t = { id: nextId++, label: `${linuxUser.value.trim()}@${nodeName(n)} #${nextId - 1}`, el, term, fit, search, session: null, send: null, done: false };
        term.onData((s) => t.send?.(s));
        term.onResize(({ rows, cols }) => { t.session?.resize(rows, cols); });
        // Ctrl/Cmd+Shift+C copies and Ctrl/Cmd+Shift+V pastes, like desktop terminals.
        term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown' || !e.shiftKey || !(e.ctrlKey || e.metaKey))
                return true;
            if (e.key.toLowerCase() === 'c') {
                void copySelection();
                return false;
            }
            if (e.key.toLowerCase() === 'v') {
                void paste();
                return false;
            }
            return true;
        });
        tabs.push(t);
        resize.observe(termArea);
        select(t);
        start(c, t);
    }
    async function reconnect() {
        if (!active || !client)
            return;
        closeSession(active);
        start(await client.ready, active);
    }
    async function connect() {
        clear(notice);
        if (!ip) {
            notice.append(callout('error', null, 'This machine has no IPv4 address.'));
            return;
        }
        if (!LINUX_USER.test(linuxUser.value.trim())) {
            notice.append(callout('error', null, 'Enter a valid Linux user name.'));
            return;
        }
        if (client && client.userId !== asUser.value) {
            notice.append(callout('info', 'Reload to switch users', h('span', 'This page is already on the tailnet as another user. ', button('Reload page', { size: 'sm', onClick: () => location.reload() }))));
            return;
        }
        store.set(`ssh.user.${n.id}`, linuxUser.value.trim());
        store.set('ssh.as', asUser.value);
        connectBtn.disabled = true;
        try {
            const c = client ? await client.ready : await startClient(ctx, asUser.value, (m) => { status.textContent = m; });
            const peer = (c.netmap?.peers || []).find((p) => (p.addresses || []).includes(ip));
            if (!peer)
                throw new Error('This machine isn\'t visible to that user. Your access policy must allow the user to reach it on port 22.');
            if (!peer.tailscaleSSHEnabled)
                throw new Error('Tailscale SSH isn\'t turned on for this machine. Run "sudo tailscale set --ssh" on it.');
            newTab(c);
        }
        catch (e) {
            status.textContent = '';
            notice.append(callout('error', 'Could not connect', e.message));
        }
        finally {
            connectBtn.disabled = false;
        }
    }
    connectBtn.addEventListener('click', () => void connect());
    return () => { for (const t of [...tabs])
        closeTab(t); resize.disconnect(); };
}
function setupHelp(ctx) {
    return put(h('div', { class: 'stack' }), h('div', { class: 'page-head' }, h('div', h('h1', 'Browser SSH'))), callout('info', 'Browser SSH is not enabled on this console', 'It needs the console locked to your Headscale server (HEADSCALE_URL) and the SSH client built into the image. The default Docker build includes it.'), !ctx.config.lockedUrl ? codeBlock(`# docker-compose.yml → environment:\nHEADSCALE_URL: "${serverUrl(ctx) || 'https://headscale.example.com'}"`) : null, h('p', { class: 'help' }, 'Without Docker, build the client once (needs Go):'), codeBlock('scripts/build-ssh.sh'));
}
//# sourceMappingURL=ssh.js.map