---
name: task-update-deps
description: Update one task's dependencies after its text changed - re-judge it against every unfinished task, add what now clashes, remove only what certainly no longer applies, and write the result through the deps command.
disable-model-invocation: true
---

# Task Update Deps

Updates the dependencies of one task whose text has just changed. Run by `customize_order` after it writes the task
change. The input is the task's id. The output is that task's `dependencies` and `dependencyReasons` updated in
`factory/tasks.json`, and the list of dependencies it is still waiting for.

The changed task is treated as the newcomer: **only its own dependencies change**. No other task's dependencies are
touched, and running tasks are left alone. The minimal-change rule of `customize_order` is about the task's text.
Dependencies follow the safety rule instead: when in doubt, the task waits.

Other skills named here sit beside this one, at `../<name>/SKILL.md` from this skill's folder. Load each by reading
that file with the Read tool.

## Steps

1. **Get the tasks to compare against.** Run `bun factory/deps-cli.ts candidates --for <task-id>`. It prints the
   `mode` (`hands-on` or `hands-off`) and the `candidates`: every other unfinished task. A candidate with
   `eligible: false` already depends on this task, so the two already run in order; this task must never depend on
   it. Completed and deleted tasks are not listed and are never dependencies.
2. **Judge.** Read `../task-pair-check/SKILL.md` and follow it with the task, as it reads now, as the target and
   the eligible candidates.
3. **Work out the new dependencies.** Start from the task's current `dependencies`.
   - A current dependency that is no longer in the candidates (it was completed or deleted): drop it.
   - A current dependency judged `dependent`: keep it, with the new reason.
   - A current dependency judged `independent`: remove it. This is the only way one is removed, and it needs
     certainty.
   - A candidate that is not a current dependency and is judged `dependent`: add it, with the reason.
   - Anything judged `unsure`, mode `hands-on`: ask the engineer about that pair with the AskUserQuestion tool,
     showing the task's footprint and the candidate's `mayConflict`, and do what they say.
   - Anything judged `unsure`, mode `hands-off`: keep it if it is a current dependency, add it if it is not. Start
     the reason with `unsure: `.
4. **Write.** Run `bun factory/deps-cli.ts set <task-id> '<json>'`, where `<json>` is an object of dependency id to
   its one-line reason (`{}` for none). If it refuses, read why, correct the object and run it again. Never edit
   `factory/tasks.json` by hand for this.
5. **See what it now waits for.** Run `bun factory/deps-cli.ts blockers <task-id>`.

## Return

- The dependencies before and after, each with its reason, and why each one was added, kept or removed.
- `waiting`: the list from step 5. Empty means nothing holds the task back.

## Rules

- Change only this task's dependencies. Never another task's.
- Never decide whether the task may run, and never start or stop anything. The loop's start gate does that.
