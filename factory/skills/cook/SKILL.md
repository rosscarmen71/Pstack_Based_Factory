---
name: cook
description: Take one task from the task queue and deliver it as one verified pull request - branch, cook_poteto implementation, CI checks, independent verification, PR
---

# Cook

Takes one task and produces one pull request. The input is a task `id` from the task queue (or the task object
itself). The output is an open PR and its URL.

Cook owns the factory contract: the branch, the checks, the verification and the PR. The coding is done by
**cook_poteto**. Other skills named here sit beside this one, at `../<name>/SKILL.md` from this skill's folder. Load
each by reading that file with the Read tool; do not use the Skill tool for them.

**The task queue** is this repository's `tasks.json`. It is kept in the factory's home, not in the repository. Get its
path by running `~/.pstack-factory/bin/factory tasks-file` in the repository (or in a worktree of it), and use that
path wherever this skill says "the task queue".

## Steps

1. **Load the task.** Read the task from the task queue by `id`. Stop and report if it does not exist. The loop
   only starts a task once every dependency is met: its task is `completed` (merged into main) or deleted, or, for a
   hands-off dependency, its open PR has passed taste_test.
2. **Create a branch.** Run `git fetch origin`. Start from the up-to-date base branch (`origin/main`). If the task has
   dependencies, read each one's `status` in the task queue. A dependency that is `completed`, or no longer in
   the file, is already in `origin/main`: do nothing for it. Any other dependency's code lives on its unmerged branch
   (`origin/<type>/<dependency-id>`): branch from that branch instead of main, and with several unmerged
   dependencies merge the others in. The PR still targets main. If that merge conflicts, resolve it
   when the fix is clear; otherwise stop and end the run as `skipped` with the conflicting files as the reason. Create
   `<type>/<task-id>`, where `type` is the Conventional Commit type that fits the task (`feat`, `fix`, `refactor`,
   `docs`, `chore`). Never work on the base branch directly. Note the commit the branch starts from (after any
   dependency merges) as `<start-sha>`.
3. **Implement the task.** Read `../cook_poteto/SKILL.md` and follow it with the task object as input. It works on
   the branch you created, commits its work, and never pushes or opens a PR. Its rules apply only while it runs; when
   it returns, continue here under this skill's rules. It returns a **handoff report**:
   - `status`: `implemented`, `already-done`, or `blocked` with a reason.
   - For each acceptance criterion: its proof type and the evidence. `test`: the test name. `live`: the command or
     journey and its output. `measure`: the baseline and the after number. `manual`: the check a person can do.
   - Each `test: update <what> in <task title>` commit, with its reason.
   - Choices it made on its own.

   On `already-done`, end the run as `skipped` with the reason. On `blocked`, end the run as `skipped` with the reason.
4. **Discover CI's checks.** Read the project's CI config (`.github/workflows/*`) and list every command CI runs on a
   pull request. Take the list from the config as it is now; do not rely on a remembered or hardcoded list. Skip jobs
   that do not run on PRs.
5. **Verify locally.** Run every command from step 4 locally, one per Bash call, and record each command's exit
   status and a short output excerpt. If step 4 found no CI, run the repo's own test, typecheck and lint scripts
   instead, and say so in the PR.
   - A check fails because of your change: hand the command and its output back to **cook_poteto** to fix the root
     cause, then rerun every check. Never skip or weaken a check, or the test or config it runs, to get green.
   - A check fails in a way that may be flaky: rerun it once. If it passes, record it as flaky with both outputs. If
     it fails again, treat it as a real failure.
   - A check already fails on the base branch: confirm it there and record it in one line.

   Then walk each acceptance criterion against the handoff report and confirm it has evidence of its proof type:
   `test` names a test that ran above, `live` gives a command and its output, `measure` gives a baseline and an after
   number, `manual` names the check. If you already know a criterion cannot be met, stop and end the run as `skipped`
   with `failed:` and the criterion as the reason, instead of opening the PR. A criterion the step 6 verifier later
   marks `fail` is handled in step 6, not here.
