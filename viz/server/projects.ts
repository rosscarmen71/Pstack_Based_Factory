/**
 * Moving a session (an order) to a project: a project is only a name kept in each of the order's tasks in tasks.json.
 * Pure over a TaskStore so it can be tested against a temp file.
 */
import type { TaskStore } from "../../factory/tasks.store.ts";
import { groupOrders } from "./factory-model.ts";

export const MAX_PROJECT_LENGTH = 60;

export type ProjectInput = { ok: true; project: string | null } | { ok: false; error: string };

/** Checks a request body `{project}`: a non-empty name of at most 60 characters (trimmed), or null to leave the project. */
export function parseProjectBody(body: Record<string, unknown> | null): ProjectInput {
  const bad = { ok: false, error: `body must be {project: a name of 1-${MAX_PROJECT_LENGTH} characters, or null}` } as const;
  if (!body || !("project" in body)) return bad;
  if (body.project === null) return { ok: true, project: null };
  if (typeof body.project !== "string") return bad;
  const name = body.project.trim();
  return name && name.length <= MAX_PROJECT_LENGTH ? { ok: true, project: name } : bad;
}

/** Sets (or, with null, removes) the project on every task of the order. Returns the task ids written, or null when no such order exists. */
export function setOrderProject(store: TaskStore, orderId: string, project: string | null): string[] | null {
  const order = groupOrders(store.load()).find((o) => o.id === orderId && o.taskIds.length > 0);
  if (!order) return null;
  // undefined drops the key when the store writes the file.
  for (const id of order.taskIds) store.update(id, { project: project ?? undefined });
  return order.taskIds;
}
