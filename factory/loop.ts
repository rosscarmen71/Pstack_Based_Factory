// The factory loop: pick one ready task, hand it to Claude Code running the cook skill, repeat.
// The loop owns status: pending -> in_progress -> pr -> completed (once the PR is merged). `completed` is final.

import { AGENT_RESULT_SCHEMA, parseAgentResult, toAuditOutcome, type AgentResult } from "./agent-result.ts";
import { auditStore, type AuditAction, type AuditStore } from "./audit-log.ts";
import { pickCandidate } from "./candidates.ts";
import { stackBase, taskOfPr } from "./gate.ts";
import { acquireLoopLock, type AcquireOptions } from "./loop-lock.ts";
import { attemptsStore, type AttemptsStore } from "./pr-attempts.ts";
import { ghPrSource, type ClosedPr, type PrSource, type PullRequest } from "./prs.ts";
import { DEFAULT_SETTINGS, settingsStore, type Settings } from "./settings.ts";
import type { Task } from "./tasks.schema.ts";
import { fileStore, type TaskStore } from "./tasks.store.ts";

/** Claude Code headless, running the cook skill for one task. `{id}` is substituted. */
export const ALLOWED_TOOLS: string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Agent",
  "Bash(git *)",
  "Bash(gh *)",
  "Bash(bun *)",
  "Bash(jq *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(sed -n *)",
  "Bash(echo *)",
];

/** Flags that make the agent end with a schema-checked result report in a JSON envelope on stdout. */
const REPORT_FLAGS: string[] = ["--output-format", "json", "--json-schema", JSON.stringify(AGENT_RESULT_SCHEMA)];

export const AGENT_CMD: string[] = ["claude", "-p", "/cook {id}", "--allowedTools", ALLOWED_TOOLS.join(","), ...REPORT_FLAGS];

/** Claude Code headless, reviewing or patching one open PR. `{pr}` is substituted with the PR number. */
export const REVIEW_CMD: string[] = ["claude", "-p", "/taste_test {pr}", "--allowedTools", ALLOWED_TOOLS.join(","), ...REPORT_FLAGS];
export const PATCH_CMD: string[] = ["claude", "-p", "/remake {pr}", "--allowedTools", ALLOWED_TOOLS.join(","), ...REPORT_FLAGS];

/** What one agent run produced: the process exit code and its result report, null when there was no valid one. */
export interface RunResult {
  exitCode: number;
  report: AgentResult | null;
}

/** Runs the agent for one task. */
export type Runner = (task: Task) => Promise<RunResult>;

interface LoopResult {
  ran: string[];
  /** Id of the task that stopped the loop, or null when it was stopped by the signal. */
  stoppedOn: string | null;
}

/** How long the loop sleeps before re-polling when no task is ready. */
export const LOOP_IDLE_MS = 60_000;

/** Runs the agent to review or patch one PR. */
export type PrRunner = (pr: PullRequest, action: "review" | "patch") => Promise<RunResult>;

/** Stands in for the attempts store when no PR source is wired, so the loop works on tasks alone. */
const NO_ATTEMPTS: AttemptsStore = {
  get: () => undefined,
  record: () => {},
  exceeded: () => false,
  flagForHuman: async () => {},
  sync: () => {},
  remove: () => false,
};

/** Stands in for the audit log when none is wired, so the loop records nothing by default. */
const NO_AUDIT: AuditStore = { record: () => {}, list: () => [], purge: () => 0 };

export interface LoopOptions {
  /** Where every task, review and patch run is recorded. Defaults to a no-op. */
  audit?: AuditStore;
  /** Open PRs to review or patch. Without it (and `attempts`, `runPr`) the loop works on tasks only. */
  prs?: PrSource;
  attempts?: AttemptsStore;
  runPr?: PrRunner;
  /** Defaults to Bun.sleep; tests inject a fake so they never wait real time. */
  sleep?: (ms: number) => Promise<unknown>;
  /** Aborting stops the loop: immediately when idle, after the current task otherwise. */
  signal?: AbortSignal;
  /** Read on every poll, so a mode flip takes effect at the next start. Defaults to the built-in defaults. */
  settings?: () => Settings;
}

