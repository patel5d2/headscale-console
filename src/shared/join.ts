// Builds the commands that join a device to the tailnet: install Tailscale, run
// `tailscale up` against this Headscale server, then check the result. Used by the
// Add device dialog and by `hsconsole join`.

export type JoinOS = 'mac' | 'linux' | 'win' | 'docker' | 'compose';

export const OS_LABELS: Record<JoinOS, string> = {
  mac: 'macOS', linux: 'Linux', win: 'Windows', docker: 'Docker', compose: 'Docker Compose',
};

export interface JoinOptions {
  acceptRoutes?: boolean;
  acceptDns?: boolean;
  exitNode?: boolean;
  routes?: string[];
  hostname?: string;
  ssh?: boolean;
  useExitNode?: string;
  exitLan?: boolean;
  shieldsUp?: boolean;
  operator?: string;
  forceReauth?: boolean;
  qr?: boolean;
  reset?: boolean;
  /** Include the step that installs Tailscale (default true). */
  install?: boolean;
  /** Include a step that shows the result (default true). */
  verify?: boolean;
  /** Where the device sends its Tailscale log (the console's ingest address); see logStep(). */
  logTarget?: string;
}

// The macOS app doesn't put `tailscale` on PATH, so call the bundled CLI directly.
const CLI: Record<'mac' | 'linux' | 'win', string> = {
  mac: 'sudo /Applications/Tailscale.app/Contents/MacOS/Tailscale',
  linux: 'sudo tailscale',
  win: '& "C:\\Program Files\\Tailscale\\tailscale.exe"',
};

const INSTALL: Record<'mac' | 'linux' | 'win', string> = {
  mac: 'curl -fsSLo /tmp/Tailscale.pkg https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg && sudo installer -pkg /tmp/Tailscale.pkg -target /',
  linux: 'curl -fsSL https://tailscale.com/install.sh | sh',
  win: 'winget install --id Tailscale.Tailscale --exact --accept-source-agreements --accept-package-agreements',
};

// tailscaled reads TS_LOG_TARGET from a per-platform environment file at start-up, then
// uploads its log there instead of to Tailscale. Only plain URLs are accepted, so the
// value needs no quoting in any of the shells below.
const LOG_TARGET_RE = /^https?:\/\/[A-Za-z0-9.:[\]_/-]+$/;
const MAC_ENV_DIRS = [
  '/private/var/root/Library/Containers/io.tailscale.ipn.macsys.network-extension/Data', // standalone app
  '"$1/Library/Containers/io.tailscale.ipn.macos.network-extension/Data"', // App Store app
];

/** The step that points a device's Tailscale log at the console, or '' if there's no valid target. */
export function logStep(os: JoinOS, target: string | undefined): string {
  if (!target || !LOG_TARGET_RE.test(target)) return '';
  const line = `TS_LOG_TARGET=${target}`;
  switch (os) {
    case 'linux':
      return `sudo sh -c "sed -i '/^TS_LOG_TARGET=/d' /etc/default/tailscaled 2>/dev/null; echo ${line} >> /etc/default/tailscaled" && sudo systemctl restart tailscaled`;
    case 'mac':
      return `sudo sh -c 'for d in ${MAC_ENV_DIRS.join(' ')}; do [ -d "$d" ] || continue; sed -i "" "/^TS_LOG_TARGET=/d" "$d/tailscaled-env.txt" 2>/dev/null; echo ${line} >> "$d/tailscaled-env.txt"; done; killall io.tailscale.ipn.macsys.network-extension io.tailscale.ipn.macos.network-extension 2>/dev/null; sleep 3; true' _ "$HOME"`;
    case 'win':
      return `$f = "$env:ProgramData\\Tailscale\\tailscaled-env.txt"; @(Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '^TS_LOG_TARGET=' }) + '${line}' | Set-Content $f; Restart-Service Tailscale`;
    default:
      return line; // docker / compose: an environment variable of the container
  }
}

/** POSIX shell quoting: plain words stay as they are, anything else is single-quoted. */
export const shq = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** PowerShell quoting. */
export const psq = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

