// Pick the next thing the loop should work on: a PR that needs a patch, else one that needs a review, else a task
// the start gate (gate.ts) lets through.
// Pure: no I/O beyond reading the attempts store, nothing is run or written here.

import { canStart, dependencyMoved, type GateContext, taskOfPr } from "./gate.ts";
import type { AttemptsStore } from "./pr-attempts.ts";
import { decidePr } from "./pr-state.ts";
import type { PullRequest } from "./prs.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import type { Task } from "./tasks.schema.ts";

export type Candidate =
  | { kind: "task"; task: Task }
  | { kind: "pr"; pr: PullRequest; action: "review" | "patch" };

export interface Pick {
  /** The oldest candidate, or null when there is nothing to do. */
  candidate: Candidate | null;
  /** PRs that need work but hit the attempt limit and are not flagged yet; the loop flags them. */
  newlyExceeded: PullRequest[];
}

interface Ranked {
  candidate: Candidate;
  /** 0 patch, 1 review, 2 new task: work closest to mergeable goes first. */
  group: number;
  /** Epoch ms; Infinity for a task with no createdAt, so it sorts after every stamped candidate of its group. */
  sortAt: number;
  index: number;
}

const GROUP = { patch: 0, review: 1, task: 2 } as const;

const stamp = (iso: string | undefined): number => {
  if (iso === undefined) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

interface Ranking {
  candidates: Candidate[];
  newlyExceeded: PullRequest[];
}

function rank(tasks: Task[], prs: PullRequest[], attempts: AttemptsStore, settings: Settings): Ranking {
  const ctx: GateContext = { tasks, prs, settings, reviewedSha: (pr) => attempts.get(pr)?.reviewedSha };
  const ranked: Ranked[] = [];
  const newlyExceeded: PullRequest[] = [];

  // Every open PR is a candidate, including the ones cook opened for a task: the factory reviews its own work.
  for (const pr of prs) {
    const owner = taskOfPr(pr, tasks);
    const action = decidePr(pr, {
      reviewedSha: attempts.get(pr.number)?.reviewedSha,
      dependencyMoved: owner !== undefined && dependencyMoved(owner, ctx),
    });
    if (action === "none") continue;
    if (attempts.exceeded(pr.number)) {
      if (!attempts.get(pr.number)?.flagged) newlyExceeded.push(pr);
      continue;
    }
    ranked.push({ candidate: { kind: "pr", pr, action }, group: GROUP[action], sortAt: stamp(pr.createdAt), index: ranked.length });
  }

  for (const task of tasks) {
    if (!canStart(task, ctx)) continue;
    ranked.push({ candidate: { kind: "task", task }, group: GROUP.task, sortAt: stamp(task.createdAt), index: ranked.length });
  }

  // Finish before starting: patches, then reviews, then new tasks; oldest first within each, ties by original order.
  ranked.sort((a, b) => a.group - b.group || (a.sortAt === b.sortAt ? a.index - b.index : a.sortAt < b.sortAt ? -1 : 1));
  return { candidates: ranked.map((r) => r.candidate), newlyExceeded };
}

/** Every candidate in loop order: patches, reviews, then new tasks that pass the start gate; oldest first in each. */
export function rankCandidates(tasks: Task[], prs: PullRequest[], attempts: AttemptsStore, settings: Settings = DEFAULT_SETTINGS): Candidate[] {
  return rank(tasks, prs, attempts, settings).candidates;
}

export function pickCandidate(tasks: Task[], prs: PullRequest[], attempts: AttemptsStore, settings: Settings = DEFAULT_SETTINGS): Pick {
  const { candidates, newlyExceeded } = rank(tasks, prs, attempts, settings);
  return { candidate: candidates[0] ?? null, newlyExceeded };
}