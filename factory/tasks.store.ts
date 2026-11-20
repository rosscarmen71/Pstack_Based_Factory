// File-backed task store. Re-reads before every write so tasks appended by the take_order skill are never clobbered.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseTasks, type Task, type TaskStatus } from "./tasks.schema.ts";

export const TASKS_PATH = new URL("./tasks.json", import.meta.url).pathname;

export interface TaskStore {
  load(): Task[];
  setStatus(id: string, status: TaskStatus): void;
  /** Shallow-merges the patch into the task; writes only when the task changes. */
  update(id: string, patch: Partial<Omit<Task, "id">>): void;
  /**
   * Deletes the task and strips its id from every other task's dependencies and dependency reasons, so its
   * dependents are judged on what remains. Returns false when there is no such task.
   */
  remove(id: string): boolean;
  /** Marks the task completed (final) and clears any needs-you flag. A no-op when it already is. */
  complete(id: string, at?: Date): void;
}

export function fileStore(path: string = TASKS_PATH): TaskStore {
  const load = () => parseTasks(JSON.parse(readFileSync(path, "utf8")));
  const write = (tasks: Task[]) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(tasks, null, 2)}\n`);
    renameSync(tmp, path); // atomic: readers never see a half-written file
  };
  return {
    load,
    setStatus(id, status) {
      const tasks = load();
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`cannot set status: no task "${id}"`);
      if (task.status === "completed" && status !== "completed") throw new Error(`cannot set status: "${id}" is completed, which is final`);
      task.status = status;
      write(tasks);
    },
    update(id, patch) {
      const tasks = load();
      const i = tasks.findIndex((t) => t.id === id);
      const task = tasks[i];
      if (!task) throw new Error(`cannot update: no task "${id}"`);
      if (task.status === "completed" && patch.status !== undefined && patch.status !== "completed") {
        throw new Error(`cannot update: "${id}" is completed, which is final`);
      }
      const merged = { ...task, ...patch };
      if (JSON.stringify(merged) === JSON.stringify(task)) return; // nothing changed: skip the write
      tasks[i] = merged;
      parseTasks(tasks); // reject a patch that would make the file invalid
      write(tasks);
    },
    remove(id) {
      const tasks = load();
      if (!tasks.some((t) => t.id === id)) return false;
      const rest = tasks
        .filter((t) => t.id !== id)
        .map((t) => {
          if (!t.dependencies.includes(id)) return t;
          const next: Task = { ...t, dependencies: t.dependencies.filter((d) => d !== id) };
          if (t.dependencyReasons) {
            const { [id]: _gone, ...reasons } = t.dependencyReasons;
            if (Object.keys(reasons).length > 0) next.dependencyReasons = reasons;
            else delete next.dependencyReasons;
          }
          return next;
        });
      parseTasks(rest);
      write(rest);
      return true;
    },
    complete(id, at = new Date()) {
      const tasks = load();
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`cannot complete: no task "${id}"`);
      if (task.status === "completed") return;
      task.status = "completed";
      task.completedAt = at.toISOString();
      delete task.needsYou;
      write(tasks);
    },
  };
}