/** `tailscale up` flags shared by every platform. Values are quoted by the caller's `quote`. */
export function upFlags(url: string, key: string | undefined, tags: string[], o: JoinOptions, quote = shq): string[] {
  const flag = (name: string, v: string): string => `--${name}=${quote(v)}`;
  return [
    key ? flag('auth-key', key) : '',
    flag('login-server', url),
    o.acceptRoutes ? '--accept-routes' : '',
    o.acceptDns === false ? '--accept-dns=false' : '',
    o.exitNode ? '--advertise-exit-node' : '',
    o.routes?.length ? flag('advertise-routes', o.routes.join(',')) : '',
    tags.length ? flag('advertise-tags', tags.join(',')) : '',
    o.hostname ? flag('hostname', o.hostname) : '',
    o.ssh ? '--ssh' : '',
    o.useExitNode ? flag('exit-node', o.useExitNode) : '',
    o.useExitNode && o.exitLan ? '--exit-node-allow-lan-access' : '',
    o.shieldsUp ? '--shields-up' : '',
    o.operator ? flag('operator', o.operator) : '',
    o.forceReauth ? '--force-reauth' : '',
    o.qr ? '--qr' : '',
    o.reset ? '--reset' : '',
  ].filter(Boolean);
}

/** The full set of steps for one platform, one command per line. */
export function joinCommand(os: JoinOS, url: string, key: string | undefined, tags: string[] = [], o: JoinOptions = {}): string {
  if (os === 'docker' || os === 'compose') {
    const extra = upFlags(url, undefined, tags, o, (s) => s).join(' ');
    if (os === 'docker') {
      return [
        'docker run -d --name tailscaled --restart unless-stopped --cap-add NET_ADMIN --device /dev/net/tun \\',
        key ? `  -e TS_AUTHKEY=${shq(key)} \\` : '',
        logStep(os, o.logTarget) ? `  -e ${logStep(os, o.logTarget)} \\` : '',
        `  -e TS_EXTRA_ARGS=${shq(extra)} \\`,
        '  -e TS_STATE_DIR=/var/lib/tailscale -v tailscale-state:/var/lib/tailscale \\',
        '  tailscale/tailscale:latest',
        o.verify === false ? '' : 'docker exec tailscaled tailscale status',
      ].filter(Boolean).join('\n');
    }
    return [
      'services:',
      '  tailscale:',
      '    image: tailscale/tailscale:latest',
      '    restart: unless-stopped',
      '    cap_add: [NET_ADMIN]',
      '    devices: [/dev/net/tun]',
      '    environment:',
      key ? `      TS_AUTHKEY: ${JSON.stringify(key)}` : '',
      logStep(os, o.logTarget) ? `      TS_LOG_TARGET: ${JSON.stringify(o.logTarget)}` : '',
      `      TS_EXTRA_ARGS: ${JSON.stringify(extra)}`,
      '      TS_STATE_DIR: /var/lib/tailscale',
      '    volumes:',
      '      - tailscale-state:/var/lib/tailscale',
      'volumes:',
      '  tailscale-state: {}',
    ].filter(Boolean).join('\n');
  }
  const quote = os === 'win' ? psq : shq;
  const flags = upFlags(url, key, tags, o, quote);
  if (os === 'win') flags.push('--unattended');
  return [
    o.install === false ? '' : INSTALL[os],
    logStep(os, o.logTarget),
    `${CLI[os]} up ${flags.join(' ')}`,
    o.verify === false ? '' : `${CLI[os]} status`,
  ].filter(Boolean).join('\n');
}

/** A runnable script for download: stops at the first failing step. */
export function joinScript(os: 'mac' | 'linux', url: string, key: string | undefined, tags: string[] = [], o: JoinOptions = {}): string {
  return `#!/bin/sh\n# Joins this device to ${url.replace(/[\r\n]+/g, ' ')}\nset -eu\n${joinCommand(os, url, key, tags, o)}\n`;
}
