import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickCandidate, rankCandidates } from "./candidates";
import { type AttemptsStore, attemptsStore, MAX_PR_ATTEMPTS, type PrAttempts } from "./pr-attempts";
import type { PullRequest } from "./prs";
import type { Task } from "./tasks.schema";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  acceptanceCriteria: [],
  dependencies: [],
  status: "pending",
  ...over,
});

// A PR that decidePr routes to review (new head SHA, nothing else going on).
const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  repo: "acme/widgets",
  title: `pr ${number}`,
  branch: `feat/unknown-${number}`,
  createdAt: "2026-10-29T12:00:00Z",
  isDraft: false,
  headSha: "sha",
  ci: "pass",
  mergeable: "clean",
  reviewDecision: "none",
  labels: [],
  comments: [],
  ...over,
});

const fakeAttempts = (entries: Record<number, PrAttempts> = {}): AttemptsStore => ({
  remove: () => false,
  get: (n) => entries[n],
  record: () => {},
  exceeded: (n) => {
    const e = entries[n];
    return e !== undefined && e.reviews + e.patches >= MAX_PR_ATTEMPTS;
  },
  flagForHuman: async () => {},
  sync: () => {},
});

const idOf = (c: ReturnType<typeof pickCandidate>["candidate"]) =>
  c === null ? null : c.kind === "task" ? `task:${c.task.id}` : `pr:${c.pr.number}`;

describe("pickCandidate", () => {
  test("returns null when nothing is ready", () => {
    const r = pickCandidate([task("a", { status: "pr" })], [], fakeAttempts());
    expect(r).toEqual({ candidate: null, newlyExceeded: [] });
  });

  test("an older PR beats a newer task", () => {
    const tasks = [task("a", { createdAt: "2026-10-29T13:00:00Z" })];
    const prs = [pr(1, { createdAt: "2026-10-29T12:00:00Z" })];
    expect(idOf(pickCandidate(tasks, prs, fakeAttempts()).candidate)).toBe("pr:1");
  });

  test("a PR that needs a review beats an older task", () => {
    const tasks = [task("a", { createdAt: "2026-10-29T11:00:00Z" })];
    const prs = [pr(1, { createdAt: "2026-10-29T12:00:00Z" })];
    expect(idOf(pickCandidate(tasks, prs, fakeAttempts()).candidate)).toBe("pr:1");
  });

  test("a patch beats an older review", () => {
    const prs = [pr(1, { createdAt: "2026-10-29T10:00:00Z" }), pr(2, { createdAt: "2026-10-29T12:00:00Z", ci: "fail" })];
    expect(idOf(pickCandidate([], prs, fakeAttempts()).candidate)).toBe("pr:2");
  });

  test("an unstamped task loses to a stamped PR", () => {
    expect(idOf(pickCandidate([task("a")], [pr(1)], fakeAttempts()).candidate)).toBe("pr:1");
  });

  test("unstamped tasks keep file order", () => {
    expect(idOf(pickCandidate([task("b"), task("a")], [], fakeAttempts()).candidate)).toBe("task:b");
  });

  test("a PR that cook opened on a task's branch is a candidate like any other", () => {
    const tasks = [task("some-task-id", { status: "pr" })];
    const owned = pr(1, { branch: "feat/some-task-id" });
    expect(pickCandidate(tasks, [owned], fakeAttempts()).candidate).toEqual({ kind: "pr", pr: owned, action: "review" });
  });

  test("a PR candidate carries its action", () => {
    const failing = pr(1, { ci: "fail" });
    const c = pickCandidate([], [failing], fakeAttempts()).candidate;
    expect(c).toEqual({ kind: "pr", pr: failing, action: "patch" });
  });

  test("tasks with unmet dependencies are skipped", () => {
    const tasks = [task("a", { status: "in_progress" }), task("b", { dependencies: ["a"] }), task("c")];
    expect(idOf(pickCandidate(tasks, [], fakeAttempts()).candidate)).toBe("task:c");
  });

  test("exceeded PRs are skipped, and newly exceeded ones are returned for flagging", () => {
    const attempts = fakeAttempts({ 1: { reviews: 2, patches: 1 } });
    const stuck = pr(1, { createdAt: "2026-10-29T01:00:00Z" });
    const r = pickCandidate([task("a", { createdAt: "2026-10-29T13:00:00Z" })], [stuck], attempts);
    expect(idOf(r.candidate)).toBe("task:a");
    expect(r.newlyExceeded).toEqual([stuck]);
  });

  test("an already flagged exceeded PR is not returned again", () => {
    const attempts = fakeAttempts({ 1: { reviews: 2, patches: 1, flagged: true } });
    expect(pickCandidate([], [pr(1)], attempts)).toEqual({ candidate: null, newlyExceeded: [] });
  });

  test("a PR that needs nothing is neither a candidate nor flagged", () => {
    const attempts = fakeAttempts({ 1: { reviews: 3, patches: 0 } });
    const r = pickCandidate([], [pr(1, { labels: ["needs-human"] }), pr(2, { isDraft: true })], attempts);
    expect(r).toEqual({ candidate: null, newlyExceeded: [] });
  });

  test("a PR already reviewed at its head SHA needs nothing", () => {
    const attempts = fakeAttempts({ 1: { reviews: 1, patches: 0, reviewedSha: "sha" } });
    expect(pickCandidate([], [pr(1)], attempts).candidate).toBeNull();
  });

  test("an exact timestamp tie still picks the PR", () => {
    const at = "2026-10-29T12:00:00Z";
    const r = pickCandidate([task("a", { createdAt: at })], [pr(1, { createdAt: at })], fakeAttempts());
    expect(idOf(r.candidate)).toBe("pr:1");
  });
});