/** Resolves after `ms` via `sleep`, or as soon as the signal aborts. */
async function idleWait(sleep: (ms: number) => Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
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
 * One task at a time. Exit 0 with a processed report means a PR was opened; anything else returns the task to pending
 * and stops.
 * When no task is ready the loop sleeps LOOP_IDLE_MS and polls again, until the signal aborts.
 */
export async function runLoop(
  store: TaskStore,
  run: Runner,
  log: (msg: string) => void = () => {},
  { sleep = Bun.sleep, signal, prs, attempts = NO_ATTEMPTS, runPr, audit = NO_AUDIT, settings = () => DEFAULT_SETTINGS }: LoopOptions = {},
): Promise<LoopResult> {
  const ran: string[] = [];
  let stuckKey = "";
  let idle = false;
  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /**
   * Records one run of the agent. A runner that threw never ran the agent, so callers do not record it.
   * A failed write is logged, never fatal: the audit log must not stop the factory.
   */
  const recordRun = (
    action: AuditAction,
    target: string | number,
    title: string,
    { exitCode, report }: RunResult,
    startedAt: number,
    pr?: Pick<PullRequest, "repo" | "url">,
  ) => {
    try {
      audit.record({
        at: new Date().toISOString(),
        action,
        target,
        title,
        ...toAuditOutcome(exitCode, report),
        exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(pr ? { repo: pr.repo, url: pr.url } : {}),
      });
    } catch (err) {
      log(`could not write audit entry for ${action} ${target}: ${errMsg(err)}`);
    }
  };

  /** Writes tracking fields to a task. A failed write is logged, never fatal: tracking must not stop the factory. */
  const track = (id: string, patch: Partial<Omit<Task, "id">>) => {
    try {
      store.update(id, patch);
    } catch (err) {
      log(`could not update tracking for ${id}: ${errMsg(err)}`);
    }
  };

  /** The closed PR that belongs to the task: its recorded PR, else the newest one on its branch opened after it. */
  const closedPrOf = (task: Task, closed: ClosedPr[]): ClosedPr | undefined => {
    if (task.pr) return closed.find((c) => c.number === task.pr?.number && c.repo === task.pr.repo);
    const createdAt = task.createdAt ? Date.parse(task.createdAt) : Number.NEGATIVE_INFINITY;
    return closed
      .filter((c) => c.branch.endsWith(`/${task.id}`) && Date.parse(c.createdAt) >= createdAt)
      .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  };

  /**
   * Follows each `pr`-status task's pull request: points the task at its open PR; completes the task once that PR
   * is merged; flags it for the engineer when the PR was closed without merging.
   */
  const trackPrs = (tasks: Task[], open: PullRequest[], closed: ClosedPr[]) => {
    for (const task of tasks) {
      if (task.status !== "pr") continue;
      const found = open.find((p) => p.branch.endsWith(`/${task.id}`));
      if (found) {
        const next = { repo: found.repo, number: found.number, url: found.url, open: true };
        const cur = task.pr;
        const same = cur?.repo === next.repo && cur.number === next.number && cur.url === next.url && cur.open;
        if (!same) track(task.id, { pr: next });
        continue;
      }
      const gone = closedPrOf(task, closed);
      const pr = gone ? { repo: gone.repo, number: gone.number, url: gone.url, open: false } : task.pr ? { ...task.pr, open: false } : undefined;
      if (gone?.merged) {
        if (pr) track(task.id, { pr });
        try {
          store.complete(task.id);
          log(`${task.id} -> completed (PR #${gone.number} merged)`);
        } catch (err) {
          log(`could not complete ${task.id}: ${errMsg(err)}`);
        }
      } else if (gone) {
        const needsYou = `PR #${gone.number} was closed without merging`;
        if (task.needsYou !== needsYou || task.pr?.open !== false) track(task.id, { pr, needsYou });
      } else if (task.pr?.open) {
        track(task.id, { pr });
      }
    }
  };

  while (!signal?.aborted) {
    const tasks = store.load();

    let open: PullRequest[] = [];
    if (prs) {
      try {
        open = await prs.list();
        attempts.sync(open);
        trackPrs(tasks, open, prs.listClosed ? await prs.listClosed() : []);
      } catch (err) {
        log(`could not list PRs, continuing with tasks only: ${errMsg(err)}`);
        open = [];
      }
    }

    let current = DEFAULT_SETTINGS;
    try {
      current = settings();
    } catch (err) {
      log(`could not read settings, using the defaults: ${errMsg(err)}`);
    }
    const { candidate, newlyExceeded } = pickCandidate(tasks, open, attempts, current);
    for (const pr of newlyExceeded) {
      try {
        await attempts.flagForHuman(pr.number);
        log(`PR #${pr.number} hit the attempt limit; flagged for a human`);
      } catch (err) {
        log(`could not flag PR #${pr.number} for a human: ${errMsg(err)}`);
      }
    }

    if (candidate?.kind === "pr") {
      idle = false;
      const { pr, action } = candidate;
      log(`${action} PR #${pr.number}: ${pr.title}`);
      let outcome: RunResult;
      let threw = false;
      const startedAt = Date.now();
      try {
        if (!runPr) throw new Error("no PR runner configured");
        outcome = await runPr(pr, action);
      } catch (err) {
        log(`PR #${pr.number} ${action} threw: ${errMsg(err)}`);
        outcome = { exitCode: -1, report: null };
        threw = true;
      }
      const code = outcome.exitCode;
      if (!threw) recordRun(action, pr.number, pr.title, outcome, startedAt, pr);
      if (outcome.report?.outcome === "skipped") log(`PR #${pr.number} ${action} skipped: ${outcome.report.reason}`);
      // Every run counts, pass or fail, so a PR that never settles ends up with a human; only a
      // successful review marks the SHA reviewed, so a crashed one is retried.
      // A failed write is not caught: without the count the same PR would be rerun forever.
      const ok = code === 0 && outcome.report !== null;
      attempts.record(pr.number, action, pr.headSha, ok);
      // A patch brought the task up to its dependencies' current commits: remember them, so it is not patched again.
      const owner = action === "patch" && ok ? taskOfPr(pr, tasks) : undefined;
      if (owner?.builtOn) track(owner.id, { builtOn: stackBase(owner, { tasks, prs: open }) });
      if (!ok) log(`PR #${pr.number} ${action} failed (exit ${code}${outcome.report ? "" : ", no result report"}); continuing`);
      continue;
    }

    const next = candidate?.task ?? null;

    if (!next) {
      const stuck = tasks.filter((t) => t.status === "in_progress").map((t) => t.id);
      const key = stuck.join(", ");
      if (key !== stuckKey) {
        stuckKey = key;
        if (stuck.length > 0) log(`warning: still in_progress from an earlier run: ${key}`);
      }
      if (!idle) log(`nothing ready; polling every ${LOOP_IDLE_MS / 1000}s`);
      idle = true;
      await idleWait(sleep, LOOP_IDLE_MS, signal);
      continue;
    }
    idle = false;

    log(`starting ${next.id}: ${next.title}`);
    store.setStatus(next.id, "in_progress");
    // The unmerged dependencies it is about to be stacked on, so a later commit on one of them is noticed.
    const base = stackBase(next, { tasks, prs: open });
    if (Object.keys(base).length > 0 || next.builtOn) track(next.id, { builtOn: Object.keys(base).length > 0 ? base : undefined });
    ran.push(next.id);

    let outcome: RunResult;
    let threw = false;
    const startedAt = Date.now();
    try {
      outcome = await run(next);
    } catch (err) {
      log(`${next.id} runner threw: ${errMsg(err)}`);
      outcome = { exitCode: -1, report: null };
      threw = true;
    }
    const { exitCode: code, report } = outcome;
    // Deleted from the viz while its agent ran: there is no task left to record or advance.
    if (!store.load().some((t) => t.id === next.id)) {
      log(`${next.id} was deleted while running; ignoring its result`);
      continue;
    }
    if (!threw) {
      recordRun("dev-task", next.id, next.title, outcome, startedAt);
      const runs = (next.runs ?? 0) + 1;
      if (code === 0 && report?.outcome === "skipped") {
        track(next.id, { runs, skips: (next.skips ?? 0) + 1, lastSkipReason: report.reason });
      } else {
        track(next.id, { runs });
      }
    }

    if (code !== 0 || !report) {
      store.setStatus(next.id, "pending");
      log(`${next.id} failed (exit ${code}${report ? "" : ", no result report"}); returned to pending, stopping`);
      return { ran, stoppedOn: next.id };
    }
    if (report?.outcome === "skipped") {
      store.setStatus(next.id, "pending");
      log(`${next.id} skipped: ${report.reason}; returned to pending, stopping`);
      return { ran, stoppedOn: next.id };
    }
    store.setStatus(next.id, "pr");
    log(`${next.id} -> pr`);
  }

  log("stopped by signal");
  return { ran, stoppedOn: null };
}

/** The envelope's human-readable `result` text, or null when stdout is not an envelope. */
function envelopeText(stdout: string): string | null {
  try {
    const { result } = JSON.parse(stdout) as { result?: unknown };
    return typeof result === "string" && result !== "" ? result : null;
  } catch {
    return null;
  }
}

/**
 * Spawns the command with stdout captured and stderr inherited, parses the JSON envelope for the
 * result report and prints its result text through `print` so the run stays visible.
 */
async function spawnAgent(cmd: string[], print: (text: string) => void): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const text = envelopeText(stdout);
  if (text !== null) print(text);
  return { exitCode, report: parseAgentResult(stdout) };
}

