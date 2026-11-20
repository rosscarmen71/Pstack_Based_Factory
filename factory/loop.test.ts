import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CMD,
  agentCommands,
  agentRunner,
  ALLOWED_TOOLS,
  LOOP_IDLE_MS,
  main,
  PATCH_CMD,
  prRunner,
  readLoopState,
  REVIEW_CMD,
  type LoopState,
  MAX_TASK_ATTEMPTS,
  runLoop,
  USAGE_LIMIT_FALLBACK_MS,
  writeLoopState,
  type PrRunner,
  type RunResult,
  type Runner,
} from "./loop.ts";
import { AGENT_RESULT_SCHEMA, type AgentResult } from "./agent-result.ts";
import type { AuditEntry, AuditStore } from "./audit-log.ts";
import { attemptsStore, MAX_PR_ATTEMPTS, type AttemptsStore } from "./pr-attempts.ts";
import type { PrSource, PullRequest } from "./prs.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import type { Task, TaskStatus } from "./tasks.schema.ts";
import type { TaskStore } from "./tasks.store.ts";
import type { Workspaces } from "./worktrees.ts";

const task = (id: string, status: TaskStatus = "pending", dependencies: string[] = []): Task => ({
  id,
  title: `Task ${id}`,
  description: "d",
  acceptanceCriteria: ["c"],
  dependencies,
  status,
});

/** A lock path in a fresh temp dir, so main never touches the real factory/loop.lock. */
const tempLock = (over: { isAlive?: (pid: number) => boolean } = {}) => ({
  lock: { path: join(mkdtempSync(join(tmpdir(), "loop-lock-")), "loop.lock"), ...over },
});

const PROCESSED: AgentResult = { outcome: "processed" };
const SKIPPED: AgentResult = { outcome: "skipped", reason: "PR is already merged" };

/** A runner result: exit 0 with a processed report unless told otherwise. */
const res = (exitCode = 0, report: AgentResult | null = exitCode === 0 ? PROCESSED : null): RunResult => ({ exitCode, report });

const NOOP_ATTEMPTS: AttemptsStore = {
  get: () => undefined,
  record: () => {},
  exceeded: () => false,
  flagForHuman: async () => {},
  sync: () => {},
  remove: () => false,
};

/** In-memory store that records every status transition. */
function memStore(tasks: Task[]) {
  const history: string[] = [];
  const store: TaskStore = {
    load: () => tasks.map((t) => ({ ...t })),
    setStatus(id, status) {
      tasks.find((t) => t.id === id)!.status = status;
      history.push(`${id}:${status}`);
    },
    update(id, patch) {
      Object.assign(tasks.find((t) => t.id === id)!, patch);
    },
    remove(id) {
      const i = tasks.findIndex((t) => t.id === id);
      if (i < 0) return false;
      tasks.splice(i, 1);
      for (const t of tasks) t.dependencies = t.dependencies.filter((d) => d !== id);
      return true;
    },
    complete(id) {
      tasks.find((t) => t.id === id)!.status = "completed";
    },
  };
  return { store, history, tasks };
}

/**
 * Fake sleep for a loop that polls while agents run. It lets everything already under way settle first; a sleep the
 * loop gave up on (because an agent finished and it polled again) counts for nothing. Sleeps that do complete are
 * the loop's idle polls: they are recorded, and the signal aborts after `after` of them (default: the first).
 */
function fakeSleep(after = 1, onCall: (n: number) => void = () => {}) {
  const controller = new AbortController();
  const calls: number[] = [];
  let latest = 0;
  const sleep = async (ms: number) => {
    const mine = ++latest;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (mine !== latest) return;
    calls.push(ms);
    onCall(calls.length);
    if (calls.length >= after) controller.abort();
  };
  return { sleep, calls, signal: controller.signal };
}

/** One agent at a time, for tests that assert an exact order. */
const ONE_AT_A_TIME = { settings: (): Settings => ({ ...DEFAULT_SETTINGS, agentCap: 1 }) };
const HANDS_OFF = { settings: (): Settings => ({ ...DEFAULT_SETTINGS, defaultMode: "hands-off" }) };

