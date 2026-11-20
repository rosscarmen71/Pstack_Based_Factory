import { DEFAULT_SETTINGS } from "../../factory/settings.ts";
import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "../../factory/audit-log.ts";
import type { Task } from "../../factory/tasks.schema.ts";
import {
  buildModel,
  depState,
  isBucketId,
  ordersOf,
  groupOrders,
  milestoneFor,
  runStatus,
  UNDATED_ID,
  UNLINKED_ID,
  type PrInfo,
  type Snapshot,
  type Transcript,
} from "./factory-model.ts";
import type { CustomizeState } from "../shared/customize.ts";
import { parseFeed, parseTranscript, runCommand } from "./transcripts.ts";

const T0 = Date.parse("2026-11-18T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  description: `Do ${id}`,
  acceptanceCriteria: ["it works (proof: live)"],
  dependencies: [],
  status: "pending",
  createdAt: at(0),
  ...over,
});

const audit = (over: Partial<AuditEntry>): AuditEntry => ({
  at: at(5),
  action: "dev-task",
  target: "a",
  title: "t",
  outcome: "success",
  exitCode: 0,
  durationMs: 60_000,
  ...over,
});

const transcript = (over: Partial<Transcript>): Transcript => ({
  sessionId: "11111111-1111-1111-1111-111111111111",
  kind: "cook",
  target: "a",
  startedAt: at(4),
  lastAt: at(5),
  mtimeMs: T0 + 5 * 60_000,
  model: "claude-opus",
  tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
  milestones: [],
  ...over,
});

const pr = (over: Partial<PrInfo>): PrInfo => ({
  number: 1,
  url: "https://github.com/o/r/pull/1",
  repo: "o/r",
  title: "chore: a",
  branch: "chore/a",
  state: "OPEN",
  createdAt: at(5),
  mergedAt: null,
  closedAt: null,
  ci: "pass",
  headSha: "head1",
  labels: [],
  reviews: [],
  commitDates: [],
  comments: [],
  ...over,
});

const snap = (over: Partial<Snapshot>): Snapshot => ({
  tasks: [],
  audit: [],
  prs: [],
  transcripts: [],
  labelEvents: {},
  stuckHistory: [],
  loopRunning: false,
  customize: {},
  now: T0 + 60 * 60_000,
  ...over,
});

describe("task info for the controls", () => {
  const HANDS_OFF = { ...DEFAULT_SETTINGS, defaultMode: "hands-off" as const };

  test("each task lane carries its state, mode and dependencies with reasons and what they wait for", () => {
    const m = buildModel(
      snap({
        tasks: [
          task("a", { status: "pr", session: "s1" }),
          task("b", { session: "s1", dependencies: ["a", "gone"], dependencyReasons: { a: "both edit x.ts" }, mode: "hands-off" }),
          task("c", { session: "s1", needsYou: "cook failed (exit 1)", attempts: 2 }),
        ],
      }),
    );
    const meta = m.details.get("s1")!.lane_meta;
    expect(meta.b?.task).toEqual({
      id: "b",
      status: "pending",
      needsYou: null,
      attempts: 0,
      mode: { mode: "hands-off", from: "task", own: "hands-off", inherited: "hands-on" },
      dependencies: [
        { id: "a", reason: "both edit x.ts", met: false, text: "waiting on a to merge" },
        { id: "gone", reason: null, met: true, text: null },
      ],
    });
    expect(meta.c?.task).toMatchObject({ needsYou: "cook failed (exit 1)", attempts: 2 });
  });

  test("what a dependency waits for follows the dependency's own mode", () => {
    const tasks = new Map([
      ["built", task("built", { status: "pr" })],
      ["todo", task("todo")],
      ["done", task("done", { status: "completed" })],
      ["stuck", task("stuck", { status: "pr", needsYou: "PR #7 was closed without merging" })],
    ]);
    expect(depState("built", null, tasks, DEFAULT_SETTINGS).text).toBe("waiting on built to merge");
    expect(depState("built", null, tasks, HANDS_OFF).text).toBe("waiting on taste_test of built");
    expect(depState("todo", null, tasks, HANDS_OFF).text).toBe("waiting on todo to be built");
    expect(depState("done", "r", tasks, DEFAULT_SETTINGS)).toEqual({ id: "done", reason: "r", met: true, text: null });
    expect(depState("stuck", null, tasks, HANDS_OFF).text).toBe("waiting on you: stuck: PR #7 was closed without merging");
  });

  test("a session reports its mode, its task count and whether every task is completed", () => {
    const m = buildModel(
      snap({
        tasks: [
          task("a", { status: "completed", session: "s1", project: "p" }),
          task("b", { status: "completed", session: "s1", project: "p" }),
          task("c", { session: "s2", project: "p" }),
          task("old", { createdAt: at(0) }),
        ],
        settings: { ...DEFAULT_SETTINGS, projects: { p: "hands-off" }, sessions: { s2: "hands-on" } },
      }),
    );
    const by = (id: string) => m.sessions.find((s) => s.adw_id === id)!;
    expect(by("s1")).toMatchObject({ completed: true, task_count: 2, mode: { mode: "hands-off", from: "project", own: null, inherited: "hands-off" } });
    expect(by("s2")).toMatchObject({ completed: false, task_count: 1, mode: { mode: "hands-on", from: "session", own: "hands-on", inherited: "hands-off" } });
    // An older order with no stored session id cannot carry a mode of its own.
    expect(by("order-old").mode).toBeNull();
  });
});

