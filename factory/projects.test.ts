import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPaths, projectSlug, registryPath } from "./home.ts";
import { dependencyCycle, dependencyFolders, identifyRepo, isFinished, projectContext, projectRegistry, registerRepo, repoNameFromRemote, waitingOnProjects } from "./projects.ts";
import { bunGitIn } from "./worktrees.ts";

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "factory-home-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const reg = () => projectRegistry(registryPath(home));
const AT = new Date("2026-11-19T12:00:00.000Z");
const task = (id: string, status: string) => ({ id, title: id, description: "d", acceptanceCriteria: ["c"], dependencies: [], status });

describe("home", () => {
  test("a project's files live in its own folder under the home, named after the repository", () => {
    expect(projectSlug("acme/shop-api")).toBe("acme__shop-api");
    const paths = projectPaths("acme/shop-api", "/h");
    expect(paths.dir).toBe("/h/projects/acme__shop-api");
    expect(paths.tasks).toBe("/h/projects/acme__shop-api/tasks.json");
    expect(paths.worktrees).toBe("/h/projects/acme__shop-api/worktrees");
  });
});

describe("registry", () => {
  test("starts empty; add registers a project once and updates a moved checkout", () => {
    const r = reg();
    expect(r.list()).toEqual([]);
    expect(r.add({ name: "acme/api", path: "/a" }, AT)).toEqual({ name: "acme/api", path: "/a", dependsOn: [], paused: false, addedAt: AT.toISOString() });
    r.add({ name: "acme/api", path: "/a" });
    expect(r.list()).toHaveLength(1);
    expect(r.add({ name: "acme/api", path: "/moved" }).path).toBe("/moved");
    expect(reg().get("acme/api")?.path).toBe("/moved");
    expect(() => r.add({ name: "my project", path: "/x" })).toThrow("owner/repo");
  });

  test("setDependsOn refuses unknown projects, itself and cycles", () => {
    const r = reg();
    for (const n of ["acme/a", "acme/b", "acme/c"]) r.add({ name: n, path: `/${n}` });
    expect(r.setDependsOn("acme/b", ["acme/a", "acme/a"]).dependsOn).toEqual(["acme/a"]);
    r.setDependsOn("acme/c", ["acme/b"]);
    expect(() => r.setDependsOn("acme/a", ["acme/c"])).toThrow("acme/c already waits on acme/a");
    expect(() => r.setDependsOn("acme/a", ["acme/a"])).toThrow("itself");
    expect(() => r.setDependsOn("acme/a", ["acme/zzz"])).toThrow('no project "acme/zzz"');
    expect(() => r.setDependsOn("acme/zzz", [])).toThrow('no project "acme/zzz"');
    expect(dependencyCycle(r.list(), "acme/a", ["acme/b"])).toBe("acme/b");
    expect(dependencyCycle(r.list(), "acme/c", ["acme/a"])).toBeNull();
  });

  test("remove drops the project and every dependency on it; pause is per project", () => {
    const r = reg();
    r.add({ name: "acme/a", path: "/a" });
    r.add({ name: "acme/b", path: "/b" });
    r.setDependsOn("acme/b", ["acme/a"]);
    expect(r.setPaused("acme/b", true).paused).toBe(true);
    expect(r.remove("acme/a")).toBe(true);
    expect(r.remove("acme/a")).toBe(false);
    expect(r.list()).toMatchObject([{ name: "acme/b", dependsOn: [], paused: true }]);
  });

  test("a registry file that is not a list of projects is rejected", () => {
    writeFileSync(registryPath(home), JSON.stringify([{ name: "x" }]));
    expect(() => reg().list()).toThrow("list of projects");
  });

  test("a project without allowedCommands loads with an empty list; setting them leaves the other fields alone", () => {
    const stored = { name: "acme/api", path: "/a", dependsOn: ["acme/dep"], paused: true, addedAt: AT.toISOString() };
    writeFileSync(registryPath(home), JSON.stringify([stored]));
    expect(reg().get("acme/api")?.allowedCommands).toEqual([]);
    const updated = reg().setAllowedCommands("acme/api", ["conda", "python", "pytest"]);
    expect(updated.allowedCommands).toEqual(["conda", "python", "pytest"]);
    const { allowedCommands, ...rest } = reg().get("acme/api")!;
    expect(rest).toEqual(stored); // name, path, dependsOn, paused and addedAt are untouched
    expect(reg().setAllowedCommands("acme/api", []).allowedCommands).toEqual([]);
  });

  test("setAllowedCommands refuses a non-bare or dangerous entry, names it, and keeps the stored list", () => {
    const r = reg();
    r.add({ name: "acme/api", path: "/a" });
    r.setAllowedCommands("acme/api", ["conda"]);
    for (const bad of ["rm -rf", "Bash(x)", "*", "sudo", "sh", "bash", "zsh", "env", "xargs", "eval"]) {
      expect(() => r.setAllowedCommands("acme/api", ["conda", bad])).toThrow(bad);
      expect(reg().get("acme/api")?.allowedCommands).toEqual(["conda"]);
    }
    expect(() => r.setAllowedCommands("acme/zzz", ["conda"])).toThrow('no project "acme/zzz"');
  });
});

