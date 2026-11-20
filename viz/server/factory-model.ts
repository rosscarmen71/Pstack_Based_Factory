/**
 * Pure mapping from the factory's own records to the visualizer's data shape.
 *
 * No I/O here: factory-source.ts gathers a Snapshot (tasks, audit rows, PRs, parsed transcripts, needs history)
 * and everything below turns it into Sessions, Phases, Events, Gates and Needs.
 *
 *   order (take_order batch)  -> Session
 *   one agent run              -> Phase (owner = the task id or "PR #n", which makes it the lane)
 *   task not started yet       -> queued Phase
 *   milestone command          -> tool_call Event
 *   result checklist           -> GateResult.checks_json
 */
import type { AuditAction, AuditEntry } from "../../factory/audit-log.ts";
import { isDependencyDone, type Task } from "../../factory/tasks.schema.ts";
import type {
  AgentSession,
  Envelope,
  Event,
  GateCheck,
  GateResult,
  Phase,
  PhaseStatus,
  Session,
  SessionDetail,
  SessionStatus,
  SessionSummary,
} from "../shared/types.ts";
import type { CustomizeState } from "../shared/customize.ts";
import { CUSTOMIZE_COMMAND, CUSTOMIZE_SUMMARY_HEADING, startsWithWord } from "../../factory/pr-state.ts";

// ── Inputs ──────────────────────────────────────────────────────────────────

export type RunKind = "cook" | "taste_test" | "remake" | "customize_order";

