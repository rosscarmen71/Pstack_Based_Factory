import { describe, expect, test } from "bun:test";
import type { AgentResult } from "./agent-result.ts";
import { runLoop, type RunResult, type Runner } from "./loop.ts";
import type { AttemptsStore } from "./pr-attempts.ts";
import type { ClosedPr, PrSource, PullRequest } from "./prs.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import type { Task, TaskStatus } from "./tasks.schema.ts";
import type { TaskStore } from "./tasks.store.ts";

const task = (id: string, status: TaskStatus = "pending"): Task => ({
  id,
  title: `Task ${id}`,
  description: "d",
  acceptanceCriteria: ["c"],
  dependencies: [],
  status,
});

const res = (exitCode = 0, report: AgentResult | null = exitCode === 0 ? { outcome: "processed" } : null): RunResult => ({
  exitCode,
  report,
});

const NOOP_ATTEMPTS: AttemptsStore = {
  get: () => undefined,
  record: () => {},
  exceeded: () => false,
  flagForHuman: async () => {},
  sync: () => {},
  remove: () => false,
};

/** In-memory store that records every update call. */
function memStore(tasks: Task[]) {
  const updates: Array<{ id: string; patch: Partial<Task> }> = [];
  const store: TaskStore = {
    load: () => tasks.map((t) => ({ ...t })),
    setStatus(id, status) {
      tasks.find((t) => t.id === id)!.status = status;
    },
    update(id, patch) {
      updates.push({ id, patch });
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
  return { store, tasks, updates };
}

/** Fake sleep that lets running agents settle, ignores sleeps the loop gave up on, and aborts after `after` idle polls. */
function fakeSleep(after = 1) {
  const controller = new AbortController();
  let calls = 0;
  let latest = 0;
  const sleep = async () => {
    const mine = ++latest;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (mine !== latest) return;
    calls++;
    if (calls >= after) controller.abort();
  };
  return { sleep, signal: controller.signal };
}

const pr = (number: number, branch: string, over: Partial<PullRequest> = {}): PullRequest => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  repo: "acme/widgets",
  title: `PR ${number}`,
  branch,
  createdAt: "2026-10-29T10:00:00.000Z",
  isDraft: false,
  headSha: `sha${number}`,
  ci: "pass",
  mergeable: "clean",
  reviewDecision: "approved", // settled: the loop has nothing to do with it
  labels: [],
  comments: [],
  ...over,
});

const OPEN = (number: number) => ({
  repo: "acme/widgets",
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  open: true,
});

describe("runLoop run counters", () => {
  test("runs increments on a processed run", async () => {
    const { store, tasks } = memStore([task("A")]);
    await runLoop(store, async () => res(), undefined, fakeSleep());
    expect(tasks[0]?.runs).toBe(1);
    expect(tasks[0]?.skips).toBeUndefined();
    expect(tasks[0]?.lastSkipReason).toBeUndefined();
  });

  test("runs increments on a failed run and leaves skips alone", async () => {
    const { store, tasks } = memStore([task("A")]);
    await runLoop(store, async () => res(1), undefined, fakeSleep());
    expect(tasks[0]?.runs).toBe(1);
    expect(tasks[0]?.skips).toBeUndefined();
  });

  test("runs keeps counting from the recorded value", async () => {
    const { store, tasks } = memStore([{ ...task("A"), runs: 4, skips: 1 }]);
    await runLoop(store, async () => res(), undefined, fakeSleep());
    expect(tasks[0]?.runs).toBe(5);
    expect(tasks[0]?.skips).toBe(1);
  });

  test("a skipped run increments runs and skips and records the agent's reason", async () => {
    const { store, tasks } = memStore([task("A")]);
    await runLoop(store, async () => res(0, { outcome: "skipped", reason: "already done" }), undefined, fakeSleep());
    expect(tasks[0]?.runs).toBe(1);
    expect(tasks[0]?.skips).toBe(1);
    expect(tasks[0]?.lastSkipReason).toBe("already done");
  });

  test("a later skip replaces the reason and adds to skips", async () => {
    const { store, tasks } = memStore([{ ...task("A"), runs: 1, skips: 1, lastSkipReason: "old" }]);
    await runLoop(store, async () => res(0, { outcome: "skipped", reason: "new" }), undefined, fakeSleep());
    expect(tasks[0]?.runs).toBe(2);
    expect(tasks[0]?.skips).toBe(2);
    expect(tasks[0]?.lastSkipReason).toBe("new");
  });

  test("a runner that threw never ran the agent, so nothing is counted", async () => {
    const { store, tasks } = memStore([task("A")]);
    await runLoop(
      store,
      async () => {
        throw new Error("spawn failed");
      },
      undefined,
      fakeSleep(),
    );
    expect(tasks[0]?.runs).toBeUndefined();
  });

  test("a failing store update is logged and does not stop the loop", async () => {
    const { store, tasks } = memStore([task("A"), task("B")]);
    store.update = () => {
      throw new Error("disk full");
    };
    const logs: string[] = [];
    // A run that failed would stop the loop; a failed bookkeeping write must not.
    const out = await runLoop(store, async () => res(), (m) => logs.push(m), fakeSleep());
    expect(out.ran).toEqual(["A", "B"]);
    expect(tasks.map((t) => t.status)).toEqual(["pr", "pr"]);
    expect(logs.some((m) => m.includes("disk full"))).toBe(true);
  });
});

