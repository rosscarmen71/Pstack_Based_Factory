---
name: to_tasks
description: break down a plan / design into separable modular independent tasks.
disable-model-invocation: true
---

# Plan

Run by a human, interactively; it is not part of the loop. The input is a brief description of what the engineer wants
to build. The output is a reviewed set of tasks appended to `factory/tasks.json`. The 

## Task schema

Each task is an object with:

- `id`: unique kebab-case slug (e.g. `add-login-route`). Needed so other tasks can depend on it.
- `title`: short, imperative.
- `description`: what to build, why, and what is out of scope.
- `acceptanceCriteria`: array of statements written as checks that can be run or inspected, not as intentions.
- `dependencies`: array of task `id`s that must finish first (`[]` if none).
- `dependencyReasons`: object with one entry per id in `dependencies`: `{<dependency id>: <one line saying why>}`.
  Leave it out when there are no dependencies.
- `status`: always `"pending"` when you write it. The loop owns it from there (`pending` -> `in_progress` -> `pr` ->
  `completed`).
- `createdAt`: optional ISO 8601 timestamp (e.g. `2026-10-29T18:46:00.000Z`). Stamp it with the current time at
  append time (step 5). Existing tasks without it stay valid; do not backfill them.
- `session`: id of the take_order call that created the task. Stamped at append time (step 5), the same for every
  task of one order. Never changed afterwards.

Each task must be small enough to deliver as one PR.

## Task Requirements

All tasks must have the following qualities if they do not naturally have these qualities it should not be an independent task:

- **Independent Testing**: a task must be able to be tested without also subsequently testing other tasks. More specifically, if you must be able to build tests specifically for this task where doing those tests do not guarantee that another task is tested. If there is severe overlap in tests between tasks, they are not independent and should not be separate tasks. (note that this does not mean that if one task is broken and everything else works that only that tasks tests will fail it as possible for tasks dependent on the failing task to fail as well that does not mean they are dependent on each other in a code sense.)
- **Independent Code**: if it is impossible to separate the new code that needs to be generated for two tasks they are not two individual tasks. This is different than creating a universal function that many tasks will need to use. This is a along the lines that if two different functionalities can't be separated then there should not be two different tasks for that functionality.
- **Independent Context**: if there are two tasks where it be impractical to develop both unless you were developing them in parallel talking to each other and developing them together then those two tasks are not independent tasks and should not be separate. Note that this is different than tasks being dependent on each other. It is pulse to have multiple tasks that must be done in sequence because the next tasks depend on the specific code written by the previous tasks. They can still be separate the differences if they would have to be developed in parallel, then they are not separate tasks.

## Task Dependency
A task that depends on another runs after it, never at the same time; tasks with no dependency between them run in parallel. Dependencies are decided by the **task-determine-deps** skill, not here: read `../task-determine-deps/SKILL.md` and follow it with the drafted tasks and the order's project. It compares each new task with every unfinished task, including ones from earlier orders, and returns each task's `dependencies` and `dependencyReasons`. Do not add or remove a dependency by any other means, except when the engineer asks for it.

## Steps

1. **Initial Break Down**: Split the plan / design into tasks following the task schema. Then decide the dependencies as the Task Dependency section says. Order the tasks so dependencies point backwards. Note that it is posible that the plan is only composed of one task.
2. **Validate Each Task**: show the user the list of tasks. Verify that each task is independent and makes most logical sense to be separated instead of merged into another task. Task requirements and dependencies are described above. For each task, ask the user if they think the task should be merged with another, separated into sub tasks, or left as is. If the user specifies that two tasks or more should be merged, update the task list appropriately ensuring that dependencies are up-to-date as well as the description, etc.. If the user says to separate the task into sub-tasks, read `../separate_task/SKILL.md` and follow it, passing the task and the current task list. On `split`, replace the task in the list with `subtasks`, set each task named in `rewire` to its new `dependencies`, and do not ask the merge/split question again for the new sub-tasks. On `unchanged`, leave the list as it is.
3. **Sharpen Each Task**: call the **sharpen** skill on each task in the task list.
4. **Grill Each Task**: call the **grilling** skill on each task and update the task requiorments, description, and addtional info as needed.

## Return 
Return the finalized and updated list of tasks.