export interface Milestone {
  title: string;
  description: string;
  command: string;
  ok: boolean;
  at: string;
  endedAt: string;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One headless agent run, as read from its Claude Code transcript. */
export interface Transcript {
  sessionId: string;
  kind: RunKind;
  /** Task id for cook, PR number (as text) for taste_test, remake and customize_order. */
  target: string;
  startedAt: string;
  lastAt: string;
  /** File modification time, used to tell a live run from one that ended without a report. */
  mtimeMs: number;
  model: string | null;
  tokens: Tokens;
  milestones: Milestone[];
}

export interface PrReview {
  state: string;
  body: string;
  submittedAt: string;
  /** The commit the review was left on. */
  commit: string;
}

export interface PrInfo {
  number: number;
  url: string;
  repo: string;
  title: string;
  branch: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  ci: "pass" | "fail" | "pending";
  headSha: string;
  labels: string[];
  reviews: PrReview[];
  commitDates: string[];
  /** Plain PR comments (not reviews), oldest first as GitHub returns them. */
  comments: PrComment[];
}

export interface PrComment {
  body: string;
  createdAt: string;
}

export interface LabelEvent {
  event: "labeled" | "unlabeled";
  label: string;
  at: string;
}

const WARNING_KINDS = ["agent_silent", "running_long", "task_stranded"] as const;
export type WarningKind = (typeof WARNING_KINDS)[number];

/** A run warning the visualizer itself recorded (it leaves no trace in the factory's files). key is the run id, or the task id for task_stranded. */
export interface StuckHistoryEntry {
  kind: WarningKind;
  key: string;
  raisedAt: string;
  resolvedAt?: string;
}

export interface Snapshot {
  tasks: Task[];
  audit: AuditEntry[];
  prs: PrInfo[];
  transcripts: Transcript[];
  labelEvents: Record<number, LabelEvent[]>;
  stuckHistory: StuckHistoryEntry[];
  loopRunning: boolean;
  /** The /customize_order agents the visualizer hosts, by PR number. */
  customize: Record<number, CustomizeState>;
  now: number;
}

// ── Outputs beyond their shared types ───────────────────────────────────────

export type NeedKind =
  | "loop_stopped"
  | "needs_human"
  | "stuck_changes"
  | "ready_for_review"
  | "task_change_requested"
  | WarningKind;

export interface Need {
  id: string;
  kind: NeedKind;
  severity: "review" | "broken";
  title: string;
  description: string;
  sessionId: string;
  lane: string;
  /** The block to highlight when the dot is clicked, if there is one. */
  phaseId: string | null;
  raisedAt: string;
  resolvedAt: string | null;
  /** What the need is about: a PR page, or a run. The run panel's buttons use it; clicking a dot only highlights its block. */
  goTo: { kind: "pr"; url: string } | { kind: "run"; phaseId: string };
}

export interface LaneMeta {
  title: string;
  subtitle: string;
  /** The lane's pull request, when it has one: the run panel's "Open PR" button and customize card need it. */
  pr?: { number: number; url: string };
}

export type OrderStatus = "broken" | "running" | "done" | "waiting";

/** SessionSummary plus the extras the edited UI reads. */
export interface OrderSummary extends SessionSummary {
  order_status: OrderStatus;
  needs_open: number;
  needs_broken: number;
}

export interface OrderDetail extends SessionDetail {
  order_status: OrderStatus;
  lane_meta: Record<string, LaneMeta>;
  /** Phases where the loop really stopped: a cook the loop recorded as failed or skipped. A run outside the loop never stopped it. */
  loop_stops: string[];
  needs: Need[];
}

export interface Model {
  sessions: OrderSummary[];
  details: Map<string, OrderDetail>;
  events: Map<string, Event[]>;
  gates: Map<string, GateResult[]>;
  envelopes: Map<string, Envelope[]>;
  /** Live runs, by transcript session id, for take-over and the feed. */
  liveSessions: Set<string>;
  /** Run warnings to persist; factory-source.ts writes them. */
  stuckHistory: StuckHistoryEntry[];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Tasks next to each other whose createdAt are this close belong to one take_order order. */
export const ORDER_GAP_MS = 5 * 60_000;
/** A transcript written to this recently, with no audit row yet, is a run in progress. */
export const LIVE_WRITE_MS = 120_000;
export const UNLINKED_ID = "unlinked-prs";
export const UNDATED_ID = "tasks-without-a-date";

/** A running agent whose transcript has been quiet this long is probably hung. */
export const SILENT_MS = 5 * 60_000;
/** Normal runs take a few minutes; a run past this is worth a look. */
export const LONG_RUN_MS = 15 * 60_000;

/** A run whose transcript ended with no audit row: it ran outside the loop, or was cut off before the loop recorded it. */
const NO_AUDIT_TEXT = "no result in the audit log (ran outside the loop, or was cut off)";

/** The audit action a run kind writes; customize_order is run by a human, never the loop, so it has none. */
const AUDIT_ACTION: Record<RunKind, AuditAction | null> = {
  cook: "dev-task",
  taste_test: "review",
  remake: "patch",
  customize_order: null,
};
const RUN_KIND: Record<AuditAction, RunKind> = { "dev-task": "cook", review: "taste_test", patch: "remake" };

// ── Milestones ──────────────────────────────────────────────────────────────

interface MilestoneRule {
  match: (tool: string, command: string) => boolean;
  title: string;
  description: string;
}

const bash = (re: RegExp) => (tool: string, command: string) => tool === "Bash" && re.test(command);

/** The fixed table of commands that count as milestones; everything else stays out of the waterfall. */
export const MILESTONE_RULES: MilestoneRule[] = [
  { match: bash(/\bgit (checkout|switch) -[bc]\b/), title: "Branch created", description: "Started the work branch." },
  { match: bash(/\bgh pr checkout\b/), title: "PR checked out", description: "Checked out the PR branch." },
  { match: bash(/\bgit commit\b/), title: "Committed", description: "Committed work to the branch." },
  {
    match: bash(/\bbun (run (check|test|lint|typecheck)|test)\b/),
    title: "Checks ran",
    description: "Ran the repo's checks.",
  },
  {
    match: (tool) => tool === "Agent" || tool === "Task",
    title: "Verifier launched",
    description: "Launched a subagent to check the work independently.",
  },
  { match: bash(/\bgit push\b/), title: "Pushed", description: "Pushed the branch to GitHub." },
  { match: bash(/\bgh pr create\b/), title: "PR opened", description: "Opened the pull request." },
  { match: bash(/\bgh pr review\b/), title: "Review posted", description: "Posted the review on the PR." },
  { match: bash(/\bgh pr comment\b/), title: "Summary posted", description: "Posted a comment on the PR." },
];

export function milestoneFor(tool: string, input: Record<string, unknown>): Omit<Milestone, "ok" | "at" | "endedAt"> | null {
  const command =
    tool === "Bash"
      ? String(input.command ?? "")
      : tool === "Agent" || tool === "Task"
        ? `Agent: ${String(input.description ?? "subagent")}`
        : "";
  const rule = MILESTONE_RULES.find((r) => r.match(tool, command));
  return rule ? { title: rule.title, description: rule.description, command } : null;
}

// ── Orders ──────────────────────────────────────────────────────────────────

export interface Order {
  id: string;
  title: string;
  taskIds: string[];
}

/**
 * Groups tasks into sessions (take_order orders). A task that stores its `session` belongs to exactly that one,
 * whose id is the stored id. Older tasks without one are grouped the old way: neighbours in tasks.json whose
 * createdAt are within ORDER_GAP_MS.
 */
export function groupOrders(tasks: Task[]): Order[] {
  const orders: Order[] = [];
  const undated: string[] = [];
  const bySession = new Map<string, Order>();
  let current: { ids: string[]; last: number } | null = null;
  for (const task of tasks) {
    if (task.session) {
      let order = bySession.get(task.session);
      if (!order) {
        order = { id: task.session, title: "", taskIds: [] };
        bySession.set(task.session, order);
        orders.push(order);
      }
      order.taskIds.push(task.id);
      current = null;
      continue;
    }
    const at = task.createdAt ? Date.parse(task.createdAt) : Number.NaN;
    if (!Number.isFinite(at)) {
      undated.push(task.id);
      current = null;
      continue;
    }
    if (current && Math.abs(at - current.last) <= ORDER_GAP_MS) {
      current.ids.push(task.id);
      current.last = at;
    } else {
      current = { ids: [task.id], last: at };
      orders.push({ id: "", title: "", taskIds: current.ids });
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const o of orders) {
    const first = byId.get(o.taskIds[0] ?? "");
    if (!bySession.has(o.id)) o.id = `order-${o.taskIds[0]}`;
    o.title = orderTitle(first?.title ?? o.taskIds[0] ?? "order", o.taskIds.length);
  }
  if (undated.length) orders.push({ id: UNDATED_ID, title: "Tasks without a date", taskIds: undated });
  return orders;
}

const orderTitle = (first: string, count: number) => (count > 1 ? `${first} +${count - 1} more` : first);

// ── Runs ────────────────────────────────────────────────────────────────────

export type RunStatus = "running" | "success" | "fail" | "skipped";

export interface Run {
  id: string;
  kind: RunKind;
  target: string;
  /** Lane: a task id, or "PR #n" for a PR that matches no task. */
  lane: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  audit: AuditEntry | null;
  transcript: Transcript | null;
  pr: PrInfo | null;
}

const branchIsOf = (task: Task, branch: string) => branch.endsWith(`/${task.id}`);

/**
 * A task id can be reused by a later order, so the branch alone does not say whose PR it is. A PR belongs to a task
 * only if its branch ends in the task id and it was opened at or after the task was created. A task with no
 * createdAt keeps the branch-only match.
 */
export function ownsPr(task: Task, pr: Pick<PrInfo, "branch" | "createdAt">): boolean {
  if (!branchIsOf(task, pr.branch)) return false;
  const created = task.createdAt ? Date.parse(task.createdAt) : Number.NaN;
  return !Number.isFinite(created) || Date.parse(pr.createdAt) >= created;
}

const ownerOfPr = (tasks: Task[], pr: PrInfo) => tasks.find((t) => ownsPr(t, pr)) ?? null;

/** A PR on a current task's branch that opened before that task existed: it belongs to an earlier order, so the model leaves it out. */
const isPastPr = (tasks: Task[], pr: PrInfo) => !ownerOfPr(tasks, pr) && tasks.some((t) => branchIsOf(t, pr.branch));

/** The PR a task is on now: the newest one it owns (an earlier one means the task was cooked again). */
const currentPrOf = (prs: PrInfo[], task: Task): PrInfo | null =>
  prs.filter((p) => ownsPr(task, p)).toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;

/** A run from before its task existed belongs to an earlier use of the id (cook), or to a PR of an earlier order (the others). */
function isPastRun(snap: Snapshot, r: Run): boolean {
  if (r.kind === "cook") {
    const created = snap.tasks.find((t) => t.id === r.target)?.createdAt;
    return created !== undefined && Date.parse(r.startedAt) < Date.parse(created);
  }
  const pr = snap.prs.find((p) => String(p.number) === r.target);
  return pr !== undefined && isPastPr(snap.tasks, pr);
}

/** auditless: the run kind never gets an audit row (customize_order), so ending without one is not a failure. */
export function runStatus(audit: AuditEntry | null, live: boolean, auditless = false): RunStatus {
  if (!audit) return live ? "running" : auditless ? "success" : "fail";
  if (audit.outcome === "success") return "success";
  if (audit.outcome === "failure") return "fail";
  return (audit.reason ?? "").startsWith("failed:") ? "fail" : "skipped";
}

/** Joins each transcript to its audit row (same action and target, written after the run started). */
export function buildRuns(snap: Snapshot): Run[] {
  const used = new Set<AuditEntry>();
  const transcripts = snap.transcripts.toSorted((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const runs: Run[] = [];
  for (const [i, t] of transcripts.entries()) {
    const start = Date.parse(t.startedAt);
    const audit =
      snap.audit
        .filter(
          (a) =>
            !used.has(a) &&
            AUDIT_ACTION[t.kind] !== null &&
            a.action === AUDIT_ACTION[t.kind] &&
            String(a.target) === t.target &&
            Date.parse(a.at) >= start - 5_000,
        )
        .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null;
    if (audit) used.add(audit);
    const laterStarted = transcripts.slice(i + 1).some((n) => Date.parse(n.startedAt) > start);
    // The loop never runs customize_order, so a running loop says nothing about whether one is live.
    const live =
      !audit && (snap.now - t.mtimeMs < LIVE_WRITE_MS || (t.kind !== "customize_order" && snap.loopRunning && !laterStarted));
    runs.push(makeRun(snap, t.kind, t.target, `run:${t.sessionId}`, t.startedAt, audit, t, live));
  }
  for (const a of snap.audit) {
    if (used.has(a)) continue;
    const startedAt = new Date(Date.parse(a.at) - a.durationMs).toISOString();
    runs.push(makeRun(snap, RUN_KIND[a.action], String(a.target), `audit:${a.at}`, startedAt, a, null, false));
  }
  return runs.filter((r) => !isPastRun(snap, r)).toSorted((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

function makeRun(
  snap: Snapshot,
  kind: RunKind,
  target: string,
  id: string,
  startedAt: string,
  audit: AuditEntry | null,
  transcript: Transcript | null,
  live: boolean,
): Run {
  const task = kind === "cook" ? snap.tasks.find((t) => t.id === target) : undefined;
  // A cook's PR is the first its task owns that opened after the run began (the task may have been cooked again); else the newest.
  const owned = task ? snap.prs.filter((p) => ownsPr(task, p)).toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) : [];
  const pr =
    kind === "cook"
      ? (owned.find((p) => Date.parse(p.createdAt) >= Date.parse(startedAt) - 5_000) ?? owned.at(-1) ?? null)
      : (snap.prs.find((p) => String(p.number) === target) ?? null);
  const lane = kind === "cook" ? target : (pr && ownerOfPr(snap.tasks, pr)?.id) || `PR #${target}`;
  const status = runStatus(audit, live, AUDIT_ACTION[kind] === null);
  const endedAt = status === "running" ? null : (audit?.at ?? transcript?.lastAt ?? startedAt);
  return { id, kind, target, lane, startedAt, endedAt, status, audit, transcript, pr };
}

// ── Needs ───────────────────────────────────────────────────────────────────

const VERDICT_CHANGES = /Verdict:\s*\**\s*CHANGES/i;
const VERDICT_APPROVE = /Verdict:\s*\**\s*APPROVE/i;

function firstAfter(dates: (string | null)[], after: string): string | null {
  const t0 = Date.parse(after);
  const later = dates.filter((d): d is string => d !== null && Date.parse(d) > t0).toSorted();
  return later[0] ?? null;
}

/** Every situation where the factory needs the human, resolved ones included (they render greyed). */
export function buildNeeds(snap: Snapshot, runs: Run[], sessionOfLane: (lane: string) => string): {
  needs: Need[];
  stuckHistory: StuckHistoryEntry[];
} {
  const needs: Need[] = [];
  const nowIso = new Date(snap.now).toISOString();
  const runOpen = (r: Run): Need["goTo"] => ({ kind: "run", phaseId: r.id });

  for (const r of runs) {
    if (r.kind !== "cook" || !r.audit || r.status === "success" || r.status === "running") continue;
    const next = runs.find((n) => n.kind === "cook" && n.target === r.target && Date.parse(n.startedAt) > Date.parse(r.startedAt));
    needs.push({
      id: `loop_stopped:${r.id}`,
      kind: "loop_stopped",
      severity: "broken",
      title: "Loop stopped",
      description: `cook on ${r.target} ${r.status === "skipped" ? "skipped" : "failed"}: ${r.audit.reason ?? "no reason"}. The loop stops after this; fix it, then run bun run loop again.`,
      sessionId: sessionOfLane(r.lane),
      lane: r.lane,
      phaseId: r.id,
      raisedAt: r.audit.at,
      resolvedAt: next?.startedAt ?? null,
      goTo: runOpen(r),
    });
  }

  for (const pr of snap.prs) {
    // A task's needs come from its current PR only; earlier PRs, and PRs of an earlier order that used the id, are history.
    if (isPastPr(snap.tasks, pr)) continue;
    const task = ownerOfPr(snap.tasks, pr);
    if (task && currentPrOf(snap.prs, task)?.number !== pr.number) continue;
    const lane = task?.id ?? `PR #${pr.number}`;
    const closedAt = pr.mergedAt ?? pr.closedAt;
    const prRuns = runs.filter((r) => r.lane === lane);
    const anchor = (at: string) =>
      prRuns.filter((r) => Date.parse(r.startedAt) <= Date.parse(at)).at(-1)?.id ?? prRuns.at(-1)?.id ?? null;
    const goTo: Need["goTo"] = { kind: "pr", url: pr.url };
    // The /customize_order run that answers a request is the first one for this PR that starts at or after the comment.
    const customizeRunFor = (at: string) =>
      prRuns.find((r) => r.kind === "customize_order" && Date.parse(r.startedAt) >= Date.parse(at))?.id ?? null;

    for (const [i, ev] of (snap.labelEvents[pr.number] ?? []).entries()) {
      if (ev.event !== "labeled" || ev.label !== "needs-human") continue;
      const removed = (snap.labelEvents[pr.number] ?? [])
        .slice(i + 1)
        .find((e) => e.event === "unlabeled" && e.label === "needs-human");
      needs.push({
        id: `needs_human:${pr.number}:${ev.at}`,
        kind: "needs_human",
        severity: "broken",
        title: "Factory gave up on this PR",
        description: `PR #${pr.number} hit the attempt limit and was labelled needs-human. Remove the label to let the loop try again.`,
        sessionId: sessionOfLane(lane),
        lane,
        phaseId: anchor(ev.at),
        raisedAt: ev.at,
        resolvedAt: removed?.at ?? closedAt,
        goTo,
      });
    }

    for (const review of pr.reviews) {
      if (!VERDICT_CHANGES.test(review.body)) continue;
      needs.push({
        id: `stuck_changes:${pr.number}:${review.submittedAt}`,
        kind: "stuck_changes",
        severity: "broken",
        title: "Stuck on Verdict: CHANGES",
        description: `taste_test found a blocking issue on PR #${pr.number}, but the loop won't patch it. Open the PR to decide what to do.`,
        sessionId: sessionOfLane(lane),
        lane,
        phaseId: anchor(review.submittedAt),
        raisedAt: review.submittedAt,
        resolvedAt: firstAfter([...pr.commitDates, closedAt], review.submittedAt),
        goTo,
      });
    }

    const summaries = pr.comments.filter((c) => c.body.trimStart().startsWith(CUSTOMIZE_SUMMARY_HEADING)).map((c) => c.createdAt);
    const requests = pr.comments
      .filter((c) => startsWithWord(c.body, CUSTOMIZE_COMMAND))
      .toSorted((x, y) => x.createdAt.localeCompare(y.createdAt))
      .map((c) => ({ at: c.createdAt, resolvedAt: firstAfter([...summaries, closedAt], c.createdAt) }));
    // One /customize_order run answers every request before its summary, so only the newest unanswered one is shown.
    const newestOpen = requests.findLast((q) => q.resolvedAt === null);
    for (const q of requests) {
      if (q.resolvedAt === null && q !== newestOpen) continue;
      // Only the open request has a live agent to ask about; a resolved one keeps the plain title.
      const agent = q === newestOpen ? snap.customize[pr.number] : undefined;
      const asking = agent?.status === "waiting" ? agent.pending : null;
      const title = asking
        ? "Agent is asking you a question"
        : agent?.status === "idle"
          ? "Agent is waiting for your reply"
          : "Comment asks to change the task";
      const description = asking
        ? asking.questions.map((x) => x.question).join("\n")
        : agent?.status === "idle"
          ? `The /customize_order ${pr.number} agent asked in plain text. Open its run and type your reply under the feed.`
          : `A comment on PR #${pr.number} asks to change the task. The visualizer runs the /customize_order ${pr.number} agent; open its run to answer its questions.`;
      needs.push({
        id: `task_change_requested:${pr.number}:${q.at}`,
        kind: "task_change_requested",
        severity: "review",
        title,
        description,
        sessionId: sessionOfLane(lane),
        lane,
        phaseId: customizeRunFor(q.at) ?? anchor(q.at),
        raisedAt: q.at,
        resolvedAt: q.resolvedAt,
        goTo,
      });
    }

    const verdict = pr.reviews.filter((r) => r.commit === pr.headSha).toSorted((x, y) => x.submittedAt.localeCompare(y.submittedAt)).at(-1);
    const blocked = pr.labels.some((l) => l === "changes-requested" || l === "needs-human");
    if (task && verdict && VERDICT_APPROVE.test(verdict.body) && pr.ci === "pass" && !blocked) {
      needs.push({
        id: `ready_for_review:${pr.number}`,
        kind: "ready_for_review",
        severity: "review",
        title: "Ready for your review",
        description: `taste_test approved PR #${pr.number} for ${task.id} and CI is green. Review and merge it on GitHub; the loop never merges.`,
        sessionId: sessionOfLane(lane),
        lane,
        phaseId: anchor(verdict.submittedAt),
        raisedAt: verdict.submittedAt,
        resolvedAt: closedAt,
        goTo,
      });
    }
  }

  const active = new Set<string>();
  for (const r of runs) {
    if (r.status !== "running") continue;
    if (r.transcript && snap.now - r.transcript.mtimeMs >= SILENT_MS) active.add(`agent_silent:${r.id}`);
    if (snap.now - Date.parse(r.startedAt) >= LONG_RUN_MS) active.add(`running_long:${r.id}`);
  }
  if (!snap.loopRunning) for (const t of snap.tasks) if (t.status === "in_progress") active.add(`task_stranded:${t.id}`);

  const history = snap.stuckHistory.filter((h) => (WARNING_KINDS as readonly string[]).includes(h.kind)).map((h) => ({ ...h }));
  for (const h of history) if (!h.resolvedAt && !active.has(`${h.kind}:${h.key}`)) h.resolvedAt = nowIso;
  for (const id of active) {
    if (!history.some((h) => `${h.kind}:${h.key}` === id && !h.resolvedAt)) {
      const [kind, ...key] = id.split(":");
      history.push({ kind: kind as WarningKind, key: key.join(":"), raisedAt: nowIso });
    }
  }
  for (const h of history) {
    const common = { id: `${h.kind}:${h.key}:${h.raisedAt}`, kind: h.kind, raisedAt: h.raisedAt, resolvedAt: h.resolvedAt ?? null };
    if (h.kind === "task_stranded") {
      const last = runs.filter((r) => r.lane === h.key).at(-1);
      needs.push({
        ...common,
        severity: "broken",
        title: "Task stranded in progress",
        description: `${h.key} is marked in_progress but the loop is not running. Set it back to pending to retry.`,
        sessionId: sessionOfLane(h.key),
        lane: h.key,
        phaseId: last?.id ?? null,
        goTo: last ? runOpen(last) : { kind: "run", phaseId: "" },
      });
      continue;
    }
    const r = runs.find((x) => x.id === h.key);
    if (!r) continue;
    const silent = h.kind === "agent_silent";
    needs.push({
      ...common,
      severity: "review",
      title: silent ? "Agent has gone quiet" : "Run is taking long",
      description: silent
        ? `The ${r.kind} run on ${r.target} has written nothing for ${SILENT_MS / 60_000} minutes. It may be hung; open the run to check.`
        : `The ${r.kind} run on ${r.target} has been going for ${LONG_RUN_MS / 60_000} minutes or more; normal runs take a few. It may still be making progress.`,
      sessionId: sessionOfLane(r.lane),
      lane: r.lane,
      phaseId: r.id,
      goTo: runOpen(r),
    });
  }

  return { needs: needs.toSorted((a, b) => a.raisedAt.localeCompare(b.raisedAt)), stuckHistory: history };
}

// ── Sessions ────────────────────────────────────────────────────────────────

export function orderStatus(laneRuns: Run[][], tasks: Task[], isTaskOrder: boolean): OrderStatus {
  const latest = laneRuns.map((rs) => rs.at(-1)).filter((r): r is Run => r !== undefined);
  const broke = (r: Run) => r.status === "fail" || (r.kind === "cook" && r.status === "skipped");
  if (latest.some(broke)) return "broken";
  if (laneRuns.flat().some((r) => r.status === "running")) return "running";
  if (isTaskOrder) return tasks.length > 0 && tasks.every((t) => isDependencyDone(t.status)) ? "done" : "waiting";
  return latest.length > 0 ? "done" : "waiting";
}

const SESSION_STATUS: Record<OrderStatus, SessionStatus> = {
  broken: "fail",
  running: "running",
  done: "success",
  waiting: "waiting",
};

const PHASE_STATUS: Record<RunStatus, PhaseStatus> = {
  running: "running",
  success: "success",
  fail: "fail",
  skipped: "skipped",
};

function runDescription(r: Run): string {
  if (r.status === "running") return "running";
  const reason = r.audit?.reason;
  if (r.status === "skipped" || r.status === "fail") return reason ?? NO_AUDIT_TEXT;
  const last = r.transcript?.milestones.at(-1);
  if (r.kind === "taste_test") {
    const verdict = r.pr?.reviews.toReversed().find((v) => Date.parse(v.submittedAt) >= Date.parse(r.startedAt));
    if (verdict) return VERDICT_CHANGES.test(verdict.body) ? "Verdict: CHANGES" : "Verdict: APPROVE";
  }
  if (r.kind === "cook" && r.pr) return `PR #${r.pr.number} opened`;
  return last?.title ?? "done";
}

function resultChecks(r: Run, snap: Snapshot): GateCheck[] {
  const checks: GateCheck[] = [];
  const a = r.audit;
  if (r.kind === "customize_order") {
    // Run by a human: no audit row and no exit code to check, only the PR and the summary it should leave.
    const posted = r.transcript?.milestones.some((m) => m.title === "Summary posted" && m.ok) ?? false;
    return [prOpenCheck(r.pr), { item: "summary posted", ok: posted, note: posted ? "gh pr comment succeeded" : "no summary comment posted" }];
  }
  checks.push(
    a
      ? { item: "exit code", ok: a.exitCode === 0, note: `exit ${a.exitCode ?? "none"} (audit log)` }
      : { item: "exit code", ok: false, note: NO_AUDIT_TEXT },
  );
  if (a) {
    const reportOk = a.outcome === "success" || (a.outcome === "skip" && !(a.reason ?? "").startsWith("failed:"));
    checks.push({
      item: "result report",
      ok: reportOk && !(r.kind === "cook" && a.outcome === "skip"),
      note: a.outcome === "success" ? "processed" : `${a.outcome}: ${a.reason ?? ""}`,
    });
  }
  if (r.kind === "cook") {
    const task = snap.tasks.find((t) => t.id === r.target);
    checks.push({ item: "task moved to pr", ok: task !== undefined && isDependencyDone(task.status), note: `status: ${task?.status ?? "task not found"}` });
    checks.push(prOpenCheck(r.pr));
    checks.push(ciCheck(r.pr));
  } else {
    checks.push(prOpenCheck(r.pr));
    if (r.kind === "taste_test") {
      const posted = r.transcript?.milestones.some((m) => m.title === "Review posted" && m.ok) ?? false;
      checks.push({ item: "review posted", ok: posted, note: posted ? runDescription(r) : "no successful gh pr review" });
    } else {
      const pushed = r.transcript?.milestones.some((m) => m.title === "Pushed" && m.ok) ?? false;
      checks.push({ item: "fixes pushed", ok: pushed, note: pushed ? "git push succeeded" : "nothing pushed" });
      checks.push(ciCheck(r.pr));
    }
  }
  return checks;
}

const prOpenCheck = (pr: PrInfo | null): GateCheck =>
  pr
    ? { item: "PR open", ok: pr.state === "OPEN" || pr.state === "MERGED", note: `PR #${pr.number} ${pr.state.toLowerCase()} on ${pr.branch}` }
    : { item: "PR open", ok: false, note: "no PR found" };

const ciCheck = (pr: PrInfo | null): GateCheck =>
  pr ? { item: "CI green", ok: pr.ci === "pass", note: `CI ${pr.ci}` } : { item: "CI green", ok: false, note: "no PR" };

const tokenTotal = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** Builds every session the UI can show, from one snapshot. */
export function buildModel(snap: Snapshot): Model {
  const runs = buildRuns(snap);
  const orders = groupOrders(snap.tasks);
  const sessionOfTask = new Map<string, string>();
  for (const o of orders) for (const id of o.taskIds) sessionOfTask.set(id, o.id);
  const sessionOfLane = (lane: string) => sessionOfTask.get(lane) ?? UNLINKED_ID;
  const { needs, stuckHistory } = buildNeeds(snap, runs, sessionOfLane);

  // An open need on a PR with no factory run (a human's review, say) still gets a lane, so it is never dropped.
  // A resolved one alone does not: a closed PR nobody ran anything on is history, not something to show.
  const unlinkedLanes = [
    ...new Set(
      [...runs.map((r) => r.lane), ...needs.filter((n) => n.resolvedAt === null).map((n) => n.lane)].filter(
        (l) => !sessionOfTask.has(l),
      ),
    ),
  ];
  const groups: { order: Order; lanes: string[]; isTaskOrder: boolean }[] = orders.map((o) => ({
    order: o,
    lanes: o.taskIds,
    isTaskOrder: true,
  }));
  if (unlinkedLanes.length) {
    groups.push({
      order: { id: UNLINKED_ID, title: "Unlinked PRs", taskIds: [] },
      lanes: unlinkedLanes,
      isTaskOrder: false,
    });
  }

  const model: Model = {
    sessions: [],
    details: new Map(),
    events: new Map(),
    gates: new Map(),
    envelopes: new Map(),
    liveSessions: new Set(runs.filter((r) => r.status === "running" && r.transcript).map((r) => r.transcript!.sessionId)),
    stuckHistory,
  };

  const taskById = new Map(snap.tasks.map((t) => [t.id, t]));
  for (const { order, lanes, isTaskOrder } of groups) {
    const laneRuns = lanes.map((l) => runs.filter((r) => r.lane === l));
    const tasks = order.taskIds.map((id) => taskById.get(id)).filter((t): t is Task => t !== undefined);
    const status = orderStatus(laneRuns, tasks, isTaskOrder);
    const phases: Phase[] = [];
    const events: Event[] = [];
    const gates: GateResult[] = [];
    const envelopes: Envelope[] = [];
    const agents: AgentSession[] = [];
    const laneMeta: Record<string, LaneMeta> = {};
    let tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    for (const [li, lane] of lanes.entries()) {
      const task = taskById.get(lane);
      const rs = laneRuns[li] ?? [];
      const deps = task?.dependencies ?? [];
      const depText = deps.map((d) => (order.taskIds.includes(d) ? d : `${d} (other order)`)).join(", ");
      const pr = (task ? currentPrOf(snap.prs, task) : null) ?? rs.findLast((r) => r.pr)?.pr;
      laneMeta[lane] = task
        ? { title: task.id, subtitle: deps.length ? `needs ${depText}` : "no dependencies" }
        : { title: lane, subtitle: pr?.branch ?? "no task matches this branch" };
      if (pr) laneMeta[lane].pr = { number: pr.number, url: pr.url };

      for (const [ri, r] of rs.entries()) {
        const seq = li * 1000 + ri;
        phases.push({
          phase_id: r.id,
          adw_id: order.id,
          seq,
          name: r.kind,
          kind: "agent",
          owner: lane,
          description: runDescription(r),
          status: PHASE_STATUS[r.status],
          attempt: ri + 1,
          retries: 0,
          error: r.status === "fail" ? (r.audit?.reason ?? NO_AUDIT_TEXT) : null,
          started_at: r.startedAt,
          ended_at: r.endedAt,
        });
        pushRunEvents(events, order.id, r);
        if (r.status !== "running") {
          const checks = resultChecks(r, snap);
          gates.push({
            id: gates.length + 1,
            adw_id: order.id,
            phase_id: r.id,
            attempt: 1,
            gate: "result checklist",
            passed: checks.every((c) => c.ok) ? 1 : 0,
            violations_json: JSON.stringify(checks.filter((c) => !c.ok).map((c) => `${c.item}: ${c.note}`)),
            checks_json: JSON.stringify(checks),
            created_at: r.endedAt,
          });
        }
        if (task) {
          envelopes.push({
            envelope_id: `${r.id}:task`,
            adw_id: order.id,
            phase_id: r.id,
            agent: lane,
            output_type: "task",
            payload_json: JSON.stringify({
              title: task.title,
              description: task.description,
              acceptanceCriteria: task.acceptanceCriteria,
              dependencies: task.dependencies,
              status: task.status,
            }),
            valid: 1,
            attempt: 1,
            created_at: r.startedAt,
          });
        }
        if (r.transcript) tokens = addTokens(tokens, r.transcript.tokens);
      }

      if (task && task.status === "pending" && !rs.some((r) => r.status === "running")) {
        const waitingOn = deps.filter((d) => {
          const dep = taskById.get(d);
          // Shown as waiting until the dependency is completed; a deleted one is not waited for.
          return dep !== undefined && dep.status !== "completed";
        });
        phases.push({
          phase_id: `queued:${task.id}`,
          adw_id: order.id,
          seq: li * 1000 + 999,
          name: "cook",
          kind: "agent",
          owner: lane,
          description: waitingOn.length
            ? `waiting on ${waitingOn.map((d) => (order.taskIds.includes(d) ? d : `${d} (other order)`)).join(", ")}`
            : "queued: ready for the loop",
          status: "queued",
          attempt: 0,
          retries: 0,
          error: null,
          started_at: null,
          ended_at: null,
        });
      }

      const lastWithModel = rs.toReversed().find((r) => r.transcript?.model);
      agents.push({
        adw_id: order.id,
        agent: lane,
        coding_agent: "claude",
        model: lastWithModel?.transcript?.model ?? null,
        session_id: rs.at(-1)?.transcript?.sessionId ?? null,
        color: null,
        context_tokens: null,
        context_window: null,
        created_at: rs[0]?.startedAt ?? null,
        last_used_at: rs.at(-1)?.endedAt ?? null,
      });
    }

    const starts = [
      ...tasks.map((t) => t.createdAt).filter((d): d is string => !!d),
      ...phases.map((p) => p.started_at).filter((d): d is string => !!d),
    ].toSorted();
    const ends = phases.map((p) => p.ended_at).filter((d): d is string => !!d).toSorted();
    const orderNeeds = needs.filter((n) => n.sessionId === order.id);
    const session: Session = {
      adw_id: order.id,
      adw_name: isTaskOrder ? "take_order" : "unlinked PRs",
      request: order.title,
      status: SESSION_STATUS[status],
      engineer: "You",
      started_at: starts[0] ?? null,
      ended_at: status === "running" ? null : (ends.at(-1) ?? null),
      total_tokens: tokenTotal(tokens),
      total_cost: null,
      archived: 0,
      // An order's tasks share a project; if they ever differ, the first task's wins.
      project: isTaskOrder ? (tasks[0]?.project ?? null) : null,
    };
    events.sort((a, b) => Date.parse(a.started_at ?? "") - Date.parse(b.started_at ?? "") || a.event_id.localeCompare(b.event_id));
    for (const [i, e] of events.entries()) e.rowid = i + 1;

    model.sessions.push({
      ...session,
      phases,
      phase_count: phases.length,
      agents,
      order_status: status,
      needs_open: orderNeeds.filter((n) => !n.resolvedAt).length,
      needs_broken: orderNeeds.filter((n) => !n.resolvedAt && n.severity === "broken").length,
    });
    model.details.set(order.id, {
      session,
      usage: { read: tokens.input + tokens.cacheWrite, written: tokens.output },
      phases,
      agents,
      order_status: status,
      lane_meta: laneMeta,
      loop_stops: lanes.flatMap((_, li) => (laneRuns[li] ?? []).filter((r) => r.kind === "cook" && r.audit && r.audit.outcome !== "success").map((r) => r.id)),
      needs: orderNeeds,
    });
    model.events.set(order.id, events);
    model.gates.set(order.id, gates);
    model.envelopes.set(order.id, envelopes);
  }

  model.sessions.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return model;
}

const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

function pushRunEvents(events: Event[], adwId: string, r: Run): void {
  const base = { adw_id: adwId, phase_id: r.id, parent_id: null, rowid: 0 };
  const t = r.transcript;
  events.push({
    ...base,
    event_id: `${r.id}:start`,
    type: "agent_start",
    name: r.kind,
    payload_json: JSON.stringify({ model: t?.model ?? undefined, session_id: t?.sessionId, coding_agent: "claude", purpose: `${r.kind} ${r.target}` }),
    tokens: null,
    started_at: r.startedAt,
    ended_at: null,
  });
  for (const [i, m] of (t?.milestones ?? []).entries()) {
    events.push({
      ...base,
      event_id: `${r.id}:m${String(i).padStart(4, "0")}`,
      type: "tool_call",
      name: m.title,
      payload_json: JSON.stringify({ tool: m.command.startsWith("Agent:") ? "agent" : "bash", args: { command: m.command }, ok: m.ok, title: m.title, description: m.description }),
      tokens: null,
      started_at: m.at,
      ended_at: m.endedAt,
    });
  }
  if (r.status === "running") return;
  const tok = t?.tokens;
  events.push({
    ...base,
    event_id: `${r.id}:end`,
    type: "agent_end",
    name: r.kind,
    payload_json: JSON.stringify(
      tok
        ? {
            usage: {
              input_tokens: tok.input,
              output_tokens: tok.output,
              cache_read_tokens: tok.cacheRead,
              cache_write_tokens: tok.cacheWrite,
              total_tokens: tokenTotal(tok),
            },
          }
        : {},
    ),
    tokens: tok ? tokenTotal(tok) : null,
    started_at: r.endedAt,
    ended_at: null,
  });
  events.push({
    ...base,
    event_id: `${r.id}:result`,
    type: r.status === "success" ? "gate_pass" : "gate_fail",
    name: "result checklist",
    payload_json: null,
    tokens: null,
    started_at: r.endedAt,
    ended_at: null,
  });
}
