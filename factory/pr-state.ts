// Decide what a PR needs next. Pure: no I/O, no attempt limits.
//
// Rules, first match wins:
//   1. draft, or labelled `needs-human`                  -> none
//   2. CI failed, merge conflict, changes requested,
//      or labelled `changes-requested`                   -> patch
//   3. approved with CI passing                          -> none
//   4. head SHA differs from reviewedSha, CI not failing -> review
//   5. anything else                                     -> none

import type { PullRequest } from "./prs";

/**
 * Set by taste_test when it finds problems, cleared by remake after its fix. GitHub refuses a real
 * "request changes" review from the PR's own author, and the factory usually is that author.
 */
export const CHANGES_REQUESTED_LABEL = "changes-requested";

export type PrAction = "review" | "patch" | "none";

export interface PrHistory {
  /** Head SHA of the last review we ran on this PR, if any. */
  reviewedSha?: string;
}

export function decidePr(
  pr: Pick<PullRequest, "isDraft" | "labels" | "ci" | "mergeable" | "reviewDecision" | "headSha">,
  history: PrHistory,
): PrAction {
  if (pr.isDraft || pr.labels.includes("needs-human")) return "none";
  if (pr.ci === "fail" || pr.mergeable === "conflicting" || pr.reviewDecision === "changes_requested") return "patch";
  if (pr.labels.includes(CHANGES_REQUESTED_LABEL)) return "patch";
  if (pr.reviewDecision === "approved" && pr.ci === "pass") return "none";
  if (pr.headSha !== history.reviewedSha) return "review";
  return "none";
}