describe("a snapshot of a named project", () => {
  test("every session reports the project, and the catch-all buckets carry it in their id", () => {
    const m = buildModel(
      snap({
        projectName: "acme/api",
        tasks: [task("a", { session: "s1" }), task("old", { createdAt: undefined })],
        audit: [audit({ action: "review", target: 2 })],
        transcripts: [transcript({ kind: "taste_test", target: "2" })],
        prs: [pr({ number: 2, branch: "refactor/x" })],
      }),
    );
    expect(m.sessions.map((s) => [s.adw_id, s.project]).toSorted()).toEqual([
      ["s1", "acme/api"],
      ["tasks-without-a-date@acme/api", "acme/api"],
      ["unlinked-prs@acme/api", "acme/api"],
    ]);
    expect(isBucketId("unlinked-prs@acme/api")).toBe(true);
    expect(isBucketId("tasks-without-a-date")).toBe(true);
    expect(isBucketId("s1")).toBe(false);
    expect(ordersOf([task("old", { createdAt: undefined })], "acme/api")[0]?.id).toBe("tasks-without-a-date@acme/api");
  });
});

describe("orders", () => {
  test("neighbours within 5 minutes form one order titled by its first task", () => {
    const orders = groupOrders([task("a", { createdAt: at(0) }), task("b", { createdAt: at(1) }), task("c", { createdAt: at(30) })]);
    expect(orders.map((o) => o.taskIds)).toEqual([["a", "b"], ["c"]]);
    expect(orders[0]?.title).toBe("Title a +1 more");
    expect(orders[1]?.title).toBe("Title c");
  });

  test("tasks that store a session are grouped by it, whatever their dates", () => {
    const orders = groupOrders([
      task("a", { createdAt: at(0), session: "s1" }),
      task("b", { createdAt: at(1), session: "s2" }),
      task("c", { createdAt: at(90), session: "s1" }),
      task("d", { createdAt: at(91) }),
    ]);
    expect(orders.map((o) => [o.id, o.taskIds])).toEqual([
      ["s1", ["a", "c"]],
      ["s2", ["b"]],
      ["order-d", ["d"]],
    ]);
    expect(orders[0]?.title).toBe("Title a +1 more");
  });

  test("tasks with no createdAt go into one 'Tasks without a date' order", () => {
    const orders = groupOrders([task("a"), task("b", { createdAt: undefined })]);
    expect(orders.at(-1)).toEqual({ id: UNDATED_ID, title: "Tasks without a date", taskIds: ["b"] });
  });
});

describe("run status", () => {
  test("a skip whose reason starts with failed: is a failure; other skips are skipped", () => {
    expect(runStatus(audit({ outcome: "skip", reason: "failed: merge conflict" }), false)).toBe("fail");
    expect(runStatus(audit({ outcome: "skip", reason: "task already done" }), false)).toBe("skipped");
    expect(runStatus(audit({ outcome: "failure", reason: "exited with code 1" }), false)).toBe("fail");
  });

  test("no audit row is running while live, a failure once it is not", () => {
    expect(runStatus(null, true)).toBe("running");
    expect(runStatus(null, false)).toBe("fail");
  });
});

describe("milestones", () => {
  test("only commands in the fixed table become milestones", () => {
    expect(milestoneFor("Bash", { command: "git checkout -b chore/a origin/main" })?.title).toBe("Branch created");
    expect(milestoneFor("Bash", { command: "gh pr create --title x" })?.title).toBe("PR opened");
    expect(milestoneFor("Bash", { command: "bun run check" })?.title).toBe("Checks ran");
    expect(milestoneFor("Agent", { description: "verify" })?.command).toBe("Agent: verify");
    expect(milestoneFor("Bash", { command: "ls -la" })).toBeNull();
    expect(milestoneFor("Read", { file_path: "x" })).toBeNull();
  });
});

