---
name: taste_test
description: Review one open pull request through cook_poteto and post a single review - approve when clean, request changes with proven findings otherwise
---

# Taste test

Reviews one open PR and posts one review on it. The input is a PR number. The output is a posted review (approve or
request changes) and its URL.

Taste test owns the factory contract: every `gh` call, the verdict, the one review and the result. The review work is
done by **cook_poteto**. Other skills named here sit beside this one, at `../<name>/SKILL.md` from this skill's folder.
Load each by reading that file with the Read tool; do not use the Skill tool for them.

## Steps

1. **Load the PR.** Read it with `gh pr view <pr>` and `gh pr diff <pr>`. Stop and report if it does not exist or is
   not open. Check it out with `gh pr checkout <pr>` so the review runs against the real code. Run `git fetch origin`
   and note the base branch, the head SHA and the merge base (`git merge-base origin/<base> <head-sha>`).
2. **Find the task.** If the head branch is `<type>/<task-id>` and that id exists in `factory/tasks.json`, load the
   task. Otherwise the review has no criteria to check.
3. **Review through cook_poteto.** Read `../cook_poteto/SKILL.md` and follow it with this brief. Its rules apply only
   while it runs; when it returns, continue here under this skill's rules. The brief:
   - The PR number, base branch, head SHA, merge base and diff range `<merge-base>..<head-sha>`. The PR branch is
     checked out.
   - The task's `title`, `description` and `acceptanceCriteria`, or "no matching task".
   - The job: review this change. It is read-only: change no file and commit nothing. GitHub is not yours; everything
     you need is here.
   - Check each acceptance criterion against the diff and name the code or test that meets it.
   - Try to break the change with the **interrogate** skill. Keep only findings a run proves.
   - Find what it could break beyond the diff with the **blast-radius** skill, and prove the one fact it is safe
     because of.
   - List changes outside the task's description, or that it calls out of scope, as risks with file and line.
   - Return a **findings report**:
     - `criteria`: `[{criterion, verdict: met | unmet | unverifiable, evidence}]`
     - `findings`: `[{title, file, line, command, output, expected, foundBy}]`, verified findings only
     - `safetyFact`: `{fact, proofLevel, proof}`, with `proof` set to `unproven` when it is
     - `risks`: `[{risk, file, line, how to check}]`
     - `cleared`: what was checked and is fine

   If it returns no findings report, post no review and end the run as a failure.
4. **Decide the verdict.** Request changes when `findings` has an entry or a criterion is `unmet`. Otherwise approve.
   Never change, soften or reword a finding or a criterion verdict.
5. **Post one review.** Write the body to a file outside the repo with the Write tool and run
   `gh pr review <pr> --body-file <file>` exactly once, with `--approve` or `--request-changes`. Never build the body
   inline in the shell. The body:
   - **Blocking**: each finding (title, file and line, the command, its output, the output the intent requires), then
     each `unmet` criterion with its evidence.
   - **Notes** (non-blocking): `unverifiable` criteria, `risks`, and the safety fact with its proof level or
     `unproven`.

   GitHub rejects `--approve` and `--request-changes` on your own PR ("Can not approve your own pull request"), which
   happens when the reviewer and the PR author share a `gh` login. Then post the same body with `--comment`, and start
   it with a `Verdict: APPROVE` or `Verdict: CHANGES` line. Report the review URL.
6. **Set the label.** The loop reads the `changes-requested` label, not the review, because a `--comment` review
   carries no verdict GitHub can see. After posting:
   - Request changes: run `gh label create changes-requested --force --description "Factory review found problems"`,
     then `gh pr edit <pr> --add-label changes-requested`.
   - Approve: if the PR has the label, run `gh pr edit <pr> --remove-label changes-requested`.

## Rules

- Never edit code, never push, never merge.
- Post exactly one review per run; do not add separate comments. The label in step 6 is not a comment.
- Do not edit `factory/tasks.json`; `status` is moved by the loop.
- Exit non-zero if no review was posted; the loop reads exit 0 as "reviewed".
- The session starts in the repo root, so `cd` is not needed.
- Prefer one command per Bash call; avoid chaining with `&&`, `;` or pipes unless every part is a read-only helper.

## Result

End the run with the structured result. Pick one outcome:

- `processed`: the review was posted.
- `skipped`: you deliberately did nothing, for example the PR is closed or merged, or this head commit is already
  reviewed. Give a one-sentence reason.

A failure is not a skip: exit non-zero as the rules above say.
