import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLoopLock, pidIsAlive } from "./loop-lock.ts";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "lock-")), "loop.lock");

describe("acquireLoopLock", () => {
  test("a second acquire while the holder is alive fails and names the holder", () => {
    const path = lockPath();
    const now = () => new Date("2026-10-29T10:00:00.000Z");
    const first = acquireLoopLock(path, { pid: 111, now, isAlive: () => true });
    expect(first.ok).toBe(true);
    const second = acquireLoopLock(path, { pid: 222, isAlive: () => true });
    expect(second).toEqual({ ok: false, holder: { pid: 111, startedAt: "2026-10-29T10:00:00.000Z" } });
  });

  test("a lock whose pid is dead is replaced", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 111, startedAt: "2026-10-29T10:00:00.000Z" }));
    const lock = acquireLoopLock(path, { pid: 222, isAlive: () => false });
    expect(lock.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(222);
  });

  test("an unreadable lock is replaced", () => {
    const path = lockPath();
    writeFileSync(path, "not json");
    expect(acquireLoopLock(path, { pid: 222, isAlive: () => true }).ok).toBe(true);
  });

  test("release removes the lock and leaves no temp files", () => {
    const path = lockPath();
    const lock = acquireLoopLock(path, { pid: 111 });
    if (!lock.ok) throw new Error("expected the lock");
    lock.release();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });

  test("release does not delete a lock another pid now holds", () => {
    const path = lockPath();
    const lock = acquireLoopLock(path, { pid: 111, isAlive: () => false });
    if (!lock.ok) throw new Error("expected the lock");
    const other = acquireLoopLock(path, { pid: 222, isAlive: () => false });
    expect(other.ok).toBe(true);
    lock.release();
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(222);
  });

  test("by default our own pid counts as alive and a dead one as stale", () => {
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(pidIsAlive(2 ** 22 + 12345)).toBe(false);
  });
});
