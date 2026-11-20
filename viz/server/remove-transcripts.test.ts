import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeRunTranscripts } from "./factory-source.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transcripts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes a transcript whose first prompt is `/<command> <args>`, or plain chat when command is null. */
function transcript(name: string, command: string | null, args = ""): void {
  const content = command ? `<command-name>/${command}</command-name>\n<command-args>${args}</command-args>` : "hello there";
  writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify({ type: "user", message: { content } })}\n`);
}

test("erases only the target's runs, with their side folders", () => {
  transcript("cook-a", "cook", "a");
  mkdirSync(join(dir, "cook-a", "subagents"), { recursive: true });
  transcript("cook-ab", "cook", "ab");
  transcript("review-7", "taste_test", "7");
  transcript("patch-7", "remake", "7");
  transcript("customize-7", "customize_order", "7");
  transcript("review-70", "taste_test", "70");
  transcript("chat", null);
  writeFileSync(join(dir, "notes.txt"), "/cook a");

  const removed = removeRunTranscripts({ taskId: "a", pr: { repo: "acme/widgets", number: 7 } }, dir);

  expect(removed).toBe(4);
  expect(readdirSync(dir).toSorted()).toEqual(["chat.jsonl", "cook-ab.jsonl", "notes.txt", "review-70.jsonl"]);
});

test("a task with no PR loses only its cook runs; a missing folder is fine", () => {
  transcript("cook-a", "cook", "a");
  transcript("review-7", "taste_test", "7");
  expect(removeRunTranscripts({ taskId: "a" }, dir)).toBe(1);
  expect(existsSync(join(dir, "review-7.jsonl"))).toBe(true);
  expect(removeRunTranscripts({ taskId: "a" }, join(dir, "nope"))).toBe(0);
});