describe("runLoop", () => {
  const ok: Runner = async () => res();

  test("moves a task pending -> in_progress -> pr; its dependent waits for the merge (hands-on)", async () => {
    const { store, history } = memStore([task("B", "pending", ["A"]), task("A")]);
    expect(await runLoop(store, ok, undefined, fakeSleep())).toEqual({ ran: ["A"], stoppedOn: null });
    expect(history).toEqual(["A:in_progress", "A:pr"]);
  });

  test("a dependent starts once its dependency is completed", async () => {
    const { store, history } = memStore([task("B", "pending", ["A"]), task("A", "completed")]);
    expect((await runLoop(store, ok, undefined, fakeSleep())).ran).toEqual(["B"]);
    expect(history).toEqual(["B:in_progress", "B:pr"]);
  });

  test("marks the task in_progress while the runner executes", async () => {
    const { store, tasks } = memStore([task("A")]);
    let seen: TaskStatus | undefined;
    await runLoop(
      store,
      async (t) => {
        seen = tasks.find((x) => x.id === t.id)?.status;
        return res();
      },
      undefined,
      fakeSleep(),
    );
    expect(seen).toBe("in_progress");
  });

  test("passes the picked task to the runner", async () => {
    const { store } = memStore([task("A")]);
    const got: string[] = [];
    await runLoop(store, async (t) => { got.push(t.title); return res(); }, undefined, fakeSleep());
    expect(got).toEqual(["Task A"]);
  });

  test("hands-on: a failed task is parked for the engineer and the others still run", async () => {
    const { store, tasks } = memStore([task("A"), task("B"), task("C")]);
    const run: Runner = async (t) => res(t.id === "B" ? 1 : 0);
    const out = await runLoop(store, run, undefined, fakeSleep());
    expect(out.stoppedOn).toBeNull();
    expect(out.ran.toSorted()).toEqual(["A", "B", "C"]);
    expect(tasks.map((t) => t.status)).toEqual(["pr", "pending", "pr"]);
    expect(tasks[1]).toMatchObject({ attempts: 1, needsYou: "cook failed (exit 1, no result report)" });
  });

  test("a parked task is not started again until its needs-you note is cleared", async () => {
    const { store, tasks } = memStore([task("A")]);
    let runs = 0;
    const run: Runner = async () => {
      runs++;
      return res(runs === 1 ? 1 : 0);
    };
    const s = fakeSleep(3, (n) => {
      if (n === 2) Object.assign(tasks[0]!, { needsYou: undefined, attempts: undefined });
    });
    await runLoop(store, run, undefined, s);
    expect(runs).toBe(2);
    expect(tasks[0]?.status).toBe("pr");
  });

  test("hands-off: a failing task is retried up to the cap, then parked", async () => {
    const { store, tasks } = memStore([task("A")]);
    let runs = 0;
    const logs: string[] = [];
    const run: Runner = async () => {
      runs++;
      return res(1);
    };
    await runLoop(store, run, (m) => logs.push(m), { ...fakeSleep(), ...HANDS_OFF });
    expect(runs).toBe(MAX_TASK_ATTEMPTS);
    expect(MAX_TASK_ATTEMPTS).toBe(3);
    expect(tasks[0]).toMatchObject({ status: "pending", attempts: 3, needsYou: "cook failed (exit 1, no result report)" });
    expect(logs.filter((m) => m.includes("trying again"))).toHaveLength(2);
  });

  test("hands-off: a retry that succeeds clears the attempt count", async () => {
    const { store, tasks } = memStore([task("A")]);
    let runs = 0;
    const run: Runner = async () => res(++runs < 3 ? 1 : 0);
    await runLoop(store, run, undefined, { ...fakeSleep(), ...HANDS_OFF });
    expect(tasks[0]?.status).toBe("pr");
    expect(tasks[0]?.attempts).toBeUndefined();
    expect(tasks[0]?.needsYou).toBeUndefined();
  });

  test("a throwing runner is treated as a failure", async () => {
    const { store, tasks } = memStore([task("A")]);
    const logs: string[] = [];
    const run: Runner = async () => {
      throw new Error("spawn failed");
    };
    expect(await runLoop(store, run, (m) => logs.push(m), fakeSleep())).toEqual({ ran: ["A"], stoppedOn: null });
    expect(tasks[0]?.status).toBe("pending");
    expect(tasks[0]?.needsYou).toContain("failed");
    expect(logs.some((m) => m.includes("spawn failed"))).toBe(true);
  });

  test("does not start dependents of a failed task", async () => {
    const { store, history } = memStore([task("A"), task("B", "pending", ["A"])]);
    await runLoop(store, async () => res(1), undefined, fakeSleep());
    expect(history).toEqual(["A:in_progress", "A:pending"]);
  });

  test("sleeps LOOP_IDLE_MS when no task is ready and returns only once the signal aborts", async () => {
    const { store, history } = memStore([task("A", "completed"), task("B", "pr")]);
    const s = fakeSleep(3);
    expect(await runLoop(store, ok, undefined, s)).toEqual({ ran: [], stoppedOn: null });
    expect(s.calls).toEqual([LOOP_IDLE_MS, LOOP_IDLE_MS, LOOP_IDLE_MS]);
    expect(LOOP_IDLE_MS).toBe(60_000);
    expect(history).toEqual([]);
  });

  test("a task left in progress by a dead loop goes back to pending, is cleaned up and runs again, with no attempt counted", async () => {
    const { store, tasks, history } = memStore([task("A", "in_progress")]);
    const logs: string[] = [];
    const recovered: string[][] = [];
    const out = await runLoop(store, ok, (m) => logs.push(m), { ...fakeSleep(), recover: (orphans) => void recovered.push(orphans.map((t) => t.id)) });
    expect(recovered).toEqual([["A"]]);
    expect(logs.some((m) => m.includes("A was in progress with no agent"))).toBe(true);
    expect(history).toEqual(["A:pending", "A:in_progress", "A:pr"]);
    expect(out.ran).toEqual(["A"]);
    expect(tasks[0]?.attempts).toBeUndefined();
  });

  test("a failing clean-up is logged and the orphan still runs again", async () => {
    const { store, tasks } = memStore([task("A", "in_progress")]);
    const logs: string[] = [];
    await runLoop(store, ok, (m) => logs.push(m), {
      ...fakeSleep(),
      recover: () => {
        throw new Error("git gone");
      },
    });
    expect(logs.some((m) => m.includes("git gone"))).toBe(true);
    expect(tasks[0]?.status).toBe("pr");
  });

  test("picks up a task appended during the idle sleep on the next poll", async () => {
    const { store, tasks, history } = memStore([task("A", "pr")]);
    const s = fakeSleep(2, (n) => {
      if (n === 1) tasks.push(task("B"));
    });
    expect(await runLoop(store, ok, undefined, s)).toEqual({ ran: ["B"], stoppedOn: null });
    expect(history).toEqual(["B:in_progress", "B:pr"]);
    expect(s.calls).toHaveLength(2);
  });

  test("aborting during a sleep returns without waiting for it to finish", async () => {
    const { store } = memStore([]);
    const controller = new AbortController();
    const never = () => new Promise<void>(() => {});
    const loop = runLoop(store, ok, undefined, { sleep: never, signal: controller.signal });
    controller.abort();
    expect(await loop).toEqual({ ran: [], stoppedOn: null });
  });

  test("does not start a task when the signal is already aborted", async () => {
    const { store, history } = memStore([task("A")]);
    const controller = new AbortController();
    controller.abort();
    await runLoop(store, ok, undefined, { signal: controller.signal });
    expect(history).toEqual([]);
  });

  test("picks up tasks appended while the loop runs", async () => {
    const { store, tasks } = memStore([task("A")]);
    const run: Runner = async (t) => {
      if (t.id === "A") tasks.push(task("B"));
      return res();
    };
    expect((await runLoop(store, run, undefined, fakeSleep())).ran).toEqual(["A", "B"]);
  });
});

