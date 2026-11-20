// The projects the factory manages. A project IS a GitHub repository: exactly one per repository, named
// "owner/repo", never made up by hand. The registry records where each one is checked out, which other projects
// it depends on, and whether it is paused.
//
// A project that depends on another waits for it project-wide: none of its tasks may START until every task of
// the other project is completed. That gate is always "merged", whatever the modes: one repository can only see
// what is in another repository's main.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type AuditStore, auditStore } from "./audit-log.ts";
import { factoryHome, type ProjectPaths, projectPaths, registryPath } from "./home.ts";
import { type AttemptsStore, attemptsStore } from "./pr-attempts.ts";
import { type GhRunner, ghPrSource, type PrSource } from "./prs.ts";
import type { Task } from "./tasks.schema.ts";
import { fileStore, type TaskStore } from "./tasks.store.ts";
import { bunGitIn, type GitRunner, gitWorktrees, type Workspaces } from "./worktrees.ts";

export interface Project {
  /** "owner/repo" on GitHub. */
  name: string;
  /** Absolute path of the repository's main checkout on this machine. */
  path: string;
  /** Names of the projects that must have no unfinished task before this one may start a task. */
  dependsOn: string[];
  /** While true this project's loop starts nothing new. */
  paused: boolean;
  /** ISO 8601 timestamp. */
  addedAt: string;
  /** Extra bare commands this project's agents may run, on top of the factory's built-in list. Missing means none. */
  allowedCommands?: string[];
}

export interface ProjectRegistry {
  list(): Project[];
  get(name: string): Project | undefined;
  /** Adds the project, or updates the path of one already registered under that name. */
  add(project: Pick<Project, "name" | "path">, now?: Date): Project;
  remove(name: string): boolean;
  setPaused(name: string, paused: boolean): Project;
  /** Replaces what the project depends on. Throws on an unknown project, itself, or a cycle. */
  setDependsOn(name: string, dependsOn: string[]): Project;
  /**
   * Replaces the extra commands this project's agents may run. Each must be a bare command name; sudo and the
   * shells are refused. Throws naming the refused entry, and leaves the stored list unchanged.
   */
  setAllowedCommands(name: string, commands: string[]): Project;
}

const NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A single allowed command: a bare name only, so it cannot smuggle arguments, a path or a second command. */
const COMMAND_NAME = /^[A-Za-z0-9._-]+$/;
/** Commands that could run anything else, so a project may never add them. */
const FORBIDDEN_COMMANDS = new Set(["sudo", "sh", "bash", "zsh", "env", "xargs", "eval"]);

/** Throws naming `command` when it is not a bare name, or is one that could run other commands. */
export function checkAllowedCommand(command: string): void {
  if (!COMMAND_NAME.test(command)) throw new Error(`cannot allow "${command}": a command must be a bare name like "pytest"`);
  if (FORBIDDEN_COMMANDS.has(command)) throw new Error(`cannot allow "${command}": it can run other commands`);
}

function isProject(v: unknown): v is Project {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    NAME.test(p.name) &&
    typeof p.path === "string" &&
    p.path !== "" &&
    Array.isArray(p.dependsOn) &&
    p.dependsOn.every((d) => typeof d === "string") &&
    typeof p.paused === "boolean" &&
    typeof p.addedAt === "string" &&
    (p.allowedCommands === undefined || (Array.isArray(p.allowedCommands) && p.allowedCommands.every((c) => typeof c === "string")))
  );
}

/** The project `from` would end up waiting on itself through; null when `dependsOn` is safe. */
export function dependencyCycle(projects: Project[], name: string, dependsOn: string[]): string | null {
  const next = new Map(projects.map((p) => [p.name, p.name === name ? dependsOn : p.dependsOn]));
  const seen = new Set<string>();
  const reaches = (from: string): boolean => {
    if (from === name) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (next.get(from) ?? []).some(reaches);
  };
  return dependsOn.find(reaches) ?? null;
}

