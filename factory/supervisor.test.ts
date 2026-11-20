import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLauncher, installSkills, migrateLegacy, runCli, type CliEnv } from "./cli.ts";
import { launcherPath, projectPaths, registryPath, settingsPath } from "./home.ts";
import { projectRegistry } from "./projects.ts";
import { PROJECT_POLL_MS, projectCommands, supervise } from "./supervisor.ts";
import { bunGitIn } from "./worktrees.ts";

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "factory-sup-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const reg = () => projectRegistry(registryPath(home));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("supervise", () => {
  /** A sleep the test steps by hand: each `tick()` ends the supervisor's current wait. */
  function stepper() {
    let release = () => {};
    const waits: number[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        waits.push(ms);
        release = resolve;
      });
    return {
      sleep,
      waits,
      tick: async () => {
        release();
        await settle();
      },
    };
  }

  test("runs one loop per project, picks up a new project, and stops the loop of a removed one", async () => {
    const r = reg();
    r.add({ name: "acme/a", path: "/a" });
    const live = new Set<string>();
    const starts: string[] = [];
    const controller = new AbortController();
    const s = stepper();
    const done = supervise({
      registry: r,
      signal: controller.signal,
      sleep: s.sleep,
      runProject: (project, signal) =>
        new Promise<void>((resolve) => {
          starts.push(project.name);
          live.add(project.name);
          signal.addEventListener("abort", () => {
            live.delete(project.name);
            resolve();
          });
        }),
    });
    await settle();
    expect([...live]).toEqual(["acme/a"]);
    expect(s.waits).toEqual([PROJECT_POLL_MS]);

    r.add({ name: "acme/b", path: "/b" });
    await s.tick();
    expect([...live].toSorted()).toEqual(["acme/a", "acme/b"]);
    await s.tick();
    expect(starts).toEqual(["acme/a", "acme/b"]); // a running project is not started twice

    r.remove("acme/a");
    await s.tick();
    expect([...live]).toEqual(["acme/b"]);

    controller.abort();
    await done;
    expect([...live]).toEqual([]);
  });

  test("a loop that crashes is logged and started again on the next poll; the others keep running", async () => {
    const r = reg();
    r.add({ name: "acme/a", path: "/a" });
    r.add({ name: "acme/b", path: "/b" });
    const starts: string[] = [];
    const logs: string[] = [];
    const controller = new AbortController();
    const s = stepper();
    const done = supervise({
      registry: r,
      signal: controller.signal,
      sleep: s.sleep,
      log: (m) => logs.push(m),
      runProject: (project, signal) => {
        starts.push(project.name);
        if (project.name === "acme/a" && starts.filter((n) => n === "acme/a").length === 1) return Promise.reject(new Error("boom"));
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
    });
    await settle();
    expect(logs.some((m) => m.includes("the loop for acme/a failed: boom"))).toBe(true);
    await s.tick();
    expect(starts).toEqual(["acme/a", "acme/b", "acme/a"]);
    controller.abort();
    await done;
  });
});

describe("projectCommands", () => {
  const allowed = (cmd: string[]): string => cmd[cmd.indexOf("--allowedTools") + 1] ?? "";

  test("adds a project's allowedCommands to all three agent commands, read fresh each call", () => {
    const r = reg();
    r.add({ name: "acme/a", path: "/a" });
    r.add({ name: "acme/b", path: "/b" });

    for (const kind of ["cook", "review", "patch"] as const) {
      const tools = allowed(projectCommands("acme/a", r, home)[kind]);
      for (const name of ["conda", "python", "pytest"]) expect(tools).not.toContain(`Bash(${name} *)`);
    }

    // A change to the registry reaches the very next build, no loop restart.
    r.setAllowedCommands("acme/a", ["conda", "python", "pytest"]);
    for (const kind of ["cook", "review", "patch"] as const) {
      const tools = allowed(projectCommands("acme/a", r, home)[kind]);
      for (const name of ["conda", "python", "pytest"]) {
        expect(tools).toContain(`Bash(${name} *)`);
        expect(tools).toContain(`Bash(${name})`);
      }
      // Another project's commands carry none of them.
      const other = allowed(projectCommands("acme/b", r, home)[kind]);
      for (const name of ["conda", "python", "pytest"]) expect(other).not.toContain(`Bash(${name} *)`);
    }
  });
});