describe("waterfall", () => {
  test("one lane per task: runs as blocks, an unstarted task as a queued block naming what it waits on", () => {
    const m = buildModel(
      snap({
        tasks: [task("a", { status: "pr" }), task("b", { dependencies: ["a", "z"] }), task("z", { createdAt: at(90) })],
        audit: [audit({ target: "a" })],
        transcripts: [transcript({ target: "a" })],
        prs: [pr({})],
      }),
    );
    const detail = m.details.get("order-a")!;
    expect(detail.phases.map((p) => [p.owner, p.name, p.status, p.description])).toEqual([
      ["a", "cook", "success", "PR #1 opened"],
      ["b", "cook", "queued", "waiting on a, z (other order)"],
    ]);
    expect(detail.lane_meta.b).toMatchObject({ title: "b", subtitle: "needs a, z (other order)" });
  });

  test("a review on a PR that matches no task lands in the Unlinked PRs order, on its own lane", () => {
    const m = buildModel(
      snap({
        audit: [audit({ action: "review", target: 2 })],
        transcripts: [transcript({ kind: "taste_test", target: "2" })],
        prs: [pr({ number: 2, branch: "refactor/x" })],
      }),
    );
    expect(m.details.get(UNLINKED_ID)?.phases.map((p) => [p.owner, p.name])).toEqual([["PR #2", "taste_test"]]);
  });

  test("a PR on <type>/<task-id> belongs to that task's lane", () => {
    const m = buildModel(
      snap({
        tasks: [task("a", { status: "pr" })],
        audit: [audit({ action: "patch", target: 1 })],
        transcripts: [transcript({ kind: "remake", target: "1" })],
        prs: [pr({ branch: "fix/a" })],
      }),
    );
    expect(m.details.get("order-a")?.phases.map((p) => [p.owner, p.name])).toEqual([["a", "remake"]]);
    expect(m.details.has(UNLINKED_ID)).toBe(false);
  });

  test("milestone ticks carry title, command and ok in their payload, and rowids follow time", () => {
    const m = buildModel(
      snap({
        tasks: [task("a", { status: "pr" })],
        audit: [audit({})],
        transcripts: [
          transcript({
            milestones: [
              { title: "Branch created", description: "d", command: "git checkout -b chore/a", ok: true, at: at(4.2), endedAt: at(4.2) },
              { title: "PR opened", description: "d", command: "gh pr create", ok: false, at: at(4.8), endedAt: at(4.9) },
            ],
          }),
        ],
      }),
    );
    const events = m.events.get("order-a")!;
    const ticks = events.filter((e) => e.type === "tool_call");
    expect(ticks.map((e) => JSON.parse(e.payload_json!).ok)).toEqual([true, false]);
    expect(JSON.parse(ticks[1]!.payload_json!).args.command).toBe("gh pr create");
    expect(events.map((e) => e.rowid)).toEqual(events.map((_, i) => i + 1));
  });
});

describe("order status", () => {
  const base = { tasks: [task("a", { status: "pr" })], prs: [pr({})] };
  test("done when every task reached pr", () => {
    const m = buildModel(snap({ ...base, audit: [audit({})], transcripts: [transcript({})] }));
    expect(m.sessions[0]?.order_status).toBe("done");
  });
  test("a skipped cook makes the order broken", () => {
    const m = buildModel(snap({ ...base, audit: [audit({ outcome: "skip", reason: "task already done" })], transcripts: [transcript({})] }));
    expect(m.sessions[0]?.order_status).toBe("broken");
  });
  test("a live run with no audit row yet makes it running", () => {
    const m = buildModel(snap({ ...base, now: T0 + 5 * 60_000 + 1000, transcripts: [transcript({})] }));
    expect(m.sessions[0]?.order_status).toBe("running");
    expect(m.liveSessions.has("11111111-1111-1111-1111-111111111111")).toBe(true);
  });
  test("pending tasks with nothing running are waiting", () => {
    const m = buildModel(snap({ tasks: [task("a")] }));
    expect(m.sessions[0]?.order_status).toBe("waiting");
  });
});

