// One git worktree per running agent, so several agents can work in the same repo without sharing a checkout.
// A worktree starts detached at origin/main; the agent creates or checks out its own branch inside it.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GhResult } from "./prs.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const WORKTREES_DIR = join(REPO_ROOT, ".worktrees");

/**
 * Paths a fresh worktree lacks because git does not track them, linked back to the main checkout: the task queue
 * the skills read, and the installed dependencies the checks need.
 */
export const LINKED_PATHS = ["factory/tasks.json", "node_modules", "viz/node_modules"];

export interface Workspaces {
  /** Makes a fresh worktree called `name` and returns its path. Replaces a leftover one of the same name. */
  create(name: string): Promise<string>;
  /** Removes the worktree and keeps its agent transcripts with the main checkout's. Fine when it does not exist. */
  remove(name: string): Promise<void>;
  /** Removes every worktree left behind by an earlier loop. */
  prune(): Promise<void>;
}

export type GitRunner = (args: string[], cwd?: string) => Promise<GhResult>;

export const bunGitIn: GitRunner = async (args, cwd = REPO_ROOT) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
};

/** The folder Claude Code keeps a checkout's transcripts in: its path with every non-alphanumeric turned into "-". */
export const claudeProjectDir = (path: string, home: string = homedir()): string =>
  join(home, ".claude", "projects", path.replace(/[^A-Za-z0-9]/g, "-"));

/** A name safe to use as a folder and in a branch-free worktree path. */
export const worktreeName = (kind: "cook" | "pr", target: string | number): string => `${kind}-${String(target).replace(/[^A-Za-z0-9._-]/g, "-")}`;

/** Moves a finished worktree's transcripts next to the main checkout's, so history and take-over still find them. */
export function adoptTranscripts(worktree: string, root: string = REPO_ROOT, home: string = homedir()): number {
  const from = claudeProjectDir(worktree, home);
  if (!existsSync(from)) return 0;
  const to = claudeProjectDir(root, home);
  mkdirSync(to, { recursive: true });
  let moved = 0;
  for (const name of readdirSync(from)) {
    if (existsSync(join(to, name))) continue;
    renameSync(join(from, name), join(to, name));
    moved += 1;
  }
  rmSync(from, { recursive: true, force: true });
  return moved;
}

export interface WorktreeOptions {
  root?: string;
  dir?: string;
  git?: GitRunner;
  linked?: string[];
  home?: string;
}

export function gitWorktrees({ root = REPO_ROOT, dir = join(root, ".worktrees"), git = bunGitIn, linked = LINKED_PATHS, home = homedir() }: WorktreeOptions = {}): Workspaces {
  const remove = async (name: string) => {
    const path = join(dir, name);
    if (existsSync(path)) {
      await git(["worktree", "remove", "--force", path], root);
      rmSync(path, { recursive: true, force: true });
    }
    await git(["worktree", "prune"], root);
    adoptTranscripts(path, root, home);
  };
  return {
    async create(name) {
      await remove(name);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      await git(["fetch", "origin"], root);
      let added = await git(["worktree", "add", "--detach", path, "origin/main"], root);
      // No origin/main (a repo with no remote yet): start from the current commit instead.
      if (added.exitCode !== 0) added = await git(["worktree", "add", "--detach", path, "HEAD"], root);
      if (added.exitCode !== 0) throw new Error(`could not create worktree ${name}: ${added.stderr.trim() || "git failed"}`);
      for (const rel of linked) {
        const source = join(root, rel);
        const target = join(path, rel);
        if (!existsSync(source) || existsSync(target)) continue;
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(source, target);
      }
      return path;
    },
    remove,
    async prune() {
      if (existsSync(dir)) for (const name of readdirSync(dir)) await remove(name);
      await git(["worktree", "prune"], root);
    },
  };
}