describe("runLoop PR routing", () => {
  const ok: Runner = async () => res();
  const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    repo: "acme/widgets",
    title: `PR ${number}`,
    branch: `feat/other-${number}`,
    createdAt: "2026-10-29T10:00:00.000Z",
    isDraft: false,
    headSha: `sha${number}`,
    ci: "pass",
    mergeable: "clean",
    reviewDecision: "none",
    labels: [],
    comments: [],
    ...over,
  });
  const stamped = (id: string, createdAt: string): Task => ({ ...task(id), createdAt });

  /** PR source whose list reflects what the fake runner has done: reviewed PRs get approved, patched ones go green. */
  function world(prs: PullRequest[]) {
    const calls: string[] = [];
    const flagged: number[] = [];
    const source: PrSource = { list: async () => prs.map((p) => ({ ...p })) };
    const real = attemptsStore(join(mkdtempSync(join(tmpdir(), "loop-")), "attempts.json"));
    const attempts: AttemptsStore = {
      ...real,
      flagForHuman: async (n) => {
        flagged.push(n);
        await real.flagForHuman(n, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
        const p = prs.find((x) => x.number === n)!;
        p.labels = [...p.labels, "needs-human"];
      },
    };
    return { source, attempts, calls, flagged, prs };
  }

  test("reviews every PR before starting a new task, oldest PR first", async () => {
    const w = world([pr(7, { createdAt: "2026-10-29T10:00:00.000Z" }), pr(9, { createdAt: "2026-10-29T12:00:00.000Z" })]);
    const { store } = memStore([stamped("T1", "2026-10-29T11:00:00.000Z")]);
    const order: string[] = [];
    const run: Runner = async (t) => { order.push(`task ${t.id}`); return res(); };
    const runPr: PrRunner = async (p, a) => { order.push(`${a} ${p.number}`); return res(); };
    await runLoop(store, run, undefined, { ...fakeSleep(), prs: w.source, attempts: w.attempts, runPr });
    expect(order.slice(0, 3)).toEqual(["review 7", "review 9", "task T1"]);
  });

  test("a review and a patch route to their own command with {pr} substituted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-cmd-"));
    const reviewOut = join(dir, "review");
    const patchOut = join(dir, "patch");
    const reviewCmd = ["sh", "-c", `echo "$0" > ${reviewOut}`, "{pr}"];
    const patchCmd = ["sh", "-c", `echo "$0" > ${patchOut}`, "{pr}"];
    const run = prRunner(reviewCmd, patchCmd);
    expect((await run(pr(12), "review")).exitCode).toBe(0);
    expect((await run(pr(34), "patch")).exitCode).toBe(0);
    expect(readFileSync(reviewOut, "utf8").trim()).toBe("12");
    expect(readFileSync(patchOut, "utf8").trim()).toBe("34");
    expect(REVIEW_CMD.some((a) => a.includes("{pr}"))).toBe(true);
    expect(PATCH_CMD.some((a) => a.includes("{pr}"))).toBe(true);
  });

  test("a failed patch does not stop the loop and counts as an attempt", async () => {
    const w = world([pr(5, { ci: "fail" })]);
    const { store } = memStore([task("A")]);
    const s = fakeSleep();
    const runPr: PrRunner = async (p, a) => { w.calls.push(`${a} ${p.number}`); return res(1); };
    const result = await runLoop(store, ok, undefined, { ...s, prs: w.source, attempts: w.attempts, runPr });
    expect(result.stoppedOn).toBeNull();
    expect(w.calls[0]).toBe("patch 5");
    expect(w.attempts.get(5)?.patches).toBeGreaterThanOrEqual(1);
    expect(result.ran).toEqual(["A"]);
  });

  test("a failed review counts as an attempt but leaves the SHA unreviewed so it is retried", async () => {
    const w = world([pr(5)]);
    const { store } = memStore([]);
    const runPr: PrRunner = async (p, a) => { w.calls.push(`${a} ${p.number}`); return res(1); };
    await runLoop(store, ok, undefined, { ...fakeSleep(2), prs: w.source, attempts: w.attempts, runPr });
    expect(w.calls.length).toBeGreaterThan(1);
    expect(w.attempts.get(5)?.reviewedSha).toBeUndefined();
    expect(w.attempts.get(5)?.reviews).toBeGreaterThanOrEqual(2);
  });

  test("a PR reaching the limit is flagged once and never run again", async () => {
    const w = world([pr(5, { ci: "fail" })]);
    const { store } = memStore([]);
    const runPr: PrRunner = async (p, a) => { w.calls.push(`${a} ${p.number}`); return res(1); };
    await runLoop(store, ok, undefined, { ...fakeSleep(2), prs: w.source, attempts: w.attempts, runPr });
    expect(w.calls).toHaveLength(MAX_PR_ATTEMPTS);
    expect(w.flagged).toEqual([5]);
    expect(w.attempts.get(5)?.flagged).toBe(true);
  });

  test("a throwing PrSource still lets a pending task run", async () => {
    const { store, history } = memStore([task("A")]);
    const logs: string[] = [];
    const prs: PrSource = {
      list: async () => {
        throw new Error("gh down");
      },
    };
    const result = await runLoop(store, ok, (m) => logs.push(m), { ...fakeSleep(), prs, attempts: NOOP_ATTEMPTS });
    expect(result.ran).toEqual(["A"]);
    expect(history).toEqual(["A:in_progress", "A:pr"]);
    expect(logs.some((m) => m.includes("gh down"))).toBe(true);
  });

  test("sleeps only when there are no candidates", async () => {
    const w = world([pr(5, { ci: "fail" })]);
    const { store } = memStore([]);
    const runPr: PrRunner = async () => res();
    const s = fakeSleep();
    await runLoop(store, ok, undefined, { ...s, prs: w.source, attempts: w.attempts, runPr });
    // three patch runs, then the limit leaves nothing to do: exactly one sleep
    expect(s.calls).toEqual([LOOP_IDLE_MS]);
  });
});

