import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../factory/tasks.schema.ts";
import { fileStore } from "../../factory/tasks.store.ts";
import { parseProjectBody, setOrderProject } from "./projects.ts";

const T0 = Date.parse("2026-11-18T10:00:00Z");
const t = (id: string, min: number): Task => ({
  id,
  title: id,
  description: "d",
  acceptanceCriteria: ["c (proof: live)"],
  dependencies: [],
  status: "pending",
  createdAt: new Date(T0 + min * 60_000).toISOString(),
});

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "viz-projects-"));
  path = join(dir, "tasks.json");
  writeFileSync(path, JSON.stringify([t("a", 0), t("b", 1), t("c", 60)]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const saved = () => JSON.parse(readFileSync(path, "utf8")) as Task[];

describe("setOrderProject", () => {
  test("sets the project on every task of the order and no other", () => {
    expect(setOrderProject(fileStore(path), "order-a", "Alpha")).toEqual(["a", "b"]);
    expect(saved().map((x) => x.project)).toEqual(["Alpha", "Alpha", undefined]);
  });

  test("null removes the field", () => {
    const store = fileStore(path);
    setOrderProject(store, "order-a", "Alpha");
    setOrderProject(store, "order-a", null);
    expect(saved().every((x) => !("project" in x))).toBe(true);
  });

  test("an unknown or synthetic session changes nothing", () => {
    const before = readFileSync(path, "utf8");
    expect(setOrderProject(fileStore(path), "order-zzz", "x")).toBeNull();
    expect(setOrderProject(fileStore(path), "unlinked-prs", "x")).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("parseProjectBody", () => {
  test("accepts a trimmed name or null", () => {
    expect(parseProjectBody({ project: "  Alpha " })).toEqual({ ok: true, project: "Alpha" });
    expect(parseProjectBody({ project: "x".repeat(60) })).toEqual({ ok: true, project: "x".repeat(60) });
    expect(parseProjectBody({ project: null })).toEqual({ ok: true, project: null });
  });

  test("rejects anything else", () => {
    for (const body of [null, {}, { project: "" }, { project: "   " }, { project: 3 }, { project: "x".repeat(61) }, { project: undefined }]) {
      expect(parseProjectBody(body as Record<string, unknown> | null).ok).toBe(false);
    }
  });
});
