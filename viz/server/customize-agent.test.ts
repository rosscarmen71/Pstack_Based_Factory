import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CUSTOMIZE_ALLOWED_TOOLS,
  CustomizeManager,
  QUESTION_INSTRUCTIONS,
  RESUME_PROMPT,
  type AgentMessage,
  type QueryFn,
} from "./customize-agent.ts";

const QUESTIONS = [
  {
    question: "Which file?",
    header: "File",
    multiSelect: false,
    options: [
      { label: "a.ts", description: "Recommended" },
      { label: "b.ts", description: "" },
    ],
  },
];

type Call = Parameters<QueryFn>[0];
type CanUse = NonNullable<Call["options"]["canUseTool"]>;
type Decision = Awaited<ReturnType<CanUse>>;

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** A fake agent: each call runs `script` with the call's canUseTool. Nothing real is ever started. */
function fake(script: (call: Call, ask: (tool: string, input: Record<string, unknown>) => Promise<Decision>) => AsyncGenerator<AgentMessage>) {
  const calls: Call[] = [];
  const query: QueryFn = (call) => {
    calls.push(call);
    const ask = (tool: string, input: Record<string, unknown>) =>
      (call.options.canUseTool as CanUse)(tool, input, { signal: new AbortController().signal, toolUseID: `tu${calls.length}` } as never);
    return script(call, ask);
  };
  return { query, calls };
}

const msg = (type: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ type, session_id: "11111111-1111-1111-1111-111111111111", ...extra });

function manager(query: QueryFn, answered: () => boolean = () => false, statePath: string | null = null) {
  return new CustomizeManager({ query, cwd: "/repo", statePath, isAnswered: async () => answered(), log: () => {} });
}

