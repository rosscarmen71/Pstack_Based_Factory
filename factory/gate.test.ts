import { describe, expect, test } from "bun:test";
import { blockers, canStart, dependencyMoved, dependencyState, type GateContext, isClean, prOfTask, stackBase, taskOfPr } from "./gate.ts";
import type { PullRequest } from "./prs.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import type { Task } from "./tasks.schema.ts";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: "d",
  acceptanceCriteria: ["c"],
  dependencies: [],
  status: "pending",
  ...over,
});

/** An open PR on the task's branch that has passed taste_test cleanly when reviewed at "sha". */
const pr = (number: number, id: string, over: Partial<PullRequest> = {}): PullRequest => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  repo: "acme/widgets",
  title: `pr ${number}`,
  branch: `feat/${id}`,
  createdAt: "2026-11-19T12:00:00Z",
  isDraft: false,
  headSha: "sha",
  ci: "pass",
  mergeable: "clean",
  reviewDecision: "none",
  labels: [],
  comments: [],
  ...over,
});

const HANDS_OFF: Settings = { ...DEFAULT_SETTINGS, defaultMode: "hands-off" };

const ctx = (tasks: Task[], prs: PullRequest[] = [], settings: Settings = DEFAULT_SETTINGS, reviewed: Record<number, string> = {}): GateContext => ({
  tasks,
  prs,
  settings,
  reviewedSha: (n) => reviewed[n],
});

describe("isClean", () => {
  test("clean needs approval of the current commit, green CI, no conflict and no pending request", () => {
    expect(isClean(pr(1, "a"), "sha")).toBe(true);
    expect(isClean(pr(1, "a"), undefined)).toBe(false);
    expect(isClean(pr(1, "a", { headSha: "newer" }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { ci: "fail" }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { ci: "pending" }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { mergeable: "conflicting" }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { mergeable: "unknown" }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { labels: ["changes-requested"] }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { reviewDecision: "changes_requested" }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { labels: ["needs-human"] }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { isDraft: true }), "sha")).toBe(false);
  });

  test("an unanswered /remake or /customize_order comment is not clean; an answered one is", () => {
    const ask = { body: "/remake rename it", createdAt: "2026-11-19T13:00:00Z" };
    const answer = { body: "## Remake summary\ndone", createdAt: "2026-11-19T14:00:00Z" };
    expect(isClean(pr(1, "a", { comments: [ask] }), "sha")).toBe(false);
    expect(isClean(pr(1, "a", { comments: [ask, answer] }), "sha")).toBe(true);
    expect(isClean(pr(1, "a", { comments: [{ body: "/customize_order x", createdAt: "2026-11-19T13:00:00Z" }] }), "sha")).toBe(false);
  });
});

describe("dependencyState", () => {
  test("a completed or deleted dependency is met in both modes", () => {
    for (const settings of [DEFAULT_SETTINGS, HANDS_OFF]) {
      expect(dependencyState("a", ctx([task("a", { status: "completed" })], [], settings)).met).toBe(true);
      expect(dependencyState("gone", ctx([], [], settings)).met).toBe(true);
    }
  });

  test("a dependency that has not reached a PR is never met", () => {
    for (const status of ["pending", "in_progress"] as const) {
      const state = dependencyState("a", ctx([task("a", { status })], [], HANDS_OFF));
      expect(state).toMatchObject({ met: false, waitingFor: "start" });
    }
  });

  test("hands-on: an open PR, even a clean one, waits for the merge", () => {
    const state = dependencyState("a", ctx([task("a", { status: "pr" })], [pr(7, "a")], DEFAULT_SETTINGS, { 7: "sha" }));
    expect(state).toEqual({ id: "a", met: false, mode: "hands-on", waitingFor: "merge", text: "waiting on a to merge (PR #7)" });
  });

  test("hands-off: met once the PR passed taste_test cleanly, and unmet again after a new commit", () => {
    const tasks = [task("a", { status: "pr" })];
    expect(dependencyState("a", ctx(tasks, [pr(7, "a")], HANDS_OFF, { 7: "sha" })).met).toBe(true);
    expect(dependencyState("a", ctx(tasks, [pr(7, "a")], HANDS_OFF))).toMatchObject({ met: false, waitingFor: "review", text: "waiting on taste_test of a (PR #7)" });
    expect(dependencyState("a", ctx(tasks, [pr(7, "a", { headSha: "newer" })], HANDS_OFF, { 7: "sha" })).met).toBe(false);
  });

  test("a PR closed without merging is not met in either mode and points at the engineer", () => {
    const tasks = [task("a", { status: "pr", needsYou: "PR #7 was closed without merging" })];
    for (const settings of [DEFAULT_SETTINGS, HANDS_OFF]) {
      expect(dependencyState("a", ctx(tasks, [], settings))).toMatchObject({ met: false, waitingFor: "you" });
    }
  });
});