describe("runLoop PR tracking", () => {
  const ok: Runner = async () => res();
  const options = (prs: PrSource, after = 1) => ({
    ...fakeSleep(after),
    prs,
    attempts: NOOP_ATTEMPTS,
    runPr: async () => res(),
  });

  test("a pr-status task gets the open PR on its branch", async () => {
    const { store, tasks } = memStore([task("A", "pr")]);
    const source: PrSource = { list: async () => [pr(7, "feat/A")] };
    await runLoop(store, ok, undefined, options(source));
    expect(tasks[0]?.pr).toEqual(OPEN(7));
  });

  test("a task that is not in pr status is not given a PR", async () => {
    const { store, tasks } = memStore([task("A", "in_progress"), task("B", "pending")]);
    const source: PrSource = { list: async () => [pr(7, "feat/A"), pr(8, "feat/B")] };
    await runLoop(store, async () => res(1), undefined, options(source));
    expect(tasks.every((t) => t.pr === undefined)).toBe(true);
  });

  test("a task's own PR is attached on the tick after the run, not mid-run", async () => {
    const { store, tasks } = memStore([task("A")]);
    const source: PrSource = { list: async () => [pr(7, "feat/A")] };
    await runLoop(store, ok, undefined, options(source, 1));
    expect(tasks[0]?.status).toBe("pr");
    expect(tasks[0]?.pr).toEqual(OPEN(7));
  });

  test("a recorded PR missing from a later open list flips to open false and keeps repo, number and url", async () => {
    const { store, tasks } = memStore([task("A", "pr")]);
    let open = [pr(7, "feat/A")];
    const source: PrSource = { list: async () => open };
    const { sleep, signal } = fakeSleep(2);
    await runLoop(store, ok, undefined, {
      signal,
      sleep: async () => {
        open = [];
        await sleep();
      },
      prs: source,
      attempts: NOOP_ATTEMPTS,
      runPr: async () => res(),
    });
    expect(tasks[0]?.pr).toEqual({ ...OPEN(7), open: false });
  });

  test("a PR that stays closed is not rewritten on later ticks", async () => {
    const closed = { ...OPEN(7), open: false };
    const { store, updates } = memStore([{ ...task("A", "pr"), pr: closed }]);
    await runLoop(store, ok, undefined, options({ list: async () => [] }, 2));
    expect(updates).toEqual([]);
  });

  test("a failed listing leaves every task's pr untouched", async () => {
    const { store, tasks, updates } = memStore([task("A", "pr"), { ...task("B", "pr"), pr: OPEN(9) }]);
    const source: PrSource = {
      list: async () => {
        throw new Error("gh down");
      },
    };
    await runLoop(store, ok, undefined, options(source));
    expect(updates).toEqual([]);
    expect(tasks[0]?.pr).toBeUndefined();
    expect(tasks[1]?.pr).toEqual(OPEN(9));
  });

  test("an unchanged tick performs no store update", async () => {
    const { store, updates } = memStore([task("A", "pr")]);
    const source: PrSource = { list: async () => [pr(7, "feat/A")] };
    await runLoop(store, ok, undefined, options(source, 3));
    expect(updates).toHaveLength(1); // the first tick attaches it; ticks two and three change nothing
  });

  test("a PR on a branch that belongs to no task is attached to no task", async () => {
    const { store, tasks, updates } = memStore([task("A", "pr")]);
    const source: PrSource = { list: async () => [pr(7, "feat/unrelated"), pr(8, "feat/not-A"), pr(9, "A")] };
    await runLoop(store, ok, undefined, options(source));
    expect(tasks[0]?.pr).toBeUndefined();
    expect(updates).toEqual([]);
  });

  test("a failing store update on a tick is logged and does not stop the loop", async () => {
    const { store } = memStore([task("A", "pr")]);
    store.update = () => {
      throw new Error("disk full");
    };
    const logs: string[] = [];
    const source: PrSource = { list: async () => [pr(7, "feat/A")] };
    const out = await runLoop(store, ok, (m) => logs.push(m), options(source));
    expect(out.stoppedOn).toBeNull();
    expect(logs.some((m) => m.includes("disk full"))).toBe(true);
  });

  const closed = (number: number, branch: string, merged: boolean, createdAt = "2026-11-19T12:00:00.000Z"): ClosedPr => ({
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    repo: "acme/widgets",
    branch,
    createdAt,
    merged,
  });

  test("a task whose recorded PR was merged becomes completed", async () => {
    const { store, tasks } = memStore([{ ...task("A", "pr"), pr: OPEN(9) }]);
    const source: PrSource = { list: async () => [], listClosed: async () => [closed(9, "feat/A", true)] };
    const logs: string[] = [];
    await runLoop(store, ok, (m) => logs.push(m), options(source));
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.pr?.open).toBe(false);
    expect(logs.some((m) => m.includes("A -> completed"))).toBe(true);
  });

  test("a task whose PR was closed without merging is flagged and stays pr", async () => {
    const { store, tasks } = memStore([{ ...task("A", "pr"), pr: OPEN(9) }]);
    const source: PrSource = { list: async () => [], listClosed: async () => [closed(9, "feat/A", false)] };
    await runLoop(store, ok, undefined, options(source, 2));
    expect(tasks[0]?.status).toBe("pr");
    expect(tasks[0]?.needsYou).toBe("PR #9 was closed without merging");
    expect(tasks[0]?.pr?.open).toBe(false);
  });

  test("a merged PR with another number on the same branch does not complete the task", async () => {
    const { store, tasks } = memStore([{ ...task("A", "pr"), pr: OPEN(9) }]);
    const source: PrSource = { list: async () => [], listClosed: async () => [closed(4, "feat/A", true)] };
    await runLoop(store, ok, undefined, options(source));
    expect(tasks[0]?.status).toBe("pr");
  });

  test("with no recorded PR, only a closed PR opened after the task counts", async () => {
    const { store, tasks } = memStore([{ ...task("A", "pr"), createdAt: "2026-11-19T12:00:00.000Z" }]);
    const source: PrSource = {
      list: async () => [],
      listClosed: async () => [closed(3, "feat/A", true, "2026-11-01T00:00:00.000Z")],
    };
    await runLoop(store, ok, undefined, options(source));
    expect(tasks[0]?.status).toBe("pr");
    source.listClosed = async () => [closed(12, "feat/A", true, "2026-11-19T12:30:00.000Z")];
    await runLoop(store, ok, undefined, options(source));
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.pr?.number).toBe(12);
  });
});

