/**
 * Factory visualizer server: the SSSF visualizer's JSON API, fed by this repo's factory
 * (factory/tasks.json, factory/audit-log.jsonl, GitHub through gh, and Claude Code transcripts),
 * plus the built UI from ./dist.
 *
 * Reads only, with these exceptions, the endpoints that act:
 *   - POST /api/takeover/:session opens a Terminal window on this Mac, resuming a run's conversation.
 *   - POST /api/customize/:pr/answer and POST /api/customize/:pr/reply talk to the /customize_order agent this
 *     server hosts for the PR (customize-agent.ts), which the source layer starts for any unanswered request.
 *     GET /api/customize/:pr only reads its state.
 *   - DELETE /api/tasks/:id deletes one task for good: it stops its agent, closes its PR, deletes its branch and
 *     erases its records (factory/delete-task.ts). DELETE /api/sessions/:adw_id does that for every task of the
 *     session. GET /api/tasks/:id/delete-preview says what a delete would do. POST /api/tasks/:id/complete marks a
 *     task completed by hand. POST /api/tasks/:id/retry un-parks a task the loop parked after a failure.
 *   - POST /api/factory changes the factory-wide switches (default mode, agent cap, pause) in factory/settings.json.
 *     POST /api/projects/:name/mode, /api/sessions/:adw_id/mode and /api/tasks/:id/mode set or clear the mode at
 *     that level. POST /api/tasks/:id/dependencies adds or removes one dependency of a task.
 *   - POST /api/projects adds a repository as a project; DELETE /api/projects/:name removes one with all its tasks;
 *     POST /api/projects/:name/depends-on and /paused set what it waits for and whether its loop is paused.
 * factory-source.ts also keeps viz/.needs-history.jsonl, and the agent manager keeps viz/.customize-agents.json.
 * Nothing else here writes to the factory's files.
 *
 *   PORT=4600 bun run server/index.ts
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { deleteTask, previewDelete, type DeleteReport } from "../../factory/delete-task.ts";
import { checkDependencies, setDependencies } from "../../factory/deps.ts";
import { readLoopState, type LoopState } from "../../factory/loop.ts";
import { type ProjectContext, projectRegistry, registerRepo, waitingOnProjects } from "../../factory/projects.ts";
import { MAX_AGENT_CAP, type Settings, settingsStore } from "../../factory/settings.ts";
import { TASK_MODES, type Task, type TaskMode } from "../../factory/tasks.schema.ts";
import { type Order, ordersOf } from "./factory-model.ts";
import { allContexts, contextOf, customizeFor, invalidate, isRunSession, load, readFeed, removeRunTranscripts, runCwd, transcriptDirsOf } from "./factory-source.ts";
import type { AnswerBody, ReplyBody } from "../shared/customize.ts";
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

/** Single-quotes a value for the shell inside the Terminal command. */
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

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

