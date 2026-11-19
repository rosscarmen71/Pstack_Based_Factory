/**
 * Hosts the /customize_order agent for a PR inside the visualizer, through the Claude Agent SDK (Claude Code as a
 * library, on the Claude Code login). One agent per PR. Its AskUserQuestion calls are held until the run page
 * answers them, so the questions show up there as option cards instead of in a Terminal window.
 *
 * State is persisted to viz/.customize-agents.json ({pr, commentAt, sessionId, status}) so a restart resumes the same
 * conversation by session id. Nothing is written to the task until the engineer approves, so a stop is harmless.
 */
import { query as sdkQuery, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALLOWED_TOOLS } from "../../factory/loop.ts";
import { CUSTOMIZE_COMMAND } from "../../factory/pr-state.ts";
import type { AgentQuestion, AnswerBody, CustomizeState, CustomizeStatus } from "../shared/customize.ts";

export const CUSTOMIZE_AGENTS_PATH = resolve(import.meta.dir, "..", ".customize-agents.json");

/** Appended to Claude Code's system prompt, so the questions arrive as cards. */
export const QUESTION_INSTRUCTIONS =
  "Ask every question with the AskUserQuestion tool: give 2-4 options, put your recommended option first and say so " +
  "in its description; the user can always type their own answer.";

export const RESUME_PROMPT = "The visualizer restarted. Continue, and re-ask any question I had not answered yet.";

/**
 * The tools the agent may use: the loop's, plus Skill and TodoWrite. They are handed to the CLI as allowedTools, which
 * understands Bash patterns and compound commands. canUseTool only sees what they do not cover, so it allows
 * the plain-named ones here and denies the rest (including every Bash command the patterns did not match).
 */
export const CUSTOMIZE_ALLOWED_TOOLS: string[] = [...ALLOWED_TOOLS, "Skill", "TodoWrite"];
const PLAIN_TOOLS = new Set(CUSTOMIZE_ALLOWED_TOOLS.filter((t) => !t.includes("(")));

/** The slice of an SDK message this module reads. */
export interface AgentMessage {
  type: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  subtype?: string;
}

/** The SDK's `query`, narrowed to what is used so tests can inject a fake and never run a real agent. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<AgentMessage>;

const realQuery: QueryFn = (params) => sdkQuery(params) as unknown as AsyncIterable<AgentMessage>;

export interface CustomizeManagerOptions {
  query?: QueryFn;
  /** Where the agent runs. It must be the repo root, so its transcript lands where the visualizer reads runs from. */
  cwd: string;
  /** Persisted state; null keeps it in memory only. */
  statePath?: string | null;
  /** Whether the request made at `commentAt` now has its summary comment. Asked when a run ends. */
  isAnswered: (pr: number, commentAt: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

interface Agent {
  pr: number;
  commentAt: string;
  sessionId: string | null;
  status: CustomizeStatus;
  pending: { id: string; questions: AgentQuestion[]; input: Record<string, unknown>; settle: (answers: Record<string, string> | null) => void } | null;
  error: string | null;
  /** A query is running. False for an entry restored from disk that has not been resumed yet. */
  driving: boolean;
}

interface PersistedAgent {
  pr: number;
  commentAt: string;
  sessionId: string | null;
  status: CustomizeStatus;
}

/** Reads the questions out of an AskUserQuestion input, or null when it has none. */
export function parseQuestions(input: Record<string, unknown>): AgentQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return null;
  const out: AgentQuestion[] = [];
  for (const raw of input.questions) {
    const q = raw as Record<string, unknown> | null;
    if (!q || typeof q.question !== "string") return null;
    const options = Array.isArray(q.options) ? q.options : [];
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options: options.map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>;
        return { label: String(opt.label ?? ""), description: typeof opt.description === "string" ? opt.description : "" };
      }),
    });
  }
  return out;
}

export class CustomizeManager {
  private readonly agents = new Map<number, Agent>();
  private readonly query: QueryFn;
  private readonly cwd: string;
  private readonly statePath: string | null;
  private readonly isAnswered: CustomizeManagerOptions["isAnswered"];
  private readonly log: (msg: string) => void;

  constructor(opts: CustomizeManagerOptions) {
    this.query = opts.query ?? realQuery;
    this.cwd = opts.cwd;
    this.statePath = opts.statePath === undefined ? CUSTOMIZE_AGENTS_PATH : opts.statePath;
    this.isAnswered = opts.isAnswered;
    this.log = opts.log ?? ((m) => console.log(`[customize] ${m}`));
    for (const p of this.readPersisted()) {
      // Anything unfinished waits, with no question open, until ensure() resumes it.
      const status = p.status === "done" ? "done" : "starting";
      this.agents.set(p.pr, { ...p, status, pending: null, error: null, driving: false });
    }
  }

  /** Starts, or resumes after a restart, the agent for a PR's pending request. Never starts a second one for a PR. */
  ensure(pr: number, commentAt: string): void {
    const cur = this.agents.get(pr);
    if (cur && cur.commentAt === commentAt) {
      if (cur.driving || cur.status === "done") return;
      // Same request, not running: only a restored entry gets here. (A run that failed stays failed until a restart.)
      if (cur.status === "starting" && cur.sessionId) void this.drive(cur, RESUME_PROMPT, cur.sessionId);
      else if (cur.status === "starting") void this.drive(cur, this.firstPrompt(pr), null);
      return;
    }
    if (cur?.driving) return; // a run is open; its summary will answer this newer request too
    const agent: Agent = { pr, commentAt, sessionId: null, status: "starting", pending: null, error: null, driving: false };
    this.agents.set(pr, agent);
    void this.drive(agent, this.firstPrompt(pr), null);
  }