6. **Verify independently.** Make sure all work is committed (`git status` is clean), then launch a fresh subagent
   with the Agent tool. Give it only: the task's acceptance criteria with their proof types, the branch, the base
   branch, `<start-sha>`, the absolute paths of `../principle-prove-it-works/SKILL.md` and
   `../principle-test-behavior-not-implementation/SKILL.md`, and the instructions in this step. Never give it your
   reasoning, the handoff report, a summary of the work, or any claim that a criterion is met. Tell it to read both
   principle files first, to be skeptical, and to prefer `fail` or `unverifiable` over guessing. For each criterion it
   checks the proof type:
   - `test`: the test exists, asserts the behavior, and passes when run.
   - `live`: run it. If the repo has a `verify-<app>` skill, drive the app with it.
   - `measure`: rerun the measurement and compare to the baseline.
   - `manual`: read the file or config the check names.

   It also runs `git diff <start-sha> -- <test files and check config>` and judges the test changes `clean` or
   `weakened`. Check config means the test runner, lint, typecheck and CI config, and the package scripts that run
   them. New tests are expected. A change to an existing test or check is weakening when it:
   - deletes, loosens or comments out an assertion
   - adds `skip`, `only`, `todo` or an early return
   - widens an expected value to match new output
   - mocks out the behavior under test
   - raises a timeout or lowers a threshold
   - edits a check's config to make it pass

   A change to an existing test is allowed only in its own `test: update <what> in <task title>` commit that gives the
   reason, only when the task changes the behavior the test checks or the test was tied to internals the task
   replaced, and only if the updated test still fails when the behavior it covers breaks.

   It returns one verdict per criterion (`pass`, `fail` or `unverifiable`) and one for test changes (`clean` or
   `weakened`), each with evidence: the command and an output excerpt, the test name, or the file and line. Keep the
   report as written; you may not change, soften or reword a verdict.

   On any `fail` or `weakened`: hand the report back to **cook_poteto** to fix the code (never the tests; revert a
   weakening change), commit the fix as `fix: <what> in <task title>` (code files only), rerun step 5, and launch a
   new verifier the same way. Retry at most 2 times. After that, open the PR anyway with each failing verdict clearly
   marked.
7. **Create the PR.** Push the branch and open a PR against the base branch, titled `<type>: <task title>`. Keep the body under 40 lines, with these `##` headings in order, dropping empty ones:
   - `Why`: the task's goal, from cook_poteto's restatement.
   - `What changed`: a short summary.
   - `Scope`: what the task's description puts out of scope, and anything left out on purpose.
   - `Tradeoffs`: only rejected alternatives a reviewer would ask about, from the handoff report's choices.
   - `Blast Radius`: what else the change could affect.
   - `Verification`, with three parts:
     - **Acceptance criteria**: a checklist from the step 6 report as written. Each item carries its proof type,
       verdict and evidence. A `fail` or `unverifiable` item is marked as such, never checked off. A `manual` item
       names the check that shows it is met.
     - **Local verification**: one row per check from step 5 (command, result, note), with every failed, flaky,
       not-run or already-failing check called out under the table.
     - **Test changes**: the test-changes verdict, then `none` or each `test: update` commit with its reason.
   - **Acceptance criteria**: a checklist built from the step 6 report as written. Each item carries its proof type,
     the verifier's verdict and evidence. A `fail` or `unverifiable` item is marked as such, never checked off. A
     `manual` item says it is untested and names the check that shows it is met.
   - **Local verification**: a table with one row per check from step 5, with columns command, result (`pass`,
     `fail`, `flaky` or `not run`) and note. Under the table, call out plainly every check that failed, was flaky, was
     not run, or already fails on the base branch, with the reason. Never mark a check `pass` unless you ran it and it
     exited 0. If a check fails and cannot be fixed, still open the PR and say so at the top of the body.
   - **Test changes**: the verifier's test-changes verdict, then `none` or each `test: update` commit with its reason.
   - **Choices made**: the choices from the handoff report, one line each.

Put full logs and long tables in a PR comment and link to it from the body. If a check fails and cannot be fixed, say so at the top of the body. Report the PR URL.

## Rules

- One task, one branch, one PR.
- The coding is cook_poteto's. When a check or verdict fails, hand it back to cook_poteto; do not write the fix under
  this skill's rules.
- The verdicts come from the fresh subagent, not from you; never change one.
- Stage specific files, never everything; do not commit unrelated changes.
- Do not edit the task queue; tasks are added by the take_order skill and `status` is moved by the loop.
- An unfixable check failure still opens the PR, marked failing locally. A criterion you know cannot be met before
  verification stops the run with no PR; a criterion the step 6 verifier still marks `fail` after the retries opens
  the PR with that criterion marked failing.
- The loop reads exit 0 with `processed` as "PR open". You cannot set the exit code yourself, so whenever the run ends
  without an open PR, end with `skipped` and a reason, starting the reason with `failed:` when something went wrong.
  Never report `processed` without an open PR.
- Edit files with the Edit and Write tools, never via `python3`, heredocs or `sed -i`.
- The session starts in the repo root, so `cd` is not needed.
- Prefer one command per Bash call; avoid chaining with `&&`, `;` or pipes unless every part is a read-only helper.

## Result

End the run with the structured result. Pick one outcome:

- `processed`: the PR was opened.
- `skipped`: no PR was opened. Give a one-sentence reason. Start it with `failed:` when the run tried and could not
  finish (a criterion that cannot be met, an unresolvable merge conflict, a blocked task); otherwise give the reason
  as is (the task is already done, or its PR is already open or merged).