describe("needs you", () => {
  test("a Verdict: CHANGES review is stuck until a later commit", () => {
    const review = { state: "COMMENTED", body: "**Verdict: CHANGES**\n\nbad", submittedAt: at(10), commit: "head1" };
    const stuck = buildModel(snap({ prs: [pr({ number: 2, branch: "x/y", reviews: [review], commitDates: [at(1)] })] }));
    expect(stuck.details.get(UNLINKED_ID)?.needs.map((n) => [n.kind, n.resolvedAt])).toEqual([["stuck_changes", null]]);
    expect(stuck.details.get(UNLINKED_ID)?.lane_meta["PR #2"]?.title).toBe("PR #2");
    const closed = buildModel(snap({ prs: [pr({ number: 2, branch: "x/y", reviews: [review], state: "CLOSED", closedAt: at(20) })] }));
    expect(closed.details.has(UNLINKED_ID)).toBe(false);
    const withRun = buildModel(
      snap({
        prs: [pr({ number: 2, branch: "x/y", reviews: [review], commitDates: [at(1), at(15)] })],
        audit: [audit({ action: "review", target: 2, at: at(10) })],
        transcripts: [transcript({ kind: "taste_test", target: "2", startedAt: at(9), lastAt: at(10) })],
      }),
    );
    expect(withRun.details.get(UNLINKED_ID)?.needs.map((n) => [n.kind, n.resolvedAt])).toEqual([["stuck_changes", at(15)]]);
  });

  test("a failed cook stops the loop until that task runs again", () => {
    const m = buildModel(
      snap({
        tasks: [task("a")],
        audit: [audit({ outcome: "failure", reason: "exited with code 1", at: at(5) }), audit({ at: at(30) })],
        transcripts: [
          transcript({ sessionId: "aaaaaaaa-1111-1111-1111-111111111111", startedAt: at(4) }),
          transcript({ sessionId: "bbbbbbbb-1111-1111-1111-111111111111", startedAt: at(29), lastAt: at(30) }),
        ],
      }),
    );
    const need = m.details.get("order-a")?.needs.find((n) => n.kind === "loop_stopped");
    expect(need?.resolvedAt).toBe(at(29));
    expect(need?.goTo).toEqual({ kind: "run", phaseId: "run:aaaaaaaa-1111-1111-1111-111111111111" });
    expect(m.details.get("order-a")?.loop_stops).toEqual(["run:aaaaaaaa-1111-1111-1111-111111111111"]);
  });

  test("a cook that ran outside the loop (no audit row) never counts as stopping it", () => {
    const m = buildModel(snap({ tasks: [task("a")], transcripts: [transcript({})] }));
    expect(m.details.get("order-a")?.phases[0]?.status).toBe("fail");
    expect(m.details.get("order-a")?.loop_stops).toEqual([]);
  });

  test("a needs-human label is open until it is removed", () => {
    const m = buildModel(
      snap({
        prs: [pr({ number: 3, branch: "x/y" })],
        audit: [audit({ action: "patch", target: 3 })],
        transcripts: [transcript({ kind: "remake", target: "3" })],
        labelEvents: { 3: [{ event: "labeled", label: "needs-human", at: at(8) }, { event: "unlabeled", label: "needs-human", at: at(40) }] },
      }),
    );
    expect(m.details.get(UNLINKED_ID)?.needs.map((n) => [n.kind, n.resolvedAt])).toEqual([["needs_human", at(40)]]);
  });
});

describe("transcripts", () => {
  const line = (o: object) => JSON.stringify(o);
  const text = [
    line({ type: "user", timestamp: at(1), message: { content: "<command-message>cook</command-message>\n<command-name>/cook</command-name>\n<command-args>add-x</command-args>" } }),
    line({ type: "assistant", timestamp: at(2), message: { id: "m1", model: "claude-opus", usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: "text", text: "Starting." }] } }),
    line({ type: "assistant", timestamp: at(2), message: { id: "m1", model: "claude-opus", usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git push -u origin feat/add-x" } }] } }),
    line({ type: "user", timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "rejected" }] } }),
    '{"type":"assistant","timestamp":"half-written',
  ].join("\n");

  test("recognises the factory command and its argument", () => {
    expect(runCommand(text)).toEqual({ kind: "cook", target: "add-x" });
    expect(runCommand(line({ type: "user", message: { content: "hello" } }))).toBeNull();
  });

  test("milestones take ok from the tool result, tokens count each message once", () => {
    const t = parseTranscript(text, "s", 0)!;
    expect(t.milestones.map((m) => [m.title, m.ok])).toEqual([["Pushed", false]]);
    expect(t.tokens).toEqual({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect([t.startedAt, t.lastAt]).toEqual([at(1), at(3)]);
  });

  test("the feed lists agent text, tool calls and results in order", () => {
    expect(parseFeed(text).map((f) => [f.i, f.kind, f.ok])).toEqual([
      [1, "agent", undefined],
      [2, "tool", undefined],
      [3, "result", false],
    ]);
  });
});

