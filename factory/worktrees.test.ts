import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptTranscripts, bunGitIn, claudeProjectDir, gitWorktrees, worktreeName } from "./worktrees.ts";

let root: string;
let home: string;
beforeEach(async () => {
  // realpath: macOS tmp is a symlink, and git reports worktree paths resolved.
  root = realpathSync(mkdtempSync(join(tmpdir(), "wt-repo-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "wt-home-")));
  await bunGitIn(["init", "-q", "-b", "main"], root);
  writeFileSync(join(root, "tracked.txt"), "hello\n");
  await bunGitIn(["add", "."], root);
  await bunGitIn(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], root);
  mkdirSync(join(root, "factory"));
  writeFileSync(join(root, "factory", "tasks.json"), "[]\n");
  mkdirSync(join(root, "node_modules"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("create makes a detached worktree with the tracked files and links the untracked ones it needs", async () => {
  const ws = gitWorktrees({ root, home });
  const path = await ws.create("cook-a");
  expect(path).toBe(join(root, ".worktrees", "cook-a"));
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("hello\n");
  expect(lstatSync(join(path, "factory", "tasks.json")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(path, "factory", "tasks.json"), "utf8")).toBe("[]\n");
  expect(lstatSync(join(path, "node_modules")).isSymbolicLink()).toBe(true);
  // viz/node_modules does not exist in this repo, so it is not linked.
  expect(existsSync(join(path, "viz"))).toBe(false);
  const head = await bunGitIn(["rev-parse", "--abbrev-ref", "HEAD"], path);
  expect(head.stdout.trim()).toBe("HEAD");
});

test("two worktrees exist side by side; remove drops one and leaves the other and the main checkout alone", async () => {
  const ws = gitWorktrees({ root, home });
  const a = await ws.create("cook-a");
  const b = await ws.create("pr-7");
  writeFileSync(join(a, "tracked.txt"), "changed in a\n");
  expect(readFileSync(join(b, "tracked.txt"), "utf8")).toBe("hello\n");
  await ws.remove("cook-a");
  expect(existsSync(a)).toBe(false);
  expect(existsSync(b)).toBe(true);
  expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("hello\n");
  expect(existsSync(join(root, "factory", "tasks.json"))).toBe(true);
  await ws.remove("never-existed");
});

test("create replaces a leftover worktree of the same name; prune removes them all", async () => {
  const ws = gitWorktrees({ root, home });
  const first = await ws.create("cook-a");
  writeFileSync(join(first, "junk.txt"), "left over");
  const again = await ws.create("cook-a");
  expect(existsSync(join(again, "junk.txt"))).toBe(false);
  await ws.create("pr-7");
  await ws.prune();
  expect(readdirSync(join(root, ".worktrees"))).toEqual([]);
  const list = await bunGitIn(["worktree", "list", "--porcelain"], root);
  expect(list.stdout.match(/^worktree /gm)).toHaveLength(1);
});

test("removing a worktree moves its transcripts next to the main checkout's", async () => {
  const ws = gitWorktrees({ root, home });
  const path = await ws.create("cook-a");
  const from = claudeProjectDir(path, home);
  mkdirSync(join(from, "abc"), { recursive: true });
  writeFileSync(join(from, "abc.jsonl"), "{}\n");
  await ws.remove("cook-a");
  const to = claudeProjectDir(root, home);
  expect(readdirSync(to).toSorted()).toEqual(["abc", "abc.jsonl"]);
  expect(existsSync(from)).toBe(false);
  expect(adoptTranscripts(path, root, home)).toBe(0);
});

test("names and project folders are derived the way Claude Code does it", () => {
  expect(worktreeName("cook", "add-login")).toBe("cook-add-login");
  expect(worktreeName("pr", 7)).toBe("pr-7");
  expect(worktreeName("cook", "a/b c")).toBe("cook-a-b-c");
  expect(claudeProjectDir("/Users/me/My Repo/.worktrees/cook-a", "/home")).toBe("/home/.claude/projects/-Users-me-My-Repo--worktrees-cook-a");
});