describe("factory command", () => {
  let repo: string;
  let userHome: string;
  let out: string[];
  let err: string[];
  let env: CliEnv;
  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "factory-repo-")));
    userHome = realpathSync(mkdtempSync(join(tmpdir(), "factory-user-")));
    await bunGitIn(["init", "-q", "-b", "main"], repo);
    await bunGitIn(["remote", "add", "origin", "https://github.com/acme/shop-api.git"], repo);
    out = [];
    err = [];
    env = { home, cwd: repo, userHome, registry: reg(), out: (t) => out.push(t), err: (t) => err.push(t) };
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  test("tasks-file registers the repository it is run in and prints its queue in the factory's home", async () => {
    expect(await runCli(["tasks-file"], env)).toBe(0);
    const path = projectPaths("acme/shop-api", home).tasks;
    expect(out).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("[]\n");
    expect(reg().list().map((p) => [p.name, p.path])).toEqual([["acme/shop-api", repo]]);
    expect(existsSync(join(repo, "factory"))).toBe(false); // nothing is written inside the repository
  });

  test("register adds a repository by path; projects lists them; a folder that is no repository is an error", async () => {
    expect(await runCli(["register", repo], { ...env, cwd: home })).toBe(0);
    expect(out[0]).toBe(`acme/shop-api is a project (${repo})`);
    out.length = 0;
    await runCli(["projects"], env);
    expect(JSON.parse(out[0] ?? "[]")).toMatchObject([{ name: "acme/shop-api", dependsOn: [], paused: false }]);
    expect(await runCli(["register", home], env)).toBe(1);
    expect(err[0]).toContain("not inside a git repository");
  });

  test("deps runs against the repository's own queue and its project's mode", async () => {
    await runCli(["tasks-file"], env);
    const path = projectPaths("acme/shop-api", home).tasks;
    const t = (id: string, deps: string[] = []) => ({ id, title: id, description: "d", acceptanceCriteria: ["c"], dependencies: deps, status: "pending" });
    writeFileSync(path, JSON.stringify([t("a"), t("b")]));
    writeFileSync(settingsPath(home), JSON.stringify({ projects: { "acme/shop-api": "hands-off" } }));
    out.length = 0;
    expect(await runCli(["deps", "candidates"], env)).toBe(0);
    const listed = JSON.parse(out[0] ?? "{}");
    expect(listed.mode).toBe("hands-off");
    expect(listed.candidates.map((c: { id: string }) => c.id)).toEqual(["a", "b"]);
    expect(await runCli(["deps", "set", "b", JSON.stringify({ a: "both edit x.ts" })], env)).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))[1].dependencies).toEqual(["a"]);
    expect(await runCli(["deps", "set", "a", JSON.stringify({ b: "x" })], env)).toBe(1);
    expect(err.at(-1)).toContain("deadlock");
  });

  test("commands shows, replaces and clears the repository's project's allowed commands", async () => {
    expect(await runCli(["commands", "set", "conda", "python", "pytest"], env)).toBe(0);
    expect(out).toEqual(["conda\npython\npytest"]);
    out.length = 0;
    expect(await runCli(["commands"], env)).toBe(0);
    expect(out).toEqual(["conda\npython\npytest"]);
    expect(reg().get("acme/shop-api")?.allowedCommands).toEqual(["conda", "python", "pytest"]);
    out.length = 0;
    expect(await runCli(["commands", "set"], env)).toBe(0); // no names clears the list
    expect(reg().get("acme/shop-api")?.allowedCommands).toEqual([]);
    expect(await runCli(["commands", "set", "sudo"], env)).toBe(1);
    expect(err.at(-1)).toContain("sudo");
  });

  test("commands in a folder that is no repository exits non-zero with a message", async () => {
    expect(await runCli(["commands"], { ...env, cwd: home })).toBe(1);
    expect(err.at(-1)).toContain("not inside a git repository");
    expect(await runCli(["commands", "set", "conda"], { ...env, cwd: home })).toBe(1);
  });

  test("an unknown command prints the usage", async () => {
    expect(await runCli(["nope"], env)).toBe(1);
    expect(err[0]).toContain("factory start");
  });

  test("the launcher is an executable script that runs the command with bun", () => {
    const path = installLauncher(home, "/usr/local/bin/bun");
    expect(path).toBe(launcherPath(home));
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain('exec "/usr/local/bin/bun" "');
    expect(text).toContain('/factory/cli.ts" "$@"');
    expect(lstatSync(path).mode & 0o111).not.toBe(0);
  });

  test("skills are linked for the user; a folder of the same name that is already there is left alone", () => {
    const skills = join(home, "skills");
    for (const name of ["cook", "remake", "notes"]) mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, "cook", "SKILL.md"), "cook");
    writeFileSync(join(skills, "remake", "SKILL.md"), "remake");
    mkdirSync(join(userHome, ".claude", "skills", "remake"), { recursive: true });
    expect(installSkills(userHome, skills)).toEqual({ linked: ["cook"], skipped: ["remake"] });
    expect(readFileSync(join(userHome, ".claude", "skills", "cook", "SKILL.md"), "utf8")).toBe("cook");
    expect(installSkills(userHome, skills)).toEqual({ linked: ["cook"], skipped: ["remake"] });
  });

  test("old in-repo data moves to the home once and never overwrites what is already there", async () => {
    await runCli(["tasks-file"], env);
    const project = reg().get("acme/shop-api")!;
    const legacy = join(home, "legacy");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "tasks.json"), '[{"id":"old"}]');
    writeFileSync(join(legacy, "audit-log.jsonl"), "{}\n");
    writeFileSync(join(legacy, "settings.json"), '{"agentCap":2}');
    const moved = migrateLegacy(project, home, legacy);
    expect(moved.map((p) => p.replace(`${legacy}/`, ""))).toEqual(["tasks.json", "audit-log.jsonl", "settings.json"]);
    const paths = projectPaths(project.name, home);
    expect(readFileSync(paths.tasks, "utf8")).toBe('[{"id":"old"}]');
    expect(readFileSync(settingsPath(home), "utf8")).toBe('{"agentCap":2}');
    expect(existsSync(join(legacy, "tasks.json"))).toBe(false);
    writeFileSync(join(legacy, "tasks.json"), '[{"id":"newer"}]');
    expect(migrateLegacy(project, home, legacy)).toEqual([]);
    expect(readFileSync(paths.tasks, "utf8")).toBe('[{"id":"old"}]');
  });
});