describe("repositories", () => {
  test("a GitHub remote gives the project's name, https or ssh, with or without .git", () => {
    expect(repoNameFromRemote("https://github.com/acme/shop-api.git\n")).toBe("acme/shop-api");
    expect(repoNameFromRemote("https://github.com/acme/shop-api")).toBe("acme/shop-api");
    expect(repoNameFromRemote("git@github.com:acme/shop.web.git")).toBe("acme/shop.web");
    expect(repoNameFromRemote("https://gitlab.com/acme/shop-api.git")).toBeNull();
  });

  test("identifyRepo names a repo from a sub-folder and from one of its worktrees; registerRepo adds it once", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
    try {
      await bunGitIn(["init", "-q", "-b", "main"], root);
      await bunGitIn(["remote", "add", "origin", "git@github.com:acme/shop-api.git"], root);
      writeFileSync(join(root, "a.txt"), "a");
      mkdirSync(join(root, "src"));
      await bunGitIn(["add", "."], root);
      await bunGitIn(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], root);
      expect(await identifyRepo(join(root, "src"))).toEqual({ name: "acme/shop-api", path: root });
      const wt = join(home, "wt");
      await bunGitIn(["worktree", "add", "--detach", wt, "HEAD"], root);
      expect(await identifyRepo(wt)).toEqual({ name: "acme/shop-api", path: root });
      const r = reg();
      expect((await registerRepo(wt, r)).name).toBe("acme/shop-api");
      await registerRepo(root, r);
      expect(r.list()).toHaveLength(1);
      await expect(identifyRepo(home)).rejects.toThrow("not inside a git repository");
      await bunGitIn(["remote", "remove", "origin"], root);
      await expect(identifyRepo(root)).rejects.toThrow("no GitHub remote");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dependencyFolders finds installed dependencies at the root and one level down", () => {
    const root = mkdtempSync(join(tmpdir(), "deps-folders-"));
    try {
      expect(dependencyFolders(root)).toEqual([]);
      mkdirSync(join(root, "node_modules"));
      mkdirSync(join(root, "viz", "node_modules"), { recursive: true });
      mkdirSync(join(root, "src"));
      expect(dependencyFolders(root)).toEqual(["node_modules", "viz/node_modules"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("project context", () => {
  test("creates the project's folder and an empty queue, and stamps every task with the project", () => {
    const project = reg().add({ name: "acme/api", path: "/a" });
    const ctx = projectContext(project, home);
    expect(readFileSync(ctx.paths.tasks, "utf8")).toBe("[]\n");
    writeFileSync(ctx.paths.tasks, JSON.stringify([{ ...task("t", "pending"), project: "something else" }]));
    expect(ctx.store.load()[0]?.project).toBe("acme/api");
    ctx.store.setStatus("t", "in_progress");
    expect(existsSync(ctx.paths.tasks)).toBe(true);
    expect(ctx.store.load()[0]?.status).toBe("in_progress");
  });

  test("a project waits on each dependency that still has an unfinished task", () => {
    const r = reg();
    const a = projectContext(r.add({ name: "acme/a", path: "/a" }), home);
    r.add({ name: "acme/b", path: "/b" });
    r.add({ name: "acme/x", path: "/x" });
    const x = r.setDependsOn("acme/x", ["acme/a", "acme/b"]);
    // a: empty queue = finished. b: no queue yet = nothing to wait for.
    expect(waitingOnProjects(x, r, home)).toEqual([]);
    writeFileSync(a.paths.tasks, JSON.stringify([task("t1", "completed"), task("t2", "pr")]));
    expect(waitingOnProjects(x, r, home)).toEqual(["acme/a"]);
    writeFileSync(a.paths.tasks, JSON.stringify([task("t1", "completed"), task("t2", "completed")]));
    expect(waitingOnProjects(x, r, home)).toEqual([]);
    writeFileSync(a.paths.tasks, "{broken");
    expect(waitingOnProjects(x, r, home)).toEqual(["acme/a"]);
    r.remove("acme/a");
    expect(waitingOnProjects({ ...x, dependsOn: ["acme/a"] }, r, home)).toEqual([]);
    expect(isFinished([])).toBe(true);
  });
});
