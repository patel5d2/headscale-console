// Browser SSH. A Tailscale client compiled to WebAssembly (Tailscale's tsconnect, as
// packaged by Headplane — see scripts/build-ssh.sh) joins the tailnet as a temporary,
// ephemeral machine owned by the chosen Headscale user, then opens a Tailscale SSH
// session drawn by xterm.js. Its control connection goes through this console's
// server (/key, /ts2021), so it only ever talks to the locked Headscale server.
import { h, put, button, callout, clear, spinner, errorState, statusDot, codeBlock } from '../ui.js';
import { nodeName, nodeIPv4, userLabel, store } from '../util.js';
import { serverUrl } from './actions.js';

const NODE_PREFIX = 'hsconsole-ssh-';
const STATE_TEXT = { NoState: 'Starting the SSH client…', NeedsLogin: 'Joining the tailnet…', Starting: 'Connecting to the tailnet…', Running: 'Connected to the tailnet' };

// One Tailscale client per page load: the WebAssembly module can't run two.
let client = null; // { ipn, userId, hostname, netmap, ready }

const loadScript = (src) => new Promise((resolve, reject) => {
  if (document.querySelector(`script[src="${src}"]`)) return resolve();
  document.head.appendChild(h('script', { src, onload: resolve, onerror: () => reject(new Error(`Could not load ${src}`)) }));
});

// Machines left behind by earlier sessions (closed tabs). Ephemeral nodes expire on
// their own, but removing offline ones right away keeps the machine list clean.
async function removeStaleNodes(ctx) {
  const nodes = await ctx.api.listNodes().catch(() => []);
  await Promise.all(nodes
    .filter((n) => n.givenName?.startsWith(NODE_PREFIX) && n.preAuthKey?.ephemeral && !n.online)
    .map((n) => ctx.api.deleteNode(n.id).catch(() => {})));
}

