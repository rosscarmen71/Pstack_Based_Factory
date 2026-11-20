/**
 * Gathers a Snapshot of the factory from disk and GitHub, then hands it to the pure model.
 * Reads only, with these exceptions: viz/.needs-history.jsonl, the visualizer's own record of stuck tasks, the
 * /customize_order agents it starts for PRs with an unanswered request (customize-agent.ts), and invalidate(), which
 * index.ts calls after it changes a task's project.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuditEntry } from "../../factory/audit-log.ts";
import type { TaskTarget } from "../../factory/delete-task.ts";
import { factoryHome } from "../../factory/home.ts";
import { MAX_PR_ATTEMPTS } from "../../factory/pr-attempts.ts";
import { CUSTOMIZE_COMMAND, CUSTOMIZE_SUMMARY_HEADING, pendingRequest } from "../../factory/pr-state.ts";
import { type Project, type ProjectContext, projectContext, projectRegistry } from "../../factory/projects.ts";
import { DEFAULT_SETTINGS, type Settings, settingsStore } from "../../factory/settings.ts";
import { claudeProjectDir } from "../../factory/worktrees.ts";
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
import { CustomizeManager } from "./customize-agent.ts";
import { parseFeed, parseTranscript, runCommand, type FeedItem } from "./transcripts.ts";

/** The factory's own repository: where the visualizer's code lives. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
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

// ── Projects ────────────────────────────────────────────────────────────────

/** Everything the visualizer keeps per project: where its data is, and its own caches and customize agents. */
interface ProjectSource {
  project: Project;
  ctx: ProjectContext;
  prCache: { at: number; prs: PrInfo[] } | null;
  prError?: string;
  labelCache: Map<number, { at: number; events: LabelEvent[] }>;
  /** The /customize_order agent host for this project's PRs. */
  customize: CustomizeManager;
  /** The visualizer's own record of this project's stuck tasks. */
  historyPath: string;
}

const sources = new Map<string, ProjectSource>();

/** One source per registered project, kept across polls; a project that left the registry is dropped. */
function syncSources(): ProjectSource[] {
  const projects = projectRegistry().list();
  const names = new Set(projects.map((p) => p.name));
  for (const name of sources.keys()) if (!names.has(name)) sources.delete(name);
  for (const project of projects) {
    const existing = sources.get(project.name);
    if (existing && existing.project.path === project.path) {
      // Keep the registry's latest word on what it depends on and whether it is paused.
      existing.project = project;
      existing.ctx.project = project;
      continue;
    }
    const ctx = projectContext(project);
    const src: ProjectSource = {
      project,
      ctx,
      prCache: null,
      labelCache: new Map(),
      customize: null as unknown as CustomizeManager,
      historyPath: join(ctx.paths.dir, "needs-history.jsonl"),
    };
    src.customize = new CustomizeManager({
      cwd: project.path,
      statePath: join(ctx.paths.dir, "customize-agents.json"),
      isAnswered: (pr, commentAt) => requestAnswered(src, pr, commentAt),
    });
    sources.set(project.name, src);
  }
  return projects.flatMap((p) => sources.get(p.name) ?? []);
}

/** The data of one project, or null when it is not registered. */
export function contextOf(name: string): ProjectContext | null {
  syncSources();
  return sources.get(name)?.ctx ?? null;
}

/** Every registered project's data, in registry order. */
export const allContexts = (): ProjectContext[] => syncSources().map((s) => s.ctx);

/**
 * The /customize_order host for a PR. PR numbers repeat across repositories, so `project` says which one; without
 * it the project that already has an agent for that number wins, else the first project.
 */
export function customizeFor(pr: number, project?: string | null): CustomizeManager | null {
  const all = syncSources();
  if (project) return sources.get(project)?.customize ?? null;
  return (all.find((s) => s.customize.get(pr).status !== "none") ?? all[0])?.customize ?? null;
}

/** Where a project's transcripts are: its main checkout's folder, plus one per live agent worktree. */
function dirsOf(src: ProjectSource): { dir: string; cwd: string }[] {
  if (process.env.FACTORY_TRANSCRIPTS_DIR) return [{ dir: process.env.FACTORY_TRANSCRIPTS_DIR, cwd: src.project.path }];
  const dirs = [{ dir: claudeProjectDir(src.project.path), cwd: src.project.path }];
  const worktrees = src.ctx.paths.worktrees;
  if (!existsSync(worktrees)) return dirs;
  for (const name of readdirSync(worktrees)) {
    const cwd = join(worktrees, name);
    const dir = claudeProjectDir(cwd);
    if (existsSync(dir)) dirs.push({ dir, cwd });
  }
  return dirs;
}

/** The transcript folders of one project, for erasing a deleted task's runs. */
export function transcriptDirsOf(name: string): string[] {
  syncSources();
  const src = sources.get(name);
  return src ? dirsOf(src).map((d) => d.dir) : [];
}

