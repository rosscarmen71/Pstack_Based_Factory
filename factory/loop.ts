// The factory loop: a scheduler that keeps polling the tasks and PRs and hands each ready one to a Claude Code agent
// (cook, taste_test or remake), several at a time.
// The loop owns status: pending -> in_progress -> pr -> completed (once the PR is merged). `completed` is final.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { AGENT_RESULT_SCHEMA, parseAgentResult, parseUsageLimit, toAuditOutcome, type AgentResult, type UsageLimit } from "./agent-result.ts";
import { auditStore, type AuditAction, type AuditStore } from "./audit-log.ts";
import { rankAll } from "./candidates.ts";
import { bunGit, deleteBranches } from "./delete-task.ts";
import { stackBase, taskOfPr } from "./gate.ts";
import { acquireLoopLock, type AcquireOptions } from "./loop-lock.ts";
import { attemptsStore, type AttemptsStore } from "./pr-attempts.ts";
import { ghPrSource, type ClosedPr, type PrSource, type PullRequest } from "./prs.ts";
import { DEFAULT_SETTINGS, resolveMode, settingsStore, type Settings } from "./settings.ts";
import type { Task } from "./tasks.schema.ts";
import { fileStore, type TaskStore } from "./tasks.store.ts";
import { gitWorktrees, type Workspaces, worktreeName } from "./worktrees.ts";

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
  /** Set when the run died on the account's usage limit rather than on the work. */
  usageLimit?: UsageLimit;
}

/** Cook runs a task gets before it is parked for the engineer (hands-off; hands-on parks on the first failure). */
export const MAX_TASK_ATTEMPTS = 3;
/** How long starts are held when a usage limit does not say when it resets. */
export const USAGE_LIMIT_FALLBACK_MS = 30 * 60_000;

/** Runs the agent for one task. */
export type Runner = (task: Task) => Promise<RunResult>;