describe("run warnings", () => {
  const NOW = T0 + 60 * 60_000;
  const needsOf = (m: ReturnType<typeof buildModel>) => m.details.get("order-a")?.needs.map((n) => [n.kind, n.resolvedAt]) ?? [];
  const running = (over: Partial<Transcript>) => transcript({ startedAt: at(58), lastAt: at(59), mtimeMs: NOW - 5_000, ...over });

  test("a task the loop just marked in_progress, before its transcript exists, needs nothing", () => {
    const m = buildModel(snap({ tasks: [task("a", { status: "in_progress" })], loopRunning: true }));
    expect(needsOf(m)).toEqual([]);
    expect(m.stuckHistory).toEqual([]);
  });

  test("a task in_progress while the loop is not running is stranded until it moves on", () => {
    const first = buildModel(snap({ tasks: [task("a", { status: "in_progress" })], loopRunning: false }));
    expect(needsOf(first)).toEqual([["task_stranded", null]]);
    const later = buildModel(snap({ tasks: [task("a")], stuckHistory: first.stuckHistory, now: NOW + 60_000 }));
    expect(needsOf(later)).toEqual([["task_stranded", new Date(NOW + 60_000).toISOString()]]);
  });

  test("a running agent that has not written for 5 minutes is silent until it writes again", () => {
    const quiet = buildModel(
      snap({ tasks: [task("a", { status: "in_progress" })], loopRunning: true, transcripts: [running({ mtimeMs: NOW - 6 * 60_000 })] }),
    );
    expect(needsOf(quiet)).toEqual([["agent_silent", null]]);
    const writing = buildModel(
      snap({
        tasks: [task("a", { status: "in_progress" })],
        loopRunning: true,
        transcripts: [running({ mtimeMs: NOW + 60_000 })],
        stuckHistory: quiet.stuckHistory,
        now: NOW + 90_000,
      }),
    );
    expect(needsOf(writing)).toEqual([["agent_silent", new Date(NOW + 90_000).toISOString()]]);
  });

  test("a run going for 15 minutes or more is running long", () => {
    const m = buildModel(snap({ tasks: [task("a", { status: "in_progress" })], loopRunning: true, transcripts: [running({ startedAt: at(44) })] }));
    expect(needsOf(m)).toEqual([["running_long", null]]);
  });

  test("a normal running cook raises no warning", () => {
    const m = buildModel(snap({ tasks: [task("a", { status: "in_progress" })], loopRunning: true, transcripts: [running({})] }));
    expect(needsOf(m)).toEqual([]);
  });

  test("old stuck_in_progress history entries are dropped", () => {
    const legacy = [{ taskId: "a", raisedAt: at(1), resolvedAt: at(2) }] as unknown as Snapshot["stuckHistory"];
    const m = buildModel(snap({ tasks: [task("a")], stuckHistory: legacy }));
    expect(needsOf(m)).toEqual([]);
    expect(m.stuckHistory).toEqual([]);
  });
});

describe("ready for your review", () => {
  const approve = (commit: string, submittedAt: string) => ({ state: "COMMENTED", body: "Verdict: APPROVE\n\nfine", submittedAt, commit });
  const readyOf = (m: ReturnType<typeof buildModel>) =>
    m.details.get("order-a")?.needs.filter((n) => n.kind === "ready_for_review").map((n) => [n.raisedAt, n.resolvedAt]) ?? [];
  const tasks = [task("a", { status: "pr" })];

  test("a PR cook just opened, with CI green but no review, is not ready", () => {
    expect(readyOf(buildModel(snap({ tasks, prs: [pr({})] })))).toEqual([]);
  });

  test("an APPROVE on an older commit does not make the PR ready", () => {
    expect(readyOf(buildModel(snap({ tasks, prs: [pr({ reviews: [approve("old", at(10))] })] })))).toEqual([]);
  });

  test("an APPROVE on the current commit with CI green makes it ready from the review time", () => {
    expect(readyOf(buildModel(snap({ tasks, prs: [pr({ reviews: [approve("head1", at(10))] })] })))).toEqual([[at(10), null]]);
  });

  test("a later CHANGES review on the current commit is not ready", () => {
    const changes = { state: "COMMENTED", body: "Verdict: CHANGES\n\nbad", submittedAt: at(12), commit: "head1" };
    expect(readyOf(buildModel(snap({ tasks, prs: [pr({ reviews: [approve("head1", at(10)), changes] })] })))).toEqual([]);
  });

  test("the changes-requested or needs-human label means not ready", () => {
    for (const label of ["changes-requested", "needs-human"]) {
      const m = buildModel(snap({ tasks, prs: [pr({ labels: [label], reviews: [approve("head1", at(10))] })] }));
      expect(readyOf(m)).toEqual([]);
    }
  });

  test("failing CI means not ready", () => {
    expect(readyOf(buildModel(snap({ tasks, prs: [pr({ ci: "fail", reviews: [approve("head1", at(10))] })] })))).toEqual([]);
  });

  test("a ready PR resolves when it is merged", () => {
    const m = buildModel(snap({ tasks, prs: [pr({ state: "MERGED", mergedAt: at(20), reviews: [approve("head1", at(10))] })] }));
    expect(readyOf(m)).toEqual([[at(10), at(20)]]);
  });
});

