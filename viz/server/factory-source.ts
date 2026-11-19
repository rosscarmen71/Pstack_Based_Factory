/**
 * Gathers a Snapshot of the factory from disk and GitHub, then hands it to the pure model.
 * Reads only, with one exception: viz/.needs-history.jsonl, the visualizer's own record of stuck tasks.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { auditStore } from "../../factory/audit-log.ts";
import { MAX_PR_ATTEMPTS } from "../../factory/pr-attempts.ts";
import { fileStore } from "../../factory/tasks.store.ts";
import type { Task } from "../../factory/tasks.schema.ts";
import {
  buildModel,
  type LabelEvent,
  type Model,
  type PrInfo,
  type Snapshot,
  type StuckHistoryEntry,
  type Transcript,
} from "./factory-model.ts";
import { parseFeed, parseTranscript, runCommand, type FeedItem } from "./transcripts.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
/** Claude Code keeps a project's transcripts under its path with every non-alphanumeric character turned into "-". */
export const TRANSCRIPTS_DIR =
  process.env.FACTORY_TRANSCRIPTS_DIR ?? join(homedir(), ".claude", "projects", REPO_ROOT.replace(/[^A-Za-z0-9]/g, "-"));
const HISTORY_PATH = resolve(import.meta.dir, "..", ".needs-history.jsonl");
const GH = process.env.GH_BIN ?? (existsSync("/opt/homebrew/bin/gh") ? "/opt/homebrew/bin/gh" : "gh");

const PR_TTL_MS = 10_000;
const LABEL_TTL_MS = 60_000;
const LOOP_TTL_MS = 2_000;

/** A source that could not be read this poll ("tasks", "audit", "github"), with why. */
export type SourceErrors = Record<string, string>;

// ── Transcripts ─────────────────────────────────────────────────────────────

interface Cached {
  size: number;
  mtimeMs: number;
  transcript: Transcript | null;
}
const transcriptCache = new Map<string, Cached>();

/** Reads the start of a file to decide cheaply whether it is a factory run at all. */
function headIsRun(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    // Only whole lines: the last one may be cut mid-JSON at the 64 KB boundary.
    return runCommand(text.slice(0, text.lastIndexOf("\n") + 1) || text) !== null;
  } finally {
    closeSync(fd);
  }
}

function readTranscripts(): Transcript[] {
  if (!existsSync(TRANSCRIPTS_DIR)) return [];
  const out: Transcript[] = [];
  for (const name of readdirSync(TRANSCRIPTS_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(TRANSCRIPTS_DIR, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const hit = transcriptCache.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      if (hit.transcript) out.push(hit.transcript);
      continue;
    }
    // A non-run session never becomes a run: once ruled out by its first prompt, skip re-reading it.
    if (hit && hit.transcript === null && hit.size > 0) {
      transcriptCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, transcript: null });
      continue;
    }
    let transcript: Transcript | null = null;
    try {
      if (st.size > 0 && headIsRun(path)) {
        transcript = parseTranscript(readFileSync(path, "utf8"), name.replace(/\.jsonl$/, ""), st.mtimeMs);
      }
    } catch {
      transcript = null;
    }
    transcriptCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, transcript });
    if (transcript) out.push(transcript);
  }
  return out;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRunSession(sessionId: string): boolean {
  if (!SESSION_ID.test(sessionId)) return false;
  const path = join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  return existsSync(path) && headIsRun(path);
}

export function readFeed(sessionId: string, after: number): { items: FeedItem[]; cursor: number } {
  if (!SESSION_ID.test(sessionId)) return { items: [], cursor: after };
  const path = join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(path)) return { items: [], cursor: after };
  const items = parseFeed(readFileSync(path, "utf8")).filter((it) => it.i > after);
  return { items, cursor: items.at(-1)?.i ?? after };
}

