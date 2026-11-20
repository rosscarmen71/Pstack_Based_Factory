// Factory settings the engineer toggles: the hands-on / hands-off mode at each level, and the agent cap.
// File-backed like tasks.store.ts: re-read on every use, written atomically. A missing file means the defaults.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { settingsPath } from "./home.ts";
import { TASK_MODES, type Task, type TaskMode } from "./tasks.schema.ts";

/** The factory-wide settings live in the factory's home, shared by every project. */
export const SETTINGS_PATH = settingsPath();
export const DEFAULT_AGENT_CAP = 3;

export interface Settings {
  /** The factory-wide mode every task follows unless a more specific level overrides it. */
  defaultMode: TaskMode;
  /** Mode overrides by project name. A project with no entry inherits the default. */
  projects: Record<string, TaskMode>;
  /** Mode overrides by session id. A session with no entry inherits its project's mode. */
  sessions: Record<string, TaskMode>;
  /** How many agents one repo's loop may run at once. */
  agentCap: number;
  /** While true the loop starts nothing new; running agents finish. */
  paused: boolean;
}

export const DEFAULT_SETTINGS: Settings = { defaultMode: "hands-on", projects: {}, sessions: {}, agentCap: DEFAULT_AGENT_CAP, paused: false };

/** The largest agent cap the visualizer offers. */
export const MAX_AGENT_CAP = 10;

export type ModeLevel = "task" | "session" | "project" | "default";

export interface ResolvedMode {
  mode: TaskMode;
  /** The level the mode came from: the most specific one that sets it. */
  from: ModeLevel;
}

/** A level's mode as the visualizer shows it: what applies, what it would inherit, and its own override if any. */
export interface ModeInfo extends ResolvedMode {
  /** This level's own setting; null when it inherits. */
  own: TaskMode | null;
  /** What it gets from the levels above, whether or not it overrides them. */
  inherited: TaskMode;
}

/** The mode of a task, a session or a project, with what that level inherits. */
export function modeInfo(level: "task" | "session" | "project", fields: Pick<Task, "mode" | "session" | "project">, settings: Settings): ModeInfo {
  const above: Pick<Task, "mode" | "session" | "project"> =
    level === "task" ? { session: fields.session, project: fields.project } : level === "session" ? { project: fields.project } : {};
  const own =
    level === "task"
      ? (fields.mode ?? null)
      : level === "session"
        ? ((fields.session === undefined ? undefined : settings.sessions[fields.session]) ?? null)
        : ((fields.project === undefined ? undefined : settings.projects[fields.project]) ?? null);
  const at: Pick<Task, "mode" | "session" | "project"> = level === "task" ? fields : level === "session" ? { session: fields.session, project: fields.project } : { project: fields.project };
  return { ...resolveModeSource(at, settings), own, inherited: resolveMode(above, settings) };
}

type ModeFields = Pick<Task, "mode" | "session" | "project">;

/** Most specific wins: task, then its session, then its project, then the factory default. */
export function resolveModeSource(task: ModeFields, settings: Settings): ResolvedMode {
  if (task.mode) return { mode: task.mode, from: "task" };
  const session = task.session === undefined ? undefined : settings.sessions[task.session];
  if (session) return { mode: session, from: "session" };
  const project = task.project === undefined ? undefined : settings.projects[task.project];
  if (project) return { mode: project, from: "project" };
  return { mode: settings.defaultMode, from: "default" };
}

export const resolveMode = (task: ModeFields, settings: Settings): TaskMode => resolveModeSource(task, settings).mode;

const isMode = (v: unknown): v is TaskMode => TASK_MODES.includes(v as TaskMode);

function isModeMap(v: unknown): v is Record<string, TaskMode> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isMode);
}

/** Returns human-readable problems; empty means valid. */
export function validateSettings(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["settings.json must be an object"];
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  const modes = TASK_MODES.join(" or ");
  if (!isMode(o.defaultMode)) errors.push(`defaultMode must be ${modes}`);
  if (!isModeMap(o.projects)) errors.push(`projects must map project names to ${modes}`);
  if (!isModeMap(o.sessions)) errors.push(`sessions must map session ids to ${modes}`);
  if (typeof o.agentCap !== "number" || !Number.isInteger(o.agentCap) || o.agentCap < 1) errors.push("agentCap must be a whole number of at least 1");
  if (typeof o.paused !== "boolean") errors.push("paused must be true or false");
  return errors;
}

export interface SettingsStore {
  /** The saved settings over the defaults; the defaults alone when the file does not exist. */
  load(): Settings;
  /** Applies the change to the current settings and saves the result; throws, writing nothing, if it is invalid. */
  update(change: (current: Settings) => Settings): Settings;
}

export function settingsStore(path: string = settingsPath()): SettingsStore {
  const load = (): Settings => {
    if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
    }
    const merged = { ...structuredClone(DEFAULT_SETTINGS), ...(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}) };
    const errors = validateSettings(merged);
    if (errors.length > 0) throw new Error(`invalid settings.json:\n- ${errors.join("\n- ")}`);
    return merged as Settings;
  };
  return {
    load,
    update(change) {
      const next = change(load());
      const errors = validateSettings(next);
      if (errors.length > 0) throw new Error(`invalid settings:\n- ${errors.join("\n- ")}`);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, path); // atomic: readers never see a half-written file
      return next;
    },
  };
}