describe("customize_order", () => {
  const comment = (body: string, createdAt: string) => ({ body, createdAt });
  const needsOf = (m: ReturnType<typeof buildModel>, id: string) =>
    m.details.get(id)?.needs.filter((n) => n.kind === "task_change_requested").map((n) => [n.raisedAt, n.resolvedAt]) ?? [];

  test("a run with no audit row is one customize_order block that succeeded, never a failure or a loop stop", () => {
    const m = buildModel(
      snap({
        tasks: [task("a", { status: "pr" })],
        transcripts: [transcript({ kind: "customize_order", target: "1", mtimeMs: T0 })],
        prs: [pr({})],
        now: T0 + 60 * 60_000,
        loopRunning: true,
      }),
    );
    const d = m.details.get("order-a");
    expect(d?.phases.map((p) => [p.owner, p.name, p.status])).toEqual([["a", "customize_order", "success"]]);
    expect(d?.needs.filter((n) => n.kind === "loop_stopped")).toEqual([]);
    expect(d?.loop_stops).toEqual([]);
  });

  test("a customize_order run still being written is running, and an unmatched PR gets a PR lane", () => {
    const m = buildModel(
      snap({
        transcripts: [transcript({ kind: "customize_order", target: "7", mtimeMs: T0 + 5 * 60_000 })],
        prs: [pr({ number: 7, branch: "x/y" })],
        now: T0 + 6 * 60_000,
      }),
    );
    expect(m.details.get(UNLINKED_ID)?.phases.map((p) => [p.owner, p.status])).toEqual([["PR #7", "running"]]);
  });

  test("a pending /customize_order comment raises a review need that a later summary resolves", () => {
    const tasks = [task("a", { status: "pr" })];
    const request = comment("  /customize_order please add X", at(10));
    const open = buildModel(snap({ tasks, prs: [pr({ comments: [request] })] }));
    expect(needsOf(open, "order-a")).toEqual([[at(10), null]]);
    const need = open.details.get("order-a")?.needs[0];
    expect(need?.severity).toBe("review");
    expect(need?.goTo).toEqual({ kind: "pr", url: "https://github.com/o/r/pull/1" });
    const done = buildModel(
      snap({ tasks, prs: [pr({ comments: [request, comment("## Customize order summary\n\nchanged", at(25))] })] }),
    );
    expect(needsOf(done, "order-a")).toEqual([[at(10), at(25)]]);
    const again = buildModel(
      snap({
        tasks,
        prs: [pr({ comments: [request, comment("## Customize order summary", at(25)), comment("/customize_order more", at(30))] })],
      }),
    );
    expect(needsOf(again, "order-a")).toEqual([
      [at(10), at(25)],
      [at(30), null],
    ]);
  });

  test("the request's dot asks a question while the agent waits, awaits a reply when idle, and goes back after", () => {
    const tasks = [task("a", { status: "pr" })];
    const prs = [pr({ comments: [comment("/customize_order add X", at(10))] })];
    const state = (over: Partial<CustomizeState>): Record<number, CustomizeState> => ({
      1: { pr: 1, status: "waiting", sessionId: "s", pending: null, error: null, ...over },
    });
    const need = (customize: Record<number, CustomizeState>, p = prs) =>
      buildModel(snap({ tasks, prs: p, customize })).details.get("order-a")?.needs.find((n) => n.kind === "task_change_requested");
    const asking = need(
      state({
        pending: {
          id: "t1",
          questions: [
            { question: "Which file?", header: "File", multiSelect: false, options: [{ label: "a", description: "" }] },
            { question: "Add a test?", header: "Test", multiSelect: false, options: [] },
          ],
        },
      }),
    );
    expect(asking?.title).toBe("Agent is asking you a question");
    expect(asking?.description).toContain("Which file?");
    expect(asking?.description).toContain("Add a test?");
    expect(need(state({ status: "idle" }))?.title).toBe("Agent is waiting for your reply");
    for (const status of ["running", "starting", "failed"] as const) {
      expect(need(state({ status }))?.title).toBe("Comment asks to change the task");
    }
    expect(need({})?.title).toBe("Comment asks to change the task");
    // Answered request: the resolved dot keeps its plain title whatever the agent says.
    const answered = [pr({ comments: [comment("/customize_order add X", at(10)), comment("## Customize order summary", at(25))] })];
    expect(need(state({ status: "idle" }), answered)?.title).toBe("Comment asks to change the task");
  });

  test("the request's dot anchors to the customize_order run once it exists, else to the earlier run", () => {
    const tasks = [task("a", { status: "pr" })];
    const cook = transcript({ sessionId: "c0", target: "a", startedAt: at(4), lastAt: at(5) });
    const prs = [pr({ comments: [comment("/customize_order add X", at(10))] })];
    const anchorOf = (m: ReturnType<typeof buildModel>) =>
      m.details.get("order-a")?.needs.find((n) => n.kind === "task_change_requested")?.phaseId;
    const before = buildModel(snap({ tasks, prs, transcripts: [cook], audit: [audit({ at: at(5) })] }));
    expect(anchorOf(before)).toBe("run:c0");

    const custom = transcript({ sessionId: "c1", kind: "customize_order", target: "1", startedAt: at(12), lastAt: at(20), mtimeMs: T0 });
    const after = buildModel(snap({ tasks, prs, transcripts: [cook, custom], audit: [audit({ at: at(5) })] }));
    expect(anchorOf(after)).toBe("run:c1");
  });

  test("a customize_order run that started before the comment is not its answer", () => {
    const tasks = [task("a", { status: "pr" })];
    const old = transcript({ sessionId: "c1", kind: "customize_order", target: "1", startedAt: at(2), lastAt: at(3), mtimeMs: T0 });
    const cook = transcript({ sessionId: "c0", target: "a", startedAt: at(4), lastAt: at(5) });
    const m = buildModel(
      snap({ tasks, prs: [pr({ comments: [comment("/customize_order again", at(10))] })], transcripts: [old, cook] }),
    );
    expect(m.details.get("order-a")?.needs.find((n) => n.kind === "task_change_requested")?.phaseId).toBe("run:c0");
  });

  test("lane_meta carries the lane's PR number and url for the run panel", () => {
    const m = buildModel(
      snap({ tasks: [task("a", { status: "pr" })], transcripts: [transcript({ target: "a" })], prs: [pr({})] }),
    );
    expect(m.details.get("order-a")?.lane_meta.a?.pr).toMatchObject({ number: 1, url: "https://github.com/o/r/pull/1" });
  });

  test("merging or closing the PR resolves a pending request", () => {
    const m = buildModel(
      snap({ tasks: [task("a", { status: "pr" })], prs: [pr({ state: "MERGED", mergedAt: at(40), comments: [comment("/customize_order x", at(10))] })] }),
    );
    expect(needsOf(m, "order-a")).toEqual([[at(10), at(40)]]);
  });

  test("the factory's own comments and look-alike words do not raise it", () => {
    const comments = [
      comment("## Remake summary\n\nfixed", at(10)),
      comment("/remake x", at(11)),
      comment("/customize_orders", at(12)),
      comment("please run /customize_order", at(13)),
    ];
    const m = buildModel(snap({ tasks: [task("a", { status: "pr" })], prs: [pr({ comments })] }));
    expect(needsOf(m, "order-a")).toEqual([]);
  });
});