describe("rankCandidates", () => {
  const tasks = [
    task("unstamped"),
    task("owner", { createdAt: "2026-10-29T10:00:00Z" }),
    task("blocked", { dependencies: ["late"], createdAt: "2026-10-29T09:00:00Z" }),
    task("late", { createdAt: "2026-10-29T14:00:00Z" }),
  ];
  const prs = [
    pr(1, { createdAt: "2026-10-29T12:00:00Z" }),
    pr(2, { branch: "feat/owner" }),
    pr(3, { createdAt: "2026-10-29T08:00:00Z" }),
  ];
  const exceeded: PrAttempts = { reviews: MAX_PR_ATTEMPTS, patches: 0, reviewedSha: "old" } as PrAttempts;

  test("lists PRs oldest first, then tasks oldest first with unstamped tasks last", () => {
    const ids = rankCandidates(tasks, prs.filter((p) => p.number !== 3), fakeAttempts()).map(idOf);
    expect(ids).toEqual(["pr:1", "pr:2", "task:owner", "task:late", "task:unstamped"]);
  });

  test("omits PRs at the attempt limit and blocked tasks", () => {
    const ids = rankCandidates(tasks, prs, fakeAttempts({ 3: exceeded })).map(idOf);
    expect(ids).not.toContain("pr:3");
    expect(ids).not.toContain("task:blocked");
    expect(ids).toEqual(["pr:1", "pr:2", "task:owner", "task:late", "task:unstamped"]);
  });

  test("ties keep original order within a group", () => {
    const t = [task("a", { createdAt: "2026-10-29T12:00:00Z" }), task("b", { createdAt: "2026-10-29T12:00:00Z" })];
    const ids = rankCandidates(t, [pr(1), pr(2)], fakeAttempts()).map(idOf);
    expect(ids).toEqual(["pr:1", "pr:2", "task:a", "task:b"]);
  });

  test("pickCandidate's candidate is the first ranked candidate", () => {
    const attempts = fakeAttempts();
    expect(pickCandidate(tasks, prs, attempts).candidate).toEqual(rankCandidates(tasks, prs, attempts)[0] ?? null);
  });
});
describe("a PR whose task gained a dependency", () => {
  const owned = (over: Partial<Task>) => task("t", { status: "pr", ...over });

  test("is left alone until that dependency is met", () => {
    const prs = [pr(1, { branch: "feat/t" })];
    const waiting = [task("u"), owned({ dependencies: ["u"] })];
    expect(rankCandidates(waiting, prs, fakeAttempts()).map(idOf)).toEqual(["task:u"]);
    const met = [task("u", { status: "completed" }), owned({ dependencies: ["u"] })];
    expect(rankCandidates(met, prs, fakeAttempts()).map(idOf)).toEqual(["pr:1"]);
  });

  test("a dependency it is stacked on never holds its PR", () => {
    const tasks = [task("u", { status: "pr" }), owned({ dependencies: ["u"], builtOn: { u: "sha" } })];
    const prs = [pr(1, { branch: "feat/t" }), pr(2, { branch: "feat/u" })];
    expect(rankCandidates(tasks, prs, fakeAttempts()).map(idOf)).toEqual(["pr:1", "pr:2"]);
  });
});

describe("comment requests", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "candidates-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const asked = (...comments: { body: string; createdAt: string }[]) => pr(1, { comments });

  test("a new /remake makes an exhausted PR a candidate again, and an old one does not", () => {
    const attempts = attemptsStore(join(dir, "pr-attempts.json"));
    for (let i = 0; i < MAX_PR_ATTEMPTS; i++) attempts.record(1, "patch", "sha");
    const stuck = asked({ body: "## Remake summary", createdAt: "2026-10-30T09:00:00Z" });
    attempts.sync([stuck]);
    expect(pickCandidate([], [stuck], attempts).candidate).toBeNull();

    const remade = asked({ body: "/remake", createdAt: "2026-10-30T10:00:00Z" });
    attempts.sync([remade]);
    expect(pickCandidate([], [remade], attempts).candidate).toEqual({ kind: "pr", pr: remade, action: "patch" });

    for (let i = 0; i < MAX_PR_ATTEMPTS; i++) attempts.record(1, "patch", "sha");
    attempts.sync([remade]);
    expect(pickCandidate([], [remade], attempts).candidate).toBeNull();
  });

  test("a pending /customize_order keeps the PR out, even with failed CI", () => {
    const blocked = pr(1, { ci: "fail", comments: [{ body: "/customize_order", createdAt: "2026-10-30T10:00:00Z" }] });
    expect(pickCandidate([], [blocked], fakeAttempts())).toEqual({ candidate: null, newlyExceeded: [] });
  });
});
