# Pstack Based Factory

A small software factory that relies heavily on [pstack skills](https://github.com/cursor/plugins/tree/main/pstack). You describe what you want; the factory splits it into tasks, has Claude Code turn each task into a pull request, and reviews and fixes those pull requests, several at a time, across as many repositories as you register.

> Also uses some of [Matt Pocock's skills](https://github.com/mattpocock/skills/tree/main), such as `grilling`, `grill_me`, `grill-with-docs` and `domain-modeling`.

> The factory layout and loop code are adapted from the
> [app-vitals how-to-factory repo](https://github.com/app-vitals/how-to-factory/tree/main).

> The factory visuals are adapted from the
> [disler super-simple-software-factory repo](https://github.com/disler/super-simple-software-factory/tree/example)

<img src="img/PBSF_video1.mp4" alt="simple demo clip" width="800"/>

### Table of Contents
* [What Is The **Pstack_Based_Factory**?](#what-is-the-pstack_based_factory)
* [How To **Setup** The Factory?](#setup)
* [How To **Use** The Factory?](#usage)
* [How Does It Work?](#how-it-works)

> For how it works in depth, with diagrams, see [`docs/README.md`](docs/README.md).

## What Is The Pstack_Based_Factory?

A factory that turns tasks into pull requests. You add tasks with `/take_order` in any repository; that repository
becomes a project. Each project has a loop that starts agents for whatever is ready, up to three at once: `/cook`
branches, implements and verifies a task and opens a PR, `/taste_test` reviews a PR, and `/remake` fixes one. Tasks
that depend on each other run in order; tasks that don't run in parallel. The work is done by pstack-style skills in
`factory/skills/`, run through the Claude Code CLI. Merging is always yours; the loop never merges. Watch and steer it
with the live visualizer (`bun run viz`), or read one project's queue with `bun run queue`.

## Setup

1) Clone the repo and enter it:
```shell
git clone https://github.com/rosscarmen71/Pstack_Based_Factory.git
cd Pstack_Based_Factory
```

2) Install the [prerequisites](#prerequisites) below. You need Bun and the Claude Code CLI on your `PATH`, then sign
   the GitHub CLI in:
```shell
gh auth login
```

3) Install the project's dependencies:
```shell
bun install
```

4) Install the factory for your user account. This puts a `factory` command in `~/.pstack-factory/bin/`, links the
   skills into `~/.claude/skills/` so they work in any repository, and registers this repository as the first
   project:
```shell
bun run factory install
```

5) Give the loop something to do. In the repository you want work done in, run `/take_order` in Claude Code to design
   a feature and add its tasks. That repository becomes a project the first time you do.

6) Start the factory. One command runs a loop for every project:
```shell
bun run loop
```

7) In another terminal, open the visualizer to watch it work:
```shell
bun run viz
```

Stop the loop with Ctrl+C.

### Prerequisites

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com), signed in with `gh auth login`. The loop lists, labels and comments on PRs.
- The Claude Code CLI (`npm install -g @anthropic-ai/claude-code`), on the `PATH` of the shell that runs the loop.

## Usage

### Commands

| Command | What it does |
| --- | --- |
| `bun run factory install` | Install the `factory` command and the skills for your user account, and register this repository |
| `bun run loop` | Start the factory: one loop per project (`factory/cli.ts start`). Stop it with Ctrl+C. |
| `bun run queue` | Read-only queue and history view of the current repository's project on http://127.0.0.1:4040 |
| `bun run viz` | The factory visualizer on http://127.0.0.1:4600 (see below). Never starts the loop. |
| `bun run lint` | Biome lint (no formatter) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | The factory's own tests |

Each project's queue is created empty the first time the project is used. The `factory` command (`~/.pstack-factory/bin/factory` once installed, or `bun run factory`) also has `register [path]`, `projects`, `tasks-file` and `deps`.

## How It Works

**Table of contents:**
- [General Workflow](#general-workflow)
- [Skills](#skills)
- [Tasks](#tasks)
- [Projects](#projects)
- [The Loop](#the-loop)
- [Agent Permissions](#agent-permissions)
- [Result Report](#result-report)
- [Audit Log](#audit-log)
- [Queue View](#queue-view)
- [Visualizer](#visualizer)
- [CI](#ci)

## General Workflow

1. **You add tasks.** In the repository you want work done in, run `/take_order` in Claude Code with a short
   description of what you want built. It designs the feature with you (`grill-with-docs`), splits it into tasks
   (`to_tasks`), decides which tasks must wait for which (`task-determine-deps`), and appends them to that
   repository's task queue once you approve.
2. **Each project's loop decides what to start.** `bun run loop` runs one loop per project. Every poll, a loop reads
   its tasks, lists its PRs with `gh`, and starts agents for what is ready until its cap is reached: PRs that need a
   patch first, then PRs that need a review, then tasks that may start.
3. **A task becomes a PR.** The loop runs `claude -p "/cook <task-id>"` in a fresh git worktree. `cook` creates the
   branch, has `cook_poteto` implement the task, runs the checks, gets an independent verification, and opens the PR.
4. **Every open PR gets reviewed and fixed.** The loop runs `claude -p "/taste_test <pr>"` to review a PR, the
   factory's own included, and `claude -p "/remake <pr>"` to fix conflicts, failing CI or requested changes.
5. **You merge.** Merging a task's PR completes the task, which lets the tasks that waited for it start. In
   hands-off mode they may start earlier, once the PR has passed review.
6. **You watch and steer.** `bun run viz` shows every project, session and task, and lets you set modes, edit
   dependencies, retry, complete or delete tasks, and pause.

Merging is always up to you. The loop never merges.

### Skills

- **Run by the loop:** `cook` (task → PR), `taste_test` (review a PR), `remake` (fix a PR).
- **Run by you:** `take_order` (add tasks), `customize_order` (change a PR's task when a comment asks for it).
- **Deciding dependencies:** `task-pair-check` judges whether one task must wait for another. `task-determine-deps` uses it inside `take_order`, and `task-update-deps` inside `customize_order`.
- **Used inside those:** `cook_poteto` does the actual coding, review and fixing. `to_tasks`, `grill-with-docs`, `interrogate` and the `principle-*` skills are read along the way. The rest of `factory/skills/` are general pstack and Matt Pocock skills you can also run yourself.

### Tasks

Each task in a project's `tasks.json` has an `id`, `title`, `description`, `acceptanceCriteria`, `dependencies` (other task ids) and a `status`. `take_order` also stamps `createdAt`. A task's project is the repository whose queue it is in; it is not stored on the task. The loop owns `status` and moves it `pending` → `in_progress` → `pr` → `completed`. `pr` means the task's PR is open. `completed` means that PR was merged into main (or you marked the task completed by hand) and is final: nothing touches the task again. If the PR is closed without merging, the task stays at `pr` and gets a `needsYou` note. The loop also records `runs`, `skips`, `lastSkipReason` and the task's `pr` (repo, number, url, open). A task may also carry `session` (the id of the `take_order` call that created it; tasks without one are grouped by creation time), `dependencyReasons` (why each dependency exists) and `mode` (`hands-on` or `hands-off`).

**When a task may start.** A task with no dependencies may start as soon as it exists. A task with dependencies waits until each one is met, and each dependency is judged by its own mode:

- **hands-on** (the default): the dependency's PR must be merged into main.
- **hands-off**: it is enough that the dependency's open PR has passed `taste_test` cleanly: the review covers its current commit, CI is passing, it has no merge conflict, and no `/remake` or `/customize_order` comment is waiting. The dependent task is then built on top of the dependency's unmerged branch. If the dependency later gets new commits, the loop runs `/remake` on the dependent PR to bring them in, and reviews it again.

A completed or deleted dependency is always met. The mode is set in `~/.pstack-factory/settings.json` (a missing file means the defaults), or with the switches in the visualizer, most specific level first: the task's own `mode`, then `sessions` (by session id), then `projects` (by repository, `owner/repo`), then `defaultMode`:

```json
{ "defaultMode": "hands-on", "projects": {}, "sessions": { "session-20261119T204500Z": "hands-off" }, "agentCap": 3 }
```

The file is read on every poll, so a change applies from the next start and never stops work already running. When several things are ready the loop finishes before it starts: PRs that need a patch first, then PRs that need a review, then new tasks, oldest first within each.

**Deciding dependencies.** Whether two tasks clash is a judgement, made by a skill; everything around it is code in `factory/deps.ts`, reached through the `factory` command, run in the repository the tasks belong to:

- `factory deps candidates [--for <task-id>]` lists every unfinished task to compare against (never completed or deleted ones), and the mode that decides what to do when in doubt.
- `factory deps set <task-id> '{"<dependency-id>": "<reason>"}'` writes one task's dependencies and their reasons. It refuses unknown or completed tasks and anything that would make two tasks wait for each other.
- `factory deps blockers <task-id>` says what the task is still waiting for.

A PR whose task gained a dependency after it was built (through `/customize_order`) is left alone by the loop until that dependency is met.

Deleting a task removes it for good: the visualizer's server stops its agent, closes its open PR, deletes its branch, erases its audit entries, attempt counts and run transcripts, and removes it from the dependency list of every task that depended on it (`DELETE /api/tasks/<id>`, or `DELETE /api/sessions/<id>` for every task of a session).

A task is ready when it is `pending` and every dependency is met (see "When a task may start" above). `cook` branches from the branches of its dependencies that are not merged yet, when it has any.

Tests are not mandatory for the features the factory builds. `cook` proves each acceptance criterion with one of three proof types: a `test`, a `live` check or a `manual` check. The factory's own code is tested, and those tests run in CI.

### Projects

A project is a GitHub repository: exactly one per repository, named `owner/repo`. Projects are never created or named
by hand. A repository becomes a project the first time `/take_order` runs in it, or when you add it in the visualizer
or with `factory register <path>`.

One factory manages all of them. Its data lives in `~/.pstack-factory/` (set `PSTACK_FACTORY_HOME` to move it),
outside every repository:

```
~/.pstack-factory/
  bin/factory            the command the skills call
  projects.json          the projects: path, what each depends on, paused or not
  settings.json          modes and the agent cap
  projects/<owner>__<repo>/
    tasks.json           that repository's task queue
    audit-log.jsonl      its runs
    pr-attempts.json     its review/patch counts
    loop-state.json      what its loop is doing
    worktrees/           one git worktree per running agent
```

A managed repository receives branches and pull requests and nothing else: no factory file is written inside it.
Each project has its own loop, which touches only its own repository; `bun run loop` runs them all and picks up a
newly added project by itself. Each loop runs up to `agentCap` agents.

**A project can depend on another project.** Set it on the project's heading in the visualizer. While any project it
depends on has an unfinished task, the dependent project starts no new task; reviews and patches of its existing PRs
carry on. This gate always means merged, whatever the modes: one repository only sees what is in another's main. A
dependency that would make two projects wait for each other is refused. Tasks never depend on tasks in another
repository.

Removing a project in the visualizer deletes all of its tasks and stops its loop. The repository itself is not
touched beyond closing those tasks' PRs and deleting their branches.

### The Loop

The loop is a scheduler. Every poll (60 s, and at once whenever an agent finishes) it reads the tasks and the PRs, ranks what is ready, and starts agents until `agentCap` are running (3 by default, set in the visualizer's top bar or in `~/.pstack-factory/settings.json`). It never waits on an agent, so it keeps noticing new tasks and PRs while agents work. The ranking: PRs that need a patch, then PRs that need a review, then ready tasks; within each, the oldest by `createdAt`, and tasks without `createdAt` go last. Two tasks with a dependency between them never run together, because the dependent is not ready until the gate lets it through.

**One worktree per agent.** Each agent runs in its own git worktree in the project's folder under `~/.pstack-factory/`, created from `origin/main` and removed when the run ends, so parallel agents never share a checkout and never touch yours. The repository's installed dependencies (`node_modules`) are linked into it; the skills reach the task queue through the `factory` command. Its transcripts are moved next to the main checkout's when it is removed.

**Tasks.** The loop sets the task to `in_progress` and runs `/cook <id>`.

- A `processed` result moves the task to `pr`.
- A failure (a non-zero exit, or exit 0 with no result report) returns the task to `pending`. In hands-off mode it is tried again, up to 3 attempts in all; after that, and on the first failure in hands-on mode, it is **parked**: it gets a `needsYou` note and is not started again until you clear it (`POST /api/tasks/<id>/retry` on the visualizer's server, or remove `needsYou` and `attempts` from the task). A `skipped` result parks the task at once and records its reason.
- One failure never stops the loop: everything that does not depend on the parked task keeps running.

**Usage limit.** A run that dies on your Claude usage limit counts as no attempt. The loop starts nothing new until the limit resets (30 minutes when the message gives no time), then carries on by itself.

**After a crash.** A task found `in_progress` with no agent goes back to `pending` with no attempt counted; its worktree and, if it has no PR yet, its half-finished branch are discarded.

Each project's loop publishes what is running, any usage-limit pause, and the projects it is waiting on, in `loop-state.json` in its project folder.

**PRs.** `pr-state.ts` decides what each open PR needs. The first matching rule wins:

1. Draft, or labelled `needs-human` → nothing
2. An unanswered `/customize_order` comment → nothing, until you answer the visualizer's `/customize_order <pr>` agent
3. CI failing, merge conflict, changes requested, labelled `changes-requested`, or an unanswered `/remake` comment →
   **patch** (`/remake`)
4. Approved with CI passing → nothing
5. New commits since the last review → **review** (`/taste_test`)
6. Anything else → nothing

**Asking for changes on a PR.** Leave the PR open and comment. Closing a PR means "stop": the loop only works on open
PRs. The factory posts as your GitHub login, so it only acts on comments that start with a command:

- `/remake <what to change>`: the loop runs `/remake` on its next pass. The request is answered once a
  `## Remake summary` comment is posted after it.
- `/customize_order <what to change>`: use this when the change alters the task itself, such as its acceptance
  criteria. The loop leaves the PR alone and the visualizer shows a "Comment asks to change the task" dot. Run
  `/customize_order <pr>` yourself: it confirms the task change with you, updates the task and the PR, and posts a
  `## Customize order summary`. The loop then reviews the PR against the new task.

- PRs that `/cook` opened are reviewed and patched like any other open PR.
- The factory usually authors its own PRs, and GitHub won't let an author request changes. So `/taste_test` adds the
  `changes-requested` label when it finds problems, and `/remake` removes it after pushing a fix. The new commit is
  then reviewed again.
- Every review or patch run counts as an attempt, whether it passes or fails. After `MAX_PR_ATTEMPTS` (3), the loop
  labels the PR `needs-human`, comments once, and stops working on it. Removing the label resets the count, and so
  does each new `/remake` comment or finished `/customize_order`.
- A failed or skipped review or patch is logged, and the loop carries on. A review that exits 0 with a result report
  (processed or skipped) marks that head commit as reviewed, so it isn't reviewed again until new commits arrive. A
  review that fails, including one with no report, leaves the commit unreviewed, so it's retried. Patches don't mark commits.
- A PR's attempt count is dropped once the PR is no longer open.
- If listing PRs fails, the loop logs it and continues with tasks only.

Between polls the loop sleeps `LOOP_IDLE_MS` (60 s), cut short when an agent finishes. On Ctrl-C it starts nothing new and exits once the running agents have finished.

**One factory at a time.** The factory writes its pid to `~/.pstack-factory/loop.lock`. A second `bun run loop` exits at once, naming
the running loop's pid and start time. A lock left by a killed loop is replaced.

**`/customize_order` in the visualizer.** The loop only leaves a PR with an unanswered `/customize_order` comment alone. The
visualizer (`bun run viz`) runs `/customize_order <pr>` itself, once per comment, through the Claude Agent SDK on your
Claude Code login, and you answer its questions in the PR's run page, as option cards (the recommended option first, or
type your own) or in the reply box. If the visualizer is stopped, nothing starts until it runs again, and a run it was
holding resumes where it left off. Its state is kept in `customize-agents.json` in the project's folder.

### Agent Permissions

Each run gets `--allowedTools` from `ALLOWED_TOOLS` in `factory/loop.ts`: `Read`, `Edit`, `Write`, `Glob`, `Grep`,
`Agent` (for the independent verifier subagent), and Bash limited to `git`, `gh`, `bun`, `jq`, `ls`, `cat`, `head`,
`tail`, `wc`, `sed -n`, `echo`, and the read-only helpers `grep`, `sort`, `uniq`, `diff`, `cut`, `tr`, `basename`,
`dirname`, `pwd`, `which`, `file`, `stat` and `realpath`. The factory adds its own `factory` command, which the skills
call to find the task queue, and passes the project's folder with `--add-dir` so the agent can read that queue.

**Per-project commands.** A repository whose checks need another tool (`conda`, `python`, `pytest`, `cargo`) adds it to
its project's `allowedCommands`, stored in `projects.json`. Run `factory commands` in the repository to see the list and
`factory commands set <name>...` to replace it (`factory commands set` with no names clears it). Each name must be a bare
command (matching `/^[A-Za-z0-9._-]+$/`); `sudo`, `sh`, `bash`, `zsh`, `env`, `xargs` and `eval` are refused because they
can run anything else, and `find` and `awk` are left out for the same reason. The supervisor turns each name into
`Bash(<name> *)` and `Bash(<name>)` for that project's agents and reads the list at every agent start, so a change
applies to the next `cook`, `taste_test` or `remake` run without restarting the loop.

### Result Report

Every run uses `--output-format json --json-schema <AGENT_RESULT_SCHEMA>` (`factory/agent-result.ts`). The agent ends
with `{ "outcome": "processed" }` or `{ "outcome": "skipped", "reason": "…" }`. The loop parses that from stdout and
prints the agent's result text, so you can follow the run.

- A non-zero exit is a failure, whatever the report says.
- Exit 0 with a `skipped` report is a skip. A skip without a reason doesn't count as a valid report.
- Exit 0 with no valid report is logged as a failure (`agent returned no result report`), but the loop still trusts
  the exit code.
- The schema has no top-level `anyOf`/`oneOf`/`allOf`, because the Claude API rejects those in a tool schema. The
  "reason when skipped" rule is enforced in code instead.

### Audit Log

Every agent run is appended as one JSON line to `audit-log.jsonl` in its project's folder. Each line holds the action, target
(task id or PR number), title, outcome (`success`, `failure` or `skip`), exit code and duration. PR runs also record
the repo and URL. `failure` and `skip` entries carry a `reason`. The action labels are `dev-task`, `review` and
`patch`; they name what the loop did, not which skill ran.

The log only records agent runs. Runners that crash, attempt limits, flagging failures and idle polls go to the
console only. A failed write to the log is reported but never stops the loop.

### Queue View

`bun run queue` starts a separate, read-only process bound to `127.0.0.1` on `QUEUE_PORT` (default `4040`). It shows
the project of the repository you run it in, and never writes anything.

- `GET /`: an HTML page with running tasks, the ranked queue, and a **History** section showing the latest 100 runs,
  newest first, with a count per outcome. Filter it with `?outcome=success|failure|skip`.
- `GET /api/queue`: the queue as JSON.
- `GET /api/history?outcome=`: `{ rows, total, shown, counts }` as JSON. `counts` always covers the whole log.
- Anything else returns 404.

The PR list is cached for about 10 seconds. If `gh` fails, the page still loads with tasks only and an error banner.
If the audit log can't be read, the history section shows an error and the queue still renders.

### Visualizer

`bun run viz` opens a live view of the factory in your browser. The first run installs and builds the app in `viz/`, which is an adapted version of the visualizer from [disler/super-simple-software-factory](https://github.com/disler/super-simple-software-factory)
(MIT, see `viz/LICENSE`) fed by this factory instead of its own tracer. It reads every project's task queue and audit log from `~/.pstack-factory/`, each repository's PRs through `gh`, and the Claude Code transcripts of the loops' headless runs. The UI polls
every half second.

- **Sessions screen.** One card per `/take_order` order (tasks added together), plus an "Unlinked PRs" card for runs on
  PRs whose branch matches no task. Each card shows broken, running, done or waiting, and "needs you: N". Cards are
  grouped into one section per project (a repository), the most recently active first. A project's heading has its
  mode, a pause for that project's loop, the projects it depends on (add or remove them there), and a button that
  removes the repository from the factory. A field at the top adds a repository by the path of its folder.
- **Waterfall.**
  - One lane per task. Its `cook`, `taste_test`, `remake` and `customize_order` runs are blocks in time order: green worked, red broke
    (including `failed:` skips), amber skipped. A task that hasn't started shows a dashed "waiting on …" block.
  - Ticks inside a block are milestone commands (branch, commit, checks, verifier, push, PR, review). Hover one for
    the command and whether it worked.
  - The top "You" lane has a dot for everything that needs you: loop stopped, `needs-human`, a stuck
    `Verdict: CHANGES`, a task PR ready to review, a comment asking to change the task, a task stranded
    `in_progress`, or a run that has gone quiet or is taking long. Resolved dots stay greyed. Click a
    dot to jump to its block, then click the block to open the PR or the run.
- **Run panel.** Click a block to see the task, a result checklist (exit code, report, task status, PR, CI), the
  milestones, token usage and the agent's live feed. **Take over in Claude Code** opens Terminal running
  `claude --resume` on that run. While the run is still going, that's a forked copy, and typing there doesn't reach
  the running agent.
- **Top bar.** Shows whether `bun run loop` is running, how many agents are running out of how many are allowed
  (change the cap there), the factory's default mode, and a pause button: paused, the loop starts nothing new and
  running agents finish. A usage-limit pause shows there with the time it resumes.
- **Modes.** A hands-on / hands-off switch sits on each level: the top bar (factory default), a project's heading,
  a session's card and a task's row. A level that sets its own mode says what it overrides and has a reset that
  makes it inherit again.
- **Sessions.** The × on a session card deletes the session and every task in it, after a confirmation that lists
  what will be stopped, closed and erased. A session whose tasks are all completed moves into a collapsed
  "Completed" group at the bottom of its project.
- **Tasks.** The session page has a row per task: its state, its mode, each dependency with the reason it exists and
  what it is still waiting for, and buttons to retry a parked task, mark a task completed, delete it, and add or
  remove a dependency. A dependency that would make two tasks wait for each other is refused. Completed tasks are
  greyed out and stay for their history.

It writes to the factory's files only through those controls (the projects' task queues, the project list and the settings, all under `~/.pstack-factory/`). Its
other writes are `needs-history.jsonl` in each project's folder, its own record of stuck tasks,
and the Terminal window that Take over opens. The first Take over makes macOS ask you to allow controlling Terminal.

### CI

GitHub Actions run on every PR, and on pushes to `main` for CI and secret-scan:

- **CI** (`ci.yml`): `bun install --frozen-lockfile`, the same again in `viz/` (`bun test` also runs `viz/server`'s
  tests), lint, typecheck, `bun test`.
- **pr-title-lint**: PR titles must be Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, …).
  `cook` titles its PRs `<type>: <task title>`.
- **secret-scan**: gitleaks over the commit range.