/** Reads the start of a file to find cheaply which factory command it ran; null when it is not a factory run. */
function headCommand(path: string): ReturnType<typeof runCommand> {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    // Only whole lines: the last one may be cut mid-JSON at the 64 KB boundary.
    return runCommand(text.slice(0, text.lastIndexOf("\n") + 1) || text);
  } finally {
    closeSync(fd);
  }
}

const headIsRun = (path: string): boolean => headCommand(path) !== null;

/** True when a run of `command` belongs to the target: its cook, or a review, patch or customize of its PR. */
export function runBelongsTo(command: NonNullable<ReturnType<typeof runCommand>>, target: TaskTarget): boolean {
  if (command.kind === "cook") return command.target === target.taskId;
  return target.pr !== undefined && command.target === String(target.pr.number);
}

/**
 * Erases the transcripts (and their side folders) of every factory run that belongs to the target.
 * Only files that start with a factory command are ever touched. Returns how many runs were erased.
 */
export function removeRunTranscripts(target: TaskTarget, dir: string | string[]): number {
  if (Array.isArray(dir)) return dir.reduce((n, d) => n + removeRunTranscripts(target, d), 0);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let command: ReturnType<typeof runCommand> = null;
    try {
      command = statSync(path).size > 0 ? headCommand(path) : null;
    } catch {
      continue;
    }
    if (!command || !runBelongsTo(command, target)) continue;
    rmSync(path, { force: true });
    rmSync(path.replace(/\.jsonl$/, ""), { recursive: true, force: true });
    transcriptCache.delete(path);
    removed += 1;
  }
  return removed;
}

/**
 * Every folder that may hold the factory's transcripts, across all projects. An agent runs in its own worktree,
 * and Claude Code files transcripts by working directory; a worktree's transcripts are moved to its project's
 * main folder when its run ends.
 */
export function transcriptDirs(): { dir: string; cwd: string }[] {
  return syncSources().flatMap(dirsOf);
}

/** Where the run's transcript is and which checkout it ran in; null when there is no such transcript. */
function findTranscript(sessionId: string): { path: string; cwd: string } | null {
  if (!SESSION_ID.test(sessionId)) return null;
  for (const { dir, cwd } of transcriptDirs()) {
    const path = join(dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return { path, cwd };
  }
  return null;
}

/** The checkout to resume the run's conversation from: its worktree while it is live, else the repo root. */
export const runCwd = (sessionId: string): string => findTranscript(sessionId)?.cwd ?? REPO_ROOT;

function readTranscripts(src: ProjectSource): Transcript[] {
  return dirsOf(src).flatMap(({ dir }) => readTranscriptsIn(dir));
}

function readTranscriptsIn(dir: string): Transcript[] {
  if (!existsSync(dir)) return [];
  const out: Transcript[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
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
  const found = findTranscript(sessionId);
  return found !== null && headIsRun(found.path);
}

export function readFeed(sessionId: string, after: number): { items: FeedItem[]; cursor: number } {
  const path = findTranscript(sessionId)?.path;
  if (!path) return { items: [], cursor: after };
  const items = parseFeed(readFileSync(path, "utf8")).filter((it) => it.i > after);
  return { items, cursor: items.at(-1)?.i ?? after };
}

// ── GitHub ──────────────────────────────────────────────────────────────────

async function gh(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([GH, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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

async function readPrs(src: ProjectSource, now: number): Promise<PrInfo[]> {
  if (src.prCache && now - src.prCache.at < PR_TTL_MS) return src.prCache.prs;
  const cwd = src.project.path;
  try {
    const raw = JSON.parse(await gh(cwd, ["pr", "list", "--state", "all", "--limit", "100", "--json", PR_FIELDS])) as RawPr[];
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
          const raw = JSON.parse(await gh(cwd, ["pr", "view", String(p.number), "--json", "commits"])) as {
            commits: { committedDate: string }[];
          };
          p.commitDates = raw.commits.map((c) => c.committedDate);
        }),
    );
    src.prCache = { at: now, prs };
    src.prError = undefined;
    return prs;
  } catch (e) {
    src.prError = (e as Error).message;
    return src.prCache?.prs ?? [];
  }
}

// ── /customize_order agents ─────────────────────────────────────────────────

/** Whether the request made at `commentAt` has its summary comment, read fresh from GitHub. */
async function requestAnswered(src: ProjectSource, pr: number, commentAt: string): Promise<boolean> {
  const raw = JSON.parse(await gh(src.project.path, ["pr", "view", String(pr), "--json", "comments"])) as {
    comments: { body: string; createdAt: string }[];
  };
  const answered = pendingRequest({ comments: raw.comments }, CUSTOMIZE_COMMAND, CUSTOMIZE_SUMMARY_HEADING)?.createdAt !== commentAt;
  if (answered) {
    // The summary is what resolves the dot: drop the cached PR list so the next poll sees it.
    src.prCache = null;
    last = null;
  }
  return answered;
}

/** Starts (or resumes) the agent for every open PR whose /customize_order comment is unanswered. */
function ensureCustomizeAgents(src: ProjectSource, prs: PrInfo[]): void {
  const { customize } = src;
  for (const pr of prs) {
    if (pr.state !== "OPEN") continue;
    const request = pendingRequest(pr, CUSTOMIZE_COMMAND, CUSTOMIZE_SUMMARY_HEADING);
    if (request) customize.ensure(pr.number, request.createdAt);
  }
}

/** needs-human history only exists for PRs the loop worked on enough times to be flagged, so only those are asked. */
async function readLabelEvents(src: ProjectSource, prs: PrInfo[], runsPerPr: Map<number, number>, now: number): Promise<Record<number, LabelEvent[]>> {
  const { labelCache } = src;
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
        const raw = JSON.parse(await gh(src.project.path, ["api", `repos/${p.repo}/issues/${p.number}/events`, "--paginate"])) as {
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
  const proc = Bun.spawn(["pgrep", "-f", "factory/cli\\.ts start"], { stdout: "ignore", stderr: "ignore" });
  const running = (await proc.exited) === 0;
  loopCache = { at: now, running };
  return running;
}

// ── Needs history (the visualizer's own file) ───────────────────────────────

function readHistory(path: string): StuckHistoryEntry[] {
  if (!existsSync(path)) return [];
  const out: StuckHistoryEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as StuckHistoryEntry);
    } catch {
      // A corrupt line is dropped rather than taking the view down.
    }
  }
  return out;
}