// ── GitHub ──────────────────────────────────────────────────────────────────

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn([GH, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (exit ${code}): ${err.trim() || "no output"}`);
  return out;
}

// No `commits` here: commits x authors blows GitHub's node limit on a 100-PR list, so commit dates are fetched per PR, only when needed.
const PR_FIELDS = "number,url,title,headRefName,state,createdAt,mergedAt,closedAt,statusCheckRollup,labels,reviews,headRefOid,comments";
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

interface RawPr {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  statusCheckRollup: { conclusion?: string | null; state?: string | null; status?: string | null }[] | null;
  labels: { name: string }[];
  headRefOid: string;
  comments?: { body: string; createdAt: string }[];
  reviews: { state: string; body: string; submittedAt: string; commit: { oid: string } }[];
}

function ciOf(rollup: RawPr["statusCheckRollup"]): PrInfo["ci"] {
  if (!rollup || rollup.length === 0) return "pass";
  let pending = false;
  for (const c of rollup) {
    const verdict = (c.conclusion || c.state || "").toUpperCase();
    if (FAILED.has(verdict)) return "fail";
    if (!verdict || verdict === "PENDING" || (c.status && c.status !== "COMPLETED")) pending = true;
  }
  return pending ? "pending" : "pass";
}

const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? "";

let prCache: { at: number; prs: PrInfo[] } | null = null;
let prError: string | undefined;

async function readPrs(now: number): Promise<PrInfo[]> {
  if (prCache && now - prCache.at < PR_TTL_MS) return prCache.prs;
  try {
    const raw = JSON.parse(await gh(["pr", "list", "--state", "all", "--limit", "100", "--json", PR_FIELDS])) as RawPr[];
    const prs = raw.map((r) => ({
      number: r.number,
      url: r.url,
      repo: repoOf(r.url),
      title: r.title,
      branch: r.headRefName,
      state: r.state,
      createdAt: r.createdAt,
      mergedAt: r.mergedAt,
      closedAt: r.closedAt,
      ci: ciOf(r.statusCheckRollup),
      headSha: r.headRefOid,
      labels: r.labels.map((l) => l.name),
      reviews: r.reviews.map((v) => ({ state: v.state, body: v.body, submittedAt: v.submittedAt, commit: v.commit.oid })),
      commitDates: [] as string[],
      comments: (r.comments ?? []).map((c) => ({ body: c.body, createdAt: c.createdAt })),
    }));
    // A CHANGES verdict is resolved by a later commit, so only those PRs need their commit dates.
    await Promise.all(
      prs
        .filter((p) => p.reviews.some((v) => /Verdict:\s*\**\s*CHANGES/i.test(v.body)))
        .map(async (p) => {
          const raw = JSON.parse(await gh(["pr", "view", String(p.number), "--json", "commits"])) as {
            commits: { committedDate: string }[];
          };
          p.commitDates = raw.commits.map((c) => c.committedDate);
        }),
    );
    prCache = { at: now, prs };
    prError = undefined;
    return prs;
  } catch (e) {
    prError = (e as Error).message;
    return prCache?.prs ?? [];
  }
}

const labelCache = new Map<number, { at: number; events: LabelEvent[] }>();

/** needs-human history only exists for PRs the loop worked on enough times to be flagged, so only those are asked. */
async function readLabelEvents(prs: PrInfo[], runsPerPr: Map<number, number>, now: number): Promise<Record<number, LabelEvent[]>> {
  const out: Record<number, LabelEvent[]> = {};
  const wanted = prs.filter((p) => p.labels.includes("needs-human") || (runsPerPr.get(p.number) ?? 0) >= MAX_PR_ATTEMPTS);
  await Promise.all(
    wanted.map(async (p) => {
      const hit = labelCache.get(p.number);
      if (hit && now - hit.at < LABEL_TTL_MS) {
        out[p.number] = hit.events;
        return;
      }
      try {
        const raw = JSON.parse(await gh(["api", `repos/${p.repo}/issues/${p.number}/events`, "--paginate"])) as {
          event: string;
          created_at: string;
          label?: { name: string };
        }[];
        const events = raw
          .filter((e) => (e.event === "labeled" || e.event === "unlabeled") && e.label)
          .map((e) => ({ event: e.event as LabelEvent["event"], label: e.label!.name, at: e.created_at }));
        labelCache.set(p.number, { at: now, events });
        out[p.number] = events;
      } catch {
        out[p.number] = hit?.events ?? [];
      }
    }),
  );
  return out;
}

// ── Loop process ────────────────────────────────────────────────────────────

let loopCache: { at: number; running: boolean } | null = null;

async function loopRunning(now: number): Promise<boolean> {
  if (loopCache && now - loopCache.at < LOOP_TTL_MS) return loopCache.running;
  const proc = Bun.spawn(["pgrep", "-f", "factory/loop\\.ts"], { stdout: "ignore", stderr: "ignore" });
  const running = (await proc.exited) === 0;
  loopCache = { at: now, running };
  return running;
}

// ── Needs history (the visualizer's own file) ───────────────────────────────

function readHistory(): StuckHistoryEntry[] {
  if (!existsSync(HISTORY_PATH)) return [];
  const out: StuckHistoryEntry[] = [];
  for (const line of readFileSync(HISTORY_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as StuckHistoryEntry);
    } catch {
      // A corrupt line is dropped rather than taking the view down.
    }
  }
  return out;
}

function writeHistory(entries: StuckHistoryEntry[]): void {
  const text = entries.map((e) => JSON.stringify(e)).join("\n");
  const current = existsSync(HISTORY_PATH) ? readFileSync(HISTORY_PATH, "utf8").trim() : "";
  if (text !== current) writeFileSync(HISTORY_PATH, text ? `${text}\n` : "");
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface Loaded {
  model: Model;
  errors: SourceErrors;
  loopRunning: boolean;
  transcriptsDir: string;
}

let last: { at: number; loaded: Loaded } | null = null;
let inflight: Promise<Loaded> | null = null;
const MODEL_TTL_MS = 400;

/** One model per ~0.4 s, shared by every request in that window. */
export function load(): Promise<Loaded> {
  const now = Date.now();
  if (last && now - last.at < MODEL_TTL_MS) return Promise.resolve(last.loaded);
  inflight ??= build(now).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function build(now: number): Promise<Loaded> {
  const errors: SourceErrors = {};
  let tasks: Task[] = [];
  try {
    tasks = fileStore().load();
  } catch (e) {
    errors.tasks = (e as Error).message;
  }
  let audit: ReturnType<ReturnType<typeof auditStore>["list"]> = [];
  try {
    audit = auditStore().list();
  } catch (e) {
    errors.audit = (e as Error).message;
  }
  const [prs, running] = await Promise.all([readPrs(now), loopRunning(now)]);
  if (prError) errors.github = prError;
  const runsPerPr = new Map<number, number>();
  for (const a of audit) if (typeof a.target === "number") runsPerPr.set(a.target, (runsPerPr.get(a.target) ?? 0) + 1);
  const snap: Snapshot = {
    tasks,
    audit,
    prs,
    transcripts: readTranscripts(),
    labelEvents: await readLabelEvents(prs, runsPerPr, now),
    stuckHistory: readHistory(),
    loopRunning: running,
    now,
  };
  const model = buildModel(snap);
  try {
    writeHistory(model.stuckHistory);
  } catch {
    // History is a convenience; failing to save it never breaks the view.
  }
  const loaded = { model, errors, loopRunning: running, transcriptsDir: TRANSCRIPTS_DIR };
  last = { at: now, loaded };
  return loaded;
}
