---
name: take_order
description: Design a feature with the engineer, break it into tasks, and append the approved tasks to factory/tasks.json
---

# Take Order

Run by a human, interactively; it is not part of the loop. The input is a brief description of what the engineer wants
to build. The output is a reviewed set of tasks appended to `factory/tasks.json`. The 

## Steps

1. **Understand and Design.** Read the engineer's brief. Skim the repo enough to know where the work lands and what already exists. Ask clarifying questions by calling the **grill-with-docs** skill.
2. **Break down.** Split the agreed apon design into tasks using the **to_tasks**. 
3. **Present.** Show the engineer the full task list (titles, descriptions, criteria, dependencies) and the dependency order. Revise until they approve. **Do not write to `tasks.json` before explicit approval.**
4. **Pick the project.** Ask the engineer which project this order belongs to with the AskUserQuestion tool. Offer the
   distinct `project` values already in `factory/tasks.json` (up to four, most recent first); the engineer types a new
   name through "Other". A project is just a name that groups orders in the visualizer.
5. **Append.** After approval, add the tasks to the array in `factory/tasks.json` (create it as `[]` first if it does not exist). Never modify or remove existing tasks. If an id collides with an existing one, rename the new task. New tasks may depend on existing ids. Stamp each new task's `createdAt` with the current time, its `project` with the chosen name, and its `session` with one id shared by every task of this order and by no other: `session-<UTC time as YYYYMMDDTHHMMSSZ>` (e.g. `session-20261119T204500Z`).
6. **Validate.** Re-read the file and confirm: it is valid JSON, ids are unique, every dependency id exists, and there are no dependency cycles. Fix anything that fails before reporting.
7. **Summarize.** List the tasks added, their project, and their dependency order.