describe("runLoop hands-off stacks", () => {
  const HANDS_OFF: Settings = { ...DEFAULT_SETTINGS, defaultMode: "hands-off" };
  /** Attempts whose last successful review of each PR is the given SHA. */
  const reviewed = (shas: Record<number, string>): AttemptsStore => ({
    ...NOOP_ATTEMPTS,
    get: (n) => (shas[n] === undefined ? undefined : { reviews: 1, patches: 0, reviewedSha: shas[n] }),
  });
  const ok: Runner = async () => res();
  const clean = (number: number, branch: string, headSha: string) => pr(number, branch, { headSha, reviewDecision: "none" });

  test("hands-on: a dependent does not start on an approved, unmerged dependency", async () => {
    const { store, tasks } = memStore([task("A", "pr"), { ...task("B"), dependencies: ["A"] }]);
    const source: PrSource = { list: async () => [clean(7, "feat/A", "a1")] };
    const out = await runLoop(store, ok, undefined, { ...fakeSleep(), prs: source, attempts: reviewed({ 7: "a1" }), runPr: async () => res() });
    expect(out.ran).toEqual([]);
    expect(tasks[1]?.status).toBe("pending");
  });

  test("hands-off: it starts once the dependency passed taste_test cleanly, and records what it is stacked on", async () => {
    const { store, tasks } = memStore([task("A", "pr"), { ...task("B"), dependencies: ["A"] }]);
    const source: PrSource = { list: async () => [clean(7, "feat/A", "a1")] };
    const out = await runLoop(store, ok, undefined, {
      ...fakeSleep(),
      prs: source,
      attempts: reviewed({ 7: "a1" }),
      runPr: async () => res(),
      settings: () => HANDS_OFF,
    });
    expect(out.ran).toEqual(["B"]);
    expect(tasks[1]?.builtOn).toEqual({ A: "a1" });
  });

  test("hands-off: an unreviewed dependency is reviewed first, then the dependent starts", async () => {
    const { store } = memStore([task("A", "pr"), { ...task("B"), dependencies: ["A"] }]);
    const source: PrSource = { list: async () => [clean(7, "feat/A", "a1")] };
    const shas: Record<number, string> = {};
    const order: string[] = [];
    const out = await runLoop(
      store,
      async (t) => {
        order.push(`cook ${t.id}`);
        return res();
      },
      undefined,
      {
        ...fakeSleep(),
        prs: source,
        attempts: {
          ...reviewed(shas),
          record: (n, _kind, sha) => {
            shas[n] = sha;
          },
        },
        runPr: async (p, action) => {
          order.push(`${action} ${p.number}`);
          return res();
        },
        settings: () => HANDS_OFF,
      },
    );
    expect(order).toEqual(["review 7", "cook B"]);
    expect(out.ran).toEqual(["B"]);
  });

  test("a dependency with new commits gets its stacked dependent patched, then the new base is remembered", async () => {
    const { store, tasks } = memStore([task("A", "pr"), { ...task("B", "pr"), dependencies: ["A"], builtOn: { A: "a1" } }]);
    const source: PrSource = { list: async () => [clean(7, "feat/A", "a2"), clean(8, "feat/B", "b1")] };
    const ran: string[] = [];
    await runLoop(store, ok, undefined, {
      ...fakeSleep(2),
      prs: source,
      attempts: reviewed({ 7: "a2", 8: "b1" }),
      runPr: async (p, action) => {
        ran.push(`${action} ${p.number}`);
        return res();
      },
      settings: () => HANDS_OFF,
    });
    expect(ran).toEqual(["patch 8"]);
    expect(tasks[1]?.builtOn).toEqual({ A: "a2" });
  });

  test("unreadable settings fall back to hands-on and are logged", async () => {
    const { store } = memStore([task("A", "pr"), { ...task("B"), dependencies: ["A"] }]);
    const source: PrSource = { list: async () => [clean(7, "feat/A", "a1")] };
    const logs: string[] = [];
    const out = await runLoop(store, ok, (m) => logs.push(m), {
      ...fakeSleep(),
      prs: source,
      attempts: reviewed({ 7: "a1" }),
      runPr: async () => res(),
      settings: () => {
        throw new Error("bad json");
      },
    });
    expect(out.ran).toEqual([]);
    expect(logs.some((m) => m.includes("bad json"))).toBe(true);
  });
});
