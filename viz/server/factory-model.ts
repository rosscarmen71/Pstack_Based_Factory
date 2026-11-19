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
import type { Task } from "../../factory/tasks.schema.ts";
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

// ── Inputs ──────────────────────────────────────────────────────────────────

export type RunKind = "cook" | "taste_test" | "remake";

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
  /** Task id for cook, PR number (as text) for taste_test and remake. */
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
  labels: string[];
  reviews: PrReview[];
  commitDates: string[];
}

export interface LabelEvent {
  event: "labeled" | "unlabeled";
  label: string;
  at: string;
}

/** A stuck-in_progress sighting the visualizer itself recorded (it leaves no trace in the factory's files). */
export interface StuckHistoryEntry {
  taskId: string;
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
  now: number;
}

// ── Outputs beyond their shared types ───────────────────────────────────────

export type NeedKind = "loop_stopped" | "needs_human" | "stuck_changes" | "ready_for_review" | "stuck_in_progress";

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
  /** Where clicking the highlighted spot goes: a PR page, or the run's panel. */
  goTo: { kind: "pr"; url: string } | { kind: "run"; phaseId: string };
}

export interface LaneMeta {
  title: string;
  subtitle: string;
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
  /** Stuck-in_progress sightings to persist; factory-source.ts writes them. */
  stuckHistory: StuckHistoryEntry[];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Tasks next to each other whose createdAt are this close belong to one take_order order. */
export const ORDER_GAP_MS = 5 * 60_000;
/** A transcript written to this recently, with no audit row yet, is a run in progress. */
export const LIVE_WRITE_MS = 120_000;
export const UNLINKED_ID = "unlinked-prs";
export const UNDATED_ID = "tasks-without-a-date";

/** A run whose transcript ended with no audit row: it ran outside the loop, or was cut off before the loop recorded it. */
const NO_AUDIT_TEXT = "no result in the audit log (ran outside the loop, or was cut off)";

const AUDIT_ACTION: Record<RunKind, AuditAction> = { cook: "dev-task", taste_test: "review", remake: "patch" };
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

/** Groups tasks into take_order orders: neighbours in tasks.json whose createdAt are within ORDER_GAP_MS. */
export function groupOrders(tasks: Task[]): Order[] {
  const orders: Order[] = [];
  const undated: string[] = [];
  let current: { ids: string[]; last: number } | null = null;
  for (const task of tasks) {
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
    o.id = `order-${o.taskIds[0]}`;
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

const taskForBranch = (tasks: Task[], branch: string) => tasks.find((t) => branch.endsWith(`/${t.id}`)) ?? null;

export function runStatus(audit: AuditEntry | null, live: boolean): RunStatus {
  if (!audit) return live ? "running" : "fail";
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
            a.action === AUDIT_ACTION[t.kind] &&
            String(a.target) === t.target &&
            Date.parse(a.at) >= start - 5_000,
        )
        .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null;
    if (audit) used.add(audit);
    const laterStarted = transcripts.slice(i + 1).some((n) => Date.parse(n.startedAt) > start);
    const live = !audit && (snap.now - t.mtimeMs < LIVE_WRITE_MS || (snap.loopRunning && !laterStarted));
    runs.push(makeRun(snap, t.kind, t.target, `run:${t.sessionId}`, t.startedAt, audit, t, live));
  }
  for (const a of snap.audit) {
    if (used.has(a)) continue;
    const startedAt = new Date(Date.parse(a.at) - a.durationMs).toISOString();
    runs.push(makeRun(snap, RUN_KIND[a.action], String(a.target), `audit:${a.at}`, startedAt, a, null, false));
  }
  return runs.toSorted((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
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
  const pr =
    kind === "cook"
      ? (snap.prs.find((p) => taskForBranch(snap.tasks, p.branch)?.id === target) ?? null)
      : (snap.prs.find((p) => String(p.number) === target) ?? null);
  const lane = kind === "cook" ? target : (pr && taskForBranch(snap.tasks, pr.branch)?.id) || `PR #${target}`;
  const status = runStatus(audit, live);
  const endedAt = status === "running" ? null : (audit?.at ?? transcript?.lastAt ?? startedAt);
  return { id, kind, target, lane, startedAt, endedAt, status, audit, transcript, pr };
}

// ── Needs ───────────────────────────────────────────────────────────────────

const VERDICT_CHANGES = /Verdict:\s*\**\s*CHANGES/i;

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
    const task = taskForBranch(snap.tasks, pr.branch);
    const lane = task?.id ?? `PR #${pr.number}`;
    const closedAt = pr.mergedAt ?? pr.closedAt;
    const prRuns = runs.filter((r) => r.lane === lane);
    const anchor = (at: string) =>
      prRuns.filter((r) => Date.parse(r.startedAt) <= Date.parse(at)).at(-1)?.id ?? prRuns.at(-1)?.id ?? null;
    const goTo: Need["goTo"] = { kind: "pr", url: pr.url };

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

    if (task && (pr.state !== "OPEN" || pr.ci === "pass")) {
      needs.push({
        id: `ready_for_review:${pr.number}`,
        kind: "ready_for_review",
        severity: "review",
        title: "Ready for your review",
        description: `PR #${pr.number} for ${task.id} is open with CI green. Review and merge it on GitHub; the loop never merges.`,
        sessionId: sessionOfLane(lane),
        lane,
        phaseId: anchor(pr.createdAt),
        raisedAt: pr.createdAt,
        resolvedAt: closedAt,
        goTo,
      });
    }
  }

  const stuckNow = new Set(
    snap.tasks
      .filter((t) => t.status === "in_progress" && !runs.some((r) => r.lane === t.id && r.status === "running"))
      .map((t) => t.id),
  );
  const history = snap.stuckHistory.map((h) => ({ ...h }));
  for (const h of history) if (!h.resolvedAt && !stuckNow.has(h.taskId)) h.resolvedAt = nowIso;
  for (const id of stuckNow) {
    if (!history.some((h) => h.taskId === id && !h.resolvedAt)) history.push({ taskId: id, raisedAt: nowIso });
  }
  for (const h of history) {
    const last = runs.filter((r) => r.lane === h.taskId).at(-1);
    needs.push({
      id: `stuck_in_progress:${h.taskId}:${h.raisedAt}`,
      kind: "stuck_in_progress",
      severity: "broken",
      title: "Task stuck in progress",
      description: `${h.taskId} is marked in_progress but no run is working on it, usually because a run crashed or the loop was killed. Set it back to pending to retry.`,
      sessionId: sessionOfLane(h.taskId),
      lane: h.taskId,
      phaseId: last?.id ?? null,
      raisedAt: h.raisedAt,
      resolvedAt: h.resolvedAt ?? null,
      goTo: last ? runOpen(last) : { kind: "run", phaseId: "" },
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
  if (isTaskOrder) return tasks.length > 0 && tasks.every((t) => t.status === "pr") ? "done" : "waiting";
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
    checks.push({ item: "task moved to pr", ok: task?.status === "pr", note: `status: ${task?.status ?? "task not found"}` });
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
      const pr = rs.find((r) => r.pr)?.pr;
      laneMeta[lane] = task
        ? { title: task.id, subtitle: deps.length ? `needs ${depText}` : "no dependencies" }
        : { title: lane, subtitle: pr?.branch ?? "no task matches this branch" };

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
        const waitingOn = deps.filter((d) => taskById.get(d)?.status !== "pr");
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
