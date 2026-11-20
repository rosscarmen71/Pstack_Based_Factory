---
name: task-determine-deps
description: Decide the dependencies of the tasks of a new order before they are written - list the unfinished tasks to compare against, judge each pair with task-pair-check, and ask the engineer or default to dependent when in doubt.
disable-model-invocation: true
---

# Task Determine Deps

Decides which tasks each new task must wait for. Run by `to_tasks` inside `take_order`, after the tasks are drafted
and before the engineer reviews them. The input is the drafted tasks of one order (not yet in the task queue: this repository's
`tasks.json`, kept in the factory's home). The output is each drafted task's `dependencies` and `dependencyReasons`, plus a report for
the engineer.

Other skills named here sit beside this one, at `../<name>/SKILL.md` from this skill's folder. Load each by reading
that file with the Read tool.

## Steps

1. **Get the tasks to compare against.** Run `~/.pstack-factory/bin/factory deps candidates`. It prints:
   - `mode`: `hands-on` or `hands-off`, which decides what to do when in doubt (step 4);
   - `candidates`: every unfinished task. Completed and deleted tasks are never in it and are never dependencies.

   Use exactly this list. Do not drop a candidate because it looks unrelated, and do not add tasks from anywhere
   else. If the engineer named a task to check and it is not in the list, tell them it is completed or deleted and
   so cannot be waited for.
2. **Put the drafted tasks in build order.** Foundations first: a task that others build on comes before them.
   Where nothing decides it, keep the order they were written in.
3. **Judge each drafted task.** In build order, for each drafted task: its candidates are the list from step 1
   plus the drafted tasks before it. Read `../task-pair-check/SKILL.md` and follow it with the drafted task as the
   target and those candidates.
4. **Apply the verdicts.**
   - `dependent`: add the candidate to the task's `dependencies`, with the reason in `dependencyReasons`.
   - `independent`: do not add it.
   - `unsure`, mode `hands-on`: ask the engineer about that pair with the AskUserQuestion tool, and do what they
     say. Show them:
     - the new task: its name, what it is meant to do, its hard limits, the files it will likely edit and its
       other likely changes (the footprint);
     - the other task: its name, what it does, and which of its files and changes may conflict (`mayConflict`).
   - `unsure`, mode `hands-off`: treat it as `dependent`. Start the reason with `unsure: `.
5. **Keep the direction.** A new task waits for an existing one. Never add a dependency to a task that is already
   in the task queue. Among the drafted tasks, a later one in build order waits for an earlier one, never the
   reverse.

## Return

- For each drafted task: `dependencies` (task ids) and `dependencyReasons` (`{<dependency id>: <one line>}`, one
  entry per dependency).
- The pairs judged `independent`, each with its reason, so the engineer can overrule one when they review the tasks.

## Rules

- Never write the task queue; `take_order` appends the tasks.
- Never decide whether a task may run. That is the loop's start gate.
- A wrong dependency only costs time. When the choice is yours, choose dependent.
