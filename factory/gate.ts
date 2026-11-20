// The start gate: may this task start now? Pure: decided from recorded facts only (task statuses, the open PRs,
// the last reviewed commit of each, and the modes). No skill or agent ever decides this.
//
// A dependency is met when its task is completed (its PR merged, or marked completed by hand) or no longer exists
// (deleted). In hands-off mode it is also met once its open PR has passed taste_test cleanly. The DEPENDENCY's mode
// decides, not the mode of the task that waits.

import { CHANGES_REQUESTED_LABEL, CUSTOMIZE_COMMAND, CUSTOMIZE_SUMMARY_HEADING, pendingRequest, REMAKE_COMMAND, REMAKE_SUMMARY_HEADING } from "./pr-state.ts";
import type { PullRequest } from "./prs.ts";
import { resolveMode, type Settings } from "./settings.ts";
import type { Task, TaskMode } from "./tasks.schema.ts";

const NEEDS_HUMAN_LABEL = "needs-human";

export interface GateContext {
  tasks: Task[];
  /** Open pull requests. */
  prs: PullRequest[];
  settings: Settings;
  /** Head SHA of the last successful taste_test on the PR, if any. */
  reviewedSha: (pr: number) => string | undefined;
}

/** The open PR that belongs to the task: its recorded one, else the one on its `<type>/<id>` branch. */
export function prOfTask(task: Pick<Task, "id" | "pr">, prs: PullRequest[]): PullRequest | undefined {
  const recorded = task.pr;
  if (recorded) {
    const byNumber = prs.find((p) => p.number === recorded.number && p.repo === recorded.repo);
    if (byNumber) return byNumber;
  }
  return prs.find((p) => p.branch.endsWith(`/${task.id}`));
}

/** The task whose branch the PR is on, if any. */
export function taskOfPr(pr: Pick<PullRequest, "number" | "repo" | "branch">, tasks: Task[]): Task | undefined {
  return tasks.find((t) => (t.pr ? t.pr.number === pr.number && t.pr.repo === pr.repo : false)) ?? tasks.find((t) => pr.branch.endsWith(`/${t.id}`));
}

/**
 * "Passed taste_test cleanly": taste_test approved the PR's current head commit, CI is passing, there is no merge
 * conflict with main, and no /remake or /customize_order comment is waiting. A new commit or a CI break undoes it.
 */
export function isClean(pr: PullRequest, reviewedSha: string | undefined): boolean {
  if (pr.isDraft || pr.labels.includes(NEEDS_HUMAN_LABEL)) return false;
  // taste_test approves by reviewing the commit and leaving no changes-requested label.
  const approved = reviewedSha === pr.headSha && !pr.labels.includes(CHANGES_REQUESTED_LABEL) && pr.reviewDecision !== "changes_requested";
  const noPending = !pendingRequest(pr, REMAKE_COMMAND, REMAKE_SUMMARY_HEADING) && !pendingRequest(pr, CUSTOMIZE_COMMAND, CUSTOMIZE_SUMMARY_HEADING);
  // "unknown" mergeability (GitHub has not computed it yet) is not a pass.
  return approved && pr.ci === "pass" && pr.mergeable === "clean" && noPending;
}

export type WaitingFor = "start" | "merge" | "review" | "you";

export interface DependencyState {
  id: string;
  met: boolean;
  /** The dependency's own mode, which decides the gate. Absent when the dependency no longer exists. */
  mode?: TaskMode;
  /** What an unmet dependency still needs. Absent when met. */
  waitingFor?: WaitingFor;
  /** One line for the engineer, e.g. "waiting on a to merge". Absent when met. */
  text?: string;
}

export function dependencyState(id: string, ctx: GateContext): DependencyState {
  const dep = ctx.tasks.find((t) => t.id === id);
  // Deleted: nothing left to wait for.
  if (!dep) return { id, met: true };
  const mode = resolveMode(dep, ctx.settings);
  if (dep.status === "completed") return { id, met: true, mode };
  const unmet = (waitingFor: WaitingFor, text: string): DependencyState => ({ id, met: false, mode, waitingFor, text });
  if (dep.status !== "pr") return unmet("start", `waiting on ${id} to be built`);
  const pr = prOfTask(dep, ctx.prs);
  // At `pr` with no open PR: closed without merging, or the merge has not been seen yet.
  if (!pr) return unmet(dep.needsYou ? "you" : "merge", dep.needsYou ? `waiting on you: ${id}: ${dep.needsYou}` : `waiting on ${id} to merge`);
  if (mode === "hands-on") return unmet("merge", `waiting on ${id} to merge (PR #${pr.number})`);
  if (isClean(pr, ctx.reviewedSha(pr.number))) return { id, met: true, mode };
  return unmet("review", `waiting on taste_test of ${id} (PR #${pr.number})`);
}

/** The dependencies still holding the task back; empty when it may start. */
export function blockers(task: Pick<Task, "dependencies">, ctx: GateContext): DependencyState[] {
  return task.dependencies.map((d) => dependencyState(d, ctx)).filter((s) => !s.met);
}

/** A pending task may start once every dependency is met, each judged by its own mode. A parked task waits for the engineer. */
export function canStart(task: Pick<Task, "status" | "dependencies" | "needsYou">, ctx: GateContext): boolean {
  return task.status === "pending" && !task.needsYou && blockers(task, ctx).length === 0;
}

/**
 * For a task about to be built: the head commit of each unmerged dependency it will be stacked on.
 * Empty when every dependency is already in main.
 */
export function stackBase(task: Pick<Task, "dependencies">, ctx: Pick<GateContext, "tasks" | "prs">): Record<string, string> {
  const base: Record<string, string> = {};
  for (const id of task.dependencies) {
    const dep = ctx.tasks.find((t) => t.id === id);
    if (!dep || dep.status === "completed") continue;
    const pr = prOfTask(dep, ctx.prs);
    if (pr) base[id] = pr.headSha;
  }
  return base;
}

/** True when a dependency the task was stacked on has new commits on its still-open PR. */
export function dependencyMoved(task: Pick<Task, "builtOn">, ctx: Pick<GateContext, "tasks" | "prs">): boolean {
  return Object.entries(task.builtOn ?? {}).some(([id, sha]) => {
    const dep = ctx.tasks.find((t) => t.id === id);
    const pr = dep ? prOfTask(dep, ctx.prs) : undefined;
    return pr !== undefined && pr.headSha !== sha;
  });
}
