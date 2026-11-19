import { describe, expect, test } from "bun:test";
import { decidePr, pendingRequest } from "./pr-state";
import type { PullRequest } from "./prs";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 1,
  url: "https://github.com/acme/widgets/pull/1",
  repo: "acme/widgets",
  title: "t",
  branch: "feat/x",
  createdAt: "2026-10-29T00:00:00Z",
  isDraft: false,
  headSha: "sha-new",
  ci: "pass",
  mergeable: "clean",
  reviewDecision: "none",
  labels: [],
  comments: [],
  ...over,
});

describe("decidePr", () => {
  test("draft -> none, even with failed CI", () => {
    expect(decidePr(pr({ isDraft: true, ci: "fail" }), {})).toBe("none");
  });

  test("needs-human label -> none, even with failed CI", () => {
    expect(decidePr(pr({ labels: ["needs-human"], ci: "fail" }), {})).toBe("none");
  });

  test("CI fail -> patch", () => {
    expect(decidePr(pr({ ci: "fail" }), { reviewedSha: "sha-new" })).toBe("patch");
  });

  test("merge conflict -> patch", () => {
    expect(decidePr(pr({ mergeable: "conflicting" }), {})).toBe("patch");
  });

  test("changes requested -> patch", () => {
    expect(decidePr(pr({ reviewDecision: "changes_requested" }), {})).toBe("patch");
  });

  test("changes-requested label -> patch, even on an already-reviewed head", () => {
    expect(decidePr(pr({ labels: ["changes-requested"] }), { reviewedSha: "sha-new" })).toBe("patch");
  });

  test("changes-requested label with needs-human -> none", () => {
    expect(decidePr(pr({ labels: ["changes-requested", "needs-human"] }), {})).toBe("none");
  });

  test("approved with CI pass -> none, even on an unreviewed head", () => {
    expect(decidePr(pr({ reviewDecision: "approved" }), {})).toBe("none");
  });

  test("unreviewed head with CI pass -> review", () => {
    expect(decidePr(pr(), {})).toBe("review");
  });

  test("head differs from reviewedSha, CI pending -> review", () => {
    expect(decidePr(pr({ ci: "pending" }), { reviewedSha: "sha-old" })).toBe("review");
  });

  test("already-reviewed head with CI pass -> none", () => {
    expect(decidePr(pr(), { reviewedSha: "sha-new" })).toBe("none");
  });

  test("failed CI on an unreviewed head -> patch, not review", () => {
    expect(decidePr(pr({ ci: "fail", headSha: "sha-new" }), { reviewedSha: undefined })).toBe("patch");
  });

  test("patched PR (new head, CI pass, previously reviewed) -> review", () => {
    expect(decidePr(pr({ headSha: "sha-patched" }), { reviewedSha: "sha-old" })).toBe("review");
  });

  test("pending CI on an already-reviewed head -> none", () => {
    expect(decidePr(pr({ ci: "pending" }), { reviewedSha: "sha-new" })).toBe("none");
  });
});
const comment = (body: string, createdAt: string) => ({ body, createdAt });

describe("comment requests", () => {
  const T1 = "2026-10-30T10:00:00Z";
  const T2 = "2026-10-30T11:00:00Z";

  test("a pending /remake -> patch, even on a reviewed head", () => {
    expect(decidePr(pr({ comments: [comment("/remake please tighten the types", T1)] }), { reviewedSha: "sha-new" })).toBe("patch");
  });

  test("a /remake with leading whitespace or alone on the line counts", () => {
    expect(decidePr(pr({ comments: [comment("  \n/remake", T1)] }), { reviewedSha: "sha-new" })).toBe("patch");
  });

  test("a /remake answered by a later remake summary -> back to the normal rules", () => {
    const comments = [comment("/remake", T1), comment("## Remake summary\nDone", T2)];
    expect(decidePr(pr({ comments }), { reviewedSha: "sha-new" })).toBe("none");
    expect(decidePr(pr({ comments }), {})).toBe("review");
  });

  test("a /remake newer than an earlier remake summary is pending again", () => {
    const comments = [comment("## Remake summary", T1), comment("/remake again", T2)];
    expect(decidePr(pr({ comments }), { reviewedSha: "sha-new" })).toBe("patch");
  });

  test("a /remake on a PR with needs-human or draft -> none", () => {
    const comments = [comment("/remake", T1)];
    expect(decidePr(pr({ comments, labels: ["needs-human"] }), {})).toBe("none");
    expect(decidePr(pr({ comments, isDraft: true }), {})).toBe("none");
  });

  test("a pending /customize_order -> none, even with failed CI or a pending /remake", () => {
    const comments = [comment("/remake", T1), comment("/customize_order change the scope", T2)];
    expect(decidePr(pr({ comments, ci: "fail" }), {})).toBe("none");
  });

  test("a /customize_order answered by a later customize order summary -> normal rules again", () => {
    const comments = [comment("/customize_order change the scope", T1), comment("## Customize order summary", T2)];
    expect(decidePr(pr({ comments, ci: "fail" }), {})).toBe("patch");
    expect(decidePr(pr({ comments }), {})).toBe("review");
  });

  test("factory-posted comments never trigger a patch", () => {
    const comments = [comment("Verdict: CHANGES\n- a finding", T1), comment("## Remake summary", T2)];
    expect(decidePr(pr({ comments }), { reviewedSha: "sha-new" })).toBe("none");
  });

  test("/remakes and /customize_orders are not commands", () => {
    expect(decidePr(pr({ comments: [comment("/remakes foo", T1)] }), { reviewedSha: "sha-new" })).toBe("none");
    expect(decidePr(pr({ comments: [comment("/customize_orders", T1)], ci: "fail" }), {})).toBe("patch");
  });

  test("pendingRequest returns the newest unanswered request", () => {
    const newest = comment("/remake second", T2);
    const comments = [comment("/remake first", T1), newest];
    expect(pendingRequest({ comments }, "/remake", "## Remake summary")).toEqual(newest);
    expect(pendingRequest({ comments: [] }, "/remake", "## Remake summary")).toBeNull();
  });
});
