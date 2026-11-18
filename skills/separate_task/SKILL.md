---
name: separate_task
description: Split one proposed task into smaller independent sub-tasks with the engineer's approval. Called by to_tasks step 2 only.
disable-model-invocation: true
---

# Separate Task

Called by **to_tasks** step 2 when the engineer asks to split a task into sub-tasks; it is not run on its own. The
input is the task to split (T) and to_tasks' current task list. The output is the approved sub-tasks plus a rewiring
map for the tasks that depended on T, or T unchanged with a reason. The current list is read-only here: return the
result and let to_tasks apply it. Never write `factory/tasks.json`.

The task schema and the independence rules live in `../to_tasks/SKILL.md` (**Task schema** and **Task Requirements**).
Read that file before step 1; this skill does not restate them.

## Sub-task rules

- Each sub-task follows the task schema, meets all three independence rules (testing, code, context), and is small
  enough to deliver as one PR.
- T's id is retired. Give each sub-task a new kebab-case id that names its own work (`add-login-form`, not `T-1`),
  unique against the current list and `factory/tasks.json` (when it exists).
- Hand T's dependencies only to the sub-tasks that need them. A sub-task depends on another sub-task only when it needs
  that sub-task's code; otherwise they stay parallel.
- Every acceptance criterion of T lands in at least one sub-task, reworded to fit if needed. Sub-tasks may add new
  criteria for the seams between them. A criterion is dropped only when the engineer agrees.
- Set `status` to `"pending"`. Leave `createdAt` out; take_order stamps it when it appends.

## Steps

1. **Read.** Read T, the current list, and the code where T lands. Find the seams: separate modules, separate
   behaviors, and code one part needs from another. Change nothing.
2. **Propose.** Show the engineer:
   - The sub-tasks in dependency order: id, title, description, acceptance criteria, dependencies.
   - For each cut, why it is there and how both sides meet the three independence rules.
   - The criterion map: each of T's criteria and the sub-task(s) that now carry it.
   - The rewiring map: each task in the list that depended on T, and the sub-task ids it now depends on. Pick only the
     sub-tasks whose code it actually needs.

   If every cut breaks an independence rule, say which rule each cut breaks and recommend keeping T whole or the
   closest cut that holds.
3. **Revise.** Iterate until the engineer approves. If they ask to split a sub-task further, do it here, in this same
   loop. If they insist on a cut that breaks a rule, make it, and add one line to the description of each affected
   sub-task naming the broken rule and why the split was kept anyway.
4. **Check.** Before returning, confirm:
   - Sub-task ids are unique against the current list and `factory/tasks.json`.
   - Every criterion of T is in the criterion map, or was dropped with the engineer's agreement.
   - No sub-task or rewired task still depends on T's id.
   - The sub-tasks and rewired dependencies form no cycle.

   Fix anything that fails and show the engineer what changed.
5. **Return** the result below to to_tasks.

## Return

One of:

- `split`:
  - `subtasks`: the approved sub-task objects, in dependency order.
  - `rewire`: `[{ id, dependencies }]`, one entry per task in the list that depended on T, giving its full new
    `dependencies` array with T replaced by the sub-task ids it needs. Empty when nothing depended on T.
  - `criteriaMap`: each of T's criteria with the sub-task id(s) that carry it, or `dropped` with the engineer's
    agreement.
- `unchanged`: the engineer agreed to keep T whole. Give the reason in one sentence.