describe("CustomizeManager", () => {
  test("starts /customize_order <pr> in the repo with the question instruction, and the loop's tools", async () => {
    const f = fake(async function* () {
      yield msg("system");
      yield msg("result");
    });
    manager(f.query).ensure(15, "t1");
    await until(() => f.calls.length === 1);
    const { prompt, options } = f.calls[0] as Call;
    expect(prompt).toBe("/customize_order 15");
    expect(options.cwd).toBe("/repo");
    expect(options.permissionMode).toBe("default");
    expect(options.allowedTools).toEqual(CUSTOMIZE_ALLOWED_TOOLS);
    expect(JSON.stringify(options.systemPrompt)).toContain(QUESTION_INSTRUCTIONS);
    expect(options.resume).toBeUndefined();
  });

  test("a question sets waiting + pending; answer() hands the answers back in updatedInput", async () => {
    let decision = null as Decision | null;
    const f = fake(async function* (_call, ask) {
      yield msg("system");
      decision = await ask("AskUserQuestion", { questions: QUESTIONS });
      yield msg("result");
    });
    const m = manager(f.query);
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "waiting");
    const state = m.get(15);
    expect(state.sessionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(state.pending?.questions).toEqual(QUESTIONS);
    expect(decision).toBeNull();

    expect(m.answer(15, { id: "wrong", answers: { "Which file?": "a.ts" } })).toBe(false);
    expect(m.get(15).status).toBe("waiting");
    expect(m.answer(15, { id: state.pending?.id as string, answers: { "Which file?": "a.ts" } })).toBe(true);
    await until(() => decision !== null);
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: { questions: QUESTIONS, answers: { "Which file?": "a.ts" } },
    });
    expect(m.get(15).pending).toBeNull();
    // A second answer to the same question has nothing to answer.
    expect(m.answer(15, { id: state.pending?.id as string, answers: {} })).toBe(false);
    await until(() => m.get(15).status === "idle");
  });

  test("a second ensure for the same request starts no second agent, whatever state the first is in", async () => {
    const f = fake(async function* (_call, ask) {
      yield msg("system");
      await ask("AskUserQuestion", { questions: QUESTIONS });
      yield msg("result");
    });
    const m = manager(f.query);
    m.ensure(15, "t1");
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "waiting");
    m.ensure(15, "t1");
    m.ensure(15, "t2"); // a newer comment while the run is open: that run's summary answers it too
    await tick();
    expect(f.calls).toHaveLength(1);
  });

  test("an unanswered run that ends is idle and takes a reply, which resumes the session with that text", async () => {
    const f = fake(async function* () {
      yield msg("system");
      yield msg("result");
    });
    const m = manager(f.query);
    expect(m.reply(15, "hi")).toBe(false); // nothing there yet
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "idle");
    expect(m.reply(15, "use a.ts")).toBe(true);
    expect(m.get(15).status).toBe("running");
    expect(m.reply(15, "again")).toBe(false); // not idle any more
    await until(() => f.calls.length === 2);
    expect(f.calls[1]?.prompt).toBe("use a.ts");
    expect(f.calls[1]?.options.resume).toBe("11111111-1111-1111-1111-111111111111");
    await until(() => m.get(15).status === "idle");
  });

  test("a run whose request now has its summary is done, and stays done", async () => {
    let answered = false;
    const f = fake(async function* () {
      yield msg("system");
      answered = true;
      yield msg("result");
    });
    const m = manager(f.query, () => answered);
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "done");
    m.ensure(15, "t1");
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(m.reply(15, "x")).toBe(false);
  });

  test("a newer request after a finished one starts a fresh agent", async () => {
    const f = fake(async function* () {
      yield msg("result");
    });
    const m = manager(f.query, () => true);
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "done");
    m.ensure(15, "t2");
    await until(() => f.calls.length === 2);
    expect(f.calls[1]?.options.resume).toBeUndefined();
  });

  test("an erroring query fails the agent with the message; the same request is not retried", async () => {
    const f = fake(async function* () {
      yield msg("system");
      throw new Error("not logged in");
    });
    const m = manager(f.query);
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "failed");
    expect(m.get(15).error).toBe("not logged in");
    m.ensure(15, "t1");
    await tick();
    expect(f.calls).toHaveLength(1);
  });

  test("a result flagged is_error fails the agent", async () => {
    const f = fake(async function* () {
      yield msg("result", { is_error: true, result: "rate limited" });
    });
    const m = manager(f.query);
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "failed");
    expect(m.get(15).error).toBe("rate limited");
  });

  test("tools outside the loop's list are denied; the listed plain ones are allowed; Bash is left to the CLI's patterns", async () => {
    const decisions: Record<string, Decision> = {};
    const f = fake(async function* (_call, ask) {
      yield msg("system");
      for (const tool of ["WebFetch", "Read", "Skill", "Bash", "NotebookEdit"]) decisions[tool] = await ask(tool, { x: 1 });
      yield msg("result");
    });
    const m = manager(f.query);
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "idle");
    expect(decisions.WebFetch?.behavior).toBe("deny");
    expect(decisions.NotebookEdit?.behavior).toBe("deny");
    expect(decisions.Bash?.behavior).toBe("deny");
    expect(decisions.Read?.behavior).toBe("allow");
    expect(decisions.Skill?.behavior).toBe("allow");
  });

  test("an AskUserQuestion with no questions is denied and opens nothing", async () => {
    let decision = null as Decision | null;
    const f = fake(async function* (_call, ask) {
      yield msg("system");
      decision = await ask("AskUserQuestion", { questions: [] });
      yield msg("result");
    });
    const m = manager(f.query);
    m.ensure(15, "t1");
    await until(() => m.get(15).status === "idle");
    expect(decision).toMatchObject({ behavior: "deny" });
  });

  describe("after a restart", () => {
    const file = () => join(mkdtempSync(join(tmpdir(), "customize-")), "agents.json");

    test("an unfinished agent resumes its session by id instead of starting fresh, and re-asks", async () => {
      const path = file();
      const first = fake(async function* (_call, ask) {
        yield msg("system");
        await ask("AskUserQuestion", { questions: QUESTIONS });
        yield msg("result");
      });
      const m1 = manager(first.query, () => false, path);
      m1.ensure(15, "t1");
      await until(() => m1.get(15).status === "waiting");
      expect(existsSync(path)).toBe(true);

      // The server stops here: a new manager reads the file.
      let decision = null as Decision | null;
      const second = fake(async function* (_call, ask) {
        yield msg("system");
        decision = await ask("AskUserQuestion", { questions: QUESTIONS });
        yield msg("result");
      });
      const m2 = manager(second.query, () => false, path);
      expect(m2.get(15).status).toBe("starting");
      expect(m2.get(15).sessionId).toBe("11111111-1111-1111-1111-111111111111");
      m2.ensure(15, "t1");
      m2.ensure(15, "t1");
      await until(() => m2.get(15).status === "waiting");
      expect(second.calls).toHaveLength(1);
      expect(second.calls[0]?.options.resume).toBe("11111111-1111-1111-1111-111111111111");
      expect(second.calls[0]?.prompt).toBe(RESUME_PROMPT);
      m2.answer(15, { id: m2.get(15).pending?.id as string, answers: { "Which file?": "b.ts" } });
      await until(() => decision !== null);
    });

    test("a request answered before the restart never starts anything", async () => {
      const path = file();
      writeFileSync(path, JSON.stringify([{ pr: 15, commentAt: "t1", sessionId: "s1", status: "done" }]));
      const f = fake(async function* () {
        yield msg("result");
      });
      const m = manager(f.query, () => true, path);
      expect(m.get(15).status).toBe("done");
      m.ensure(15, "t1");
      await tick();
      expect(f.calls).toHaveLength(0);
    });

    test("a persisted request with no session yet starts fresh; one for an older comment is replaced", async () => {
      const path = file();
      writeFileSync(path, JSON.stringify([{ pr: 15, commentAt: "t1", sessionId: null, status: "starting" }, { pr: 16, commentAt: "old", sessionId: "s", status: "waiting" }]));
      const f = fake(async function* () {
        yield msg("result");
      });
      const m = manager(f.query, () => false, path);
      m.ensure(15, "t1");
      m.ensure(16, "new");
      await until(() => f.calls.length === 2);
      expect(f.calls.map((c) => [c.prompt, c.options.resume])).toEqual([
        ["/customize_order 15", undefined],
        ["/customize_order 16", undefined],
      ]);
    });
  });
});
