// The mechanical half of deciding dependencies: which tasks a task must be compared against, and writing the
// result safely. Whether two tasks actually clash is a judgement, made by the task-pair-check skill; nothing here
// judges, and nothing here decides whether a task may run (that is gate.ts).

import type { Task, TaskStatus } from "./tasks.schema.ts";
import type { TaskStore } from "./tasks.store.ts";

export interface DepCandidate {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  session?: string;
  dependencies: string[];
  /** True once work on it has begun (it is in progress or has a PR). */
  started: boolean;
  /** False when the target must never depend on it. */
  eligible: boolean;
  /** Why it is not eligible. Absent when it is. */
  ineligibleReason?: string;
}

/** True when `a` depends on `b`, directly or through other tasks. */
export function dependsOn(tasks: Task[], a: string, b: string): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const deps = byId.get(id)?.dependencies ?? [];
    return deps.includes(b) || deps.some(walk);
  };
  return walk(a);
}

/**
 * The tasks to compare against: every unfinished task in the file except the target itself. Completed tasks are
 * never listed (their work is already in main), and deleted ones no longer exist.
 *
 * `forId` is the existing task whose dependencies are being decided or updated, or null for a task that is not in
 * the file yet. A candidate that already depends on the target is listed as not eligible: the two are already
 * forced to run in order, target first, and the reverse dependency would deadlock them.
 */
export function dependencyCandidates(tasks: Task[], forId: string | null = null): DepCandidate[] {
  if (forId !== null && !tasks.some((t) => t.id === forId)) throw new Error(`no task "${forId}"`);
  return tasks
    .filter((t) => t.status !== "completed" && t.id !== forId)
    .map((t) => {
      const blocked = forId !== null && dependsOn(tasks, t.id, forId);
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        status: t.status,
        ...(t.session ? { session: t.session } : {}),
        dependencies: t.dependencies,
        started: t.status !== "pending",
        eligible: !blocked,
        ...(blocked ? { ineligibleReason: `${t.id} already depends on ${forId}, so they already run in order` } : {}),
      };
    });
}

/** Returns human-readable problems with making `deps` the dependencies of task `id`; empty means it may be written. */
export function checkDependencies(tasks: Task[], id: string, deps: Record<string, string>): string[] {
  if (!tasks.some((t) => t.id === id)) return [`no task "${id}"`];
  const errors: string[] = [];
  for (const [dep, reason] of Object.entries(deps)) {
    const task = tasks.find((t) => t.id === dep);
    if (dep === id) errors.push(`${id} cannot depend on itself`);
    else if (!task) errors.push(`no task "${dep}" (deleted tasks are never dependencies)`);
    else if (task.status === "completed") errors.push(`"${dep}" is completed, so there is nothing to wait for`);
    else if (dependsOn(tasks, dep, id)) errors.push(`"${dep}" already depends on ${id}; the reverse would deadlock them`);
    if (typeof reason !== "string" || reason.trim() === "") errors.push(`the reason for "${dep}" must be a non-empty line`);
  }
  return errors;
}

/**
 * Replaces the task's dependencies with the keys of `deps`, and their reasons with its values. Throws, writing
 * nothing, when the result would be invalid. No other task is touched.
 */
export function setDependencies(store: TaskStore, id: string, deps: Record<string, string>): Task {
  const errors = checkDependencies(store.load(), id, deps);
  if (errors.length > 0) throw new Error(`cannot set dependencies of ${id}:\n- ${errors.join("\n- ")}`);
  const ids = Object.keys(deps);
  const reasons = Object.fromEntries(Object.entries(deps).map(([dep, reason]) => [dep, reason.trim()]));
  store.update(id, { dependencies: ids, dependencyReasons: ids.length > 0 ? reasons : undefined });
  return store.load().find((t) => t.id === id) as Task;
}