  get(pr: number): CustomizeState {
    const a = this.agents.get(pr);
    if (!a) return { pr, status: "none", sessionId: null, pending: null, error: null };
    return {
      pr,
      status: a.status,
      sessionId: a.sessionId,
      pending: a.pending ? { id: a.pending.id, questions: a.pending.questions } : null,
      error: a.error,
    };
  }

  all(): Record<number, CustomizeState> {
    return Object.fromEntries([...this.agents.keys()].map((pr) => [pr, this.get(pr)]));
  }

  /** Answers the open question. False when there is none, or its id is not the open one. */
  answer(pr: number, body: AnswerBody): boolean {
    const a = this.agents.get(pr);
    if (!a?.pending || a.pending.id !== body.id) return false;
    const { settle } = a.pending;
    a.pending = null;
    a.status = "running";
    this.persist();
    settle(body.answers);
    return true;
  }

  /** Sends free text to an agent whose turn ended without an answer (idle). False when it is not idle. */
  reply(pr: number, text: string): boolean {
    const a = this.agents.get(pr);
    if (!a || a.status !== "idle" || a.driving || !a.sessionId) return false;
    void this.drive(a, text, a.sessionId);
    return true;
  }

  private firstPrompt(pr: number): string {
    return `${CUSTOMIZE_COMMAND} ${pr}`;
  }

  private async drive(a: Agent, prompt: string, resume: string | null): Promise<void> {
    a.driving = true;
    a.error = null;
    a.status = resume ? "running" : "starting";
    this.persist();
    let result: AgentMessage | null = null;
    try {
      const options: Options = {
        cwd: this.cwd,
        permissionMode: "default",
        systemPrompt: { type: "preset", preset: "claude_code", append: QUESTION_INSTRUCTIONS },
        allowedTools: CUSTOMIZE_ALLOWED_TOOLS,
        canUseTool: this.canUseTool(a),
        ...(resume ? { resume } : {}),
      };
      for await (const msg of this.query({ prompt, options })) {
        if (msg.session_id && msg.session_id !== a.sessionId) {
          a.sessionId = msg.session_id;
          this.persist();
        }
        if (a.status === "starting") a.status = "running";
        if (msg.type === "result") result = msg;
      }
      if (result?.is_error) throw new Error(String(result.result ?? result.subtype ?? "the agent reported an error"));
      let answered = false;
      try {
        answered = await this.isAnswered(a.pr, a.commentAt);
      } catch (err) {
        this.log(`could not check whether PR #${a.pr}'s request was answered: ${err instanceof Error ? err.message : String(err)}`);
      }
      a.status = answered ? "done" : "idle";
    } catch (err) {
      a.status = "failed";
      a.error = err instanceof Error ? err.message : String(err);
      this.log(`agent for PR #${a.pr} failed: ${a.error}`);
    } finally {
      a.pending?.settle(null);
      a.pending = null;
      a.driving = false;
      this.persist();
    }
  }

  private canUseTool(a: Agent): CanUseTool {
    return (toolName, input, { signal, toolUseID }) => {
      if (toolName !== "AskUserQuestion") {
        return Promise.resolve(
          PLAIN_TOOLS.has(toolName)
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: `${toolName} is not allowed in /customize_order. Use only the tools you were given.` },
        );
      }
      const questions = parseQuestions(input);
      if (!questions) return Promise.resolve({ behavior: "deny", message: "AskUserQuestion needs at least one question." });
      if (a.pending) return Promise.resolve({ behavior: "deny", message: "A question is already open. Wait for its answer." });
      return new Promise((resolve) => {
        const finish = (answers: Record<string, string> | null) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(
            answers
              ? { behavior: "allow", updatedInput: { ...input, answers } }
              : { behavior: "deny", message: "The question was not answered." },
          );
        };
        const onAbort = () => {
          if (a.pending?.id !== id) return;
          a.pending = null;
          a.status = "running";
          this.persist();
          finish(null);
        };
        const id = toolUseID || randomUUID();
        a.pending = { id, questions, input, settle: finish };
        a.status = "waiting";
        this.persist();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    };
  }

  private readPersisted(): PersistedAgent[] {
    if (!this.statePath || !existsSync(this.statePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedAgent[];
      return Array.isArray(raw) ? raw.filter((p) => Number.isInteger(p?.pr) && typeof p.commentAt === "string") : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    const rows: PersistedAgent[] = [...this.agents.values()].map((a) => ({
      pr: a.pr,
      commentAt: a.commentAt,
      sessionId: a.sessionId,
      status: a.status,
    }));
    try {
      writeFileSync(`${this.statePath}.tmp`, `${JSON.stringify(rows, null, 2)}\n`);
      renameSync(`${this.statePath}.tmp`, this.statePath);
    } catch (err) {
      this.log(`could not save ${this.statePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
