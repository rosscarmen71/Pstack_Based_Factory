import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditStore, type AuditEntry } from "./audit-log.ts";
import { agentPatterns, DELETED_COMMENT, deleteTask, previewDelete, type DeleteDeps, type TaskTarget } from "./delete-task.ts";
import { attemptsStore } from "./pr-attempts.ts";
import type { GhResult } from "./prs.ts";
import type { Task } from "./tasks.schema.ts";
import { fileStore } from "./tasks.store.ts";

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  description: "d",
  acceptanceCriteria: ["c"],
  dependencies: [],
  status: "pending",
  ...over,
});
const PR = (number: number, open = true) => ({ repo: "acme/widgets", number, url: `https://github.com/acme/widgets/pull/${number}`, open });
const entry = (over: Partial<AuditEntry>): AuditEntry => ({ at: "2026-11-19T12:00:00.000Z", action: "dev-task", target: "a", title: "t", outcome: "success", durationMs: 1, ...over });
const OK: GhResult = { exitCode: 0, stdout: "", stderr: "" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delete-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Real file stores in a temp dir; fake gh, git, agents and transcripts that record their calls. */
function setup(tasks: Task[], audit: AuditEntry[] = [], branches: { local?: string[]; remote?: string[]; current?: string } = {}) {
  const tasksPath = join(dir, "tasks.json");
  const auditPath = join(dir, "audit.jsonl");
  const attemptsPath = join(dir, "attempts.json");
  writeFileSync(tasksPath, JSON.stringify(tasks));
  writeFileSync(auditPath, audit.map((e) => `${JSON.stringify(e)}\n`).join(""));
  const ghCalls: string[][] = [];
  const gitCalls: string[][] = [];
  const stopped: TaskTarget[] = [];
  const transcripts: TaskTarget[] = [];
  const deps: DeleteDeps = {
    store: fileStore(tasksPath),
    audit: auditStore(auditPath),
    attempts: attemptsStore(attemptsPath),
    gh: async (args) => {
      ghCalls.push(args);
      return OK;
    },
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "for-each-ref") return { ...OK, stdout: ((args[2] ?? "").startsWith("refs/heads") ? (branches.local ?? []) : (branches.remote ?? [])).join("\n") };
      if (args[0] === "rev-parse") return { ...OK, stdout: `${branches.current ?? "main"}\n` };
      return OK;
    },
    stopAgents: async (target) => {
      stopped.push(target);
      return 1;
    },
    removeTranscripts: (target) => {
      transcripts.push(target);
      return 2;
    },
  };
  return { deps, ghCalls, gitCalls, stopped, transcripts };
}

test("returns null and touches nothing for an unknown task", async () => {
  const { deps, ghCalls, gitCalls, stopped } = setup([t("a")]);
  expect(await deleteTask("nope", deps)).toBeNull();
  expect([ghCalls, gitCalls, stopped]).toEqual([[], [], []]);
  expect(deps.store.load()).toHaveLength(1);
});

test("deleting an unfinished task releases its dependents and erases its records", async () => {
  const { deps, ghCalls, stopped, transcripts } = setup(
    [t("a", { status: "pr", pr: PR(7) }), t("b", { dependencies: ["a"], dependencyReasons: { a: "both edit x" } }), t("c")],
    [
      entry({ target: "a" }),
      entry({ target: "c" }),
      entry({ action: "review", target: 7, repo: "acme/widgets", url: PR(7).url }),
      entry({ action: "patch", target: 8, repo: "acme/widgets", url: PR(8).url }),
    ],
    { local: ["feat/a"], remote: ["origin/feat/a"] },
  );
  deps.attempts.record(7, "review", "sha");
  deps.attempts.record(8, "review", "sha");

  const report = await deleteTask("a", deps);

  expect(report).toEqual({
    id: "a",
    stoppedAgents: 1,
    closedPr: 7,
    deletedBranches: ["feat/a", "origin/feat/a"],
    releasedDependents: ["b"],
    auditEntries: 2,
    transcripts: 2,
    warnings: [],
  });
  const left = deps.store.load();
  expect(left.map((x) => x.id)).toEqual(["b", "c"]);
  expect(left[0]?.dependencies).toEqual([]);
  expect(left[0]?.dependencyReasons).toBeUndefined();
  expect(ghCalls).toEqual([["pr", "close", "7", "--comment", DELETED_COMMENT]]);
  expect(deps.audit.list().map((e) => e.target)).toEqual(["c", 8]);
  expect(deps.attempts.get(7)).toBeUndefined();
  expect(deps.attempts.get(8)).toBeDefined();
  const target = { taskId: "a", pr: { repo: "acme/widgets", number: 7 } };
  expect(stopped).toEqual([target]);
  expect(transcripts).toEqual([target]);
});

