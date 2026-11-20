// Deleting a task: stop its agent, close its PR, delete its branch, erase every record of it, and release the
// tasks that depended on it. Run on the engineer's request only. Each side effect is injected so tests touch
// neither GitHub nor git.

import type { AuditStore } from "./audit-log.ts";
import type { AttemptsStore } from "./pr-attempts.ts";
import { bunGh, type GhResult, type GhRunner } from "./prs.ts";
import type { Task } from "./tasks.schema.ts";
import type { TaskStore } from "./tasks.store.ts";

/** What a task's records are keyed by: its id, and its pull request when it has one. */
export interface TaskTarget {
  taskId: string;
  pr?: { repo: string; number: number };
}

export interface DeleteDeps {
  store: TaskStore;
  audit: AuditStore;
  attempts: AttemptsStore;
  gh?: GhRunner;
  /** Runs `git` in the repo. */
  git?: (args: string[]) => Promise<GhResult>;
  /** Stops every agent working on the target; resolves to how many it stopped. */
  stopAgents?: (target: TaskTarget) => Promise<number>;
  /** Erases the run transcripts of the target; returns how many it erased. */
  removeTranscripts?: (target: TaskTarget) => number;
}

/** What a delete will do, for the confirm dialog. */
export interface DeletePreview {
  id: string;
  title: string;
  status: Task["status"];
  /** The open PR that will be closed, if any. */
  openPr: number | null;
  /** Tasks that list this one as a dependency and will be released from it. */
  dependents: string[];
}

export interface DeleteReport {
  id: string;
  stoppedAgents: number;
  closedPr: number | null;
  deletedBranches: string[];
  releasedDependents: string[];
  auditEntries: number;
  transcripts: number;
  /** Steps that failed without stopping the delete, in plain words. */
  warnings: string[];
}

export const DELETED_COMMENT = "Closing: this task was deleted from the factory.";

export const bunGit = async (args: string[]): Promise<GhResult> => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Process patterns of the loop's headless agents for a target, as `pgrep -f` extended regexes. */
export function agentPatterns(target: TaskTarget): string[] {
  const patterns = [`-p /cook ${escapeRegex(target.taskId)} --allowedTools`];
  if (target.pr) patterns.push(`-p /(taste_test|remake) ${target.pr.number} --allowedTools`);
  return patterns;
}

/** Stops the loop's agents for the target with SIGTERM, found by their command line. */
export async function pkillAgents(target: TaskTarget): Promise<number> {
  let stopped = 0;
  for (const pattern of agentPatterns(target)) {
    const proc = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "ignore" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGTERM");
        stopped += 1;
      } catch {
        // Already gone.
      }
    }
  }
  return stopped;
}

export function previewDelete(tasks: Task[], id: string): DeletePreview | null {
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  return {
    id,
    title: task.title,
    status: task.status,
    openPr: task.pr?.open ? task.pr.number : null,
    dependents: tasks.filter((t) => t.dependencies.includes(id)).map((t) => t.id),
  };
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Deletes the task's `<type>/<id>` branches, locally and on origin. Returns the names deleted. */
async function deleteBranches(id: string, git: NonNullable<DeleteDeps["git"]>, warnings: string[]): Promise<string[]> {
  const deleted: string[] = [];
  const local = await git(["for-each-ref", "--format=%(refname:short)", `refs/heads/*/${id}`]);
  const remote = await git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/origin/*/${id}`]);
  if (local.exitCode !== 0 || remote.exitCode !== 0) {
    warnings.push(`could not list branches: ${(local.stderr || remote.stderr).trim() || "git failed"}`);
    return deleted;
  }
  const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  for (const branch of lines(local.stdout)) {
    if (branch === current) {
      const away = await git(["checkout", "main"]);
      if (away.exitCode !== 0) {
        warnings.push(`branch ${branch} is checked out and could not be left: ${away.stderr.trim()}`);
        continue;
      }
    }
    const res = await git(["branch", "-D", branch]);
    if (res.exitCode === 0) deleted.push(branch);
    else warnings.push(`could not delete local branch ${branch}: ${res.stderr.trim()}`);
  }
  for (const ref of lines(remote.stdout)) {
    const branch = ref.replace(/^origin\//, "");
    const res = await git(["push", "origin", "--delete", branch]);
    if (res.exitCode === 0) deleted.push(`origin/${branch}`);
    else warnings.push(`could not delete remote branch ${branch}: ${res.stderr.trim()}`);
  }
  return deleted;
}

/**
 * Deletes one task for good. Returns null when there is no such task. A failed side step (GitHub, git) is
 * reported as a warning and never keeps the task alive: the factory's own records are always erased.
 */
export async function deleteTask(id: string, deps: DeleteDeps): Promise<DeleteReport | null> {
  const { store, audit, attempts, gh = bunGh, git = bunGit, stopAgents = pkillAgents, removeTranscripts = () => 0 } = deps;
  const tasks = store.load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  const preview = previewDelete(tasks, id);
  const target: TaskTarget = { taskId: id, pr: task.pr ? { repo: task.pr.repo, number: task.pr.number } : undefined };
  const warnings: string[] = [];
  const attempt = async <T>(what: string, fallback: T, fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  const stoppedAgents = await attempt("could not stop the running agent", 0, () => stopAgents(target));

  // Remove the task first so the loop cannot pick it, or its PR, up again while GitHub is being cleaned.
  store.remove(id);

  let closedPr: number | null = null;
  if (task.pr?.open) {
    const pr = task.pr.number;
    const res = await attempt("could not close the PR", null as GhResult | null, () => gh(["pr", "close", String(pr), "--comment", DELETED_COMMENT]));
    if (res?.exitCode === 0) closedPr = pr;
    else if (res) warnings.push(`could not close PR #${pr}: ${res.stderr.trim() || `gh exit ${res.exitCode}`}`);
  }

  // A completed task's branch is already merged history; only unfinished work has a branch worth removing.
  const deletedBranches = task.status === "completed" ? [] : await attempt("could not delete branches", [] as string[], () => deleteBranches(id, git, warnings));

  const auditEntries = await attempt("could not erase audit entries", 0, () =>
    audit.purge((e) =>
      e.action === "dev-task"
        ? e.target === id
        : target.pr !== undefined && Number(e.target) === target.pr.number && (e.repo === undefined || e.repo === target.pr.repo),
    ),
  );
  if (target.pr) {
    const pr = target.pr.number;
    await attempt("could not erase PR attempts", false, () => attempts.remove(pr));
  }
  const transcripts = await attempt("could not erase transcripts", 0, () => removeTranscripts(target));

  return {
    id,
    stoppedAgents,
    closedPr,
    deletedBranches,
    releasedDependents: preview?.dependents ?? [],
    auditEntries,
    transcripts,
    warnings,
  };
}
