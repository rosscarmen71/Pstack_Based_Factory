// The task shape written by the take_order skill and advanced by the loop.

export const TASK_STATUSES = ["pending", "in_progress", "pr", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_MODES = ["hands-on", "hands-off"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

/** A dependency is satisfied once its task has a PR or is completed. (The mode-aware gate replaces this.) */
export const isDependencyDone = (status: TaskStatus): boolean => status === "pr" || status === "completed";

/** Unfinished: anything that is not completed. Deleted tasks are simply absent. */
export const isUnfinished = (task: Pick<Task, "status">): boolean => task.status !== "completed";

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  /** Owned by the loop: pending -> in_progress -> pr -> completed. `completed` is final. */
  status: TaskStatus;
  /** Optional ISO 8601 timestamp, stamped by the take_order skill when the task is appended. */
  createdAt?: string;
  /** Agent runs on this task. */
  runs?: number;
  /** How many of those runs were skips. */
  skips?: number;
  lastSkipReason?: string;
  /** The task's own pull request. */
  pr?: TaskPr;
  /** Name of the project its order is grouped under. Set by take_order, changed from the visualizer. */
  project?: string;
  /** Id of the session: the set of tasks one take_order call created. Stamped by take_order, never changed. */
  session?: string;
  /** One line per dependency id saying why it is a dependency. Keys are a subset of `dependencies`. */
  dependencyReasons?: Record<string, string>;
  /** Hands-on or hands-off override for this task. Absent means inherit. */
  mode?: TaskMode;
  /** Failed cook runs counted toward the retry cap. */
  attempts?: number;
  /** Why the task is parked waiting for the engineer. Absent when it is not. */
  needsYou?: string;
  /** ISO 8601 timestamp of when the task became completed. */
  completedAt?: string;
}

export interface TaskPr {
  repo: string;
  number: number;
  url: string;
  open: boolean;
}

const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

function isHttpsUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

function isTaskPr(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.repo === "string" &&
    /^[\w.-]+\/[\w.-]+$/.test(p.repo) &&
    typeof p.number === "number" &&
    Number.isInteger(p.number) &&
    p.number > 0 &&
    isHttpsUrl(p.url) &&
    typeof p.open === "boolean"
  );
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Returns human-readable problems; empty means valid. */
export function validateTasks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["tasks.json must be an array"];
  const errors: string[] = [];
  const ids = new Set<string>();
  raw.forEach((t: unknown, i) => {
    const o = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const at = `task[${i}]${typeof o.id === "string" ? ` (${o.id})` : ""}`;
    if (typeof o.id !== "string" || o.id === "") errors.push(`${at}: id must be a non-empty string`);
    else if (ids.has(o.id)) errors.push(`${at}: duplicate id`);
    else ids.add(o.id);
    for (const f of ["title", "description"]) {
      if (typeof o[f] !== "string" || o[f] === "") errors.push(`${at}: ${f} must be a non-empty string`);
    }
    if (!isStringArray(o.acceptanceCriteria)) errors.push(`${at}: acceptanceCriteria must be an array of strings`);
    if (!isStringArray(o.dependencies)) errors.push(`${at}: dependencies must be an array of strings`);
    if (!TASK_STATUSES.includes(o.status as TaskStatus)) {
      errors.push(`${at}: status must be one of ${TASK_STATUSES.join(", ")}`);
    }
    if (o.createdAt !== undefined && (typeof o.createdAt !== "string" || Number.isNaN(Date.parse(o.createdAt)))) {
      errors.push(`${at}: createdAt must be an ISO 8601 date string`);
    }
    for (const f of ["runs", "skips", "attempts"]) {
      if (o[f] !== undefined && !isCount(o[f])) errors.push(`${at}: ${f} must be a non-negative integer`);
    }
    if (o.lastSkipReason !== undefined && (typeof o.lastSkipReason !== "string" || o.lastSkipReason === "")) {
      errors.push(`${at}: lastSkipReason must be a non-empty string`);
    }
    if (o.project !== undefined && (typeof o.project !== "string" || o.project.trim() === "")) {
      errors.push(`${at}: project must be a non-empty string`);
    }
    for (const f of ["session", "needsYou"]) {
      if (o[f] !== undefined && (typeof o[f] !== "string" || (o[f] as string).trim() === "")) {
        errors.push(`${at}: ${f} must be a non-empty string`);
      }
    }
    if (o.mode !== undefined && !TASK_MODES.includes(o.mode as TaskMode)) {
      errors.push(`${at}: mode must be one of ${TASK_MODES.join(", ")}`);
    }
    if (o.completedAt !== undefined && (typeof o.completedAt !== "string" || Number.isNaN(Date.parse(o.completedAt)))) {
      errors.push(`${at}: completedAt must be an ISO 8601 date string`);
    }
    if (o.dependencyReasons !== undefined) {
      const r = o.dependencyReasons;
      const deps = isStringArray(o.dependencies) ? o.dependencies : [];
      if (typeof r !== "object" || r === null || Array.isArray(r)) {
        errors.push(`${at}: dependencyReasons must be an object of dependency id to reason`);
      } else {
        for (const [dep, reason] of Object.entries(r)) {
          if (!deps.includes(dep)) errors.push(`${at}: dependencyReasons names "${dep}", which is not a dependency`);
          if (typeof reason !== "string" || reason.trim() === "") errors.push(`${at}: the reason for "${dep}" must be a non-empty string`);
        }
      }
    }
    if (o.pr !== undefined && !isTaskPr(o.pr)) {
      errors.push(`${at}: pr must be {repo: "owner/name", number: positive integer, url: https URL, open: boolean}`);
    }
  });
  if (errors.length > 0) return errors;

  const tasks = raw as Task[];
  for (const t of tasks) {
    for (const d of t.dependencies) {
      if (!ids.has(d)) errors.push(`${t.id}: unknown dependency "${d}"`);
      if (d === t.id) errors.push(`${t.id}: depends on itself`);
    }
  }
  if (errors.length === 0) errors.push(...findCycles(tasks));
  return errors;
}

function findCycles(tasks: Task[]): string[] {
  const deps = new Map(tasks.map((t) => [t.id, t.dependencies]));
  const state = new Map<string, "visiting" | "done">();
  const errors: string[] = [];
  const visit = (id: string): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      errors.push(`dependency cycle through "${id}"`);
      return;
    }
    state.set(id, "visiting");
    for (const d of deps.get(id) ?? []) visit(d);
    state.set(id, "done");
  };
  for (const t of tasks) visit(t.id);
  return errors;
}

export function parseTasks(raw: unknown): Task[] {
  const errors = validateTasks(raw);
  if (errors.length > 0) throw new Error(`invalid tasks.json:\n- ${errors.join("\n- ")}`);
  return raw as Task[];
}