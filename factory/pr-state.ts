// Decide what a PR needs next. Pure: no I/O, no attempt limits.
//
// Rules, first match wins:
//   1. draft, or labelled `needs-human`                  -> none
//   2. an unanswered `/customize_order` comment          -> none (a human runs that skill by hand)
//   3. CI failed, merge conflict, changes requested,
//      labelled `changes-requested`, or an unanswered
//      `/remake` comment                                 -> patch
//   4. approved with CI passing                          -> none
//   5. head SHA differs from reviewedSha, CI not failing -> review
//   6. anything else                                     -> none

import type { PrComment, PullRequest } from "./prs";

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

export const REMAKE_COMMAND = "/remake";
export const REMAKE_SUMMARY_HEADING = "## Remake summary";
export const CUSTOMIZE_COMMAND = "/customize_order";
export const CUSTOMIZE_SUMMARY_HEADING = "## Customize order summary";

/** True when `body`, ignoring leading whitespace, starts with `word` as a whole word. */
export const startsWithWord = (body: string, word: string): boolean => {
  const text = body.trimStart();
  return text.startsWith(word) && (text.length === word.length || /\s/.test(text.charAt(word.length)));
};

const newest = (comments: PrComment[], matches: (body: string) => boolean): PrComment | null => {
  let best: PrComment | null = null;
  for (const c of comments) {
    if (matches(c.body) && (best === null || Date.parse(c.createdAt) >= Date.parse(best.createdAt))) best = c;
  }
  return best;
};

/** The newest comment asking `prefix` that no later comment starting with `summaryHeading` has answered. */
export function pendingRequest(pr: Pick<PullRequest, "comments">, prefix: string, summaryHeading: string): PrComment | null {
  const request = newest(pr.comments, (b) => startsWithWord(b, prefix));
  if (!request) return null;
  const answer = newest(pr.comments, (b) => b.trimStart().startsWith(summaryHeading));
  return answer && Date.parse(answer.createdAt) >= Date.parse(request.createdAt) ? null : request;
}

export function decidePr(
  pr: Pick<PullRequest, "isDraft" | "labels" | "ci" | "mergeable" | "reviewDecision" | "headSha" | "comments">,
  history: PrHistory,
): PrAction {
  if (pr.isDraft || pr.labels.includes("needs-human")) return "none";
  if (pendingRequest(pr, CUSTOMIZE_COMMAND, CUSTOMIZE_SUMMARY_HEADING)) return "none";
  if (pr.ci === "fail" || pr.mergeable === "conflicting" || pr.reviewDecision === "changes_requested") return "patch";
  if (pr.labels.includes(CHANGES_REQUESTED_LABEL)) return "patch";
  if (pendingRequest(pr, REMAKE_COMMAND, REMAKE_SUMMARY_HEADING)) return "patch";
  if (pr.reviewDecision === "approved" && pr.ci === "pass") return "none";
  if (pr.headSha !== history.reviewedSha) return "review";
  return "none";
}