describe("runLoop audit log", () => {
  const ok: Runner = async () => res();
  const openPr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    repo: "acme/widgets",
    title: `PR ${number}`,
    branch: `feat/other-${number}`,
    createdAt: "2026-10-29T10:00:00.000Z",
    isDraft: false,
    headSha: `sha${number}`,
    ci: "pass",
    mergeable: "clean",
    reviewDecision: "none",
    labels: [],
    comments: [],
    ...over,
  });

  /** Fake store that keeps what it was given; `failWith` makes every write throw. */
  function fakeAudit(failWith?: Error) {
    const entries: AuditEntry[] = [];
    const audit: AuditStore = {
      purge: () => 0,
      record(entry) {
        if (failWith) throw failWith;
        entries.push(entry);
      },
      list: () => entries,
    };
    return { audit, entries };
  }

  test("a successful task records one dev-task/success entry", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, ok, undefined, { ...fakeSleep(), audit });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "dev-task", target: "A", title: "Task A", outcome: "success", exitCode: 0 });
    expect(Number.isNaN(Date.parse(entries[0]!.at))).toBe(false);
  });

  test("measures durationMs around the runner call", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    const slow: Runner = async () => {
      await Bun.sleep(30);
      return res();
    };
    await runLoop(store, slow, undefined, { ...fakeSleep(), audit });
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(25);
  });

  test("a task deleted while its agent ran is neither recorded nor advanced, and the loop carries on", async () => {
    const { store, history } = memStore([task("A"), task("B")]);
    const { audit, entries } = fakeAudit();
    const { sleep, signal } = fakeSleep();
    const logs: string[] = [];
    const run = async (t: Task) => {
      if (t.id === "A") store.remove("A");
      return res(1);
    };
    const out = await runLoop(store, run, (m) => logs.push(m), { sleep, signal, audit, ...ONE_AT_A_TIME });
    expect(logs.some((m) => m.includes("A was deleted while running"))).toBe(true);
    expect(entries.map((e) => e.target)).toEqual(["B"]);
    expect(history).toEqual(["A:in_progress", "B:in_progress", "B:pending"]);
    expect(out.stoppedOn).toBeNull();
  });

  test("a failing task records one dev-task/failure entry", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, async () => res(3), undefined, { ...fakeSleep(), audit });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "dev-task", target: "A", outcome: "failure", exitCode: 3 });
  });

  test("a non-zero exit records failure with reason 'exited with code N'", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, async () => res(3), undefined, { ...fakeSleep(), audit });
    expect(entries[0]).toMatchObject({ outcome: "failure", exitCode: 3, reason: "exited with code 3" });
  });

  test("a successful run records no reason", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, ok, undefined, { ...fakeSleep(), audit });
    expect(entries[0]).not.toHaveProperty("reason");
  });

  test("a thrown runner records no audit entry, logs to the console and is handled as before", async () => {
    const { store, history } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    const logs: string[] = [];
    const boom: Runner = async () => {
      throw new Error("spawn ENOENT");
    };
    const result = await runLoop(store, boom, (m) => logs.push(m), { ...fakeSleep(), audit });
    expect(entries).toEqual([]);
    expect(logs.some((m) => m.includes("runner threw") && m.includes("spawn ENOENT"))).toBe(true);
    expect(result.stoppedOn).toBeNull();
    expect(history).toEqual(["A:in_progress", "A:pending"]);
  });

  /** Lists the given PRs until each has been run once (the loop runs one candidate per poll), then goes idle. */
  const onceSource = (prs: PullRequest[]) => {
    const pending = [...prs];
    const source: PrSource = { list: async () => pending.map((p) => ({ ...p })) };
    const done = (n: number) => void pending.splice(0, pending.length, ...pending.filter((p) => p.number !== n));
    return { source, done };
  };

  test("review and patch runs record review and patch entries", async () => {
    const { source, done } = onceSource([openPr(7), openPr(8, { ci: "fail" })]);
    const { store } = memStore([]);
    const { audit, entries } = fakeAudit();
    const runPr: PrRunner = async (p) => {
      done(p.number);
      return res(p.number === 8 ? 1 : 0);
    };
    await runLoop(store, ok, undefined, { ...fakeSleep(), prs: source, attempts: NOOP_ATTEMPTS, runPr, audit });
    expect(entries).toContainEqual(expect.objectContaining({ action: "review", target: 7, title: "PR 7", outcome: "success", exitCode: 0 }));
    expect(entries).toContainEqual(expect.objectContaining({ action: "patch", target: 8, title: "PR 8", outcome: "failure", exitCode: 1 }));
  });

  test("review and patch entries carry the PR's repo and url", async () => {
    const { source, done } = onceSource([openPr(7), openPr(8, { ci: "fail", repo: "acme/gadgets", url: "https://github.com/acme/gadgets/pull/8" })]);
    const { store } = memStore([]);
    const { audit, entries } = fakeAudit();
    const runPr: PrRunner = async (p) => {
      done(p.number);
      return res();
    };
    await runLoop(store, ok, undefined, { ...fakeSleep(), prs: source, attempts: NOOP_ATTEMPTS, runPr, audit });
    expect(entries.find((e) => e.action === "review")).toMatchObject({ repo: "acme/widgets", url: "https://github.com/acme/widgets/pull/7" });
    expect(entries.find((e) => e.action === "patch")).toMatchObject({ repo: "acme/gadgets", url: "https://github.com/acme/gadgets/pull/8" });
  });

  test("dev-task entries carry neither repo nor url", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, ok, undefined, { ...fakeSleep(), audit });
    expect(entries[0]?.action).toBe("dev-task");
    expect(entries[0]).not.toHaveProperty("repo");
    expect(entries[0]).not.toHaveProperty("url");
  });

  test("a PR run with a non-zero exit records failure with reason 'exited with code N'", async () => {
    const { source, done } = onceSource([openPr(8, { ci: "fail" })]);
    const { store } = memStore([]);
    const { audit, entries } = fakeAudit();
    const runPr: PrRunner = async (p) => {
      done(p.number);
      return res(2);
    };
    await runLoop(store, ok, undefined, { ...fakeSleep(), prs: source, attempts: NOOP_ATTEMPTS, runPr, audit });
    expect(entries[0]).toMatchObject({ action: "patch", outcome: "failure", exitCode: 2, reason: "exited with code 2" });
  });

  test("a PR runner that throws records no audit entry and logs to the console", async () => {
    const { source, done } = onceSource([openPr(7)]);
    const { store } = memStore([]);
    const { audit, entries } = fakeAudit();
    const logs: string[] = [];
    const runPr: PrRunner = async (p) => {
      done(p.number);
      throw new Error("spawn ENOENT");
    };
    await runLoop(store, ok, (m) => logs.push(m), { ...fakeSleep(), prs: source, attempts: NOOP_ATTEMPTS, runPr, audit });
    expect(entries).toEqual([]);
    expect(logs.some((m) => m.includes("PR #7") && m.includes("spawn ENOENT"))).toBe(true);
  });

  test("an audit.record that throws is logged and the loop continues", async () => {
    const { store, history } = memStore([task("A"), task("B")]);
    const { audit } = fakeAudit(new Error("disk full"));
    const logs: string[] = [];
    const result = await runLoop(store, ok, (m) => logs.push(m), { ...fakeSleep(), audit, ...ONE_AT_A_TIME });
    expect(result.ran).toEqual(["A", "B"]);
    expect(history).toEqual(["A:in_progress", "A:pr", "B:in_progress", "B:pr"]);
    expect(logs.some((m) => m.includes("disk full"))).toBe(true);
  });

  test("idle ticks record nothing: only the task run is in the log after three idle polls", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    const s = fakeSleep(3);
    await runLoop(store, ok, undefined, { ...s, audit });
    expect(s.calls).toHaveLength(3);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "dev-task", target: "A" });
  });

  test("main passes the audit option through to the loop", async () => {
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    const processed = JSON.stringify({ result: "ok", structured_output: { outcome: "processed" } });
    await main(store, ["sh", "-c", `printf '%s' "$0"`, processed], { ...fakeSleep(), audit, ...tempLock() });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "dev-task", target: "A", outcome: "success" });
  });
});

