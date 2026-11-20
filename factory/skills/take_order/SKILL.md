---
name: take_order
description: Design a feature with the engineer, break it into tasks, and append the approved tasks to the task queue
---

# Take Order

Run by a human, interactively; it is not part of the loop. The input is a brief description of what the engineer wants
to build. The output is a reviewed set of tasks appended to the task queue. The 

**The task queue** is this repository's `tasks.json`. It is kept in the factory's home, not in the repository. Get its
path by running `~/.pstack-factory/bin/factory tasks-file` in the repository (or in a worktree of it), and use that
path wherever this skill says "the task queue".

## Steps

1. **Understand and Design.** Read the engineer's brief. Skim the repo enough to know where the work lands and what already exists. Ask clarifying questions by calling the **grill-with-docs** skill.
2. **Break down.** Split the agreed apon design into tasks using the **to_tasks**. It also decides each task's dependencies.
3. **Present.** Show the engineer the full task list (titles, descriptions, criteria, dependencies with the reason for each) and the dependency order, and the pairs that were judged independent with why. Revise until they approve; the engineer may add or remove a dependency. **Do not write to `tasks.json` before explicit approval.**
4. **Append.** After approval, add the tasks to the array in the task queue (create it as `[]` first if it does not exist). Never modify or remove existing tasks. If an id collides with an existing one, rename the new task. New tasks may depend on existing ids. Stamp each new task's `createdAt` with the current time and its `session` with one id shared by every task of this order and by no other: `session-<UTC time as YYYYMMDDTHHMMSSZ>` (e.g. `session-20261119T204500Z`). Write each task's `dependencyReasons` with one entry per dependency.
5. **Validate.** Re-read the file and confirm: it is valid JSON, ids are unique, every dependency id exists, and there are no dependency cycles. Fix anything that fails before reporting.
6. **Summarize.** List the tasks added, the repository they were added to, and their dependency order.