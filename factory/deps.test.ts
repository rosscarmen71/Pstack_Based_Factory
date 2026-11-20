import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDependencies, dependencyCandidates, dependsOn, setDependencies } from "./deps.ts";
import { runCli, type CliDeps } from "./deps-cli.ts";
import type { PullRequest } from "./prs.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import type { Task } from "./tasks.schema.ts";
import { fileStore } from "./tasks.store.ts";

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  description: `Describe ${id}`,
  acceptanceCriteria: [`check ${id}`],
  dependencies: [],
  status: "pending",
  ...over,
});

describe("dependencyCandidates", () => {
  const tasks = [
    t("done", { status: "completed" }),
    t("open", { status: "pr", session: "s1" }),
    t("running", { status: "in_progress" }),
    t("target", { dependencies: ["open"] }),
    t("child", { dependencies: ["target"] }),
    t("grandchild", { dependencies: ["child"] }),
    t("other"),
  ];

  test("a new task is compared against every unfinished task, never a completed one", () => {
    const list = dependencyCandidates(tasks);
    expect(list.map((c) => c.id)).toEqual(["open", "running", "target", "child", "grandchild", "other"]);
    expect(list.every((c) => c.eligible)).toBe(true);
    expect(list[0]).toEqual({
      id: "open",
      title: "Title open",
      description: "Describe open",
      acceptanceCriteria: ["check open"],
      status: "pr",
      session: "s1",
      dependencies: [],
      started: true,
      eligible: true,
    });
    expect(list.map((c) => c.started)).toEqual([true, true, false, false, false, false]);
  });

  test("an existing task is not compared with itself, and what already depends on it is not eligible", () => {
    const list = dependencyCandidates(tasks, "target");
    expect(list.map((c) => [c.id, c.eligible])).toEqual([
      ["open", true],
      ["running", true],
      ["child", false],
      ["grandchild", false],
      ["other", true],
    ]);
    expect(list[2]?.ineligibleReason).toBe("child already depends on target, so they already run in order");
    expect(() => dependencyCandidates(tasks, "nope")).toThrow('no task "nope"');
  });

  test("dependsOn follows chains and survives a cycle in bad data", () => {
    expect(dependsOn(tasks, "grandchild", "open")).toBe(true);
    expect(dependsOn(tasks, "open", "grandchild")).toBe(false);
    const loop = [t("a", { dependencies: ["b"] }), t("b", { dependencies: ["a"] })];
    expect(dependsOn(loop, "a", "zzz")).toBe(false);
  });
});

describe("setDependencies", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deps-"));
    path = join(dir, "tasks.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (tasks: Task[]) => writeFileSync(path, JSON.stringify(tasks));

  test("replaces the task's dependencies and reasons and touches no other task", () => {
    write([t("a"), t("b"), t("c", { dependencies: ["a"], dependencyReasons: { a: "old" } }), t("d", { dependencies: ["c"] })]);
    const store = fileStore(path);
    const task = setDependencies(store, "c", { b: "  both edit queue-view.ts  " });
    expect(task.dependencies).toEqual(["b"]);
    expect(task.dependencyReasons).toEqual({ b: "both edit queue-view.ts" });
    const saved = store.load();
    expect(saved.find((x) => x.id === "d")?.dependencies).toEqual(["c"]);
    expect(saved.find((x) => x.id === "a")).toEqual(t("a"));
    expect(setDependencies(store, "c", {}).dependencyReasons).toBeUndefined();
  });

  test("refuses unknown, completed, self and deadlocking dependencies, and writes nothing", () => {
    write([t("a", { status: "completed" }), t("b"), t("c", { dependencies: ["b"] })]);
    const before = readFileSync(path, "utf8");
    const store = fileStore(path);
    expect(checkDependencies(store.load(), "b", { gone: "x", a: "x", b: "x", c: "x", ok: " " })).toEqual([
      'no task "gone" (deleted tasks are never dependencies)',
      '"a" is completed, so there is nothing to wait for',
      "b cannot depend on itself",
      '"c" already depends on b; the reverse would deadlock them',
      'no task "ok" (deleted tasks are never dependencies)',
      'the reason for "ok" must be a non-empty line',
    ]);
    expect(() => setDependencies(store, "b", { c: "clash" })).toThrow("deadlock");
    expect(() => setDependencies(store, "nope", {})).toThrow('no task "nope"');
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("deps-cli", () => {
  let dir: string;
  let deps: CliDeps;
  let settings: Settings;
  let open: PullRequest[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deps-cli-"));
    const path = join(dir, "tasks.json");
    writeFileSync(path, JSON.stringify([t("a", { status: "pr", project: "p" }), t("b", { project: "p", mode: "hands-off" }), t("c", { status: "completed" })]));
    settings = DEFAULT_SETTINGS;
    open = [];
    deps = {
      store: fileStore(path),
      settings: () => settings,
      prs: { list: async () => open },
      attempts: { get: () => undefined, record: () => {}, exceeded: () => false, flagForHuman: async () => {}, sync: () => {}, remove: () => false },
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("candidates lists what to compare and the mode the doubt rule goes by", async () => {
    const fresh = JSON.parse((await runCli(["candidates"], deps)).output);
    expect(fresh.mode).toBe("hands-on");
    expect(fresh.candidates.map((c: { id: string }) => c.id)).toEqual(["a", "b"]);
    settings = { ...DEFAULT_SETTINGS, projects: { p: "hands-off" } };
    expect(JSON.parse((await runCli(["candidates", "--project", "p"], deps)).output).mode).toBe("hands-off");
    settings = DEFAULT_SETTINGS;
    const existing = JSON.parse((await runCli(["candidates", "--for", "b"], deps)).output);
    expect(existing).toMatchObject({ for: "b", mode: "hands-off" });
    expect(existing.candidates.map((c: { id: string }) => c.id)).toEqual(["a"]);
  });

  test("set writes valid dependencies and rejects the rest with exit 1", async () => {
    const good = await runCli(["set", "b", JSON.stringify({ a: "both edit loop.ts" })], deps);
    expect(good.exitCode).toBe(0);
    expect(JSON.parse(good.output)).toEqual({ id: "b", dependencies: ["a"], dependencyReasons: { a: "both edit loop.ts" } });
    expect(deps.store.load().find((x) => x.id === "b")?.dependencies).toEqual(["a"]);
    const bad = await runCli(["set", "b", JSON.stringify({ c: "x" })], deps);
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain("completed");
    expect((await runCli(["set", "b", "[1]"], deps)).exitCode).toBe(1);
    expect((await runCli(["set", "b", "{nope"], deps)).output).toContain("JSON object");
    expect(deps.store.load().find((x) => x.id === "b")?.dependencies).toEqual(["a"]);
  });

  test("blockers reports what the task still waits for", async () => {
    await runCli(["set", "b", JSON.stringify({ a: "needs a" })], deps);
    const out = JSON.parse((await runCli(["blockers", "b"], deps)).output);
    expect(out).toEqual({ id: "b", waiting: [{ id: "a", met: false, mode: "hands-on", waitingFor: "merge", text: "waiting on a to merge" }] });
    expect(JSON.parse((await runCli(["blockers", "a"], deps)).output).waiting).toEqual([]);
    expect((await runCli(["blockers", "nope"], deps)).exitCode).toBe(1);
  });

  test("an unknown command or missing argument prints the usage", async () => {
    for (const args of [[], ["nope"], ["set"], ["blockers"]]) {
      const res = await runCli(args, deps);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("usage:");
    }
    expect((await runCli(["candidates", "--for", "zzz"], deps)).output).toBe('no task "zzz"');
  });
});
