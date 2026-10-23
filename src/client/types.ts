// The app context every page receives.
import type { ConsoleAPI } from './api.js';
import type { Node, User, VersionInfo } from '../shared/types.js';

export interface ConsoleConfig {
  lockedUrl: string | null;
  allowedHosts: string[];
  insecureTls?: boolean;
  hostActions?: boolean;
  browserSsh?: boolean;
  auditLog?: boolean;
  /** PUBLIC_URL: the console's address as devices reach it. */
  publicUrl?: string | null;
}

export interface Conn { url: string; key: string; remember?: boolean }

export interface AppCtx {
  config: ConsoleConfig;
  api: ConsoleAPI | null;
  conn: Conn | null;
  server: { version: VersionInfo | null };
  data: { users: User[] | null; nodes: Node[] | null; loadedAt: number };
  prefs: { baseDomain: string };
  loginError?: string;
  load(force?: boolean): Promise<{ users: User[]; nodes: Node[] }>;
  invalidate(): void;
  navigate(hash: string): void;
  rerender(): void;
  disconnect(expired?: boolean): void;
  connect(conn: Conn): Promise<void>;
}

/** What a signed-in page sees: the API client is always there. */
export type Ctx = AppCtx & { api: ConsoleAPI };

/** A page renders into `root` and may return a cleanup function. */
export type PageRender = (ctx: Ctx, params: Record<string, string | undefined>, root: HTMLElement) => Promise<void | (() => void)> | void | (() => void);