/** Opens macOS Terminal in the repo, resuming the run's conversation (a fork while the run is still live). */
async function openTerminal(sessionId: string, fork: boolean): Promise<void> {
  // A live run's conversation lives with its worktree; a finished one's with the repo root.
  const command = `cd ${shq(runCwd(sessionId))} && ${CLAUDE_BIN} --resume ${sessionId}${fork ? " --fork-session" : ""}`;
  const script = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(command)}\nend tell`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`osascript failed (exit ${code}): ${err.trim()}`);
}

/** A PR number from the URL, or null when it is not a positive integer. */
function prParam(req: Request): number | null {
  const raw = param(req, "pr");
  const pr = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(pr) ? pr : null;
}

/** Which repository a PR number is in, from `?project=owner/repo`. */
const projectQuery = (req: Request): string | null => new URL(req.url).searchParams.get("project");

const badPr = () => json({ error: "pr must be a positive integer" } satisfies ApiError, 400);
const badBody = (message: string) => json({ error: message } satisfies ApiError, 400);
const conflict = (message: string) => json({ error: message } satisfies ApiError, 409);

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A request body `{mode}`: hands-on, hands-off, or null to inherit. Undefined when it is none of those. */
function modeOf(body: Record<string, unknown> | null): TaskMode | null | undefined {
  if (!body || !("mode" in body)) return undefined;
  if (body.mode === null) return null;
  return TASK_MODES.includes(body.mode as TaskMode) ? (body.mode as TaskMode) : undefined;
}

const BAD_MODE = `body must be {mode: ${TASK_MODES.map((m) => `"${m}"`).join(" or ")}, or null to inherit}`;

/** Sets or clears one key of a mode map in the settings. */
function setLevelMode(map: "projects" | "sessions", key: string, mode: TaskMode | null): Settings {
  return settingsStore().update((s) => {
    const next = { ...s[map] };
    if (mode === null) delete next[key];
    else next[key] = mode;
    return { ...s, [map]: next };
  });
}

/** The task and the project it belongs to, looked for in every project. */
function findTask(id: string): { ctx: ProjectContext; task: Task } | null {
  for (const ctx of allContexts()) {
    const task = ctx.store.load().find((t) => t.id === id);
    if (task) return { ctx, task };
  }
  return null;
}

/** The session (with at least one task) and the project it belongs to, looked for in every project. */
function findSession(id: string): { ctx: ProjectContext; order: Order } | null {
  for (const ctx of allContexts()) {
    const order = ordersOf(ctx.store.load(), ctx.project.name).find((o) => o.id === id && o.taskIds.length > 0);
    if (order) return { ctx, order };
  }
  return null;
}

/** Deletes one task of a project with that project's stores, and GitHub and git run in its checkout. */
const removeTaskIn = (ctx: ProjectContext, id: string): Promise<DeleteReport | null> =>
  deleteTask(id, {
    store: ctx.store,
    audit: ctx.audit,
    attempts: ctx.attempts,
    gh: ctx.gh,
    git: ctx.git,
    removeTranscripts: (target) => removeRunTranscripts(target, transcriptDirsOf(ctx.project.name)),
  });

/** What the top bar shows of the loops: every running agent, and the latest usage-limit pause. */
function combinedLoopState(contexts: ProjectContext[]): LoopState {
  const states = contexts.map((ctx) => readLoopState(ctx.paths.loopState));
  const paused = states.map((s) => s.pausedUntil).filter((p): p is string => !!p).toSorted();
  return { running: states.flatMap((s) => s.running), ...(paused.length > 0 ? { pausedUntil: paused.at(-1) } : {}) };
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

    "/api/sessions/:adw_id": {
      GET: safely(async (req) => {
        const detail = (await load()).model.details.get(param(req, "adw_id"));
        return detail ? json(detail) : notFound(`no session ${param(req, "adw_id")}`);
      }),
      DELETE: safely(async (req) => {
        const id = param(req, "adw_id");
        const found = findSession(id);
        if (!found) return notFound(`no session ${id}`);
        const reports: DeleteReport[] = [];
        // One at a time: each delete rewrites the queue and may run git in the same checkout.
        for (const taskId of found.order.taskIds) {
          // oxlint-disable-next-line no-await-in-loop
          const report = await removeTaskIn(found.ctx, taskId);
          if (report) reports.push(report);
        }
        invalidate();
        return json({ session: id, deleted: reports });
      }),
    },

    "/api/sessions/:adw_id/delete-preview": safely((req) => {
      const id = param(req, "adw_id");
      const found = findSession(id);
      if (!found) return notFound(`no session ${id}`);
      const tasks = found.ctx.store.load();
      return json(found.order.taskIds.flatMap((taskId) => previewDelete(tasks, taskId) ?? []));
    }),

    "/api/tasks/:id/delete-preview": safely((req) => {
      const found = findTask(param(req, "id"));
      const preview = found ? previewDelete(found.ctx.store.load(), found.task.id) : null;
      return preview ? json(preview) : notFound(`no task ${param(req, "id")}`);
    }),

    "/api/tasks/:id": {
      DELETE: safely(async (req) => {
        const found = findTask(param(req, "id"));
        const report = found ? await removeTaskIn(found.ctx, found.task.id) : null;
        if (!report) return notFound(`no task ${param(req, "id")}`);
        invalidate();
        return json(report);
      }),
    },

    // The factory-wide switches and what the loop is doing right now.
    "/api/factory": {
      GET: safely(() => {
        const contexts = allContexts();
        const registry = projectRegistry();
        return json({
          settings: settingsStore().load(),
          loop: combinedLoopState(contexts),
          projects: contexts.map((ctx) => ({
            name: ctx.project.name,
            path: ctx.project.path,
            paused: ctx.project.paused,
            dependsOn: ctx.project.dependsOn,
            waitingOn: waitingOnProjects(ctx.project, registry),
            tasks: ctx.store.load().length,
          })),
          maxAgentCap: MAX_AGENT_CAP,
        });
      }),
      POST: safely(async (req) => {
        const body = await bodyOf(req);
        if (!body) return badBody("body must be an object with defaultMode, agentCap and/or paused");
        const patch: Partial<Settings> = {};
        if ("defaultMode" in body) {
          if (!TASK_MODES.includes(body.defaultMode as TaskMode)) return badBody(`defaultMode must be ${TASK_MODES.join(" or ")}`);
          patch.defaultMode = body.defaultMode as TaskMode;
        }
        if ("agentCap" in body) {
          const cap = body.agentCap;
          if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > MAX_AGENT_CAP) return badBody(`agentCap must be a whole number from 1 to ${MAX_AGENT_CAP}`);
          patch.agentCap = cap;
        }
        if ("paused" in body) {
          if (typeof body.paused !== "boolean") return badBody("paused must be true or false");
          patch.paused = body.paused;
        }
        if (Object.keys(patch).length === 0) return badBody("nothing to change: give defaultMode, agentCap and/or paused");
        const settings = settingsStore().update((s) => ({ ...s, ...patch }));
        invalidate();
        return json({ settings });
      }),
    },

    "/api/projects/:name/mode": {
      POST: safely(async (req) => {
        const name = param(req, "name");
        const mode = modeOf(await bodyOf(req));
        if (mode === undefined) return badBody(BAD_MODE);
        if (!contextOf(name)) return notFound(`no project ${name}`);
        setLevelMode("projects", name, mode);
        invalidate();
        return json({ ok: true, project: name, mode });
      }),
    },

    "/api/sessions/:adw_id/mode": {
      POST: safely(async (req) => {
        const id = param(req, "adw_id");
        const mode = modeOf(await bodyOf(req));
        if (mode === undefined) return badBody(BAD_MODE);
        // Only a session whose tasks store its id can carry a setting of its own.
        if (!allContexts().some((ctx) => ctx.store.load().some((t) => t.session === id))) return notFound(`no session ${id} with a stored id`);
        setLevelMode("sessions", id, mode);
        invalidate();
        return json({ ok: true, session: id, mode });
      }),
    },

    "/api/tasks/:id/mode": {
      POST: safely(async (req) => {
        const id = param(req, "id");
        const mode = modeOf(await bodyOf(req));
        if (mode === undefined) return badBody(BAD_MODE);
        const found = findTask(id);
        if (!found) return notFound(`no task ${id}`);
        found.ctx.store.update(id, { mode: mode ?? undefined });
        invalidate();
        return json({ ok: true, id, mode });
      }),
    },

    // Adds or removes one dependency of a task by hand. Anything that would deadlock two tasks is refused.
    "/api/tasks/:id/dependencies": {
      POST: safely(async (req) => {
        const id = param(req, "id");
        const body = await bodyOf(req);
        const found = findTask(id);
        if (!found) return notFound(`no task ${id}`);
        const { task } = found;
        const store = found.ctx.store;
        const deps: Record<string, string> = Object.fromEntries(task.dependencies.map((d) => [d, task.dependencyReasons?.[d] ?? "added before reasons were recorded"]));
        if (typeof body?.remove === "string") {
          if (!(body.remove in deps)) return badBody(`${body.remove} is not a dependency of ${id}`);
          delete deps[body.remove];
        } else if (typeof body?.add === "string" && typeof body.reason === "string" && body.reason.trim() !== "") {
          deps[body.add] = body.reason.trim();
        } else {
          return badBody("body must be {add: <task id>, reason: <one line>} or {remove: <task id>}");
        }
        // Dependencies on tasks that were completed since are dropped rather than refused.
        const tasks = store.load();
        for (const d of Object.keys(deps)) if (d !== body?.add && tasks.find((t) => t.id === d)?.status === "completed") delete deps[d];
        const errors = checkDependencies(tasks, id, deps);
        if (errors.length > 0) return badBody(errors.join("; "));
        const updated = setDependencies(store, id, deps);
        invalidate();
        return json({ id, dependencies: updated.dependencies, dependencyReasons: updated.dependencyReasons ?? {} });
      }),
    },

    // Un-parks a task the loop gave up on: clears its needs-you note and its failed-attempt count, so it may start again.
    "/api/tasks/:id/retry": {
      POST: safely((req) => {
        const id = param(req, "id");
        const found = findTask(id);
        if (!found) return notFound(`no task ${id}`);
        found.ctx.store.update(id, { needsYou: undefined, attempts: undefined });
        invalidate();
        return json({ ok: true, id });
      }),
    },

    "/api/tasks/:id/complete": {
      POST: safely((req) => {
        const id = param(req, "id");
        const found = findTask(id);
        if (!found) return notFound(`no task ${id}`);
        found.ctx.store.complete(id);
        invalidate();
        return json({ ok: true, id });
      }),
    },

    // Their one write (archive) has no meaning here: the factory's records are not the reader's to change.
    "/api/sessions/:adw_id/archive": { POST: () => json({ error: "archiving is disabled" } satisfies ApiError, 405) },

    // Projects are repositories: one is added by the path of its checkout, never by a made-up name.
    "/api/projects": {
      POST: safely(async (req) => {
        const body = await bodyOf(req);
        if (typeof body?.path !== "string" || !body.path.trim()) return badBody("body must be {path: <folder of the repository>}");
        try {
          const project = await registerRepo(resolve(body.path.trim()));
          invalidate();
          return json(project);
        } catch (e) {
          return badBody((e as Error).message);
        }
      }),
    },

    // Removes a repository from the factory: every one of its tasks is deleted, and its loop stops. The repository
    // itself is never touched beyond closing those tasks' PRs and deleting their branches.
    "/api/projects/:name": {
      DELETE: safely(async (req) => {
        const name = param(req, "name");
        const ctx = contextOf(name);
        if (!ctx) return notFound(`no project ${name}`);
        const reports: DeleteReport[] = [];
        for (const task of ctx.store.load()) {
          // oxlint-disable-next-line no-await-in-loop
          const report = await removeTaskIn(ctx, task.id);
          if (report) reports.push(report);
        }
        projectRegistry().remove(name);
        invalidate();
        return json({ project: name, deleted: reports });
      }),
    },

    "/api/projects/:name/depends-on": {
      POST: safely(async (req) => {
        const name = param(req, "name");
        const body = await bodyOf(req);
        const wanted = body?.dependsOn;
        if (!Array.isArray(wanted) || !wanted.every((d) => typeof d === "string")) return badBody("body must be {dependsOn: [<project name>, ...]}");
        try {
          const project = projectRegistry().setDependsOn(name, wanted as string[]);
          invalidate();
          return json(project);
        } catch (e) {
          const message = (e as Error).message;
          return message === `no project "${name}"` ? notFound(message) : badBody(message);
        }
      }),
    },

    "/api/projects/:name/paused": {
      POST: safely(async (req) => {
        const name = param(req, "name");
        const body = await bodyOf(req);
        if (typeof body?.paused !== "boolean") return badBody("body must be {paused: true or false}");
        if (!contextOf(name)) return notFound(`no project ${name}`);
        const project = projectRegistry().setPaused(name, body.paused);
        invalidate();
        return json(project);
      }),
    },

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

    "/api/customize/:pr": safely((req) => {
      const pr = prParam(req);
      const host = pr === null ? null : customizeFor(pr, projectQuery(req));
      if (pr === null) return badPr();
      return host ? json(host.get(pr)) : notFound("no project to host the agent");
    }),

    "/api/customize/:pr/answer": {
      POST: safely(async (req) => {
        const pr = prParam(req);
        if (pr === null) return badPr();
        const body = await bodyOf(req);
        const answers = body?.answers as Record<string, unknown> | undefined;
        if (typeof body?.id !== "string" || !answers || typeof answers !== "object" || !Object.values(answers).every((v) => typeof v === "string")) {
          return badBody("body must be {id, answers: {question: answer}}");
        }
        const ok = customizeFor(pr, projectQuery(req))?.answer(pr, { id: body.id, answers: answers as Record<string, string> } satisfies AnswerBody) ?? false;
        return ok ? json({ ok: true }) : conflict("no open question with that id");
      }),
    },

    "/api/customize/:pr/reply": {
      POST: safely(async (req) => {
        const pr = prParam(req);
        if (pr === null) return badPr();
        const body = await bodyOf(req);
        if (typeof body?.text !== "string" || !body.text.trim()) return badBody("body must be {text}");
        const ok = customizeFor(pr, projectQuery(req))?.reply(pr, (body as unknown as ReplyBody).text) ?? false;
        return ok ? json({ ok: true }) : conflict("the agent is not waiting for a reply");
      }),
    },
  },

  fetch(req) {
    if (new URL(req.url).pathname.startsWith("/api/")) return notFound(`no route ${new URL(req.url).pathname}`);
    return serveStatic(req);
  },
});

console.log(`[viz] factory visualizer  http://${HOST}:${server.port}`);
