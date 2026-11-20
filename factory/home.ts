// Where the central factory keeps its data: one home folder, outside every repository it manages, with one
// sub-folder per project (a project is a GitHub repository). A managed repository only ever receives branches and
// pull requests; no factory file is written inside it.

import { homedir } from "node:os";
import { join } from "node:path";

/** The factory's home. `PSTACK_FACTORY_HOME` moves it (tests point it at a temp folder). */
export const factoryHome = (): string => process.env.PSTACK_FACTORY_HOME ?? join(homedir(), ".pstack-factory");

/** A project's name ("owner/repo") as a folder name. */
export const projectSlug = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "__");

export interface ProjectPaths {
  /** The project's folder under the home. */
  dir: string;
  tasks: string;
  audit: string;
  attempts: string;
  loopState: string;
  /** One git worktree per running agent lives here. */
  worktrees: string;
}

export function projectPaths(name: string, home: string = factoryHome()): ProjectPaths {
  const dir = join(home, "projects", projectSlug(name));
  return {
    dir,
    tasks: join(dir, "tasks.json"),
    audit: join(dir, "audit-log.jsonl"),
    attempts: join(dir, "pr-attempts.json"),
    loopState: join(dir, "loop-state.json"),
    worktrees: join(dir, "worktrees"),
  };
}

export const registryPath = (home: string = factoryHome()): string => join(home, "projects.json");
export const settingsPath = (home: string = factoryHome()): string => join(home, "settings.json");
export const lockPath = (home: string = factoryHome()): string => join(home, "loop.lock");
/** The command the skills call, created by `factory install`. */
export const launcherPath = (home: string = factoryHome()): string => join(home, "bin", "factory");
