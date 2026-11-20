// Runs the factory: one scheduler loop per registered project, each touching only its own repository. Projects
// added to the registry while it runs are picked up by themselves; one that is removed has its loop stopped.

import { factoryHome, launcherPath, settingsPath } from "./home.ts";
import { agentCommands, agentRunner, cleanUpOrphans, prRunner, runLoop, writeLoopState } from "./loop.ts";
import { type Project, type ProjectRegistry, projectContext, projectRegistry, waitingOnProjects } from "./projects.ts";
import { settingsStore } from "./settings.ts";

/** How often the supervisor looks for projects that were added or removed. */
export const PROJECT_POLL_MS = 10_000;

/** Runs one project until its signal aborts. */
export type ProjectRunner = (project: Project, signal: AbortSignal) => Promise<unknown>;

export interface SuperviseOptions {
  registry: ProjectRegistry;
  runProject: ProjectRunner;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Resolves after `ms`, or as soon as the signal aborts. */
async function waitOrAbort(sleep: (ms: number) => Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return void (await sleep(ms));
  if (signal.aborted) return;
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Keeps exactly one loop running per registered project until the signal aborts, then stops them all and waits
 * for them to finish. A project's loop that ends by itself (it crashed) is started again on the next poll.
 */
export async function supervise({ registry, runProject, log = () => {}, signal, sleep = Bun.sleep }: SuperviseOptions): Promise<void> {
  const running = new Map<string, { stop: () => void; done: Promise<void> }>();
  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  while (!signal?.aborted) {
    let projects: Project[] = [];
    try {
      projects = registry.list();
    } catch (err) {
      log(`could not read the projects: ${errMsg(err)}`);
      projects = [...running.keys()].map((name) => ({ name, path: "", dependsOn: [], paused: false, addedAt: "" }));
    }
    const names = new Set(projects.map((p) => p.name));
    for (const [name, loop] of running) {
      if (names.has(name)) continue;
      log(`${name} was removed; stopping its loop`);
      loop.stop();
    }
    for (const project of projects) {
      if (running.has(project.name) || !project.path) continue;
      const controller = new AbortController();
      log(`starting the loop for ${project.name} (${project.path})`);
      const done = Promise.resolve()
        .then(() => runProject(project, controller.signal))
        .then(
          () => undefined,
          (err) => log(`the loop for ${project.name} failed: ${errMsg(err)}`),
        )
        .finally(() => {
          running.delete(project.name);
        });
      running.set(project.name, { stop: () => controller.abort(), done });
    }
    await waitOrAbort(sleep, PROJECT_POLL_MS, signal);
  }

  for (const loop of running.values()) loop.stop();
  await Promise.allSettled([...running.values()].map((l) => l.done));
}

/** The real runner: this project's scheduler, with its own queue, PRs, worktrees and state file. */
export function projectRunner(registry: ProjectRegistry = projectRegistry(), home: string = factoryHome()): ProjectRunner {
  return async (project, signal) => {
    const ctx = projectContext(project, home);
    const log = (m: string) => console.log(`[${project.name}] ${m}`);
    const print = (text: string) => console.log(`[${project.name}] ${text}`);
    // The skills reach the queue through the factory's own command and read it from the project's folder.
    const commands = agentCommands([`Bash(${launcherPath(home)} *)`], [ctx.paths.dir]);
    // Worktrees left by a loop that died: nothing is running in them any more.
    await ctx.workspaces.prune();
    const settings = settingsStore(settingsPath(home));
    await runLoop(ctx.store, agentRunner(commands.cook, print, ctx.workspaces), log, {
      signal,
      prs: ctx.prs,
      attempts: ctx.attempts,
      audit: ctx.audit,
      runPr: prRunner(commands.review, commands.patch, print, ctx.workspaces),
      // Paused when the whole factory is, or when this project is.
      settings: () => {
        const s = settings.load();
        return { ...s, paused: s.paused || (registry.get(project.name)?.paused ?? false) };
      },
      onState: (state) => writeLoopState(state, ctx.paths.loopState),
      recover: cleanUpOrphans(ctx.workspaces, log, ctx.git),
      blockedBy: () => waitingOnProjects(registry.get(project.name) ?? project, registry, home),
    });
  };
}