/** Builds a runner that spawns the given argv template with `{id}` substituted in each arg. */
export function agentRunner(template: string[], print: (text: string) => void = console.log): Runner {
  return (task) => spawnAgent(template.map((a) => a.replaceAll("{id}", task.id)), print);
}

/** Builds a PR runner from the review and patch argv templates, with `{pr}` substituted in each arg. */
export function prRunner(reviewCmd: string[], patchCmd: string[], print: (text: string) => void = console.log): PrRunner {
  return (pr, action) => {
    const template = action === "review" ? reviewCmd : patchCmd;
    return spawnAgent(template.map((a) => a.replaceAll("{pr}", String(pr.number))), print);
  };
}

export interface PrCommands {
  reviewCmd?: string[];
  patchCmd?: string[];
}

export interface MainOptions extends LoopOptions {
  /** Where the one-loop lock lives, and how to tell whether its holder is running. Tests inject a temp path. */
  lock?: AcquireOptions & { path?: string };
}

/** `HH:MM` in local time. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export async function main(
  store: TaskStore = fileStore(),
  agentCmd: string[] = AGENT_CMD,
  { sleep, signal, prs, attempts, runPr, audit, settings, lock: lockOptions }: MainOptions = {},
  { reviewCmd = REVIEW_CMD, patchCmd = PATCH_CMD }: PrCommands = {},
): Promise<number> {
  store.load(); // validate up front
  const lock = acquireLoopLock(lockOptions?.path, lockOptions);
  if (!lock.ok) {
    console.error(`[loop] a loop is already running (pid ${lock.holder.pid}, started ${clock(lock.holder.startedAt)} local time)`);
    return 1;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const { stoppedOn } = await runLoop(store, agentRunner(agentCmd), (m) => console.log(`[loop] ${m}`), {
      sleep,
      signal: controller.signal,
      prs,
      attempts,
      runPr: runPr ?? prRunner(reviewCmd, patchCmd),
      audit,
      settings,
    });
    return stoppedOn ? 1 : 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
    lock.release();
  }
}

if (import.meta.main) {
  process.exit(
    await main(fileStore(), AGENT_CMD, {
      prs: ghPrSource(),
      attempts: attemptsStore(),
      audit: auditStore(),
      settings: () => settingsStore().load(),
    }),
  );
}