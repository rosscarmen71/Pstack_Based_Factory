import { describe, expect, test } from "bun:test";
import { parseTasks, validateTasks, type Task } from "./tasks.schema.ts";

const valid = (over: Partial<Task> = {}): Task => ({
  id: "a",
  title: "T",
  description: "D",
  acceptanceCriteria: ["c"],
  dependencies: [],
  status: "pending",
  ...over,
});

describe("validateTasks", () => {
  test("accepts a valid list, including an empty one", () => {
    expect(validateTasks([])).toEqual([]);
    expect(validateTasks([valid(), valid({ id: "b", dependencies: ["a"] })])).toEqual([]);
  });

  test("rejects non-arrays and malformed entries", () => {
    expect(validateTasks({})).toHaveLength(1);
    expect(validateTasks([null])).not.toEqual([]);
    expect(validateTasks([valid({ status: "done" as never })])[0]).toContain("status");
    expect(validateTasks([valid({ acceptanceCriteria: "x" as never })])[0]).toContain("acceptanceCriteria");
  });

  test("rejects duplicate ids, unknown dependencies and self-dependencies", () => {
    expect(validateTasks([valid(), valid()])[0]).toContain("duplicate");
    expect(validateTasks([valid({ dependencies: ["zzz"] })])[0]).toContain("unknown dependency");
    expect(validateTasks([valid({ dependencies: ["a"] })]).join()).toContain("depends on itself");
  });

  test("createdAt is optional and must be a parseable date string", () => {
    expect(validateTasks([valid()])).toEqual([]);
    expect(validateTasks([valid({ createdAt: "2026-10-29T18:46:00.000Z" })])).toEqual([]);
    const badDate = validateTasks([valid({ createdAt: "not a date" })]);
    expect(badDate).toHaveLength(1);
    expect(badDate[0]).toContain("(a)");
    expect(badDate[0]).toContain("createdAt");
    const badType = validateTasks([valid({ createdAt: 123 as never })]);
    expect(badType).toHaveLength(1);
    expect(badType[0]).toContain("(a)");
    expect(badType[0]).toContain("createdAt");
  });

  test("rejects dependency cycles", () => {
    const errors = validateTasks([valid({ dependencies: ["b"] }), valid({ id: "b", dependencies: ["a"] })]);
    expect(errors.join()).toContain("cycle");
  });
});

const pr = { repo: "app-vitals/how-to-factory", number: 7, url: "https://github.com/app-vitals/how-to-factory/pull/7", open: true };
const bad = (over: Record<string, unknown>) => validateTasks([{ ...valid(), ...over }]);

describe("tracking fields", () => {
  test("tasks without the fields still validate; valid fields are accepted", () => {
    expect(validateTasks([valid()])).toEqual([]);
    expect(validateTasks([valid({ runs: 0, skips: 0 })])).toEqual([]);
    expect(validateTasks([valid({ runs: 3, skips: 2, lastSkipReason: "blocked", pr })])).toEqual([]);
    expect(validateTasks([valid({ pr: { ...pr, open: false } })])).toEqual([]);
  });

  test.each(["runs", "skips"])("%s rejects negative, fractional and non-number values", (f) => {
    for (const v of [-1, 1.5, "2", null, Number.NaN]) {
      expect(bad({ [f]: v }).join()).toContain(f);
    }
  });

  test("lastSkipReason rejects empty and non-string values", () => {
    expect(bad({ lastSkipReason: "" }).join()).toContain("lastSkipReason");
    expect(bad({ lastSkipReason: 5 }).join()).toContain("lastSkipReason");
  });

  test("pr rejects a bad repo, number, url or open flag, and non-objects", () => {
    for (const repo of ["nope", "a/b/c", "", 3]) expect(bad({ pr: { ...pr, repo } }).join()).toContain("pr");
    for (const number of [0, -1, 1.5, "7"]) expect(bad({ pr: { ...pr, number } }).join()).toContain("pr");
    for (const url of ["http://github.com/a/b/pull/1", "not a url", "", 1]) {
      expect(bad({ pr: { ...pr, url } }).join()).toContain("pr");
    }
    for (const open of ["true", 1, undefined]) expect(bad({ pr: { ...pr, open } }).join()).toContain("pr");
    for (const p of [null, "x", []]) expect(bad({ pr: p }).join()).toContain("pr");
  });
});

describe("parseTasks", () => {
  test("project is optional and must be a non-empty string", () => {
    expect(bad({ project: "factory smoke tests" })).toEqual([]);
    expect(bad({ project: "" })).toHaveLength(1);
    expect(bad({ project: "   " })).toHaveLength(1);
    expect(bad({ project: 3 })).toHaveLength(1);
  });

  test("completed is a status; mode, session, needsYou, attempts and completedAt are checked", () => {
    expect(bad({ status: "completed", completedAt: "2026-11-19T20:00:00.000Z" })).toEqual([]);
    expect(bad({ mode: "hands-off", session: "s1", needsYou: "look", attempts: 2 })).toEqual([]);
    expect(bad({ mode: "away" as never })).toHaveLength(1);
    expect(bad({ session: " " })).toHaveLength(1);
    expect(bad({ needsYou: "" })).toHaveLength(1);
    expect(bad({ attempts: -1 })).toHaveLength(1);
    expect(bad({ completedAt: "yesterday" })).toHaveLength(1);
  });

  test("dependency reasons must name real dependencies and be non-empty", () => {
    const dep = valid({ id: "dep" });
    expect(validateTasks([dep, valid({ dependencies: ["dep"], dependencyReasons: { dep: "both edit x.ts" } })])).toEqual([]);
    expect(validateTasks([dep, valid({ dependencies: ["dep"], dependencyReasons: { other: "why" } })])[0]).toContain("not a dependency");
    expect(validateTasks([dep, valid({ dependencies: ["dep"], dependencyReasons: { dep: " " } })])[0]).toContain("non-empty");
    expect(bad({ dependencyReasons: [] as never })).toHaveLength(1);
  });

  test("returns the tasks or throws with every problem listed", () => {
    expect(parseTasks([valid()])).toHaveLength(1);
    expect(() => parseTasks([valid({ id: "" })])).toThrow("invalid tasks.json");
  });
});