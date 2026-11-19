# Pstack Based Factory

A small software factory that relies heavily on [pstack skills](https://github.com/cursor/plugins/tree/main/pstack). A loop picks up tasks, has Claude Code turn each one into a pull request, and reviews or fixes other open PRs.

> Also uses some of [Matt Pocock's skills](https://github.com/mattpocock/skills/tree/main), such as `grilling`, `grill_me`, `grill-with-docs` and `domain-modeling`.

> The factory layout and loop code are adapted from the
> [app-vitals how-to-factory repo](https://github.com/app-vitals/how-to-factory/tree/main).

> The factory visuals are adapted from the
> [disler super-simple-software-factory repo](https://github.com/disler/super-simple-software-factory/tree/example)

### Table of Contents
* [What Is The **Pstack_Based_Factory**?](#what-is-the-pstack_based_factory)
* [How To **Setup** The Factory?](#setup)
* [How To **Use** The Factory?](#usage)
* [How Does It Work?](#how-it-works)

> For more info see [`docs`](docs/README.md)

## What Is The Pstack_Based_Factory?

A loop that turns tasks into pull requests. You add tasks with `/take_order`; the loop picks the oldest ready one,
runs `/cook` to branch, implement and verify it, and opens a PR. It also reviews and fixes other open PRs with
`/taste_test` and `/remake`. The work is done by pstack-style skills in `factory/skills/`, run through the Claude Code
CLI. Merging is always yours; the loop never merges. Watch it with the read-only queue view (`bun run queue`) or the
live visualizer (`bun run viz`).

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

4) Give the loop something to do. Run `/take_order` in Claude Code to design a feature and append its tasks, or start
   from an empty queue:
```shell
echo '[]' > factory/tasks.json
```

5) Start the loop:
```shell
bun run loop
```

6) In another terminal, open the visualizer to watch it work:
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
| `bun run loop` | Start the factory loop (`factory/loop.ts`). Stop it with Ctrl+C. |
| `bun run queue` | Read-only queue and history view on http://127.0.0.1:4040 |
| `bun run viz` | The factory visualizer on http://127.0.0.1:4600 (see below). Never starts the loop. |
| `bun run lint` | Biome lint (no formatter) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | The factory's own tests |

`factory/tasks.json` must exist before the loop or the queue view starts. `take_order` creates it, or you can start
from `[]`.

## How It Works

**Table of contents:**
- [General Workflow](#general-workflow)
- [Skills](#skills)
- [Tasks](#tasks)
- [The Loop](#the-loop)
- [Agent Permissions](#agent-permissions)
- [Result Report](#result-report)
- [Audit Log](#audit-log)
- [Queue View](#queue-view)
- [Visualizer](#visualizer)
- [CI](#ci)

## General Workflow

1. **You add tasks.** Run `/take_order` in Claude Code with a short description of what you want built. It designs
   the feature with you (`grill-with-docs`), splits it into tasks (`to_tasks`), and appends them to
   `factory/tasks.json` once you approve.
2. **The loop picks the next thing to do.** `bun run loop` starts `factory/loop.ts`. Each turn it reads the tasks,
   lists open PRs with `gh`, and picks the single oldest candidate.
3. **A task becomes a PR.** The loop runs `claude -p "/cook <task-id>"`. `cook` creates the branch, has
   `cook_poteto` implement the task, runs the checks, gets an independent verification, and opens the PR.
4. **Other PRs get reviewed or fixed.** For an open PR that isn't one of the factory's own task PRs, the loop runs
   `claude -p "/taste_test <pr>"` to review it, or `claude -p "/remake <pr>"` to fix conflicts, failing CI or
   requested changes.
5. **You watch.** `bun run queue` serves a read-only page with what's running, what's next and what already ran.

Merging is always up to you. The loop never merges.

### Skills

- **Run by the loop:** `cook` (task → PR), `taste_test` (review a PR), `remake` (fix a PR).
- **Run by you:** `take_order` (add tasks), `customize_order` (change a PR's task when a comment asks for it).
- **Used inside those:** `cook_poteto` does the actual coding, review and fixing. `to_tasks`, `grill-with-docs`, `interrogate` and the `principle-*` skills are read along the way. The rest of `factory/skills/` are general pstack and Matt Pocock skills you can also run yourself.

### Tasks

Each task in `factory/tasks.json` has an `id`, `title`, `description`, `acceptanceCriteria`, `dependencies` (other task ids) and a `status`. `take_order` also stamps `createdAt` and a `project`: the name of the order the task belongs to, which groups orders in the visualizer (see below). `take_order` asks you for it when you add the order, and you can change it later from the visualizer. The loop owns `status` and moves it `pending` → `in_progress` → `pr`, where `pr` means the task's PR is open and is final. The loop also records `runs`, `skips`, `lastSkipReason` and the task's `pr` (repo, number, url, open).

A task is ready when it is `pending` and every dependency has reached `pr`. The PR doesn't have to be merged. `cook` branches from its dependencies' branches when it has any.

Tests are not mandatory for the features the factory builds. `cook` proves each acceptance criterion with one of three proof types: a `test`, a `live` check or a `manual` check. The factory's own code is tested, and those tests run in CI.

### The Loop

Each turn, the loop takes the single oldest candidate across ready tasks and PRs that need work, by `createdAt`. Tasks without `createdAt` go last.

**Tasks.** The loop sets the task to `in_progress` and runs `/cook <id>`.

- A `processed` result moves the task to `pr`.
- A failure (a non-zero exit, or exit 0 with no result report) or a `skipped` result returns the task to
  `pending` and **stops the loop**. A skip records its reason on the task.

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

When there's nothing to do, the loop sleeps `LOOP_IDLE_MS` (60 s) and checks again.

**One loop at a time.** The loop writes its pid to `factory/loop.lock`. A second `bun run loop` exits at once, naming
the running loop's pid and start time. A lock left by a killed loop is replaced.

**`/customize_order` in the visualizer.** The loop only leaves a PR with an unanswered `/customize_order` comment alone. The
visualizer (`bun run viz`) runs `/customize_order <pr>` itself, once per comment, through the Claude Agent SDK on your
Claude Code login, and you answer its questions in the PR's run page, as option cards (the recommended option first, or
type your own) or in the reply box. If the visualizer is stopped, nothing starts until it runs again, and a run it was
holding resumes where it left off. Its state is kept in `viz/.customize-agents.json`.

### Agent Permissions

Each run gets `--allowedTools` from `ALLOWED_TOOLS` in `factory/loop.ts`: `Read`, `Edit`, `Write`, `Glob`, `Grep`,
`Agent` (for the independent verifier subagent), and Bash limited to `git`, `gh`, `bun`, `jq`, `ls`, `cat`, `head`,
`tail`, `wc`, `sed -n` and `echo`.

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

Every agent run is appended as one JSON line to `factory/audit-log.jsonl`. Each line holds the action, target
(task id or PR number), title, outcome (`success`, `failure` or `skip`), exit code and duration. PR runs also record
the repo and URL. `failure` and `skip` entries carry a `reason`. The action labels are `dev-task`, `review` and
`patch`; they name what the loop did, not which skill ran.

The log only records agent runs. Runners that crash, attempt limits, flagging failures and idle polls go to the
console only. A failed write to the log is reported but never stops the loop.

### Queue View

`bun run queue` starts a separate, read-only process bound to `127.0.0.1` on `QUEUE_PORT` (default `4040`). It never
writes anything.

- `GET /`: an HTML page with running tasks, the ranked queue, and a **History** section showing the latest 100 runs,
  newest first, with a count per outcome. Filter it with `?outcome=success|failure|skip`.
- `GET /api/queue`: the queue as JSON.
- `GET /api/history?outcome=`: `{ rows, total, shown, counts }` as JSON. `counts` always covers the whole log.
- Anything else returns 404.

The PR list is cached for about 10 seconds. If `gh` fails, the page still loads with tasks only and an error banner.
If the audit log can't be read, the history section shows an error and the queue still renders.

### Visualizer

`bun run viz` opens a live view of the factory in your browser. The first run installs and builds the app in `viz/`, which is an adapted version of the visualizer from [disler/super-simple-software-factory](https://github.com/disler/super-simple-software-factory)
(MIT, see `viz/LICENSE`) fed by this factory instead of its own tracer. It reads `factory/tasks.json`,
`factory/audit-log.jsonl`, GitHub through `gh`, and the Claude Code transcripts of the loop's headless runs. The UI polls
every half second.

- **Sessions screen.** One card per `/take_order` order (tasks added together), plus an "Unlinked PRs" card for runs on
  PRs whose branch matches no task. Each card shows broken, running, done or waiting, and "needs you: N". Cards are
  grouped into sections by `project`, the most recently started project first and "No project" last. Each card has a
  select to move its order to another project (or out of one); the choice is written to the `project` field of every
  task in that order.
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
- **Top bar.** Shows whether `bun run loop` is running.

It never writes to the factory's files. Its only writes are `viz/.needs-history.jsonl`, its own record of stuck tasks,
and the Terminal window that Take over opens. The first Take over makes macOS ask you to allow controlling Terminal.

### CI

GitHub Actions run on every PR, and on pushes to `main` for CI and secret-scan:

- **CI** (`ci.yml`): `bun install --frozen-lockfile`, the same again in `viz/` (`bun test` also runs `viz/server`'s
  tests), lint, typecheck, `bun test`.
- **pr-title-lint**: PR titles must be Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, …).
  `cook` titles its PRs `<type>: <task title>`.
- **secret-scan**: gitleaks over the commit range.