export function projectRegistry(path: string = registryPath()): ProjectRegistry {
  const list = (): Project[] => {
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isProject)) throw new Error(`${path} must hold a list of projects`);
    // A project with no stored list reads as one that allows no extra commands.
    return parsed.map((p) => ({ ...p, allowedCommands: p.allowedCommands ?? [] }));
  };
  const write = (projects: Project[]) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(projects, null, 2)}\n`);
    renameSync(tmp, path); // atomic: readers never see a half-written file
  };
  const change = (name: string, fn: (p: Project, all: Project[]) => Project): Project => {
    const all = list();
    const i = all.findIndex((p) => p.name === name);
    const current = all[i];
    if (!current) throw new Error(`no project "${name}"`);
    const next = fn(current, all);
    all[i] = next;
    write(all);
    return next;
  };
  return {
    list,
    get: (name) => list().find((p) => p.name === name),
    add({ name, path: repoPath }, now = new Date()) {
      if (!NAME.test(name)) throw new Error(`a project is named "owner/repo", got "${name}"`);
      const all = list();
      const existing = all.find((p) => p.name === name);
      if (existing) {
        if (existing.path === repoPath) return existing;
        existing.path = repoPath;
        write(all);
        return existing;
      }
      const project: Project = { name, path: repoPath, dependsOn: [], paused: false, addedAt: now.toISOString() };
      write([...all, project]);
      return project;
    },
    remove(name) {
      const all = list();
      if (!all.some((p) => p.name === name)) return false;
      // Nothing may keep waiting on a project that is gone.
      write(all.filter((p) => p.name !== name).map((p) => ({ ...p, dependsOn: p.dependsOn.filter((d) => d !== name) })));
      return true;
    },
    setPaused: (name, paused) => change(name, (p) => ({ ...p, paused })),
    setDependsOn: (name, dependsOn) =>
      change(name, (p, all) => {
        const wanted = [...new Set(dependsOn)];
        for (const d of wanted) {
          if (d === name) throw new Error(`${name} cannot depend on itself`);
          if (!all.some((x) => x.name === d)) throw new Error(`no project "${d}"`);
        }
        const through = dependencyCycle(all, name, wanted);
        if (through) throw new Error(`${name} cannot depend on ${through}: ${through} already waits on ${name}`);
        return { ...p, dependsOn: wanted };
      }),
    setAllowedCommands: (name, commands) =>
      change(name, (p) => {
        for (const c of commands) checkAllowedCommand(c); // throws before anything is written
        return { ...p, allowedCommands: commands };
      }),
  };
}

const GITHUB_REMOTE = /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/** "owner/repo" from a GitHub remote URL (https or ssh); null for anything else. */
export function repoNameFromRemote(url: string): string | null {
  const m = GITHUB_REMOTE.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Which repository a folder belongs to: its GitHub name and the path of its main checkout. Works from a
 * sub-folder and from a git worktree. Throws when the folder is not a git repository with a GitHub `origin`.
 */
export async function identifyRepo(path: string, git: GitRunner = bunGitIn): Promise<Pick<Project, "name" | "path">> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  if (common.exitCode !== 0) throw new Error(`${path} is not inside a git repository`);
  // The shared .git folder sits in the main checkout, also when `path` is one of its worktrees.
  const root = resolve(common.stdout.trim(), "..");
  const remote = await git(["remote", "get-url", "origin"], root);
  const name = remote.exitCode === 0 ? repoNameFromRemote(remote.stdout) : null;
  if (!name) throw new Error(`${root} has no GitHub remote called origin, so it cannot be a project`);
  return { name, path: root };
}

/** Registers the repository a folder belongs to, if it is not registered yet, and returns its project. */
export async function registerRepo(path: string, registry: ProjectRegistry = projectRegistry(), git: GitRunner = bunGitIn): Promise<Project> {
  return registry.add(await identifyRepo(path, git));
}

/** A task store whose tasks all report the project they belong to, whatever the file says. */
function inProject(store: TaskStore, name: string): TaskStore {
  return { ...store, load: () => store.load().map((t) => ({ ...t, project: name })) };
}

/** Untracked folders a fresh worktree needs linked back to the main checkout: installed dependencies. */
export function dependencyFolders(root: string): string[] {
  const found: string[] = [];
  if (existsSync(join(root, "node_modules"))) found.push("node_modules");
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const nested = join(root, name, "node_modules");
    if (existsSync(nested) && statSync(nested).isDirectory()) found.push(join(name, "node_modules"));
  }
  return found;
}

export const ghIn = (cwd: string): GhRunner => async (args) => {
  const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
};

/** Everything needed to work on one project: its files in the factory's home, and gh and git run in its checkout. */
export interface ProjectContext {
  project: Project;
  paths: ProjectPaths;
  store: TaskStore;
  audit: AuditStore;
  attempts: AttemptsStore;
  prs: PrSource;
  gh: GhRunner;
  git: (args: string[]) => ReturnType<GitRunner>;
  workspaces: Workspaces;
}

export function projectContext(project: Project, home: string = factoryHome()): ProjectContext {
  const paths = projectPaths(project.name, home);
  mkdirSync(paths.dir, { recursive: true });
  if (!existsSync(paths.tasks)) writeFileSync(paths.tasks, "[]\n");
  const gh = ghIn(project.path);
  return {
    project,
    paths,
    store: inProject(fileStore(paths.tasks), project.name),
    audit: auditStore(paths.audit),
    attempts: attemptsStore(paths.attempts, gh),
    prs: ghPrSource(gh),
    gh,
    git: (args) => bunGitIn(args, project.path),
    workspaces: gitWorktrees({ root: project.path, dir: paths.worktrees, linked: dependencyFolders(project.path) }),
  };
}

/** A project is finished when it has no task left that is not completed. */
export const isFinished = (tasks: Pick<Task, "status">[]): boolean => tasks.every((t) => t.status === "completed");

/**
 * The projects this one is still waiting on: each dependency that has an unfinished task. Empty means its tasks
 * may start. A dependency that is no longer registered is not waited for.
 */
export function waitingOnProjects(project: Project, registry: ProjectRegistry, home: string = factoryHome()): string[] {
  return project.dependsOn.filter((name) => {
    if (!registry.get(name)) return false;
    const tasks = projectPaths(name, home).tasks;
    if (!existsSync(tasks)) return false;
    try {
      return !isFinished(fileStore(tasks).load());
    } catch {
      // An unreadable queue cannot be shown to be finished: keep waiting.
      return true;
    }
  });
}
