/**
 * Reads Claude Code transcripts (one JSONL file per session) written by the factory's headless runs.
 * Pure: takes the file's text, returns what the visualizer needs. factory-source.ts does the file I/O.
 */
import { milestoneFor, type Milestone, type RunKind, type Tokens, type Transcript } from "./factory-model.ts";

const COMMAND = /<command-name>\/(cook|taste_test|remake)<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>/;

interface Line {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      out.push(JSON.parse(raw) as Line);
    } catch {
      // A half-written last line during a live run: skip it, the next poll reads it whole.
    }
  }
  return out;
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

function firstPrompt(lines: Line[]): string | null {
  const first = lines.find((l) => l.type === "user" && !l.isSidechain);
  const c = first?.message?.content;
  if (typeof c === "string") return c;
  return blocks(c)
    .map((b) => b.text ?? "")
    .join("\n");
}

/** The factory command a transcript starts with, or null when it is any other session. */
export function runCommand(text: string): { kind: RunKind; target: string } | null {
  const prompt = firstPrompt(parseLines(text));
  const m = prompt ? COMMAND.exec(prompt) : null;
  return m ? { kind: m[1] as RunKind, target: (m[2] ?? "").trim() } : null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((b) => b.text ?? "")
    .join("\n");
}

/** Parses one factory run's transcript; null when the file is not a /cook, /taste_test or /remake run. */
export function parseTranscript(text: string, sessionId: string, mtimeMs: number): Transcript | null {
  const lines = parseLines(text);
  const prompt = firstPrompt(lines);
  const m = prompt ? COMMAND.exec(prompt) : null;
  if (!m) return null;

  const stamps = lines.map((l) => l.timestamp).filter((t): t is string => !!t);
  const pending = new Map<string, { name: string; input: Record<string, unknown>; at: string }>();
  const milestones: Milestone[] = [];
  const usageById = new Map<string, Tokens>();
  let model: string | null = null;

  for (const l of lines) {
    if (l.isSidechain) continue;
    if (l.type === "assistant") {
      model = l.message?.model ?? model;
      const u = l.message?.usage;
      if (u && l.message?.id) {
        usageById.set(l.message.id, {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        });
      }
      for (const b of blocks(l.message?.content)) {
        if (b.type === "tool_use" && b.id && b.name) pending.set(b.id, { name: b.name, input: b.input ?? {}, at: l.timestamp ?? "" });
      }
    } else if (l.type === "user") {
      for (const b of blocks(l.message?.content)) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        pending.delete(b.tool_use_id);
        const ms = milestoneFor(call.name, call.input);
        if (ms) milestones.push({ ...ms, ok: b.is_error !== true, at: call.at, endedAt: l.timestamp ?? call.at });
      }
    }
  }

  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of usageById.values()) {
    tokens.input += t.input;
    tokens.output += t.output;
    tokens.cacheRead += t.cacheRead;
    tokens.cacheWrite += t.cacheWrite;
  }

  return {
    sessionId,
    kind: m[1] as RunKind,
    target: (m[2] ?? "").trim(),
    startedAt: stamps[0] ?? new Date(mtimeMs).toISOString(),
    lastAt: stamps.at(-1) ?? new Date(mtimeMs).toISOString(),
    mtimeMs,
    model,
    tokens,
    milestones,
  };
}

export interface FeedItem {
  /** Position in the feed; the polling cursor. */
  i: number;
  at: string;
  kind: "agent" | "tool" | "result";
  text: string;
  ok?: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? "";
  return `${name}  ${clip(String(pick).replace(/\s+/g, " "), 160)}`;
}

/** The agent's messages and tool calls in order: what the run's panel streams live. */
export function parseFeed(text: string): FeedItem[] {
  const items: FeedItem[] = [];
  const push = (item: Omit<FeedItem, "i">) => items.push({ ...item, i: items.length + 1 });
  for (const l of parseLines(text)) {
    if (l.isSidechain) continue;
    const at = l.timestamp ?? "";
    if (l.type === "assistant") {
      for (const b of blocks(l.message?.content)) {
        if (b.type === "text" && b.text?.trim()) push({ at, kind: "agent", text: clip(b.text.trim(), 600) });
        if (b.type === "tool_use" && b.name) push({ at, kind: "tool", text: toolSummary(b.name, b.input ?? {}) });
      }
    } else if (l.type === "user") {
      for (const b of blocks(l.message?.content)) {
        if (b.type !== "tool_result") continue;
        const first = resultText(b.content).trim().split("\n")[0] ?? "";
        push({ at, kind: "result", text: clip(first, 200), ok: b.is_error !== true });
      }
    }
  }
  return items;
}
