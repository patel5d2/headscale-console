// Test stand-in for Go's wasm_exec.js plus Headplane's Tailscale WebAssembly client.
// It exposes the same globals (Go, newIPN) and drives the same callbacks, so the SSH
// page's real code runs end to end. window.__fakeSsh picks a scenario:
//   panic, rejectKey, machineAuth, noPeers, sshDisabled, sshError, exit
/* global window, fetch, WebSocket, location */
window.Go = class Go {
  constructor() { this.importObject = {}; }

  run() {
    const opt = window.__fakeSsh || {};
    window.newIPN = (cfg) => {
      let cb;
      return {
        run(callbacks) {
          cb = callbacks;
          cb.notifyState('NoState');
          if (opt.panic) cb.notifyPanicRecover('boom');
          else cb.notifyState('NeedsLogin');
        },
        async login() {
          if (opt.rejectKey) { cb.notifyBrowseToURL('https://login.example/'); return; }
          if (opt.machineAuth) { cb.notifyState('NeedsMachineAuth'); return; }
          // Same endpoints the real client uses: /key over HTTP, then /ts2021 as a WebSocket.
          await fetch(`/key?v=1&authkey=${encodeURIComponent(cfg.authKey)}&hostname=${encodeURIComponent(cfg.hostname)}`);
          await new Promise((resolve) => {
            const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ts2021?X-Tailscale-Handshake=abc`);
            ws.onmessage = () => { ws.close(); resolve(); };
            ws.onerror = () => resolve();
          });
          cb.notifyState('Starting');
          cb.notifyNetMap(JSON.stringify({
            self: { name: cfg.hostname },
            peers: opt.noPeers ? [] : [{ name: 'laptop', addresses: ['100.64.0.1'], online: true, tailscaleSSHEnabled: !opt.sshDisabled }],
          }));
          cb.notifyState('Running');
        },
        ssh(host, user, term) {
          let open = true;
          setTimeout(() => {
            term.onConnectionProgress('Starting SSH client…');
            if (opt.sshError) { term.writeErrorFn('SSH Connection Error: permission denied\r\n'); open = false; term.onDone(); return; }
            term.setReadFn((s) => term.writeFn(s)); // echo, like a shell would
            term.onConnected();
            term.writeFn(`Welcome ${user}@${host}\n`);
          }, 10);
          return {
            close() { if (open) { open = false; term.onDone(); } return true; },
            resize(rows, cols) { window.__fakeSshSize = [rows, cols]; return true; },
          };
        },
      };
    };
    return opt.exit ? Promise.resolve() : new Promise(() => {}); // Go parks forever
  }
};