test("a task with no PR closes nothing; a closed PR is not closed again", async () => {
  const one = setup([t("a")]);
  expect((await deleteTask("a", one.deps))?.closedPr).toBeNull();
  expect(one.ghCalls).toEqual([]);
  const two = setup([t("a", { status: "pr", pr: PR(7, false) })]);
  expect((await deleteTask("a", two.deps))?.closedPr).toBeNull();
  expect(two.ghCalls).toEqual([]);
});

test("a completed task keeps its merged branch", async () => {
  const { deps, gitCalls } = setup([t("a", { status: "completed", pr: PR(7, false) })], [], { local: ["feat/a"] });
  const report = await deleteTask("a", deps);
  expect(report?.deletedBranches).toEqual([]);
  expect(gitCalls).toEqual([]);
  expect(deps.store.load()).toEqual([]);
});

test("a checked-out task branch is left before it is deleted", async () => {
  const { deps, gitCalls } = setup([t("a", { status: "in_progress" })], [], { local: ["feat/a"], current: "feat/a" });
  const report = await deleteTask("a", deps);
  expect(report?.deletedBranches).toEqual(["feat/a"]);
  expect(gitCalls.map((c) => c.join(" "))).toContain("checkout main");
});

test("a failing GitHub or git step is a warning; the task is still deleted", async () => {
  const { deps } = setup([t("a", { status: "pr", pr: PR(7) })], [], { local: ["feat/a"] });
  deps.gh = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });
  deps.stopAgents = async () => {
    throw new Error("pgrep missing");
  };
  const git = deps.git;
  deps.git = async (args) => (args[0] === "branch" ? { exitCode: 1, stdout: "", stderr: "locked" } : git ? git(args) : OK);
  const report = await deleteTask("a", deps);
  expect(report?.closedPr).toBeNull();
  expect(report?.warnings).toEqual([
    "could not stop the running agent: pgrep missing",
    "could not close PR #7: not found",
    "could not delete local branch feat/a: locked",
  ]);
  expect(deps.store.load()).toEqual([]);
});

test("previewDelete lists the open PR and the dependents", () => {
  const tasks = [t("a", { status: "pr", pr: PR(7) }), t("b", { dependencies: ["a"] }), t("c", { dependencies: ["b"] })];
  expect(previewDelete(tasks, "a")).toEqual({ id: "a", title: "Task a", status: "pr", openPr: 7, dependents: ["b"] });
  expect(previewDelete(tasks, "nope")).toBeNull();
});

test("agent patterns match the loop's command lines exactly", () => {
  const [cook, pr] = agentPatterns({ taskId: "add.login", pr: { repo: "acme/widgets", number: 7 } });
  expect(new RegExp(cook ?? "").test("claude -p /cook add.login --allowedTools Read")).toBe(true);
  expect(new RegExp(cook ?? "").test("claude -p /cook addXlogin --allowedTools Read")).toBe(false);
  expect(new RegExp(cook ?? "").test("claude -p /cook add.login-two --allowedTools Read")).toBe(false);
  expect(new RegExp(pr ?? "").test("claude -p /remake 7 --allowedTools Read")).toBe(true);
  expect(new RegExp(pr ?? "").test("claude -p /taste_test 71 --allowedTools Read")).toBe(false);
  expect(agentPatterns({ taskId: "a" })).toHaveLength(1);
});
