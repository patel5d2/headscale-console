// Policy starting points (whole-file templates) and rule snippets that merge
// into an existing policy.
import type { Policy } from './types.js';

export interface Template { name: string; desc: string; text: string }
export interface Snippet { name: string; desc: string; make: (admin: string) => Policy }

export const TEMPLATES: Record<string, Template> = {
  allowAll: {
    name: 'Allow all',
    desc: 'Every device can reach every other device. Same as having no policy.',
    text: `// Access control policy for your tailnet.
// Docs: https://headscale.net/stable/ref/acls/
{
  "acls": [
    // Allow all connections.
    { "action": "accept", "src": ["*"], "dst": ["*:*"] },
  ],
  "ssh": [
    // Allow users to SSH into their own devices (in check mode).
    {
      "action": "check",
      "src": ["autogroup:member"],
      "dst": ["autogroup:self"],
      "users": ["autogroup:nonroot", "root"],
    },
  ],
}
`,
  },
  homelab: {
    name: 'Homelab',
    desc: 'Admins reach everything; members reach their own devices and tagged services.',
    text: `// Homelab policy: admins can reach everything, everyone else can reach
// their own devices plus shared services tagged tag:service.
{
  "groups": {
    "group:admins": ["admin@"],
  },

  "tagOwners": {
    "tag:server": ["group:admins"],
    "tag:service": ["group:admins"],
    "tag:exit": ["group:admins"],
  },

  "hosts": {
    "home-lan": "192.168.0.0/24",
  },

  "acls": [
    // Admins can reach every device and the home LAN.
    { "action": "accept", "src": ["group:admins"], "dst": ["*:*", "home-lan:*"] },

    // Everyone can reach their own devices.
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:self:*"] },

    // Everyone can use shared web services.
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:service:80,443"] },

    // Everyone may use exit nodes.
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:internet:*"] },
  ],

  "autoApprovers": {
    "routes": {
      "192.168.0.0/24": ["group:admins"],
    },
    "exitNode": ["tag:exit"],
  },

  "ssh": [
    {
      "action": "accept",
      "src": ["group:admins"],
      "dst": ["tag:server"],
      "users": ["root", "autogroup:nonroot"],
    },
  ],
}
`,
  },
  isolated: {
    name: 'Isolated users',
    desc: 'Users can only reach their own devices. Nothing is shared by default.',
    text: `// Each user can only talk to their own devices.
{
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:self:*"] },
  ],
}
`,
  },
};

// Rule snippets. `admin` is a policy user reference ("alice@") for the first user.
const ADMINS = (admin: string): Policy => ({ groups: { 'group:admins': [admin] } });
export const SNIPPETS: Snippet[] = [
  {
    name: 'Admins can reach everything',
    desc: 'Creates group:admins (with the first user) and lets it reach every device and port.',
    make: (admin) => ({ ...ADMINS(admin), acls: [{ action: 'accept', src: ['group:admins'], dst: ['*:*'] }] }),
  },
  {
    name: 'Users reach their own devices',
    desc: 'Every user can connect to the devices they own.',
    make: () => ({ acls: [{ action: 'accept', src: ['autogroup:member'], dst: ['autogroup:self:*'] }] }),
  },
  {
    name: 'Everyone may use exit nodes',
    desc: 'Lets users route internet traffic through approved exit nodes.',
    make: () => ({ acls: [{ action: 'accept', src: ['autogroup:member'], dst: ['autogroup:internet:*'] }] }),
  },
  {
    name: 'Shared web services',
    desc: 'Everyone can reach devices tagged tag:web on ports 80 and 443.',
    make: (admin) => ({
      ...ADMINS(admin), tagOwners: { 'tag:web': ['group:admins'] },
      acls: [{ action: 'accept', src: ['autogroup:member'], dst: ['tag:web:80,443'] }],
    }),
  },
  {
    name: 'Shared DNS server',
    desc: 'Everyone can query devices tagged tag:dns on port 53 (e.g. Pi-hole, AdGuard).',
    make: (admin) => ({
      ...ADMINS(admin), tagOwners: { 'tag:dns': ['group:admins'] },
      acls: [{ action: 'accept', src: ['autogroup:member'], dst: ['tag:dns:53'] }],
    }),
  },
  {
    name: 'Admins SSH into servers',
    desc: 'group:admins can use Tailscale SSH (as root or any user) on devices tagged tag:server.',
    make: (admin) => ({
      ...ADMINS(admin), tagOwners: { 'tag:server': ['group:admins'] },
      acls: [{ action: 'accept', src: ['group:admins'], dst: ['tag:server:22'] }],
      ssh: [{ action: 'accept', src: ['group:admins'], dst: ['tag:server'], users: ['root', 'autogroup:nonroot'] }],
    }),
  },
  {
    name: 'SSH into your own devices',
    desc: 'Users can Tailscale SSH into their own devices, re-confirming their login (check mode).',
    make: () => ({
      acls: [{ action: 'accept', src: ['autogroup:member'], dst: ['autogroup:self:22'] }],
      ssh: [{ action: 'check', src: ['autogroup:member'], dst: ['autogroup:self'], users: ['autogroup:nonroot', 'root'] }],
    }),
  },
  {
    name: 'Ping between all devices',
    desc: 'Allows ICMP everywhere so devices can always ping each other for troubleshooting.',
    make: () => ({ acls: [{ action: 'accept', src: ['*'], proto: 'icmp', dst: ['*:*'] }] }),
  },
  {
    name: 'Auto-approve a subnet router',
    desc: 'Devices tagged tag:router get 192.168.1.0/24 approved automatically; admins can reach it. Edit the subnet.',
    make: (admin) => ({
      ...ADMINS(admin), tagOwners: { 'tag:router': ['group:admins'] },
      autoApprovers: { routes: { '192.168.1.0/24': ['tag:router'] } },
      acls: [{ action: 'accept', src: ['group:admins'], dst: ['192.168.1.0/24:*'] }],
    }),
  },
  {
    name: 'Auto-approve exit nodes',
    desc: 'Devices tagged tag:exit that advertise an exit node are approved automatically.',
    make: (admin) => ({ ...ADMINS(admin), tagOwners: { 'tag:exit': ['group:admins'] }, autoApprovers: { exitNode: ['tag:exit'] } }),
  },
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// Merge `add` into `base`: arrays gain entries they don't already have, objects
// merge key by key, and existing scalar values always win.
function merge(base: unknown, add: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(add)) {
    const seen = new Set(base.map((x) => JSON.stringify(x)));
    return [...base, ...add.filter((x) => !seen.has(JSON.stringify(x)))];
  }
  if (isObj(base) && isObj(add)) {
    const out: Obj = { ...base };
    for (const [k, v] of Object.entries(add)) out[k] = k in base ? merge(base[k], v) : v;
    return out;
  }
  return base === undefined ? add : base;
}

// Like merge(), but a snippet never widens an existing group, tag owner or host:
// those entries are only added when the policy doesn't define them yet.
export function mergePolicy(base: Policy, add: Policy): Policy {
  const safe: Obj = { ...add };
  for (const k of ['groups', 'tagOwners', 'hosts'] as const) {
    const have = base[k];
    const mine = safe[k];
    if (isObj(mine) && isObj(have)) safe[k] = Object.fromEntries(Object.entries(mine).filter(([n]) => !(n in have)));
  }
  return merge(base, safe) as Policy;
}