describe("runLoop agent result report", () => {
  const openPr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    repo: "acme/widgets",
    title: `PR ${number}`,
    branch: `feat/other-${number}`,
    createdAt: "2026-10-29T10:00:00.000Z",
    isDraft: false,
    headSha: `sha${number}`,
    ci: "pass",
    mergeable: "clean",
    reviewDecision: "none",
    labels: [],
    comments: [],
    ...over,
  });

  function fakeAudit() {
    const entries: AuditEntry[] = [];
    const audit: AuditStore = { record: (e) => void entries.push(e), list: () => entries, purge: () => 0 };
    return { audit, entries };
  }

  /** Lists the PR as-is until it has been run once, then as approved with green CI so nothing is left to do. */
  function onceSource(p: PullRequest) {
    let settled = false;
    const source: PrSource = {
      list: async () => [settled ? { ...p, ci: "pass", reviewDecision: "approved" } : { ...p }],
    };
    return {
      source,
      close: () => {
        settled = true;
      },
    };
  }

  const realAttempts = () => attemptsStore(join(mkdtempSync(join(tmpdir(), "loop-result-")), "attempts.json"));

  test("a processed task goes to pr and records a success entry", async () => {
    const { store, tasks } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, async () => res(0, PROCESSED), undefined, { ...fakeSleep(), audit });
    expect(tasks[0]?.status).toBe("pr");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "dev-task", target: "A", outcome: "success", exitCode: 0 });
  });

  test("a skipped task is parked at once, even hands-off, and records a skip entry with the reason", async () => {
    const { store, tasks, history } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    const logs: string[] = [];
    const out = await runLoop(store, async () => res(0, { outcome: "skipped", reason: "task already done" }), (m) => logs.push(m), {
      ...fakeSleep(),
      audit,
      ...HANDS_OFF,
    });
    expect(out).toEqual({ ran: ["A"], stoppedOn: null });
    expect(history).toEqual(["A:in_progress", "A:pending"]);
    expect(tasks[0]?.needsYou).toBe("cook skipped: task already done");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "dev-task", target: "A", outcome: "skip", reason: "task already done", exitCode: 0 });
    expect(logs.some((m) => m.includes("skipped") && m.includes("task already done"))).toBe(true);
  });

  test("exit 0 with no report is a failure: the task returns to pending and is parked", async () => {
    const { store, tasks } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, async () => res(0, null), undefined, { ...fakeSleep(), audit });
    expect(tasks[0]).toMatchObject({ status: "pending", needsYou: "cook failed (exit 0, no result report)" });
    expect(entries[0]).toMatchObject({ outcome: "failure", exitCode: 0, reason: "agent returned no result report" });
  });

  test("a non-zero exit with a report is still a failure", async () => {
    const { store, tasks } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    await runLoop(store, async () => res(1, PROCESSED), undefined, { ...fakeSleep(), audit });
    expect(tasks[0]).toMatchObject({ status: "pending", needsYou: "cook failed (exit 1)" });
    expect(entries[0]).toMatchObject({ outcome: "failure", exitCode: 1 });
  });

  test("a skipped PR review counts an attempt, marks the SHA handled and records a skip entry", async () => {
    const { source, close } = onceSource(openPr(7));
    const attempts = realAttempts();
    const { store } = memStore([]);
    const { audit, entries } = fakeAudit();
    const runPr: PrRunner = async () => {
      close();
      return res(0, SKIPPED);
    };
    await runLoop(store, async () => res(), undefined, { ...fakeSleep(), prs: source, attempts, runPr, audit });
    expect(attempts.get(7)?.reviews).toBe(1);
    expect(attempts.get(7)?.reviewedSha).toBe("sha7");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "review", target: 7, outcome: "skip", reason: "PR is already merged", exitCode: 0 });
  });

  test("a skipped PR patch counts an attempt and records a skip entry without stopping the loop", async () => {
    const { source, close } = onceSource(openPr(8, { ci: "fail" }));
    const attempts = realAttempts();
    const { store } = memStore([task("A")]);
    const { audit, entries } = fakeAudit();
    const runPr: PrRunner = async () => {
      close();
      return res(0, SKIPPED);
    };
    const out = await runLoop(store, async () => res(), undefined, { ...fakeSleep(), prs: source, attempts, runPr, audit });
    expect(out.stoppedOn).toBeNull();
    expect(attempts.get(8)?.patches).toBe(1);
    expect(entries[0]).toMatchObject({ action: "patch", target: 8, outcome: "skip", reason: "PR is already merged" });
  });

  test("a PR review with exit 0 and no report is a failure: it counts an attempt but leaves the SHA unreviewed", async () => {
    const { source, close } = onceSource(openPr(7));
    const attempts = realAttempts();
    const { store } = memStore([]);
    const { audit, entries } = fakeAudit();
    const runPr: PrRunner = async () => {
      close();
      return res(0, null);
    };
    await runLoop(store, async () => res(), undefined, { ...fakeSleep(), prs: source, attempts, runPr, audit });
    expect(attempts.get(7)?.reviews).toBe(1);
    expect(attempts.get(7)?.reviewedSha).toBeUndefined();
    expect(entries[0]).toMatchObject({ action: "review", outcome: "failure", exitCode: 0, reason: "agent returned no result report" });
  });
});

