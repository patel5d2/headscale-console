/**
 * Runs first (see server.ts). Started as root, which only the "host" image does so it can
 * read the host's journal, the server immediately becomes the unprivileged RUN_AS user
 * (default 1000, "node"), keeping just one extra group: the one that owns the mounted
 * journal. Nothing else ever runs as root. Needs only CAP_SETUID and CAP_SETGID.
 */
import fs from 'node:fs';

/** The group that may read the journal at `dir`, or null when it isn't mounted. */
export function journalGroup(dir = '/var/log/journal'): number | null {
  for (const d of [dir, '/run/log/journal']) {
    try {
      const st = fs.statSync(d);
      if (st.isDirectory() && st.gid !== 0) return st.gid;
    } catch { /* not mounted */ }
  }
  return null;
}

/** Switches from root to `uid` with `extraGroup` (if any); a no-op unless running as root. */
export function dropPrivileges(uid: number, extraGroup: number | null): void {
  if (process.getuid?.() !== 0) return; // not root (or Windows): nothing to drop
  try {
    process.setgroups!(extraGroup === null ? [] : [extraGroup]);
    process.setgid!(uid);
    process.setuid!(uid);
  } catch (e) {
    // Never carry on as root.
    throw new Error(`Started as root but could not switch to user ${uid} (${(e as Error).message}). In Docker, keep cap_add: [SETUID, SETGID] (see docker-compose.full.yml).`);
  }
}

const RUN_AS = parseInt(process.env.RUN_AS || '', 10) || 1000;
dropPrivileges(RUN_AS, journalGroup());