async function startClient(ctx, userId, progress) {
  progress('Loading the SSH client (about 7 MB)…');
  await Promise.all([loadScript('ssh/wasm_exec.js'), loadScript('vendor/xterm/xterm.js'), loadScript('vendor/xterm/addon-fit.js')]);
  if (!document.querySelector('link[href="vendor/xterm/xterm.css"]')) document.head.appendChild(h('link', { rel: 'stylesheet', href: 'vendor/xterm/xterm.css' }));
  const go = new window.Go();
  const { instance } = await WebAssembly.instantiateStreaming(fetch('ssh/hp_ssh.wasm'), go.importObject);
  // Defines window.newIPN and parks forever; returning means the Go runtime died.
  go.run(instance).then(() => { client = null; });

  await removeStaleNodes(ctx);
  progress('Creating a single-use key…');
  const key = await ctx.api.createPreAuthKey({
    user: userId, reusable: false, ephemeral: true, expiration: new Date(Date.now() + 5 * 60000).toISOString(),
  });
  const hostname = NODE_PREFIX + Math.random().toString(36).slice(2, 8);
  const ipn = window.newIPN({ controlURL: location.origin, authKey: key.key, hostname });
  const c = { ipn, userId: String(userId), hostname, netmap: null, state: 'NoState' };
  let loginStarted = false;
  c.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out joining the tailnet.')), 60000);
    const fail = (msg) => { clearTimeout(timer); reject(new Error(msg)); };
    const check = () => { if (c.state === 'Running' && c.netmap) { clearTimeout(timer); resolve(c); } };
    ipn.run({
      notifyState: (s) => {
        c.state = s;
        progress(STATE_TEXT[s] || s);
        // The client waits at NeedsLogin until login starts; with an auth key set,
        // login() uses the key instead of an interactive flow.
        if (s === 'NeedsLogin' && !loginStarted) { loginStarted = true; ipn.login(); }
        if (s === 'NeedsMachineAuth') fail('Headscale is holding the temporary machine for approval.');
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
  c.nodeId = (await ctx.api.listNodes().catch(() => [])).find((x) => x.givenName === hostname)?.id;
  if (c.nodeId) {
    addEventListener('pagehide', () => fetch(`proxy/api/v1/node/${encodeURIComponent(c.nodeId)}`, {
      method: 'DELETE', keepalive: true,
      headers: { Authorization: `Bearer ${ctx.api.key}`, ...(ctx.api.url ? { 'X-Headscale-Url': ctx.api.url } : {}) },
    }), { once: true });
  }
  return c;
}

export async function render(ctx, { id }, root) {
  if (!ctx.config.browserSsh) { root.append(setupHelp(ctx)); return; }
  root.append(h('div', { class: 'center pad-y' }, spinner(24)));
  let n;
  try {
    const [node] = await Promise.all([ctx.api.getNode(id), ctx.load()]);
    n = node;
  } catch (e) { clear(root).append(errorState(e)); return; }
  const users = ctx.data.users || [];
  const ip = nodeIPv4(n);

  const linuxUser = h('input', { class: 'input mono', value: store.get(`ssh.user.${n.id}`, 'root'), spellcheck: 'false', 'aria-label': 'Linux user' });
  const asUser = h('select', { class: 'input', 'aria-label': 'Connect as Headscale user' },
    users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(client?.userId ?? store.get('ssh.as', n.user?.id ?? users[0]?.id)) }, userLabel(u))));
  const connectBtn = button('Connect', { variant: 'primary', icon: 'terminal' });
  const status = h('div', { class: 'muted small ssh-status' });
  const notice = h('div');
  const termEl = h('div', { class: 'ssh-term', hidden: true });

  clear(root).append(
    h('div', { class: 'page-head' },
      h('div', h('h1', 'SSH to ', nodeName(n)),
        h('p', { class: 'muted' }, statusDot(n.online), ' ', ip || 'No IPv4 address',
          ' · ', h('a', { href: `#/machines/${n.id}` }, 'Machine details')))),
    h('div', { class: 'toolbar' },
      h('label', { class: 'inline-label' }, 'Linux user', linuxUser),
      h('label', { class: 'inline-label' }, 'Connect as', asUser),
      connectBtn, status),
    notice, termEl,
    h('p', { class: 'help mt-2' }, 'The browser joins your tailnet as a temporary machine owned by the user above, so your policy\'s ',
      h('code', 'ssh'), ' rules decide whether it may log in. The machine needs Tailscale SSH (', h('code', 'tailscale set --ssh'), ').'));

  let session = null;
  let term = null;
  const resize = new ResizeObserver(() => term?._fit.fit());

  function endSession() {
    try { session?.close(); } catch { /* already closed */ }
    session = null;
    connectBtn.disabled = false;
  }

  connectBtn.addEventListener('click', async () => {
    clear(notice);
    if (!ip) { notice.append(callout('error', null, 'This machine has no IPv4 address.')); return; }
    if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(linuxUser.value.trim())) { notice.append(callout('error', null, 'Enter a valid Linux user name.')); return; }
    if (client && client.userId !== asUser.value) {
      notice.append(callout('info', 'Reload to switch users',
        h('span', 'This page is already on the tailnet as another user. ', button('Reload page', { size: 'sm', onClick: () => location.reload() }))));
      return;
    }
    store.set(`ssh.user.${n.id}`, linuxUser.value.trim());
    store.set('ssh.as', asUser.value);
    endSession();
    connectBtn.disabled = true;
    try {
      const c = client ? await client.ready : await startClient(ctx, asUser.value, (m) => { status.textContent = m; });
      const peer = (c.netmap.peers || []).find((p) => (p.addresses || []).includes(ip));
      if (!peer) throw new Error('This machine isn\'t visible to that user. Your access policy must allow the user to reach it on port 22.');
      if (!peer.tailscaleSSHEnabled) throw new Error('Tailscale SSH isn\'t turned on for this machine. Run "sudo tailscale set --ssh" on it.');
      openTerminal(c);
    } catch (e) {
      connectBtn.disabled = false;
      status.textContent = '';
      notice.append(callout('error', 'Could not connect', e.message));
    }
  });

  function openTerminal(c) {
    term?.dispose();
    termEl.hidden = false;
    term = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#0b0d10' } });
    term._fit = new window.FitAddon.FitAddon();
    term.loadAddon(term._fit);
    term.open(termEl);
    term._fit.fit();
    resize.observe(termEl);
    session = c.ipn.ssh(ip, linuxUser.value.trim(), {
      writeFn: (s) => term.write(s),
      writeErrorFn: (s) => term.write(`\x1b[31m${s}\x1b[0m`),
      setReadFn: (fn) => term.onData(fn),
      rows: term.rows,
      cols: term.cols,
      termType: 'xterm-256color',
      timeoutSeconds: 30,
      onConnectionProgress: (m) => { status.textContent = m; },
      onConnected: () => { status.textContent = `Connected as ${linuxUser.value.trim()}`; term.focus(); },
      onDone: () => { status.textContent = 'Session ended'; endSession(); },
    });
    term.onResize(({ rows, cols }) => session?.resize(rows, cols));
  }

  return () => { endSession(); resize.disconnect(); term?.dispose(); };
}

function setupHelp(ctx) {
  return put(h('div', { class: 'stack' }),
    h('div', { class: 'page-head' }, h('div', h('h1', 'Browser SSH'))),
    callout('info', 'Browser SSH is not enabled on this console',
      'It needs the console locked to your Headscale server (HEADSCALE_URL) and the SSH client built into the image. The default Docker build includes it.'),
    !ctx.config.lockedUrl ? codeBlock(`# docker-compose.yml → environment:\nHEADSCALE_URL: "${serverUrl(ctx) || 'https://headscale.example.com'}"`) : null,
    h('p', { class: 'help' }, 'Without Docker, build the client once (needs Go):'),
    codeBlock('scripts/build-ssh.sh'));
}