describe("runLoop scheduler", () => {
  /** A runner whose runs stay open until released, recording how many are open at once. */
  function gated() {
    const open = new Map<string, () => void>();
    let peak = 0;
    const started: string[] = [];
    const run: Runner = (t) =>
      new Promise((resolve) => {
        started.push(t.id);
        open.set(t.id, () => {
          open.delete(t.id);
          resolve(res());
        });
        peak = Math.max(peak, open.size);
      });
    return { run, open, started, peak: () => peak };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const basePr = (number: number): PullRequest => ({
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    repo: "acme/widgets",
    title: `PR ${number}`,
    branch: `feat/x-${number}`,
    createdAt: "2026-10-29T10:00:00.000Z",
    isDraft: false,
    headSha: "sha",
    ci: "pass",
    mergeable: "clean",
    reviewDecision: "none",
    labels: [],
    comments: [],
  });
  /** Attempts that remember the last reviewed SHA, so a finished review is not asked for again. */
  const reviewingAttempts = (): AttemptsStore => {
    const shas: Record<number, string> = {};
    return {
      ...NOOP_ATTEMPTS,
      get: (n) => (shas[n] === undefined ? undefined : { reviews: 1, patches: 0, reviewedSha: shas[n] }),
      record: (n, _kind, sha) => {
        shas[n] = sha;
      },
    };
  };
  function fakeAudit() {
    const entries: AuditEntry[] = [];
    const audit: AuditStore = { record: (e) => void entries.push(e), list: () => entries, purge: () => 0 };
    return { audit, entries };
  }

  test("independent tasks run at the same time, up to the agent cap, and the rest follow as slots free up", async () => {
    const { store, tasks } = memStore(["A", "B", "C", "D", "E"].map((id) => task(id)));
    const g = gated();
    const loop = runLoop(store, g.run, undefined, fakeSleep(1, () => {}));
    await settle();
    expect(g.started).toEqual(["A", "B", "C"]);
    expect(tasks.map((t) => t.status)).toEqual(["in_progress", "in_progress", "in_progress", "pending", "pending"]);
    g.open.get("B")?.();
    await settle();
    expect(g.started).toEqual(["A", "B", "C", "D"]);
    for (let i = 0; i < 5 && g.open.size > 0; i++) {
      for (const release of [...g.open.values()]) release();
      await settle();
    }
    await loop;
    expect(g.peak()).toBe(3);
    expect(tasks.every((t) => t.status === "pr")).toBe(true);
  });

  test("the cap comes from the settings and is re-read on every poll", async () => {
    const { store } = memStore(["A", "B", "C"].map((id) => task(id)));
    const g = gated();
    let cap = 1;
    const loop = runLoop(store, g.run, undefined, { ...fakeSleep(), settings: () => ({ ...DEFAULT_SETTINGS, agentCap: cap }) });
    await settle();
    expect(g.started).toEqual(["A"]);
    cap = 2;
    g.open.get("A")?.();
    await settle();
    expect(g.started).toEqual(["A", "B", "C"]);
    for (const release of [...g.open.values()]) release();
    await loop;
    expect(g.peak()).toBe(2);
  });

  test("a dependent never runs alongside its dependency", async () => {
    const { store } = memStore([task("A"), task("B", "pending", ["A"]), task("C")]);
    const g = gated();
    const loop = runLoop(store, g.run, undefined, fakeSleep());
    await settle();
    expect(g.started).toEqual(["A", "C"]);
    for (const release of [...g.open.values()]) release();
    await loop;
    expect(g.started).toEqual(["A", "C"]);
  });

  test("a PR already being worked on is not started a second time by the next poll", async () => {
    const { store } = memStore([]);
    const source: PrSource = { list: async () => [{ ...basePr(7) }] };
    let runs = 0;
    let release = () => {};
    const runPr: PrRunner = () =>
      new Promise((resolve) => {
        runs++;
        release = () => resolve(res());
      });
    const s = fakeSleep(3, (n) => {
      if (n === 2) release();
    });
    await runLoop(store, async () => res(), undefined, { ...s, prs: source, attempts: reviewingAttempts(), runPr });
    expect(runs).toBe(1);
  });

  test("the loop keeps polling while agents run: a task added meanwhile starts without waiting for them", async () => {
    const { store, tasks } = memStore([task("A")]);
    const g = gated();
    const s = fakeSleep(3, (n) => {
      if (n === 1) tasks.push(task("B"));
      if (n === 2) for (const release of [...g.open.values()]) release();
    });
    await runLoop(store, g.run, undefined, s);
    expect(g.started).toEqual(["A", "B"]);
    expect(g.peak()).toBe(2);
  });

  test("on abort it starts nothing new and waits for the running agents", async () => {
    const { store, tasks } = memStore([task("A"), task("B"), task("C"), task("D")]);
    const g = gated();
    const controller = new AbortController();
    const logs: string[] = [];
    const loop = runLoop(store, g.run, (m) => logs.push(m), { sleep: () => new Promise(() => {}), signal: controller.signal });
    await settle();
    controller.abort();
    await settle();
    let done = false;
    void loop.then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    for (const release of [...g.open.values()]) release();
    await loop;
    expect(g.started).toEqual(["A", "B", "C"]);
    expect(tasks[3]?.status).toBe("pending");
    expect(logs.some((m) => m.includes("waiting for 3 running agent"))).toBe(true);
  });

  test("a usage limit counts no attempt, returns the task to pending and holds every start until it resets", async () => {
    const { store, tasks } = memStore([task("A"), task("B")]);
    const { audit, entries } = fakeAudit();
    let clock = 1_000_000;
    const resetAt = clock + 5 * 60_000;
    const started: string[] = [];
    const states: LoopState[] = [];
    const run: Runner = async (t) => {
      started.push(t.id);
      return started.length === 1 ? { exitCode: 1, report: null, usageLimit: { resetAt } } : res();
    };
    const s = fakeSleep(3, (n) => {
      if (n === 1) expect(started).toEqual(["A"]);
      if (n === 2) clock = resetAt + 1;
    });
    const logs: string[] = [];
    await runLoop(store, run, (m) => logs.push(m), { ...s, audit, now: () => clock, onState: (st) => states.push(st), ...ONE_AT_A_TIME });
    expect(started).toEqual(["A", "A", "B"]);
    expect(tasks.map((t) => [t.status, t.attempts, t.needsYou])).toEqual([
      ["pr", undefined, undefined],
      ["pr", undefined, undefined],
    ]);
    expect(entries.map((e) => e.outcome)).toEqual(["success", "success"]);
    expect(logs.some((m) => m.includes("usage limit reached"))).toBe(true);
    expect(states.some((st) => st.pausedUntil === new Date(resetAt).toISOString())).toBe(true);
    expect(states.at(-1)).toEqual({ running: [] });
  });

  test("a usage limit with no reset time holds starts for the fallback period", async () => {
    const { store } = memStore([task("A")]);
    let clock = 0;
    let runs = 0;
    const run: Runner = async () => (++runs === 1 ? { exitCode: 1, report: null, usageLimit: { resetAt: null } } : res());
    const s = fakeSleep(4, (n) => {
      if (n === 2) clock = USAGE_LIMIT_FALLBACK_MS - 1;
      if (n === 3) clock = USAGE_LIMIT_FALLBACK_MS + 1;
    });
    await runLoop(store, run, undefined, { ...s, now: () => clock });
    expect(runs).toBe(2);
  });

  test("while paused by the engineer nothing starts; un-pausing resumes on the next poll", async () => {
    const { store } = memStore([task("A")]);
    let paused = true;
    const started: string[] = [];
    const s = fakeSleep(3, (n) => {
      if (n === 1) expect(started).toEqual([]);
      if (n === 2) paused = false;
    });
    const run: Runner = async (t) => {
      started.push(t.id);
      return res();
    };
    await runLoop(store, run, undefined, { ...s, settings: () => ({ ...DEFAULT_SETTINGS, paused }) });
    expect(started).toEqual(["A"]);
  });

  test("while the project waits on another project no new task starts, but PR work carries on", async () => {
    const { store, tasks } = memStore([task("A")]);
    const source: PrSource = { list: async () => [{ ...basePr(7) }] };
    let waiting = ["acme/api"];
    const order: string[] = [];
    const states: LoopState[] = [];
    const logs: string[] = [];
    const s = fakeSleep(3, (n) => {
      if (n === 1) {
        expect(order).toEqual(["review 7"]);
        expect(tasks[0]?.status).toBe("pending");
        expect(states.at(-1)?.waitingOnProjects).toEqual(["acme/api"]);
        waiting = [];
      }
    });
    const run: Runner = async (t) => {
      order.push(`cook ${t.id}`);
      return res();
    };
    const runPr: PrRunner = async (p, action) => {
      order.push(`${action} ${p.number}`);
      return res();
    };
    await runLoop(store, run, (m) => logs.push(m), { ...s, prs: source, attempts: reviewingAttempts(), runPr, blockedBy: () => waiting, onState: (st) => states.push(st) });
    expect(order).toEqual(["review 7", "cook A"]);
    expect(logs.filter((m) => m.includes("waiting on project acme/api"))).toHaveLength(1);
    expect(logs.some((m) => m.includes("no longer waiting"))).toBe(true);
    expect(states.at(-1)?.waitingOnProjects).toBeUndefined();
  });

  test("agentCommands adds the extra tools and readable folders to all three commands", () => {
    const c = agentCommands(["Bash(/h/bin/factory *)"], ["/h/projects/acme__api"]);
    for (const cmd of [c.cook, c.review, c.patch]) {
      expect(cmd[cmd.indexOf("--allowedTools") + 1]).toBe([...ALLOWED_TOOLS, "Bash(/h/bin/factory *)"].join(","));
      expect(cmd[cmd.indexOf("--add-dir") + 1]).toBe("/h/projects/acme__api");
    }
    expect(c.cook[2]).toBe("/cook {id}");
    expect(c.patch[2]).toBe("/remake {pr}");
    expect(agentCommands().cook).toEqual(AGENT_CMD);
  });

  test("the published state lists what is running", async () => {
    const { store } = memStore([task("A")]);
    const g = gated();
    const states: LoopState[] = [];
    const loop = runLoop(store, g.run, undefined, { ...fakeSleep(), now: () => 0, onState: (st) => states.push(st) });
    await settle();
    expect(states.at(-1)).toEqual({ running: [{ kind: "dev-task", target: "A", startedAt: "1970-01-01T00:00:00.000Z" }] });
    g.open.get("A")?.();
    await loop;
    expect(states.at(-1)).toEqual({ running: [] });
  });
});

describe("agent commands", () => {
  test("AGENT_CMD, REVIEW_CMD and PATCH_CMD request a JSON envelope with the result schema", () => {
    for (const cmd of [AGENT_CMD, REVIEW_CMD, PATCH_CMD]) {
      const format = cmd.indexOf("--output-format");
      expect(format).toBeGreaterThan(-1);
      expect(cmd[format + 1]).toBe("json");
      const schema = cmd.indexOf("--json-schema");
      expect(schema).toBeGreaterThan(-1);
      expect(JSON.parse(cmd[schema + 1]!)).toEqual(AGENT_RESULT_SCHEMA);
    }
  });
});

describe("agentRunner", () => {
  /** A stub command that prints a Claude Code JSON envelope and exits with `code`. */
  const envelope = (structured: unknown, code = 0, text = "all done") =>
    ["sh", "-c", `printf '%s' "$0"; exit ${code}`, JSON.stringify({ type: "result", is_error: false, result: text, structured_output: structured })];

  test("resolves the child's exit code", async () => {
    expect((await agentRunner(["sh", "-c", "exit 0"], () => {})(task("T1"))).exitCode).toBe(0);
    expect((await agentRunner(["sh", "-c", "exit 3"], () => {})(task("T1"))).exitCode).toBe(3);
  });

  test("substitutes {id} in every argument", async () => {
    const check = ["sh", "-c", 'test "{id}" = T1 && test "$0" = T1', "{id}"];
    expect((await agentRunner(check, () => {})(task("T1"))).exitCode).toBe(0);
    expect((await agentRunner(check, () => {})(task("T2"))).exitCode).not.toBe(0);
  });

  test("parses the report from the envelope and prints the result text", async () => {
    const printed: string[] = [];
    const out = await agentRunner(envelope({ outcome: "processed" }), (m) => printed.push(m))(task("T1"));
    expect(out).toEqual({ exitCode: 0, report: { outcome: "processed" } });
    expect(printed).toEqual(["all done"]);
  });

  test("parses a skipped report with its reason", async () => {
    const out = await agentRunner(envelope({ outcome: "skipped", reason: "nothing to do" }), () => {})(task("T1"));
    expect(out).toEqual({ exitCode: 0, report: { outcome: "skipped", reason: "nothing to do" } });
  });

  test("keeps a non-zero exit code alongside the parsed report", async () => {
    const out = await agentRunner(envelope({ outcome: "processed" }, 2), () => {})(task("T1"));
    expect(out.exitCode).toBe(2);
    expect(out.report).toEqual({ outcome: "processed" });
  });

  test("stdout that is not an envelope gives a null report and prints nothing", async () => {
    const printed: string[] = [];
    const out = await agentRunner(["sh", "-c", "echo not json"], (m) => printed.push(m))(task("T1"));
    expect(out).toEqual({ exitCode: 0, report: null });
    expect(printed).toEqual([]);
  });

  test("an envelope without a valid report gives a null report but still prints the result text", async () => {
    const printed: string[] = [];
    const out = await agentRunner(envelope({ outcome: "bogus" }), (m) => printed.push(m))(task("T1"));
    expect(out.report).toBeNull();
    expect(printed).toEqual(["all done"]);
  });
});

describe("prRunner", () => {
  test("parses the report and prints the result text for a review", async () => {
    const stub = ["sh", "-c", `printf '%s' "$0"`, JSON.stringify({ result: "reviewed {pr}", structured_output: { outcome: "skipped", reason: "closed" } })];
    const printed: string[] = [];
    const out = await prRunner(stub, stub, (m) => printed.push(m))(
      { number: 4, url: "https://github.com/acme/widgets/pull/4", repo: "acme/widgets", title: "t", branch: "b", createdAt: "x", isDraft: false, headSha: "s", ci: "pass", mergeable: "clean", reviewDecision: "none", labels: [], comments: [] },
      "review",
    );
    expect(out).toEqual({ exitCode: 0, report: { outcome: "skipped", reason: "closed" } });
    expect(printed).toHaveLength(1);
  });
});

describe("main", () => {
  test("returns 0 and leaves the task in pr when the agent succeeds", async () => {
    const { store, tasks } = memStore([task("A")]);
    const processed = JSON.stringify({ result: "ok", structured_output: { outcome: "processed" } });
    expect(await main(store, ["sh", "-c", `printf '%s' "$0"`, processed], { ...fakeSleep(), ...tempLock() })).toBe(0);
    expect(tasks[0]!.status).toBe("pr");
  });

  test("returns 0 and parks the task when the agent fails: a failure no longer stops the loop", async () => {
    const { store, tasks } = memStore([task("A")]);
    expect(await main(store, ["sh", "-c", "exit 1"], { ...fakeSleep(), ...tempLock() })).toBe(0);
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[0]!.needsYou).toContain("failed");
  });

  test("returns 0 when aborted while idle", async () => {
    const { store } = memStore([]);
    expect(await main(store, ["sh", "-c", "exit 0"], { ...fakeSleep(2), ...tempLock() })).toBe(0);
  });

  test("returns 0 on SIGINT while idle", async () => {
    const { store } = memStore([]);
    const never = () => new Promise<void>(() => {});
    const done = main(store, ["sh", "-c", "exit 0"], { sleep: never, ...tempLock() });
    await Bun.sleep(10);
    process.emit("SIGINT");
    expect(await done).toBe(0);
  });
});