describe("canStart", () => {
  test("a task with no dependencies may start at once; only pending tasks start", () => {
    expect(canStart(task("a"), ctx([task("a")]))).toBe(true);
    expect(canStart(task("a", { status: "in_progress" }), ctx([]))).toBe(false);
    expect(canStart(task("a", { status: "pr" }), ctx([]))).toBe(false);
    expect(canStart(task("a", { status: "completed" }), ctx([]))).toBe(false);
  });

  test("the dependency's mode decides, not the waiting task's", () => {
    const clean = [pr(7, "a")];
    const reviewed = { 7: "sha" };
    // A hands-on, B hands-off: B waits for the merge.
    const onOff = [task("a", { status: "pr", mode: "hands-on" }), task("b", { dependencies: ["a"], mode: "hands-off" })];
    expect(canStart(onOff[1] as Task, ctx(onOff, clean, DEFAULT_SETTINGS, reviewed))).toBe(false);
    // A hands-off, B hands-on: B may start once A is clean.
    const offOn = [task("a", { status: "pr", mode: "hands-off" }), task("b", { dependencies: ["a"], mode: "hands-on" })];
    expect(canStart(offOn[1] as Task, ctx(offOn, clean, DEFAULT_SETTINGS, reviewed))).toBe(true);
  });

  test("every dependency must be met, each by its own mode", () => {
    const tasks = [
      task("a", { status: "pr", mode: "hands-off" }),
      task("b", { status: "pr", mode: "hands-on" }),
      task("c", { dependencies: ["a", "b"] }),
    ];
    const c = ctx(tasks, [pr(7, "a"), pr(8, "b")], DEFAULT_SETTINGS, { 7: "sha", 8: "sha" });
    expect(canStart(tasks[2] as Task, c)).toBe(false);
    expect(blockers(tasks[2] as Task, c).map((s) => s.id)).toEqual(["b"]);
    tasks[1] = task("b", { status: "completed" });
    expect(canStart(tasks[2] as Task, c)).toBe(true);
  });

  test("the mode is inherited: session over project over the default", () => {
    const tasks = [task("a", { status: "pr", session: "s1", project: "p" }), task("b", { dependencies: ["a"] })];
    const go = (settings: Settings) => canStart(tasks[1] as Task, ctx(tasks, [pr(7, "a")], settings, { 7: "sha" }));
    expect(go(DEFAULT_SETTINGS)).toBe(false);
    expect(go({ ...DEFAULT_SETTINGS, projects: { p: "hands-off" } })).toBe(true);
    expect(go({ ...DEFAULT_SETTINGS, projects: { p: "hands-off" }, sessions: { s1: "hands-on" } })).toBe(false);
  });
});

describe("stacks", () => {
  test("prOfTask prefers the recorded PR, else the task's branch; taskOfPr is its inverse", () => {
    const a = task("a", { pr: { repo: "acme/widgets", number: 9, url: "https://github.com/acme/widgets/pull/9", open: true } });
    const prs = [pr(7, "a"), pr(9, "renamed")];
    expect(prOfTask(a, prs)?.number).toBe(9);
    expect(prOfTask(task("a"), prs)?.number).toBe(7);
    expect(prOfTask(task("zzz"), prs)).toBeUndefined();
    expect(taskOfPr(pr(9, "renamed"), [task("x"), a])?.id).toBe("a");
    expect(taskOfPr(pr(7, "x"), [task("x"), a])?.id).toBe("x");
    expect(taskOfPr(pr(5, "ax"), [task("x")])).toBeUndefined();
  });

  test("stackBase records the head of each unmerged dependency only", () => {
    const tasks = [task("a", { status: "pr" }), task("b", { status: "completed" }), task("c", { dependencies: ["a", "b", "gone"] })];
    expect(stackBase(tasks[2] as Task, { tasks, prs: [pr(7, "a", { headSha: "a1" })] })).toEqual({ a: "a1" });
    expect(stackBase(tasks[2] as Task, { tasks, prs: [] })).toEqual({});
  });

  test("dependencyMoved is true only while the dependency's open PR has a different head", () => {
    const tasks = [task("a", { status: "pr" }), task("b", { status: "pr", dependencies: ["a"], builtOn: { a: "a1" } })];
    const b = tasks[1] as Task;
    expect(dependencyMoved(b, { tasks, prs: [pr(7, "a", { headSha: "a1" })] })).toBe(false);
    expect(dependencyMoved(b, { tasks, prs: [pr(7, "a", { headSha: "a2" })] })).toBe(true);
    // Merged (no longer open) or deleted: nothing to chase.
    expect(dependencyMoved(b, { tasks, prs: [] })).toBe(false);
    expect(dependencyMoved(b, { tasks: [b], prs: [pr(7, "a", { headSha: "a2" })] })).toBe(false);
    expect(dependencyMoved(task("c"), { tasks, prs: [] })).toBe(false);
  });
});
