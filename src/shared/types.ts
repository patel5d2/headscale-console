// Headscale REST API shapes (v0.26–0.29, from gen/openapiv2/headscale/v1/headscale.swagger.json).
// Fields are optional where older servers omit them.

export interface User {
  id: string;
  name: string;
  createdAt?: string;
  displayName?: string;
  email?: string;
  providerId?: string;
  provider?: string;
  profilePicUrl?: string;
}

export interface PreAuthKey {
  id?: string;
  user?: User | null;
  key: string;
  reusable?: boolean;
  ephemeral?: boolean;
  used?: boolean;
  expiration?: string;
  createdAt?: string;
  aclTags?: string[];
}

export interface Node {
  id: string;
  machineKey?: string;
  nodeKey?: string;
  discoKey?: string;
  ipAddresses?: string[];
  name?: string;
  givenName?: string;
  user?: User | null;
  lastSeen?: string;
  expiry?: string;
  preAuthKey?: PreAuthKey | null;
  createdAt?: string;
  registerMethod?: string;
  online?: boolean;
  approvedRoutes?: string[];
  availableRoutes?: string[];
  subnetRoutes?: string[];
  tags?: string[];
  /** pre-0.28 servers */
  forcedTags?: string[];
  validTags?: string[];
  invalidTags?: string[];
}

export interface ApiKey {
  id?: string;
  prefix: string;
  expiration?: string;
  createdAt?: string;
  lastSeen?: string;
}

export interface PolicyResponse {
  policy?: string;
  updatedAt?: string;
  empty?: boolean;
}

export interface VersionInfo {
  version?: string;
  commit?: string;
  buildTime?: string;
  go?: { version?: string; os?: string; arch?: string };
  dirty?: boolean;
}

export interface Health {
  databaseConnectivity?: boolean;
  error?: string;
}

export interface Release { version: string; publishedAt: string }

/** A loosely-typed parsed policy file (HuJSON). */
export interface Policy {
  groups?: Record<string, string[]>;
  tagOwners?: Record<string, string[]>;
  hosts?: Record<string, string>;
  acls?: AclRule[];
  grants?: Grant[];
  ssh?: SshRule[];
  autoApprovers?: { routes?: Record<string, string[]>; exitNode?: string[] };
  nodeAttrs?: Array<{ target: string[]; attr: string[] }>;
  [k: string]: unknown;
}
export interface AclRule { action?: string; src: string[]; dst: string[]; proto?: string | number }
export interface Grant { src: string[]; dst: string[]; ip?: string[]; app?: Record<string, unknown>; via?: string[] }
export interface SshRule { action?: string; src: string[]; dst: string[]; users: string[]; checkPeriod?: string }