describe("agents in worktrees", () => {
  /** Workspaces that hand out real temp folders and record what was created and removed. */
  function fakeWorkspaces() {
    const events: string[] = [];
    const base = mkdtempSync(join(tmpdir(), "ws-"));
    const workspaces: Workspaces = {
      async create(name) {
        events.push(`create ${name}`);
        const path = join(base, name);
        mkdirSync(path, { recursive: true });
        return path;
      },
      async remove(name) {
        events.push(`remove ${name}`);
      },
      async prune() {
        events.push("prune");
      },
    };
    return { workspaces, events, base };
  }

  test("a cook agent runs inside its own worktree, which is removed afterwards", async () => {
    const { workspaces, events, base } = fakeWorkspaces();
    const printed: string[] = [];
    const runner = agentRunner(["sh", "-c", `printf '{"result":"%s"}' "$(pwd -P)"`], (t) => printed.push(t), workspaces);
    await runner(task("add-login"));
    expect(printed[0]).toBe(realpathSync(join(base, "cook-add-login")));
    expect(events).toEqual(["create cook-add-login", "remove cook-add-login"]);
  });

  test("a PR agent gets a worktree named after the PR, removed even when the agent fails", async () => {
    const { workspaces, events } = fakeWorkspaces();
    const runner = prRunner(["sh", "-c", "exit 3"], ["sh", "-c", "exit 4"], () => {}, workspaces);
    expect((await runner({ number: 7 } as PullRequest, "patch")).exitCode).toBe(4);
    expect(events).toEqual(["create pr-7", "remove pr-7"]);
  });

  test("the runner reports a usage limit found in the agent's output", async () => {
    const out = JSON.stringify({ is_error: true, result: "Claude AI usage limit reached|1749924000" });
    const runner = agentRunner(["sh", "-c", `printf '%s' "$0"; exit 1`, out], () => {});
    expect(await runner(task("A"))).toEqual({ exitCode: 1, report: null, usageLimit: { resetAt: 1749924000_000 } });
  });

  test("main prunes leftover worktrees before it starts", async () => {
    const { workspaces, events } = fakeWorkspaces();
    const { store } = memStore([]);
    await main(store, ["sh", "-c", "exit 0"], { ...fakeSleep(), ...tempLock(), workspaces });
    expect(events).toEqual(["prune"]);
  });

  test("the loop state round-trips through its file; a missing or broken file reads as idle", () => {
    const path = join(mkdtempSync(join(tmpdir(), "state-")), "loop-state.json");
    expect(readLoopState(path)).toEqual({ running: [] });
    const state: LoopState = { running: [{ kind: "review", target: 7, startedAt: "2026-11-19T12:00:00.000Z" }], pausedUntil: "2026-11-19T13:00:00.000Z" };
    writeLoopState(state, path);
    expect(readLoopState(path)).toEqual(state);
    writeFileSync(path, "{nope");
    expect(readLoopState(path)).toEqual({ running: [] });
  });
});