interface LoopResult {
  ran: string[];
  /** Always null: no task stops the loop any more. Kept so callers that read it keep working. */
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
  /** Clock for the usage-limit pause; injectable for tests. */
  now?: () => number;
  /** Told what is running and whether starts are paused, on every change. */
  onState?: (state: LoopState) => void;
  /** Cleans up after tasks found in progress with no agent (their worktree and half-finished branch). */
  recover?: (orphans: Task[]) => void | Promise<void>;
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

/** One thing an agent is working on right now. */
export interface RunningItem {
  kind: AuditAction;
  /** Task id (dev-task) or PR number (review, patch). */
  target: string | number;
  /** ISO 8601 timestamp. */
  startedAt: string;
}

/** What the scheduler is doing, published on every change for the queue view and the visualizer. */
export interface LoopState {
  running: RunningItem[];
  /** Set while a usage limit holds every start back: when starts resume (ISO 8601). */
  pausedUntil?: string;
}

/**
 * The scheduler. Every poll (and as soon as any agent finishes) it reads the tasks and PRs and starts agents for
 * the ranked candidates until `agentCap` are running. It never waits on an agent: a run reports back when it ends.
 *
 * A task whose run fails is retried up to MAX_TASK_ATTEMPTS in hands-off mode and parked for the engineer
 * (`needsYou`) otherwise; a skipped run is parked at once. One failure never stops the loop. A usage-limit failure
 * counts for nothing and pauses every start until the limit resets.
 * On abort it starts nothing new and returns once the running agents have finished.
 */
export async function runLoop(
  store: TaskStore,
  run: Runner,
  log: (msg: string) => void = () => {},
  {
    sleep = Bun.sleep,
    signal,
    prs,
    attempts = NO_ATTEMPTS,
    runPr,
    audit = NO_AUDIT,
    settings = () => DEFAULT_SETTINGS,
    now = Date.now,
    onState = () => {},
    recover = () => {},
  }: LoopOptions = {},
): Promise<LoopResult> {
  const ran: string[] = [];
  let idle = false;
  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const running = new Map<string, RunningItem & { done: Promise<void> }>();
  /** Bumped whenever a run ends, so a poll that was reading while it ended starts over on fresh facts. */
  let generation = 0;
  let pausedUntil = 0;
  let woken = false;
  let wake = () => {};

  const publish = () => {
    try {
      onState({
        running: [...running.values()].map(({ kind, target, startedAt }) => ({ kind, target, startedAt })),
        ...(pausedUntil > now() ? { pausedUntil: new Date(pausedUntil).toISOString() } : {}),
      });
    } catch (err) {
      log(`could not publish the loop state: ${errMsg(err)}`);
    }
  };

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

  /** A usage limit is nobody's failure: hold every start until it resets. */
  const pauseForUsageLimit = (limit: UsageLimit) => {
    const until = limit.resetAt !== null && limit.resetAt > now() ? limit.resetAt : now() + USAGE_LIMIT_FALLBACK_MS;
    if (until > pausedUntil) {
      pausedUntil = until;
      log(`usage limit reached; starting nothing until ${new Date(until).toISOString()}`);
    }
  };

  /** Registers a run and makes sure its slot is freed and the loop woken when it ends, however it ends. */
  const launch = (key: string, kind: AuditAction, target: string | number, work: () => Promise<void>) => {
    const done = work()
      .catch((err) => log(`${kind} ${target} could not be finished: ${errMsg(err)}`))
      .finally(() => {
        running.delete(key);
        generation++;
        publish();
        woken = true;
        wake();
      });
    running.set(key, { kind, target, startedAt: new Date(now()).toISOString(), done });
    publish();
  };

  const startPr = (pr: PullRequest, action: "review" | "patch", tasks: Task[], open: PullRequest[]) => {
    log(`${action} PR #${pr.number}: ${pr.title}`);
    launch(`pr:${pr.number}`, action, pr.number, async () => {
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
      if (outcome.usageLimit) {
        pauseForUsageLimit(outcome.usageLimit);
        return;
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
    });
  };

  const startTask = (next: Task, tasks: Task[], open: PullRequest[], current: Settings) => {
    log(`starting ${next.id}: ${next.title}`);
    store.setStatus(next.id, "in_progress");
    ran.push(next.id);
    // The unmerged dependencies it is about to be stacked on, so a later commit on one of them is noticed.
    const base = stackBase(next, { tasks, prs: open });
    if (Object.keys(base).length > 0 || next.builtOn) track(next.id, { builtOn: Object.keys(base).length > 0 ? base : undefined });

    launch(`task:${next.id}`, "dev-task", next.id, async () => {
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
        return;
      }
      if (outcome.usageLimit) {
        store.setStatus(next.id, "pending");
        pauseForUsageLimit(outcome.usageLimit);
        return;
      }
      const skipped = code === 0 && report?.outcome === "skipped";
      if (!threw) {
        recordRun("dev-task", next.id, next.title, outcome, startedAt);
        const runs = (next.runs ?? 0) + 1;
        if (skipped) track(next.id, { runs, skips: (next.skips ?? 0) + 1, lastSkipReason: report.reason });
        else track(next.id, { runs });
      }
      if (code === 0 && report?.outcome === "processed") {
        store.setStatus(next.id, "pr");
        if (next.attempts) track(next.id, { attempts: undefined });
        log(`${next.id} -> pr`);
        return;
      }

      store.setStatus(next.id, "pending");
      const tried = (next.attempts ?? 0) + 1;
      const why = skipped ? `skipped: ${report.reason}` : `failed (exit ${code}${report ? "" : ", no result report"})`;
      // A skip is the agent saying it cannot do the task, so another try would say the same.
      const retry = !skipped && resolveMode(next, current) === "hands-off" && tried < MAX_TASK_ATTEMPTS;
      if (retry) {
        track(next.id, { attempts: tried });
        log(`${next.id} ${why}; attempt ${tried} of ${MAX_TASK_ATTEMPTS}, trying again`);
      } else {
        track(next.id, { attempts: tried, needsYou: `cook ${why}` });
        log(`${next.id} ${why}; parked for you`);
      }
    });
  };

  /** One poll: read the facts and fill the free slots. "retry" means a run ended meanwhile and the facts are stale. */
  const tick = async (): Promise<"started" | "nothing" | "retry"> => {
    const seen = generation;
    let tasks = store.load();

    // In progress with no agent of ours: left over from a crash or a stopped loop. Back to pending, no attempt counted.
    const orphans = tasks.filter((t) => t.status === "in_progress" && !running.has(`task:${t.id}`));
    if (orphans.length > 0) {
      for (const t of orphans) {
        store.setStatus(t.id, "pending");
        log(`${t.id} was in progress with no agent; returned to pending`);
      }
      try {
        await recover(orphans);
      } catch (err) {
        log(`could not clean up after ${orphans.map((t) => t.id).join(", ")}: ${errMsg(err)}`);
      }
      tasks = store.load();
    }

    let open: PullRequest[] = [];
    if (prs) {
      try {
        open = await prs.list();
        const closed = prs.listClosed ? await prs.listClosed() : [];
        if (generation !== seen) return "retry";
        attempts.sync(open);
        trackPrs(tasks, open, closed);
        tasks = store.load();
      } catch (err) {
        log(`could not list PRs, continuing with tasks only: ${errMsg(err)}`);
        open = [];
      }
    }
    if (generation !== seen) return "retry";

    let current = DEFAULT_SETTINGS;
    try {
      current = settings();
    } catch (err) {
      log(`could not read settings, using the defaults: ${errMsg(err)}`);
    }

    const { candidates, newlyExceeded } = rankAll(tasks, open, attempts, current);
    for (const pr of newlyExceeded) {
      try {
        await attempts.flagForHuman(pr.number);
        log(`PR #${pr.number} hit the attempt limit; flagged for a human`);
      } catch (err) {
        log(`could not flag PR #${pr.number} for a human: ${errMsg(err)}`);
      }
    }
    if (generation !== seen) return "retry";
    if (pausedUntil > now() || current.paused) return "nothing";

    let started = false;
    for (const c of candidates) {
      if (running.size >= current.agentCap) break;
      if (c.kind === "pr") {
        if (running.has(`pr:${c.pr.number}`)) continue;
        startPr(c.pr, c.action, tasks, open);
      } else {
        startTask(c.task, tasks, open, current);
      }
      started = true;
    }
    return started ? "started" : "nothing";
  };

  /** Waits for the next poll: LOOP_IDLE_MS, cut short the moment an agent finishes or the signal aborts. */
  const rest = async () => {
    if (!woken) {
      const woke = new Promise<void>((resolve) => {
        wake = resolve;
      });
      await Promise.race([idleWait(sleep, LOOP_IDLE_MS, signal), woke]);
    }
    woken = false;
    wake = () => {};
  };

  while (!signal?.aborted) {
    const result = await tick();
    if (result === "retry") continue;
    if (result === "started") idle = false;
    else if (running.size === 0) {
      if (!idle) log(pausedUntil > now() ? "paused for the usage limit" : `nothing ready; polling every ${LOOP_IDLE_MS / 1000}s`);
      idle = true;
    }
    await rest();
  }

  if (running.size > 0) log(`stopping: waiting for ${running.size} running agent(s) to finish`);
  await Promise.allSettled([...running.values()].map((r) => r.done));
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
async function spawnAgent(cmd: string[], print: (text: string) => void, cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const text = envelopeText(stdout);
  if (text !== null) print(text);
  const usageLimit = parseUsageLimit(stdout);
  return { exitCode, report: parseAgentResult(stdout), ...(usageLimit ? { usageLimit } : {}) };
}

/** Runs the command in a fresh worktree of its own when workspaces are given, else in the current directory. */
async function spawnIn(workspaces: Workspaces | undefined, name: string, cmd: string[], print: (text: string) => void): Promise<RunResult> {
  if (!workspaces) return spawnAgent(cmd, print);
  const cwd = await workspaces.create(name);
  try {
    return await spawnAgent(cmd, print, cwd);
  } finally {
    await workspaces.remove(name);
  }
}

/** Builds a runner that spawns the given argv template with `{id}` substituted in each arg. */
export function agentRunner(template: string[], print: (text: string) => void = console.log, workspaces?: Workspaces): Runner {
  return (task) => spawnIn(workspaces, worktreeName("cook", task.id), template.map((a) => a.replaceAll("{id}", task.id)), print);
}

/** Builds a PR runner from the review and patch argv templates, with `{pr}` substituted in each arg. */
export function prRunner(reviewCmd: string[], patchCmd: string[], print: (text: string) => void = console.log, workspaces?: Workspaces): PrRunner {
  return (pr, action) => {
    const template = action === "review" ? reviewCmd : patchCmd;
    return spawnIn(workspaces, worktreeName("pr", pr.number), template.map((a) => a.replaceAll("{pr}", String(pr.number))), print);
  };
}

export const LOOP_STATE_PATH = new URL("./loop-state.json", import.meta.url).pathname;

/** Writes the scheduler's state where the queue view and the visualizer can read it. */
export function writeLoopState(state: LoopState, path: string = LOOP_STATE_PATH): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The scheduler's last published state; an idle one when there is none or it cannot be read. */
export function readLoopState(path: string = LOOP_STATE_PATH): LoopState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LoopState;
    return Array.isArray(parsed.running) ? parsed : { running: [] };
  } catch {
    return { running: [] };
  }
}

