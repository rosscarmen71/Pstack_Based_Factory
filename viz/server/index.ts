/**
 * Factory visualizer server: the SSSF visualizer's JSON API, fed by this repo's factory
 * (factory/tasks.json, factory/audit-log.jsonl, GitHub through gh, and Claude Code transcripts),
 * plus the built UI from ./dist.
 *
 * Reads only, with two exceptions: POST /api/takeover/:session opens a Terminal on this Mac, and
 * factory-source.ts keeps viz/.needs-history.jsonl. Nothing here writes to the factory's files.
 *
 *   PORT=4600 bun run server/index.ts
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRunSession, load, readFeed, REPO_ROOT } from "./factory-source.ts";
import type { ApiError, EventsPage, HealthResponse } from "../shared/types.ts";

const PORT = Number(process.env.PORT ?? 4600);
const HOST = "127.0.0.1";
const DIST_DIR = resolve(import.meta.dir, "..", "dist");
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const notFound = (message: string) => json({ error: message } satisfies ApiError, 404);

/** Guard every handler so a bad read can't take the server down mid-run. */
function safely(handler: (req: Request) => Response | Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      console.error(`[viz] ${req.method} ${new URL(req.url).pathname}:`, error);
      return json({ error: (error as Error).message } satisfies ApiError, 500);
    }
  };
}

const param = (req: Request, key: string) =>
  decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");

function intQuery(req: Request, key: string, fallback: number): number {
  const raw = new URL(req.url).searchParams.get(key);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function serveStatic(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!existsSync(DIST_DIR)) {
    return new Response(`Factory visualizer API is running on :${PORT}, but there is no ./dist build. Run "bun run viz".\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const candidate = resolve(join(DIST_DIR, pathname));
  if (candidate.startsWith(`${DIST_DIR}/`) && existsSync(candidate) && statSync(candidate).isFile()) {
    return new Response(Bun.file(candidate));
  }
  return new Response(Bun.file(join(DIST_DIR, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Single-quotes a value for the shell inside the Terminal command. */
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Opens macOS Terminal in the repo, resuming the run's conversation (a fork while the run is still live). */
async function openTerminal(sessionId: string, fork: boolean): Promise<void> {
  const command = `cd ${shq(REPO_ROOT)} && ${CLAUDE_BIN} --resume ${sessionId}${fork ? " --fork-session" : ""}`;
  const script = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(command)}\nend tell`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`osascript failed (exit ${code}): ${err.trim()}`);
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // Take over waits on osascript, which can sit behind macOS's first-use "control Terminal" prompt for a while.
  idleTimeout: 255,
  routes: {
    "/api/health": safely(async () => {
      const { model, errors, loopRunning, transcriptsDir } = await load();
      return json({
        ok: Object.keys(errors).length === 0,
        db: transcriptsDir,
        journal_mode: "files",
        sessions: model.sessions.length,
        loop_running: loopRunning,
        errors,
      } satisfies HealthResponse);
    }),

    "/api/sessions": safely(async () => json((await load()).model.sessions)),

    "/api/sessions/:adw_id": safely(async (req) => {
      const detail = (await load()).model.details.get(param(req, "adw_id"));
      return detail ? json(detail) : notFound(`no session ${param(req, "adw_id")}`);
    }),

    // Their one write (archive) has no meaning here: the factory's records are not the reader's to change.
    "/api/sessions/:adw_id/archive": { POST: () => json({ error: "archiving is disabled" } satisfies ApiError, 405) },

    "/api/sessions/:adw_id/events": safely(async (req) => {
      const all = (await load()).model.events.get(param(req, "adw_id")) ?? [];
      const after = intQuery(req, "after", 0);
      const limit = Math.max(1, Math.min(intQuery(req, "limit", 500), 5000));
      const page = all.filter((e) => e.rowid > after).slice(0, limit);
      return json({ events: page, cursor: page.at(-1)?.rowid ?? after, has_more: page.length === limit } satisfies EventsPage);
    }),

    "/api/sessions/:adw_id/envelopes": safely(async (req) => json((await load()).model.envelopes.get(param(req, "adw_id")) ?? [])),
    "/api/sessions/:adw_id/gates": safely(async (req) => json((await load()).model.gates.get(param(req, "adw_id")) ?? [])),
    "/api/sessions/:adw_id/needs": safely(async (req) => json((await load()).model.details.get(param(req, "adw_id"))?.needs ?? [])),

    // The factory has no per-agent prompt files; their UI renders a 404 here as "no prompts".
    "/api/sessions/:adw_id/agents/:agent/prompts": () => notFound("prompts are not recorded by this factory"),

    "/api/runs/:session/feed": safely(async (req) => {
      const session = param(req, "session");
      const { model } = await load();
      return json({ ...readFeed(session, intQuery(req, "after", 0)), live: model.liveSessions.has(session) });
    }),

    "/api/takeover/:session": {
      POST: safely(async (req) => {
        const session = param(req, "session");
        if (!isRunSession(session)) return json({ error: "unknown run session" } satisfies ApiError, 400);
        const fork = (await load()).model.liveSessions.has(session);
        await openTerminal(session, fork);
        return json({ ok: true, session, fork });
      }),
    },
  },

  fetch(req) {
    if (new URL(req.url).pathname.startsWith("/api/")) return notFound(`no route ${new URL(req.url).pathname}`);
    return serveStatic(req);
  },
});

console.log(`[viz] factory visualizer  http://${HOST}:${server.port}`);
