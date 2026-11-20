// Command line for the dependency skills. It lists what to compare, writes what was decided, and reports what a
// task is still waiting for. The skills judge; this only reads and writes facts.
//
//   bun factory/deps-cli.ts candidates [--for <task-id>] [--project <name>]
//   bun factory/deps-cli.ts set <task-id> '{"<dependency-id>": "<one-line reason>", ...}'
//   bun factory/deps-cli.ts blockers <task-id>

import { checkDependencies, dependencyCandidates, setDependencies } from "./deps.ts";
import { blockers, type DependencyState } from "./gate.ts";
import { attemptsStore, type AttemptsStore } from "./pr-attempts.ts";
import { ghPrSource, type PrSource } from "./prs.ts";
import { resolveMode, type Settings, settingsStore } from "./settings.ts";
import { fileStore, type TaskStore } from "./tasks.store.ts";

export interface CliDeps {
  store: TaskStore;
  settings: () => Settings;
  prs: PrSource;
  attempts: AttemptsStore;
}

export interface CliResult {
  exitCode: number;
  /** JSON on success, a plain message on failure. */
  output: string;
}

const USAGE = `usage:
  bun factory/deps-cli.ts candidates [--for <task-id>] [--project <name>]
  bun factory/deps-cli.ts set <task-id> '{"<dependency-id>": "<one-line reason>"}'
  bun factory/deps-cli.ts blockers <task-id>`;

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ok = (value: unknown): CliResult => ({ exitCode: 0, output: JSON.stringify(value, null, 2) });
const fail = (message: string): CliResult => ({ exitCode: 1, output: message });

export async function runCli(args: string[], deps: CliDeps): Promise<CliResult> {
  const [command, ...rest] = args;
  try {
    if (command === "candidates") {
      const forId = flag(rest, "--for") ?? null;
      const tasks = deps.store.load();
      const target = forId === null ? undefined : tasks.find((t) => t.id === forId);
      // The mode the doubt rule goes by: the existing task's own, or what a new task in this project inherits.
      const mode = resolveMode(target ?? { project: flag(rest, "--project") }, deps.settings());
      return ok({ for: forId, mode, candidates: dependencyCandidates(tasks, forId) });
    }
    if (command === "set") {
      const [id, json] = rest;
      if (!id || json === undefined) return fail(USAGE);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        return fail(`the dependencies must be a JSON object of dependency id to reason: ${(e as Error).message}`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("the dependencies must be a JSON object of dependency id to reason");
      const wanted = parsed as Record<string, string>;
      const errors = checkDependencies(deps.store.load(), id, wanted);
      if (errors.length > 0) return fail(`cannot set dependencies of ${id}:\n- ${errors.join("\n- ")}`);
      const task = setDependencies(deps.store, id, wanted);
      return ok({ id, dependencies: task.dependencies, dependencyReasons: task.dependencyReasons ?? {} });
    }
    if (command === "blockers") {
      const [id] = rest;
      if (!id) return fail(USAGE);
      const tasks = deps.store.load();
      const task = tasks.find((t) => t.id === id);
      if (!task) return fail(`no task "${id}"`);
      const open = await deps.prs.list();
      const waiting: DependencyState[] = blockers(task, { tasks, prs: open, settings: deps.settings(), reviewedSha: (pr) => deps.attempts.get(pr)?.reviewedSha });
      return ok({ id, waiting });
    }
    return fail(USAGE);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

if (import.meta.main) {
  const { exitCode, output } = await runCli(process.argv.slice(2), {
    store: fileStore(),
    settings: () => settingsStore().load(),
    prs: ghPrSource(),
    attempts: attemptsStore(),
  });
  (exitCode === 0 ? console.log : console.error)(output);
  process.exit(exitCode);
}
