// File-backed review/patch attempt counts per PR, and the hand-off to a human once a PR is stuck.
// Re-reads before every operation and writes atomically, like tasks.store.ts.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CUSTOMIZE_SUMMARY_HEADING, REMAKE_COMMAND, startsWithWord } from "./pr-state.ts";
import { bunGh, type GhRunner, type PullRequest } from "./prs.ts";

export const PR_ATTEMPTS_PATH = new URL("./pr-attempts.json", import.meta.url).pathname;
export const MAX_PR_ATTEMPTS = 3;
export const NEEDS_HUMAN_LABEL = "needs-human";

export type AttemptKind = "review" | "patch";

export interface PrAttempts {
  reviews: number;
  patches: number;
  reviewedSha?: string;
  /** Set once flagForHuman has labelled and commented; cleared with the entry when the label is removed. */
  flagged?: boolean;
  /** createdAt of the newest `/remake` or `## Customize order summary` comment seen; a newer one resets the counts. */
  requestAt?: string;
}

export interface AttemptsStore {
  get(pr: number): PrAttempts | undefined;
  /** Counts the attempt either way; a review only marks `sha` as reviewed when it succeeded, so a crashed one is retried. */
  record(pr: number, kind: AttemptKind, sha: string, succeeded?: boolean): void;
  exceeded(pr: number): boolean;
  /** Adds the `needs-human` label and one comment, only if this PR has not been flagged already. */
  flagForHuman(pr: number, gh?: GhRunner): Promise<void>;
  /** Prunes entries for PRs no longer open, resets a flagged PR whose label was removed, and zeroes the counts of a PR with a new `/remake` or customize-order answer. */
  sync(openPrs: PullRequest[]): void;
  /** Forgets everything recorded about the PR. Returns false when nothing was recorded. */
  remove(pr: number): boolean;
}

type Entries = Record<string, PrAttempts>;

function readEntries(path: string): Entries {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must hold an object keyed by PR number`);
  }
  return parsed as Entries;
}

function writeEntries(path: string, entries: Entries): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmp, path); // atomic: readers never see a half-written file
}

async function ghOrThrow(gh: GhRunner, args: string[]): Promise<void> {
  const { exitCode, stderr } = await gh(args);
  if (exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (exit ${exitCode}): ${stderr.trim() || "no output"}`);
}

/** createdAt of the newest `/remake` or `## Customize order summary` comment, which is what re-opens a PR's attempts. */
function requestTime(pr: PullRequest): string | undefined {
  let best: string | undefined;
  for (const c of pr.comments) {
    const counts = startsWithWord(c.body, REMAKE_COMMAND) || c.body.trimStart().startsWith(CUSTOMIZE_SUMMARY_HEADING);
    if (counts && (best === undefined || Date.parse(c.createdAt) > Date.parse(best))) best = c.createdAt;
  }
  return best;
}

export function attemptsStore(path: string = PR_ATTEMPTS_PATH): AttemptsStore {
  const key = (pr: number) => String(pr);
  const update = (pr: number, fn: (e: PrAttempts) => void) => {
    const entries = readEntries(path);
    const entry = entries[key(pr)] ?? { reviews: 0, patches: 0 };
    fn(entry);
    entries[key(pr)] = entry;
    writeEntries(path, entries);
  };
  return {
    get: (pr) => readEntries(path)[key(pr)],
    record(pr, kind, sha, succeeded = true) {
      update(pr, (e) => {
        if (kind === "review") {
          e.reviews += 1;
          if (succeeded) e.reviewedSha = sha;
        } else {
          e.patches += 1;
        }
      });
    },
    exceeded(pr) {
      const e = readEntries(path)[key(pr)];
      return e !== undefined && e.reviews + e.patches >= MAX_PR_ATTEMPTS;
    },
    async flagForHuman(pr, gh = bunGh) {
      if (readEntries(path)[key(pr)]?.flagged) return;
      await ghOrThrow(gh, ["label", "create", NEEDS_HUMAN_LABEL, "--force", "--description", "Factory gave up; a human must look"]);
      await ghOrThrow(gh, ["pr", "edit", String(pr), "--add-label", NEEDS_HUMAN_LABEL]);
      await ghOrThrow(gh, [
        "pr",
        "comment",
        String(pr),
        "--body",
        `The factory stopped after ${MAX_PR_ATTEMPTS} review/patch attempts on this PR. Remove the \`${NEEDS_HUMAN_LABEL}\` label to let it try again.`,
      ]);
      update(pr, (e) => {
        e.flagged = true;
      });
    },
    sync(openPrs) {
      const entries = readEntries(path);
      const open = new Map(openPrs.map((p) => [key(p.number), p]));
      let changed = false;
      for (const k of Object.keys(entries)) {
        const p = open.get(k);
        if (!p || (entries[k]?.flagged && !p.labels.includes(NEEDS_HUMAN_LABEL))) {
          delete entries[k];
          changed = true;
        }
      }
      for (const p of openPrs) {
        const at = requestTime(p);
        if (at === undefined) continue;
        const entry = entries[key(p.number)] ?? { reviews: 0, patches: 0 };
        if (entry.requestAt !== undefined && Date.parse(at) <= Date.parse(entry.requestAt)) continue;
        entries[key(p.number)] = { ...entry, reviews: 0, patches: 0, requestAt: at };
        changed = true;
      }
      if (changed) writeEntries(path, entries);
    },
    remove(pr) {
      const entries = readEntries(path);
      if (!(key(pr) in entries)) return false;
      delete entries[key(pr)];
      writeEntries(path, entries);
      return true;
    },
  };
}