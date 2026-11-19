import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "../../factory/audit-log.ts";
import type { Task } from "../../factory/tasks.schema.ts";
import {
  buildModel,
  groupOrders,
  milestoneFor,
  runStatus,
  UNDATED_ID,
  UNLINKED_ID,
  type PrInfo,
  type Snapshot,
  type Transcript,
} from "./factory-model.ts";
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
  labels: [],
  reviews: [],
  commitDates: [],
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
  now: T0 + 60 * 60_000,
  ...over,
});

describe("orders", () => {
  test("neighbours within 5 minutes form one order titled by its first task", () => {
    const orders = groupOrders([task("a", { createdAt: at(0) }), task("b", { createdAt: at(1) }), task("c", { createdAt: at(30) })]);
    expect(orders.map((o) => o.taskIds)).toEqual([["a", "b"], ["c"]]);
    expect(orders[0]?.title).toBe("Title a +1 more");
    expect(orders[1]?.title).toBe("Title c");
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
      ["b", "cook", "queued", "waiting on z (other order)"],
    ]);
    expect(detail.lane_meta.b).toEqual({ title: "b", subtitle: "needs a, z (other order)" });
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
  test("an open task PR with CI green needs a review; it resolves when merged", () => {
    const open = buildModel(snap({ tasks: [task("a", { status: "pr" })], prs: [pr({})] }));
    expect(open.details.get("order-a")?.needs.map((n) => [n.kind, n.resolvedAt])).toEqual([["ready_for_review", null]]);
    const merged = buildModel(snap({ tasks: [task("a", { status: "pr" })], prs: [pr({ state: "MERGED", mergedAt: at(20) })] }));
    expect(merged.details.get("order-a")?.needs[0]?.resolvedAt).toBe(at(20));
  });

  test("a Verdict: CHANGES review is stuck until a later commit", () => {
    const review = { state: "COMMENTED", body: "**Verdict: CHANGES**\n\nbad", submittedAt: at(10) };
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

  test("a task stuck in_progress is remembered, then marked resolved once it moves on", () => {
    const first = buildModel(snap({ tasks: [task("a", { status: "in_progress" })] }));
    expect(first.stuckHistory).toEqual([{ taskId: "a", raisedAt: new Date(T0 + 60 * 60_000).toISOString() }]);
    const later = buildModel(snap({ tasks: [task("a", { status: "pending" })], stuckHistory: first.stuckHistory, now: T0 + 90 * 60_000 }));
    expect(later.stuckHistory[0]?.resolvedAt).toBe(new Date(T0 + 90 * 60_000).toISOString());
    expect(later.details.get("order-a")?.needs.map((n) => n.kind)).toEqual(["stuck_in_progress"]);
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
