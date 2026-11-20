import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, modeInfo, resolveMode, resolveModeSource, settingsStore, validateSettings } from "./settings.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "settings-"));
  path = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the factory default starts hands-on with a cap of 3 agents", () => {
  expect(settingsStore(path).load()).toEqual({ defaultMode: "hands-on", projects: {}, sessions: {}, agentCap: 3, paused: false });
  expect(existsSync(path)).toBe(false);
});

test("the most specific level wins: task, session, project, default", () => {
  const settings = { ...DEFAULT_SETTINGS, projects: { p: "hands-off" as const }, sessions: { s: "hands-on" as const } };
  expect(resolveModeSource({}, settings)).toEqual({ mode: "hands-on", from: "default" });
  expect(resolveModeSource({ project: "p" }, settings)).toEqual({ mode: "hands-off", from: "project" });
  expect(resolveModeSource({ project: "p", session: "s" }, settings)).toEqual({ mode: "hands-on", from: "session" });
  expect(resolveModeSource({ project: "p", session: "s", mode: "hands-off" }, settings)).toEqual({ mode: "hands-off", from: "task" });
  expect(resolveMode({ project: "other", session: "other" }, { ...settings, defaultMode: "hands-off" })).toBe("hands-off");
});

test("update saves a change that later loads see, and leaves other levels alone", () => {
  const store = settingsStore(path);
  store.update((s) => ({ ...s, sessions: { ...s.sessions, s1: "hands-off" } }));
  store.update((s) => ({ ...s, defaultMode: "hands-off" }));
  expect(settingsStore(path).load()).toEqual({ defaultMode: "hands-off", projects: {}, sessions: { s1: "hands-off" }, agentCap: 3, paused: false });
  expect(existsSync(`${path}.tmp`)).toBe(false);
});

test("a partial file is filled from the defaults; an invalid one is rejected", () => {
  writeFileSync(path, JSON.stringify({ defaultMode: "hands-off" }));
  expect(settingsStore(path).load().agentCap).toBe(3);
  writeFileSync(path, JSON.stringify({ defaultMode: "away" }));
  expect(() => settingsStore(path).load()).toThrow("defaultMode");
  writeFileSync(path, "{nope");
  expect(() => settingsStore(path).load()).toThrow("not valid JSON");
  expect(() => settingsStore(join(dir, "other.json")).update((s) => ({ ...s, agentCap: 0 }))).toThrow("agentCap");
});

test("validateSettings names each problem", () => {
  expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  expect(validateSettings([])).toHaveLength(1);
  expect(validateSettings({ defaultMode: "x", projects: { a: "y" }, sessions: [], agentCap: 1.5, paused: "no" })).toHaveLength(5);
});

test("modeInfo reports each level's own setting and what it inherits", () => {
  const settings = { ...DEFAULT_SETTINGS, projects: { p: "hands-off" as const }, sessions: { s: "hands-on" as const } };
  const fields = { project: "p", session: "s", mode: "hands-off" as const };
  expect(modeInfo("project", fields, settings)).toEqual({ mode: "hands-off", from: "project", own: "hands-off", inherited: "hands-on" });
  expect(modeInfo("session", fields, settings)).toEqual({ mode: "hands-on", from: "session", own: "hands-on", inherited: "hands-off" });
  expect(modeInfo("task", fields, settings)).toEqual({ mode: "hands-off", from: "task", own: "hands-off", inherited: "hands-on" });
  expect(modeInfo("task", { project: "p" }, settings)).toEqual({ mode: "hands-off", from: "project", own: null, inherited: "hands-off" });
  expect(modeInfo("session", { session: "other" }, settings)).toEqual({ mode: "hands-on", from: "default", own: null, inherited: "hands-on" });
});
