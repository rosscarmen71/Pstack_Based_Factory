# Pstack Based Factory

A small software factory that relies heavily on [pstack skills](https://github.com/cursor/plugins/tree/main/pstack).
A loop picks up tasks, has Claude Code turn each one into a pull request, and reviews or fixes other open PRs.

> Also uses some of [Matt Pocock's skills](https://github.com/mattpocock/skills/tree/main), such as `grilling`,
> `grill_me`, `grill-with-docs` and `domain-modeling`.

> The factory layout and loop code are adapted from the
> [app-vitals how-to-factory repo](https://github.com/app-vitals/how-to-factory/tree/main).

## How it works

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

## Layout

```
.claude/skills -> ../factory/skills   symlink; how Claude Code finds the skills
factory/
  loop.ts            the loop: picks work, runs the agent, tracks status
  candidates.ts      ranks ready tasks and PRs that need work, oldest first
  pr-state.ts        decides whether a PR needs review, patch or nothing
  prs.ts             lists open PRs through `gh pr list`
  pr-attempts.ts     counts review/patch attempts per PR, flags stuck PRs
  agent-result.ts    the result report schema and its parser
  audit-log.ts       append-only log of every agent run
  tasks.schema.ts    the task shape and its validation
  tasks.store.ts     reads and writes factory/tasks.json
  queue-server.ts    the read-only queue and history web view
  queue-view.ts, history-view.ts, pr-link.ts   HTML rendering for the view
  *.test.ts          tests, next to the file they test
  skills.test.ts     checks that cook, taste_test and remake keep the result contract
  skills/            every skill (see below)
  tasks.json         the task queue
  audit-log.jsonl    run history (gitignored, created on first run)
  pr-attempts.json   attempt counts (gitignored, created on first run)
```

### Skills

- **Run by the loop:** `cook` (task → PR), `taste_test` (review a PR), `remake` (fix a PR).
- **Run by you:** `take_order` (add tasks).
- **Used inside those:** `cook_poteto` does the actual coding, review and fixing. `to_tasks`, `grill-with-docs`,
  `interrogate` and the `principle-*` skills are read along the way. The rest of `factory/skills/` are general pstack
  and Matt Pocock skills you can also run yourself.

## Prerequisites

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com), signed in with `gh auth login`. The loop lists, labels and comments on PRs.
- The Claude Code CLI (`npm install -g @anthropic-ai/claude-code`), on the `PATH` of the shell that runs the loop.

Then install dependencies:

```bash
bun install
```

## Commands

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

## Tasks

Each task in `factory/tasks.json` has an `id`, `title`, `description`, `acceptanceCriteria`, `dependencies` (other
task ids) and a `status`. `take_order` also stamps `createdAt`. The loop owns `status` and moves it
`pending` → `in_progress` → `pr`, where `pr` means the task's PR is open and is final. The loop also records `runs`,
`skips`, `lastSkipReason` and the task's `pr` (repo, number, url, open).

A task is ready when it is `pending` and every dependency has reached `pr`. The PR doesn't have to be merged.
`cook` branches from its dependencies' branches when it has any.

Tests are not mandatory for the features the factory builds. `cook` proves each acceptance criterion with one of
three proof types: a `test`, a `live` check or a `manual` check. The factory's own code is tested, and those tests run
in CI.

## The loop

Each turn, the loop takes the single oldest candidate across ready tasks and PRs that need work, by `createdAt`.
Tasks without `createdAt` go last.

**Tasks.** The loop sets the task to `in_progress` and runs `/cook <id>`.

- A `processed` result moves the task to `pr`.
- A failure (non-zero exit) or a `skipped` result returns the task to `pending` and **stops the loop**. A skip
  records its reason on the task.

**PRs.** `pr-state.ts` decides what each open PR needs. The first matching rule wins:

1. Draft, or labelled `needs-human` → nothing
2. CI failing, merge conflict, changes requested, or labelled `changes-requested` → **patch** (`/remake`)
3. Approved with CI passing → nothing
4. New commits since the last review → **review** (`/taste_test`)
5. Anything else → nothing

- PRs that `/cook` opened are reviewed and patched like any other open PR.
- The factory usually authors its own PRs, and GitHub won't let an author request changes. So `/taste_test` adds the
  `changes-requested` label when it finds problems, and `/remake` removes it after pushing a fix. The new commit is
  then reviewed again.
- Every review or patch run counts as an attempt, whether it passes or fails. After `MAX_PR_ATTEMPTS` (3), the loop
  labels the PR `needs-human`, comments once, and stops working on it. Removing the label resets the count.
- A failed or skipped review or patch is logged, and the loop carries on. A review that exits 0 (processed or
  skipped) marks that head commit as reviewed, so it isn't reviewed again until new commits arrive. A review that
  fails leaves the commit unreviewed, so it's retried. Patches don't mark commits.
- A PR's attempt count is dropped once the PR is no longer open.
- If listing PRs fails, the loop logs it and continues with tasks only.

When there's nothing to do, the loop sleeps `LOOP_IDLE_MS` (60 s) and checks again.

### Agent permissions

Each run gets `--allowedTools` from `ALLOWED_TOOLS` in `factory/loop.ts`: `Read`, `Edit`, `Write`, `Glob`, `Grep`,
`Agent` (for the independent verifier subagent), and Bash limited to `git`, `gh`, `bun`, `jq`, `ls`, `cat`, `head`,
`tail`, `wc`, `sed -n` and `echo`.

### Result report

Every run uses `--output-format json --json-schema <AGENT_RESULT_SCHEMA>` (`factory/agent-result.ts`). The agent ends
with `{ "outcome": "processed" }` or `{ "outcome": "skipped", "reason": "…" }`. The loop parses that from stdout and
prints the agent's result text, so you can follow the run.

- A non-zero exit is a failure, whatever the report says.
- Exit 0 with a `skipped` report is a skip. A skip without a reason doesn't count as a valid report.
- Exit 0 with no valid report is logged as a failure (`agent returned no result report`), but the loop still trusts
  the exit code.
- The schema has no top-level `anyOf`/`oneOf`/`allOf`, because the Claude API rejects those in a tool schema. The
  "reason when skipped" rule is enforced in code instead.

## Audit log

Every agent run is appended as one JSON line to `factory/audit-log.jsonl`. Each line holds the action, target
(task id or PR number), title, outcome (`success`, `failure` or `skip`), exit code and duration. PR runs also record
the repo and URL. `failure` and `skip` entries carry a `reason`. The action labels are `dev-task`, `review` and
`patch`; they name what the loop did, not which skill ran.

The log only records agent runs. Runners that crash, attempt limits, flagging failures and idle polls go to the
console only. A failed write to the log is reported but never stops the loop.

## Queue view

`bun run queue` starts a separate, read-only process bound to `127.0.0.1` on `QUEUE_PORT` (default `4040`). It never
writes anything.

- `GET /`: an HTML page with running tasks, the ranked queue, and a **History** section showing the latest 100 runs,
  newest first, with a count per outcome. Filter it with `?outcome=success|failure|skip`.
- `GET /api/queue`: the queue as JSON.
- `GET /api/history?outcome=`: `{ rows, total, shown, counts }` as JSON. `counts` always covers the whole log.
- Anything else returns 404.

The PR list is cached for about 10 seconds. If `gh` fails, the page still loads with tasks only and an error banner.
If the audit log can't be read, the history section shows an error and the queue still renders.

## Visualizer

`bun run viz` opens a live view of the factory in your browser. The first run installs and builds the app in `viz/`,
which is the visualizer from [disler/super-simple-software-factory](https://github.com/disler/super-simple-software-factory)
(MIT, see `viz/LICENSE`) fed by this factory instead of its own tracer. It reads `factory/tasks.json`,
`factory/audit-log.jsonl`, GitHub through `gh`, and the Claude Code transcripts of the loop's headless runs. The UI polls
every half second.

- **Sessions screen.** One card per `/take_order` order (tasks added together), plus an "Unlinked PRs" card for runs on
  PRs whose branch matches no task. Each card shows broken, running, done or waiting, and "needs you: N".
- **Waterfall.**
  - One lane per task. Its `cook`, `taste_test` and `remake` runs are blocks in time order: green worked, red broke
    (including `failed:` skips), amber skipped. A task that hasn't started shows a dashed "waiting on …" block.
  - Ticks inside a block are milestone commands (branch, commit, checks, verifier, push, PR, review). Hover one for
    the command and whether it worked.
  - The top "You" lane has a dot for everything that needs you: loop stopped, `needs-human`, a stuck
    `Verdict: CHANGES`, a task PR ready to review, or a task stuck `in_progress`. Resolved dots stay greyed. Click a
    dot to jump to its block, then click the block to open the PR or the run.
- **Run panel.** Click a block to see the task, a result checklist (exit code, report, task status, PR, CI), the
  milestones, token usage and the agent's live feed. **Take over in Claude Code** opens Terminal running
  `claude --resume` on that run. While the run is still going, that's a forked copy, and typing there doesn't reach
  the running agent.
- **Top bar.** Shows whether `bun run loop` is running.

It never writes to the factory's files. Its only writes are `viz/.needs-history.jsonl`, its own record of stuck tasks,
and the Terminal window that Take over opens. The first Take over makes macOS ask you to allow controlling Terminal.

## CI

GitHub Actions run on every PR, and on pushes to `main` for CI and secret-scan:

- **CI** (`ci.yml`): `bun install --frozen-lockfile`, lint, typecheck, `bun test`.
- **pr-title-lint**: PR titles must be Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, …).
  `cook` titles its PRs `<type>: <task title>`.
- **secret-scan**: gitleaks over the commit range.