function writeHistory(path: string, entries: StuckHistoryEntry[]): void {
  const text = entries.map((e) => JSON.stringify(e)).join("\n");
  const current = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (text !== current) writeFileSync(path, text ? `${text}\n` : "");
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
let generation = 0;
const MODEL_TTL_MS = 400;

/** Drops the cached model (and ignores a build already running) so the next load() reads tasks.json again. */
export function invalidate(): void {
  generation++;
  last = null;
  inflight = null;
}

/** One model per ~0.4 s, shared by every request in that window. */
export function load(): Promise<Loaded> {
  const now = Date.now();
  if (last && now - last.at < MODEL_TTL_MS) return Promise.resolve(last.loaded);
  const gen = generation;
  const promise: Promise<Loaded> = build(now, gen).finally(() => {
    if (inflight === promise) inflight = null;
  });
  inflight ??= promise;
  return inflight;
}

/** One project's model, built from its own queue, audit log, PRs and transcripts. */
async function buildProject(src: ProjectSource, now: number, settings: Settings, running: boolean, errors: SourceErrors): Promise<Model> {
  const name = src.project.name;
  let tasks: Task[] = [];
  try {
    tasks = src.ctx.store.load();
  } catch (e) {
    errors[`${name}: tasks`] = (e as Error).message;
  }
  let audit: AuditEntry[] = [];
  try {
    audit = src.ctx.audit.list();
  } catch (e) {
    errors[`${name}: audit`] = (e as Error).message;
  }
  const prs = await readPrs(src, now);
  if (src.prError) errors[`${name}: github`] = src.prError;
  const runsPerPr = new Map<number, number>();
  for (const a of audit) if (typeof a.target === "number") runsPerPr.set(a.target, (runsPerPr.get(a.target) ?? 0) + 1);
  ensureCustomizeAgents(src, prs);
  const snap: Snapshot = {
    tasks,
    audit,
    prs,
    transcripts: readTranscripts(src),
    labelEvents: await readLabelEvents(src, prs, runsPerPr, now),
    stuckHistory: readHistory(src.historyPath),
    loopRunning: running,
    customize: src.customize.all(),
    now,
    settings,
    projectName: name,
  };
  const model = buildModel(snap);
  try {
    writeHistory(src.historyPath, model.stuckHistory);
  } catch {
    // History is a convenience; failing to save it never breaks the view.
  }
  return model;
}

/** All projects' models as one: their sessions side by side, each naming its project. */
function mergeModels(models: Model[]): Model {
  const merged: Model = { sessions: [], details: new Map(), events: new Map(), gates: new Map(), envelopes: new Map(), liveSessions: new Set(), stuckHistory: [] };
  for (const m of models) {
    merged.sessions.push(...m.sessions);
    for (const [k, v] of m.details) merged.details.set(k, v);
    for (const [k, v] of m.events) merged.events.set(k, v);
    for (const [k, v] of m.gates) merged.gates.set(k, v);
    for (const [k, v] of m.envelopes) merged.envelopes.set(k, v);
    for (const id of m.liveSessions) merged.liveSessions.add(id);
  }
  return merged;
}

async function build(now: number, gen: number): Promise<Loaded> {
  const errors: SourceErrors = {};
  let srcs: ProjectSource[] = [];
  try {
    srcs = syncSources();
  } catch (e) {
    errors.projects = (e as Error).message;
  }
  let settings: Settings = DEFAULT_SETTINGS;
  try {
    settings = settingsStore().load();
  } catch (e) {
    errors.settings = (e as Error).message;
  }
  const running = await loopRunning(now);
  const model = mergeModels(await Promise.all(srcs.map((src) => buildProject(src, now, settings, running, errors))));
  const loaded = { model, errors, loopRunning: running, transcriptsDir: factoryHome() };
  if (gen === generation) last = { at: now, loaded };
  return loaded;
}
