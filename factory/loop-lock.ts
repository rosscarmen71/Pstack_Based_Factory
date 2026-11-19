// One loop per folder. Two loops review the same PR twice and fight over the git branch, so the loop writes its pid
// to factory/loop.lock on start and a second loop that finds a live pid there refuses to run. A lock whose pid is no
// longer running (the loop was killed) is stale and replaced. Runtime state, gitignored.

import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export const LOOP_LOCK_PATH = new URL("./loop.lock", import.meta.url).pathname;

export interface LockHolder {
  pid: number;
  /** ISO time the holding loop started. */
  startedAt: string;
}

export type LoopLock = { ok: true; release(): void } | { ok: false; holder: LockHolder };

export interface AcquireOptions {
  /** Our pid. Defaults to process.pid. */
  pid?: number;
  now?: () => Date;
  /** Whether a pid is a running process. Defaults to a signal-0 probe. */
  isAlive?: (pid: number) => boolean;
}

/** Signal 0 probes without sending: ESRCH means no such process, EPERM means it exists but belongs to someone else. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's holder, or null when the file is missing or unreadable (an unreadable lock holds nothing). */
function readHolder(path: string): LockHolder | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
    return Number.isInteger(data.pid) && typeof data.startedAt === "string"
      ? { pid: data.pid as number, startedAt: data.startedAt }
      : null;
  } catch {
    return null;
  }
}

const remove = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
};

export function acquireLoopLock(
  path: string = LOOP_LOCK_PATH,
  { pid = process.pid, now = () => new Date(), isAlive = pidIsAlive }: AcquireOptions = {},
): LoopLock {
  const mine: LockHolder = { pid, startedAt: now().toISOString() };
  const tmp = `${path}.${pid}.tmp`;
  // The content is written in full to a temp file, then hard-linked into place: the link fails if a lock exists, so
  // two starters can never both win, and nobody ever reads a half-written lock.
  const tryCreate = (): boolean => {
    writeFileSync(tmp, `${JSON.stringify(mine)}\n`);
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      remove(tmp);
    }
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    if (tryCreate()) {
      return {
        ok: true,
        release() {
          if (readHolder(path)?.pid === pid) remove(path);
        },
      };
    }
    const holder = readHolder(path);
    if (holder && isAlive(holder.pid)) return { ok: false, holder };
    remove(path); // stale or unreadable: replace it
  }
  const holder = readHolder(path);
  if (holder) return { ok: false, holder };
  throw new Error(`could not take the loop lock at ${path}`);
}