describe("a task id reused by a later order", () => {
  const ID = "smoke-trying-this-out";
  const BRANCH = `docs/${ID}`;
  const created = "2026-11-19T11:08:39.913Z";
  const approve = (commit: string, submittedAt: string) => ({ state: "APPROVED", body: "Verdict: APPROVE", submittedAt, commit });
  const customizeAsk = (createdAt: string) => ({ body: "/customize_order change it", createdAt });
  const prOf = (number: number, over: Partial<PrInfo>) =>
    pr({ number, url: `https://github.com/o/r/pull/${number}`, branch: BRANCH, headSha: `head${number}`, ...over });
  const real = () => [
    prOf(17, { createdAt: "2026-11-19T11:11:14Z", reviews: [approve("head17", "2026-11-19T11:15:00Z")] }),
    prOf(15, {
      createdAt: "2026-11-19T10:41:05Z",
      state: "CLOSED",
      closedAt: "2026-11-19T11:06:55Z",
      comments: [customizeAsk("2026-11-19T10:50:00Z")],
      reviews: [approve("head15", "2026-11-19T10:45:00Z")],
    }),
    prOf(13, {
      createdAt: "2026-11-19T10:25:25Z",
      state: "CLOSED",
      closedAt: "2026-11-19T10:36:24Z",
      reviews: [approve("head13", "2026-11-19T10:30:00Z")],
    }),
  ];
  const needPrs = (m: ReturnType<typeof buildModel>) =>
    m.details.get(`order-${ID}`)?.needs.map((n) => `${n.kind}:${n.id.split(":")[1] ?? ""}`) ?? [];

  test("only the task's own PR raises needs; PRs from before it was created raise none", () => {
    const tasks = [task(ID, { status: "pr", createdAt: created })];
    const m = buildModel(snap({ tasks, prs: real(), now: Date.parse("2026-11-19T12:00:00Z") }));
    expect(needPrs(m)).toEqual(["ready_for_review:17"]);
    // The old PRs get no lane either: nothing is unlinked.
    expect(m.sessions.map((s) => s.adw_id)).toEqual([`order-${ID}`]);
    expect(m.details.get(`order-${ID}`)?.lane_meta[ID]?.pr?.number).toBe(17);
  });

  test("runs against PRs from before the task are dropped too", () => {
    const tasks = [task(ID, { status: "pr", createdAt: created })];
    const old = transcript({ sessionId: "r15", kind: "taste_test", target: "15", startedAt: "2026-11-19T10:42:00Z", lastAt: "2026-11-19T10:44:00Z" });
    const m = buildModel(snap({ tasks, prs: real(), transcripts: [old], now: Date.parse("2026-11-19T12:00:00Z") }));
    expect(m.details.get(`order-${ID}`)?.phases.filter((p) => p.name === "taste_test")).toEqual([]);
    expect(m.sessions.some((s) => s.adw_id === UNLINKED_ID)).toBe(false);
  });

  test("a task cooked again shows only the newer PR's needs", () => {
    const tasks = [task("a", { status: "pr", createdAt: at(0) })];
    const prs = [
      pr({ number: 2, url: "https://github.com/o/r/pull/2", createdAt: at(30), headSha: "h2", reviews: [{ state: "APPROVED", body: "Verdict: APPROVE", submittedAt: at(35), commit: "h2" }] }),
      pr({
        number: 1,
        state: "CLOSED",
        closedAt: at(20),
        createdAt: at(5),
        headSha: "h1",
        reviews: [{ state: "APPROVED", body: "Verdict: APPROVE", submittedAt: at(8), commit: "h1" }],
        comments: [{ body: "/customize_order x", createdAt: at(10) }],
      }),
    ];
    const m = buildModel(snap({ tasks, prs }));
    expect(m.details.get("order-a")?.needs.map((n) => n.id)).toEqual(["ready_for_review:2"]);
    expect(m.details.get("order-a")?.lane_meta.a?.pr?.number).toBe(2);
  });

  test("a cook transcript that started before the task was created is not in its lane", () => {
    const tasks = [task("a", { status: "pr", createdAt: at(10) })];
    const stale = transcript({ sessionId: "s0", target: "a", startedAt: at(2), lastAt: at(4) });
    const fresh = transcript({ sessionId: "s1", target: "a", startedAt: at(12), lastAt: at(14) });
    const m = buildModel(snap({ tasks, transcripts: [stale, fresh], audit: [audit({ at: at(5) }), audit({ at: at(15) })] }));
    expect(m.details.get("order-a")?.phases.filter((p) => p.name === "cook").map((p) => p.phase_id)).toEqual(["run:s1"]);
    expect(m.sessions.some((s) => s.adw_id === UNLINKED_ID)).toBe(false);
  });

  test("a task without createdAt still matches by branch alone", () => {
    const m = buildModel(
      snap({
        tasks: [task("a", { status: "pr", createdAt: undefined })],
        prs: [pr({ createdAt: at(-500), reviews: [{ state: "APPROVED", body: "Verdict: APPROVE", submittedAt: at(8), commit: "head1" }] })],
      }),
    );
    expect(m.details.get(`${UNDATED_ID}`)?.needs.map((n) => n.kind)).toEqual(["ready_for_review"]);
  });
});

describe("session project", () => {
  test("is the order's tasks' project, the first task's when they differ, and null when absent", () => {
    const m = buildModel(
      snap({
        tasks: [
          task("a", { project: "alpha", createdAt: at(0) }),
          task("b", { project: "beta", createdAt: at(1) }),
          task("c", { createdAt: at(60) }),
        ],
      }),
    );
    const projects = Object.fromEntries(m.sessions.map((s) => [s.adw_id, s.project]));
    expect(projects).toEqual({ "order-a": "alpha", "order-c": null });
    expect(m.details.get("order-a")?.session.project).toBe("alpha");
  });

  test("the unlinked PRs session has no project", () => {
    const m = buildModel(snap({ tasks: [], prs: [pr({ branch: "chore/zzz", number: 9 })], transcripts: [transcript({ target: "9", kind: "taste_test" })] }));
    expect(m.sessions.find((s) => s.adw_id === UNLINKED_ID)?.project).toBeNull();
  });
});