/** After a crash: drop the orphaned tasks' worktrees and the half-finished branches of those with no PR yet. */
export function cleanUpOrphans(workspaces: Workspaces, log: (msg: string) => void): (orphans: Task[]) => Promise<void> {
  return async (orphans) => {
    for (const task of orphans) {
      await workspaces.remove(worktreeName("cook", task.id));
      if (task.pr) continue;
      const warnings: string[] = [];
      const deleted = await deleteBranches(task.id, bunGit, warnings);
      if (deleted.length > 0) log(`${task.id}: discarded half-finished ${deleted.join(", ")}`);
      for (const w of warnings) log(`${task.id}: ${w}`);
    }
  };
}

export interface PrCommands {
  reviewCmd?: string[];
  patchCmd?: string[];
}

export interface MainOptions extends LoopOptions {
  /** Where the one-loop lock lives, and how to tell whether its holder is running. Tests inject a temp path. */
  lock?: AcquireOptions & { path?: string };
  /** Gives each agent its own worktree. Without it agents run in the current directory (tests). */
  workspaces?: Workspaces;
}

/** `HH:MM` in local time. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export async function main(
  store: TaskStore = fileStore(),
  agentCmd: string[] = AGENT_CMD,
  { sleep, signal, prs, attempts, runPr, audit, settings, now, onState, recover, workspaces, lock: lockOptions }: MainOptions = {},
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
    const log = (m: string) => console.log(`[loop] ${m}`);
    // Worktrees left by a loop that died: nothing is running in them any more.
    if (workspaces) await workspaces.prune();
    const { stoppedOn } = await runLoop(store, agentRunner(agentCmd, console.log, workspaces), log, {
      sleep,
      signal: controller.signal,
      prs,
      attempts,
      runPr: runPr ?? prRunner(reviewCmd, patchCmd, console.log, workspaces),
      audit,
      settings,
      now,
      onState,
      recover: recover ?? (workspaces ? cleanUpOrphans(workspaces, log) : undefined),
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
      workspaces: gitWorktrees(),
      onState: (state) => writeLoopState(state),
    }),
  );
}