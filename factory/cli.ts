// The factory's command. `factory install` puts a launcher for it in the factory's home, so skills and people can
// call it from any repository:
//
//   factory start                 run the factory: one loop per registered project
//   factory install               install the launcher and the skills for this user, and move old in-repo data
//   factory register [path]       make the repository at path (default: here) a project
//   factory projects              list the projects
//   factory tasks-file            print the path of this repository's task queue (registers it if needed)
//   factory commands [set <...>]  show or replace the extra commands this repository's agents may run
//   factory deps <...>            the dependency commands (candidates, set, blockers) for this repository

import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCli as runDepsCli } from "./deps-cli.ts";
import { factoryHome, launcherPath, lockPath, projectPaths, registryPath, settingsPath } from "./home.ts";
import { acquireLoopLock } from "./loop-lock.ts";
import { type Project, projectContext, projectRegistry, type ProjectRegistry, registerRepo } from "./projects.ts";
import { settingsStore } from "./settings.ts";
import { projectRunner, supervise } from "./supervisor.ts";

const FACTORY_DIR = import.meta.dir;
const USAGE = `usage:
  factory start
  factory install
  factory register [path]
  factory projects
  factory tasks-file
  factory commands
  factory commands set <name>...
  factory deps candidates [--for <task-id>]
  factory deps set <task-id> '{"<dependency-id>": "<one-line reason>"}'
  factory deps blockers <task-id>`;

export interface CliEnv {
  home: string;
  /** The folder the command was run in. */
  cwd: string;
  /** The user's home, where ~/.claude/skills lives. */
  userHome: string;
  registry: ProjectRegistry;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Writes the launcher: a small script that runs this command with bun, from anywhere. */
export function installLauncher(home: string, bun: string = process.execPath): string {
  const path = launcherPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec "${bun}" "${join(FACTORY_DIR, "cli.ts")}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Links every skill into the user's skills folder. A name already taken by something that is not a link is left alone. */
export function installSkills(userHome: string, skillsDir: string = join(FACTORY_DIR, "skills")): { linked: string[]; skipped: string[] } {
  const target = join(userHome, ".claude", "skills");
  mkdirSync(target, { recursive: true });
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(skillsDir)) {
    if (!existsSync(join(skillsDir, name, "SKILL.md"))) continue;
    const link = join(target, name);
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(link);
    } catch {
      stat = null;
    }
    if (stat?.isSymbolicLink()) {
      linked.push(name);
      continue;
    }
    if (stat) {
      skipped.push(name);
      continue;
    }
    symlinkSync(join(skillsDir, name), link);
    linked.push(name);
  }
  return { linked, skipped };
}

/** The old in-repo data files, by where they go in the factory's home. */
const LEGACY = { tasks: "tasks.json", audit: "audit-log.jsonl", attempts: "pr-attempts.json" } as const;

/**
 * Moves the data the factory used to keep inside its own repository into the factory's home: the queue, the audit
 * log and the attempt counts into the project's folder, the settings into the home. Nothing is overwritten: a
 * file that already exists in the home wins and the old one is left where it is. Returns what was moved.
 */
export function migrateLegacy(project: Project, home: string, legacyDir: string = FACTORY_DIR): string[] {
  const paths = projectPaths(project.name, home);
  mkdirSync(paths.dir, { recursive: true });
  const moved: string[] = [];
  const move = (from: string, to: string, emptyOk: boolean) => {
    if (!existsSync(from)) return;
    // A queue the context just created empty counts as not there yet.
    const targetIsFresh = !existsSync(to) || (emptyOk && Bun.file(to).size <= 3);
    if (!targetIsFresh) return;
    try {
      renameSync(from, to);
    } catch {
      cpSync(from, to); // another disk: copy, and leave the original in place
    }
    moved.push(from);
  };
  move(join(legacyDir, LEGACY.tasks), paths.tasks, true);
  move(join(legacyDir, LEGACY.audit), paths.audit, false);
  move(join(legacyDir, LEGACY.attempts), paths.attempts, false);
  move(join(legacyDir, "settings.json"), settingsPath(home), false);
  return moved;
}

export async function runCli(args: string[], env: CliEnv): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === "install") {
      const launcher = installLauncher(env.home);
      const { linked, skipped } = installSkills(env.userHome);
      env.out(`launcher: ${launcher}`);
      env.out(`skills linked into ${join(env.userHome, ".claude", "skills")}: ${linked.length}`);
      if (skipped.length > 0) env.out(`skills left alone (a folder of that name already exists there): ${skipped.join(", ")}`);
      // The factory's own repository is its first project; its old in-repo data moves to the home.
      const own = await registerRepo(resolve(FACTORY_DIR, ".."), env.registry).catch(() => null);
      if (own) {
        const moved = migrateLegacy(own, env.home);
        env.out(moved.length > 0 ? `moved into ${env.home}: ${moved.join(", ")}` : `${own.name} is registered; nothing to move`);
      }
      return 0;
    }
    if (command === "register") {
      const project = await registerRepo(resolve(env.cwd, rest[0] ?? "."), env.registry);
      projectContext(project, env.home);
      env.out(`${project.name} is a project (${project.path})`);
      return 0;
    }
    if (command === "projects") {
      env.out(JSON.stringify(env.registry.list(), null, 2));
      return 0;
    }
    if (command === "tasks-file") {
      const project = await registerRepo(env.cwd, env.registry);
      env.out(projectContext(project, env.home).paths.tasks);
      return 0;
    }
    if (command === "commands") {
      const project = await registerRepo(env.cwd, env.registry);
      const [sub, ...names] = rest;
      if (sub === "set") {
        const updated = env.registry.setAllowedCommands(project.name, names);
        env.out((updated.allowedCommands ?? []).join("\n"));
        return 0;
      }
      if (sub === undefined) {
        env.out((env.registry.get(project.name)?.allowedCommands ?? []).join("\n"));
        return 0;
      }
      env.err("usage:\n  factory commands\n  factory commands set <name>...");
      return 1;
    }
    if (command === "deps") {
      const project = await registerRepo(env.cwd, env.registry);
      const ctx = projectContext(project, env.home);
      const settings = settingsStore(settingsPath(env.home));
      // A task takes its project's mode, so a not-yet-written task of this repository does too.
      const depArgs = rest[0] === "candidates" && !rest.includes("--project") ? [...rest, "--project", project.name] : rest;
      const result = await runDepsCli(depArgs, { store: ctx.store, settings: () => settings.load(), prs: ctx.prs, attempts: ctx.attempts });
      (result.exitCode === 0 ? env.out : env.err)(result.output);
      return result.exitCode;
    }
    if (command === "start") {
      const lock = acquireLoopLock(lockPath(env.home));
      if (!lock.ok) {
        env.err(`the factory is already running (pid ${lock.holder.pid}, started ${lock.holder.startedAt})`);
        return 1;
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const log = (m: string) => env.out(`[factory] ${m}`);
        if (env.registry.list().length === 0) log("no projects yet: run /take_order in a repository, or `factory register <path>`");
        await supervise({ registry: env.registry, runProject: projectRunner(env.registry, env.home), log, signal: controller.signal });
        return 0;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        lock.release();
      }
    }
    env.err(USAGE);
    return 1;
  } catch (e) {
    env.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  const home = factoryHome();
  mkdirSync(home, { recursive: true });
  process.exit(
    await runCli(process.argv.slice(2), {
      home,
      cwd: process.cwd(),
      userHome: homedir(),
      registry: projectRegistry(registryPath(home)),
      out: (t) => console.log(t),
      err: (t) => console.error(t),
    }),
  );
}