describe("main one-loop lock", () => {
  test("returns 1 and runs no agent when another live loop holds the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-lock-"));
    const path = join(dir, "loop.lock");
    writeFileSync(path, JSON.stringify({ pid: 4242, startedAt: "2026-10-29T10:00:00.000Z" }));
    const { store, tasks } = memStore([task("A")]);
    const ran = join(dir, "ran");
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    let code: number;
    try {
      code = await main(store, ["sh", "-c", `echo x > ${ran}`], { ...fakeSleep(), lock: { path, isAlive: (pid) => pid === 4242 } });
    } finally {
      console.error = orig;
    }
    expect(code).toBe(1);
    expect(existsSync(ran)).toBe(false);
    expect(tasks[0]!.status).toBe("pending");
    expect(errors.join("\n")).toMatch(/a loop is already running \(pid 4242, started \d\d:\d\d local time\)/);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(4242);
  });

  test("replaces a stale lock and removes its own when it stops", async () => {
    const { lock } = tempLock({ isAlive: () => false });
    writeFileSync(lock.path, JSON.stringify({ pid: 4242, startedAt: "2026-10-29T10:00:00.000Z" }));
    const { store } = memStore([]);
    expect(await main(store, ["sh", "-c", "exit 0"], { ...fakeSleep(2), lock })).toBe(0);
    expect(existsSync(lock.path)).toBe(false);
  });

  test("releases the lock on SIGTERM", async () => {
    const { lock } = tempLock();
    const { store } = memStore([]);
    const never = () => new Promise<void>(() => {});
    const done = main(store, ["sh", "-c", "exit 0"], { sleep: never, lock });
    await Bun.sleep(10);
    expect(existsSync(lock.path)).toBe(true);
    process.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(existsSync(lock.path)).toBe(false);
  });
});

describe("ALLOWED_TOOLS", () => {
  test("contains the base tools and the read-only helpers", () => {
    const expected = [
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(git *)",
      "Bash(gh *)",
      "Bash(bun *)",
      "Bash(jq *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(wc *)",
      "Bash(sed -n *)",
      "Bash(echo *)",
    ];
    for (const t of expected) expect(ALLOWED_TOOLS).toContain(t);
  });

  test("includes Agent so cook can launch the independent verifier subagent", () => {
    expect(ALLOWED_TOOLS).toContain("Agent");
  });

  test("excludes broad or dangerous entries", () => {
    for (const t of ["Bash(*)", "Bash(python3 *)", "Bash(sed *)", "Bash(rm *)", "Bash(curl *)"]) {
      expect(ALLOWED_TOOLS).not.toContain(t);
    }
  });

  test("AGENT_CMD passes the joined list after --allowedTools", () => {
    expect(AGENT_CMD[AGENT_CMD.indexOf("--allowedTools") + 1]).toBe(ALLOWED_TOOLS.join(","));
  });
});