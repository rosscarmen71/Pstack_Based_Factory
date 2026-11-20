# How the Pstack Based Factory works

This document explains how the factory decides what to run, when, and in what order. For setup and commands, see the
[root README](../README.md). The diagrams render on GitHub.

- [The big picture](#the-big-picture)
- [Words used here](#words-used-here)
- [Where everything lives](#where-everything-lives)
- [From an idea to a merged pull request](#from-an-idea-to-a-merged-pull-request)
- [The life of a task](#the-life-of-a-task)
- [When a task may start](#when-a-task-may-start)
- [Hands-on and hands-off](#hands-on-and-hands-off)
- [How dependencies are decided](#how-dependencies-are-decided)
- [The loop: a scheduler that never waits](#the-loop-a-scheduler-that-never-waits)
- [What happens to a pull request](#what-happens-to-a-pull-request)
- [Stacked tasks](#stacked-tasks)
- [When things go wrong](#when-things-go-wrong)
- [Projects and project dependencies](#projects-and-project-dependencies)
- [Changing a task after its PR is open](#changing-a-task-after-its-pr-is-open)
- [Deleting and completing](#deleting-and-completing)
- [What is code and what is a skill](#what-is-code-and-what-is-a-skill)
- [The visualizer](#the-visualizer)
- [Module map](#module-map)
- [Known limits](#known-limits)

## The big picture

You describe what you want. The factory splits it into tasks, turns each task into a pull request, reviews it, and
fixes what the review finds. You merge. Nothing merges without you.

```mermaid
flowchart LR
    you(["You"])
    order["/take_order<br/>design, split, decide dependencies"]
    queue[("Task queue<br/>one per repository")]
    loop{{"Loop<br/>one per repository"}}
    cook["/cook<br/>task to pull request"]
    review["/taste_test<br/>review a pull request"]
    fix["/remake<br/>fix a pull request"]
    pr["Pull request on GitHub"]
    main[("main")]

    you -->|"describe a feature"| order
    order -->|"append tasks"| queue
    queue --> loop
    loop -->|"task may start"| cook
    loop -->|"PR needs a review"| review
    loop -->|"PR needs a fix"| fix
    cook -->|"opens"| pr
    review -->|"approves or requests changes"| pr
    fix -->|"pushes commits"| pr
    pr -->|"you merge"| main
    main -.->|"task becomes completed,<br/>tasks waiting on it may start"| queue
```

Three things make this more than a loop over a list:

- **Order.** A task that depends on another runs after it, never beside it. Tasks with no dependency between them
  run at the same time.
- **Trust.** You choose, per task, session, project or for the whole factory, whether a dependent task waits for your
  merge (hands-on) or only for a clean review (hands-off).
- **Reach.** One factory manages many repositories. Each gets its own queue and its own loop.

## Words used here

| Word | Meaning |
|---|---|
| Task | One unit of work, small enough to deliver as one pull request. |
| Session | The tasks one `/take_order` call created. It never grows. |
| Project | A GitHub repository the factory manages. One per repository, named `owner/repo`, never named by hand. |
| Dependency | A task another task must wait for. |
| Project dependency | A project another project waits for as a whole. |
| Completed | A task whose PR was merged, or that you marked completed. Final. |
| Deleted | A task you removed for good, with every record of it. |
| Parked | A task the loop stopped trying. It waits for you. |
| Hands-on | A task that depends on this one waits until this one is merged. |
| Hands-off | A task that depends on this one may start once this one has passed review cleanly. |

The full list is in [GLOSSARY.md](../GLOSSARY.md).

## Where everything lives

The factory's code lives in this repository. Its data lives in one folder in your home directory, outside every
repository it manages. A managed repository receives branches and pull requests and nothing else.

```mermaid
flowchart TB
    subgraph code["This repository: the factory's code"]
        skills["factory/skills/<br/>the skills"]
        src["factory/*.ts<br/>loop, gate, stores, command"]
        viz["viz/<br/>the visualizer"]
    end

    subgraph home["~/.pstack-factory/ : the factory's data"]
        bin["bin/factory<br/>launcher the skills call"]
        registry["projects.json<br/>path, depends on, paused"]
        settings["settings.json<br/>modes, agent cap, pause"]
        subgraph pA["projects/owner__repo-a/"]
            tA["tasks.json"]
            aA["audit-log.jsonl"]
            wA["worktrees/"]
            oA["pr-attempts.json<br/>loop-state.json"]
        end
        subgraph pB["projects/owner__repo-b/"]
            tB["tasks.json"]
            xB["..."]
        end
    end

    subgraph user["~/.claude/skills/"]
        links["links to factory/skills/*"]
    end

    repoA[("Repository A<br/>branches and PRs only")]
    repoB[("Repository B<br/>branches and PRs only")]

    skills -.->|"factory install links"| links
    src -.->|"factory install writes"| bin
    pA -->|"its loop works in"| repoA
    pB -->|"its loop works in"| repoB
```

`PSTACK_FACTORY_HOME` moves the home folder. `factory/home.ts` is the only place that builds these paths.

A repository becomes a project in one of three ways: the first time `/take_order` runs in it, when you add it in the
visualizer by the path of its folder, or with `factory register <path>`. The project's name comes from the
repository's GitHub `origin` remote.

## From an idea to a merged pull request

This is one task with no dependencies, in a repository that is already a project.

```mermaid
sequenceDiagram
    actor You
    participant TO as /take_order
    participant Q as Task queue
    participant L as Loop
    participant C as /cook agent
    participant GH as GitHub
    participant T as /taste_test agent

    You->>TO: describe the feature
    TO->>You: design questions, task list, dependencies
    You->>TO: approve
    TO->>Q: append task (status pending)
    L->>Q: poll: the task may start
    L->>Q: status in_progress
    L->>C: start in a fresh worktree
    C->>GH: branch, commits, open PR
    C-->>L: processed
    L->>Q: status pr
    L->>GH: poll: PR needs a review
    L->>T: start in a fresh worktree
    T->>GH: post review, approve
    T-->>L: processed
    You->>GH: merge
    L->>GH: poll: PR merged
    L->>Q: status completed
```

## The life of a task

A task's `status` is owned by the loop. Parking is a note on a pending task, not a status of its own.

```mermaid
stateDiagram-v2
    [*] --> pending: take_order appends it
    pending --> in_progress: the start gate lets it through
    in_progress --> pr: cook opened a pull request
    in_progress --> pending: cook failed, skipped, hit the usage limit, or the factory crashed
    pr --> completed: its pull request was merged
    pr --> completed: you marked it completed
    pending --> completed: you marked it completed
    completed --> [*]

    note right of pending
        Parked = pending with a needs-you note.
        The loop skips it until you press Retry.
    end note
    note right of pr
        PR closed without merging:
        stays pr, gets a needs-you note,
        and its dependents keep waiting.
    end note
    note right of completed
        Final. No agent touches it again.
        The only actions left are view and delete.
    end note
```

Deleting is not a status. A deleted task is gone from the queue, and so are its audit lines, attempt counts and run
transcripts.

## When a task may start

A task with no dependencies may start the moment it exists. A task with dependencies waits until every one of them is
met. `factory/gate.ts` decides this from recorded facts only: task statuses, the open pull requests, the last
reviewed commit of each, and the modes. No agent and no skill takes part.

```mermaid
flowchart TD
    start(["Is this pending task allowed to start?"])
    parked{"Does it have a<br/>needs-you note?"}
    each["For each dependency"]
    exists{"Does the dependency<br/>still exist?"}
    done{"Is it completed?"}
    haspr{"Has it reached<br/>status pr?"}
    openpr{"Is its PR<br/>still open?"}
    mode{"The dependency's<br/>own mode"}
    clean{"Has its PR passed<br/>review cleanly?"}
    met["Met"]
    waitBuild["Not met:<br/>waiting for it to be built"]
    waitMerge["Not met:<br/>waiting for the merge"]
    waitYou["Not met:<br/>closed without merging,<br/>waiting for you"]
    waitReview["Not met:<br/>waiting for review"]
    all{"Every dependency met?"}
    yes(["May start"])
    no(["Waits"])

    start --> parked
    parked -->|yes| no
    parked -->|no| each
    each --> exists
    exists -->|"no, it was deleted"| met
    exists -->|yes| done
    done -->|yes| met
    done -->|no| haspr
    haspr -->|no| waitBuild
    haspr -->|yes| openpr
    openpr -->|no| waitYou
    openpr -->|yes| mode
    mode -->|hands-on| waitMerge
    mode -->|hands-off| clean
    clean -->|yes| met
    clean -->|no| waitReview
    met --> all
    waitBuild --> all
    waitMerge --> all
    waitYou --> all
    waitReview --> all
    all -->|yes| yes
    all -->|no| no
```

Two details matter here.

**The dependency's mode decides, not the waiting task's.** If A is hands-on and B depends on A, B waits for A's
merge even when B itself is hands-off. If A is hands-off, B may start once A is clean even when B is hands-on. With
several dependencies, each is judged by its own mode and all must be met.

**"Passed review cleanly" has an exact meaning.** All four must hold on the dependency's open PR:

1. `/taste_test` reviewed the PR's current head commit and left no `changes-requested` label.
2. CI is passing.
3. GitHub reports no merge conflict with main. "Not computed yet" does not count as a pass.
4. No `/remake` or `/customize_order` comment is waiting for an answer.

A new commit or a CI failure removes the clean state until the PR is reviewed again.

## Hands-on and hands-off

The same two tasks, B depending on A, under each mode.

**A is hands-on.** B waits for your merge.

```mermaid
sequenceDiagram
    participant A as Task A
    participant B as Task B (depends on A)
    actor You

    A->>A: cook opens PR
    A->>A: taste_test approves
    Note over B: waits for the merge
    You->>A: merge
    Note over A: completed
    B->>B: cook starts from main
```

**A is hands-off.** B starts as soon as A is clean.

```mermaid
sequenceDiagram
    participant A as Task A
    participant B as Task B (depends on A)
    actor You

    A->>A: cook opens PR
    A->>A: taste_test approves, CI green
    Note over A: clean
    B->>B: cook starts, stacked on A's branch
    B->>B: taste_test approves
    You->>A: merge A in the morning
    You->>B: then merge B
```

Hands-on is the default. Use hands-off when you want a chain of dependent tasks to keep moving while you are away.

### Where the mode comes from

The mode is set at four levels. The most specific level that sets one wins.

```mermaid
flowchart LR
    t{"Task has<br/>its own mode?"}
    s{"Its session<br/>has one?"}
    p{"Its project<br/>has one?"}
    d["Factory default<br/>starts as hands-on"]
    rt(["Use the task's"])
    rs(["Use the session's"])
    rp(["Use the project's"])

    t -->|yes| rt
    t -->|no| s
    s -->|yes| rs
    s -->|no| p
    p -->|yes| rp
    p -->|no| d
```

Each level has a switch in the visualizer: the top bar for the factory default, a project's heading, a session's
card, and a task's row. A level that sets its own mode shows what it overrides and has a reset that makes it inherit
again.

A flip only changes future starts. It never stops a running agent and never closes a PR. Flipping one level never
changes another level's setting.

## How dependencies are decided

Deciding whether two tasks clash is a judgement, so a skill makes it. Everything around that judgement is code, so
that no task is skipped because an agent thought it looked unrelated.

```mermaid
sequenceDiagram
    participant TO as /take_order
    participant TT as to_tasks
    participant DD as task-determine-deps
    participant CLI as factory deps (code)
    participant PC as task-pair-check
    actor You

    TO->>TT: split the design into tasks
    TT->>DD: decide the dependencies of the drafted tasks
    DD->>CLI: candidates
    CLI-->>DD: the mode, and every unfinished task in this repository
    loop each drafted task, in build order
        DD->>PC: this task against the list and the drafted tasks before it
        PC->>PC: work out what the task will touch, once
        PC->>PC: for each candidate: any chance it touches the same things?
        PC-->>DD: dependent, independent, or unsure, with a one-line reason
    end
    alt unsure and hands-on
        DD->>You: show both tasks and what may conflict
        You-->>DD: dependent or not
    else unsure and hands-off
        DD->>DD: treat as dependent
    end
    DD-->>TO: dependencies and a reason for each
    TO->>You: present the tasks for approval
```

The rules behind it:

- **What is compared.** Every unfinished task in the same repository, from any session. Completed and deleted tasks
  are never listed. Tasks in another repository are never dependencies; see
  [Projects and project dependencies](#projects-and-project-dependencies).
- **What makes a dependency.** Both tasks are likely to edit the same file, or one changes something the other
  relies on (a function, a type, a schema, a config value), or anything else makes it unsafe to work on both at once
  (the same lockfile, the same CI config, the same migration).
- **Direction.** A new task waits for an existing one. An existing task never gains a dependency on a newer task,
  which is why dependencies cannot form a cycle. Among the tasks of one order, the one that others build on goes
  first.
- **Doubt.** The pair check answers `independent` only when it is certain. Any doubt is `unsure`. In hands-on mode
  you are asked about that pair. In hands-off mode doubt means dependent. A wrong dependency costs time; a wrong
  independence costs merge conflicts.
- **Reasons.** Each dependency stores one line saying why it exists. The visualizer shows it, and lets you add or
  remove a dependency by hand.

The footprint a task will touch is worked out fresh each time and never stored.

## The loop: a scheduler that never waits

`bun run loop` starts a supervisor. It runs one loop per project, picks up a newly registered project within 10
seconds, restarts a loop that crashed, and stops the loop of a project you removed.

Each loop is a scheduler. It polls every 60 seconds, and again the moment any of its agents finishes. It never waits
on an agent, so it keeps noticing new tasks and PRs while agents work.

```mermaid
flowchart TD
    wake(["Poll: every 60 s,<br/>or an agent just finished"])
    orphans["Return tasks left in progress<br/>with no agent to pending"]
    read["Read the task queue.<br/>List open and recently closed PRs."]
    track["Follow each task's PR:<br/>merged makes it completed,<br/>closed unmerged flags it for you"]
    rank["Rank what is ready:<br/>1. PRs that need a patch<br/>2. PRs that need a review<br/>3. tasks the start gate lets through<br/>oldest first within each"]
    paused{"Paused by you,<br/>or by the usage limit?"}
    slot{"A free slot?<br/>cap is 3 by default"}
    blocked{"Is it a new task, and does<br/>the project wait on another project?"}
    start["Start an agent in its own worktree"]
    rest(["Sleep until the next poll"])

    wake --> orphans --> read --> track --> rank --> paused
    paused -->|yes| rest
    paused -->|no| slot
    slot -->|no| rest
    slot -->|"yes, next candidate"| blocked
    blocked -->|"yes: skip it"| slot
    blocked -->|no| start
    start --> slot
```

The ranking finishes work before it starts more. A PR that needs a fix is closer to mergeable than a PR that needs a
review, which is closer than a task nobody has started. This is also what stops reviews from being starved by a long
queue of tasks.

### One worktree per agent

Agents never share a checkout and never touch yours.

```mermaid
flowchart LR
    repo[("Repository's main checkout<br/>yours, untouched")]
    subgraph wt["~/.pstack-factory/projects/owner__repo/worktrees/"]
        w1["cook-add-login<br/>agent 1"]
        w2["cook-fix-header<br/>agent 2"]
        w3["pr-41<br/>agent 3"]
    end
    origin[("origin/main")]

    origin -->|"each starts here, detached"| w1
    origin --> w2
    origin --> w3
    repo -.->|"node_modules linked in"| wt
    w1 -->|"branch, commits, push"| gh["GitHub"]
    w2 --> gh
    w3 --> gh
```

A worktree is created when its agent starts and removed when it ends. The agent's transcript is then moved next to
the main checkout's, so the visualizer's history and Take over still find it.

### What an agent is allowed to do

Each agent runs as `claude -p "/<skill> <target>"` with a fixed list of allowed tools: file reading and editing,
subagents, and Bash limited to `git`, `gh`, `bun`, the factory's own `factory` command, and a few read-only helpers
(`grep`, `sort`, `uniq`, `diff`, `cut`, `tr`, `basename`, `dirname`, `pwd`, `which`, `file`, `stat`, `realpath`, and
the like). It ends with a schema-checked report: `processed`, or `skipped` with a reason.

A project whose checks need another tool adds it to its own `allowedCommands`: run `factory commands set conda python
pytest` in the repository, or `factory commands` to see the list. Each entry must be a bare command name; `sudo`, the
shells, `env`, `xargs` and `eval` are refused, as are `find` and `awk`, because they can run other commands. The
supervisor re-reads the list at every agent start, so a change reaches the next run without restarting the loop.

## What happens to a pull request

Every open PR in a project is a candidate, the factory's own included. `factory/pr-state.ts` decides what each one
needs. The first rule that matches wins.

```mermaid
flowchart TD
    pr(["An open pull request"])
    r1{"Draft, or labelled<br/>needs-human?"}
    r2{"Unanswered<br/>/customize_order comment?"}
    r3{"CI failed, merge conflict,<br/>changes requested,<br/>unanswered /remake comment,<br/>or a dependency it is stacked on moved?"}
    r4{"Approved and<br/>CI passing?"}
    r5{"Head commit differs from<br/>the last reviewed commit?"}
    held{"Does its task wait on a dependency<br/>it gained after the PR was built?"}
    cap{"3 review and patch<br/>runs used?"}
    none(["Nothing to do"])
    patch(["Patch: /remake"])
    review(["Review: /taste_test"])
    human(["Label needs-human,<br/>comment once, stop"])

    pr --> r1
    r1 -->|yes| none
    r1 -->|no| r2
    r2 -->|"yes: the visualizer hosts that"| none
    r2 -->|no| r3
    r3 -->|yes| needPatch["needs a patch"]
    r3 -->|no| r4
    r4 -->|yes| none
    r4 -->|no| r5
    r5 -->|no| none
    r5 -->|yes| needReview["needs a review"]
    needPatch --> held
    needReview --> held
    held -->|yes| none
    held -->|no| cap
    cap -->|yes| human
    cap -->|"no, patch"| patch
    cap -->|"no, review"| review
```

`/taste_test` cannot use GitHub's "request changes" on a PR the factory itself opened, so it sets a
`changes-requested` label instead. `/remake` clears the label after its fix. A new `/remake` comment, or a finished
`/customize_order`, resets the count of three.

## Stacked tasks

In hands-off mode a task can start before its dependency is merged. Its code then has to be built on top of the
dependency's unmerged branch.

```mermaid
gitGraph
    commit id: "main"
    branch feat/a
    commit id: "A: endpoint"
    commit id: "A: tests"
    branch feat/b
    commit id: "B: page"
    checkout feat/a
    commit id: "A: review fix"
    checkout feat/b
    merge feat/a id: "remake brings A's fix into B"
    checkout main
    merge feat/a id: "you merge A"
    merge feat/b id: "you merge B"
```

B's pull request targets main. Until A merges, it also shows A's changes; after, it shows only B's. You merge in
order, A then B.

When B starts, the loop records which commit of A it was built on. If A later gets new commits, B is out of date:

```mermaid
sequenceDiagram
    participant A as A's PR
    participant L as Loop
    participant B as B's PR (stacked on A)

    Note over B: built on A at commit a1
    A->>A: /remake pushes a fix: now at a2
    L->>A: review A again
    Note over A: clean again
    L->>L: B was built on a1, A is at a2
    L->>B: patch: /remake merges A's branch into B
    L->>L: remember B is now on a2
    L->>B: review B again
    Note over B: B's earlier approval did not count until now
```

If you delete A after B was stacked on it, B is kept exactly as it is. Deleting a task does not mean its work is
unwanted, and merging B lands it.

## When things go wrong

One failure never stops the loop. Everything that does not depend on the failed task keeps running.

```mermaid
flowchart TD
    run(["A cook run ended"])
    gone{"Was the task deleted<br/>while it ran?"}
    limit{"Did it die on your<br/>Claude usage limit?"}
    ok{"Exit 0 and a<br/>processed report?"}
    skip{"A skipped report?"}
    mode{"The task's mode"}
    tries{"Fewer than 3<br/>attempts so far?"}
    ignore(["Ignore the result"])
    pause(["No attempt counted.<br/>Back to pending.<br/>Every start waits for the reset."])
    pr(["Status pr"])
    park(["Parked: back to pending<br/>with a needs-you note"])
    retry(["Back to pending.<br/>Tried again on the next poll."])

    run --> gone
    gone -->|yes| ignore
    gone -->|no| limit
    limit -->|yes| pause
    limit -->|no| ok
    ok -->|yes| pr
    ok -->|no| skip
    skip -->|"yes: another try would say the same"| park
    skip -->|"no: it failed"| mode
    mode -->|hands-on| park
    mode -->|hands-off| tries
    tries -->|yes| retry
    tries -->|no| park
```

- **Parked.** The task waits until you press **Retry** on its row in the visualizer, which clears the note and the
  attempt count.
- **Usage limit.** The loop reads the reset time from the agent's output when it is there, and waits 30 minutes when
  it is not. The visualizer's top bar shows when work resumes. It resumes by itself.
- **Crash.** If the factory dies while agents run, the next start finds tasks marked in progress with no agent. Each
  goes back to pending with no attempt counted. Its worktree is removed, and its half-finished branch too if it has
  no PR yet.
- **Pause.** You can pause the whole factory or one project. Paused, a loop starts nothing new; running agents
  finish.

## Projects and project dependencies

Tasks never depend on tasks in another repository. When one repository needs another's work first, for example
because it uses it as a submodule, the dependency is between the projects.

```mermaid
flowchart LR
    subgraph api["Project: acme/shop-api"]
        a1["task: orders endpoint<br/>status pr"]
        a2["task: order emails<br/>completed"]
    end
    subgraph web["Project: acme/shop-web (depends on acme/shop-api)"]
        w1["task: orders page<br/>pending: held"]
        w2["task: restyle header<br/>PR open: still reviewed and patched"]
    end
    a1 -. "unfinished, so shop-web<br/>starts no new task" .-> w1
```

The rule: while any project it depends on has a task that is not completed, a project starts no new task. Reviews
and patches of its existing PRs carry on.

This gate always means merged, whatever the modes. Inside one repository a task can be stacked on an unmerged
branch. Across repositories there is nothing to stack on; one repository only sees what is in another's main.

The gate is checked each time a task is about to start. If the project you depend on gets new work, your running
agents finish and your not-yet-started tasks wait again. You set what a project depends on in its heading in the
visualizer. A dependency that would make two projects wait for each other is refused.

## Changing a task after its PR is open

Comment `/customize_order <what should change>` on a task's PR. The loop leaves that PR alone, and the visualizer
hosts the `/customize_order` run, asking you its questions on the PR's run page.

```mermaid
flowchart TD
    c(["/customize_order comment on a PR"])
    agree["Agree the smallest change to the task's text with you"]
    write["Write the new title, description and criteria"]
    deps["task-update-deps:<br/>re-judge this task against every unfinished task"]
    rules["Only this task's dependencies change.<br/>A clash becomes a dependency of this task on the other.<br/>A dependency is removed only when it certainly no longer applies.<br/>A task that already waits on this one is never added."]
    wait{"Does the task now wait<br/>on something?"}
    now["Update the PR now:<br/>cook_poteto, checks, push"]
    later["Push nothing.<br/>The loop leaves the PR alone until the wait is over,<br/>then reviews it against the new task and patches it."]
    sum(["Post the summary comment"])

    c --> agree --> write --> deps --> rules --> wait
    wait -->|no| now --> sum
    wait -->|yes| later --> sum
```

The changed task is treated as the newcomer. Tasks that were running when you changed it finish untouched, and their
dependencies do not change.

## Deleting and completing

**Completing.** A task becomes completed when the loop sees its own PR merged into main, or when you press **Mark
completed**. Either way it is kept for its history, nothing touches it again, and the tasks that waited for it are
released. A wrong or reverted merge is fixed with a new order, not by reopening.

**Deleting.** You can delete a task, a whole session, or a whole project from the visualizer. Each asks first and
lists what it will do.

```mermaid
flowchart TD
    del(["You confirm a delete"])
    stop["Stop the agent working on it, if any"]
    remove["Remove the task from the queue.<br/>Remove it from every other task's dependency list."]
    pr{"Open PR?"}
    close["Close the PR with a comment"]
    unfinished{"Was it completed?"}
    branch["Delete its branch,<br/>locally and on GitHub"]
    erase["Erase its audit lines, attempt counts<br/>and run transcripts"]
    done(["Gone. Its dependents are judged<br/>on what they have left."])

    del --> stop --> remove --> pr
    pr -->|yes| close --> unfinished
    pr -->|no| unfinished
    unfinished -->|"no"| branch --> erase
    unfinished -->|"yes: the branch is merged history"| erase
    erase --> done
```

A step that fails on GitHub or in git is reported as a warning. It never keeps the task alive: the factory's own
records are always erased. GitHub keeps a closed PR in its own history; that cannot be erased.

Deleting a session deletes each of its tasks. Removing a project deletes all of its tasks, stops its loop, and drops
it from every other project's depends-on list. The repository's code and its main branch are not touched.

## What is code and what is a skill

One test decides it: can the rule be settled from recorded facts alone? If yes, it is code with tests, so it behaves
the same every time. If it needs reading a repository and judging, it is a skill.

| Rule | Lives in | File |
|---|---|---|
| May this task start now | Code | `factory/gate.ts` |
| What "passed review cleanly" means | Code | `factory/gate.ts` |
| Which mode applies | Code | `factory/settings.ts` |
| What a PR needs next | Code | `factory/pr-state.ts` |
| What to start first, and how many at once | Code | `factory/candidates.ts`, `factory/loop.ts` |
| Retries, parking, usage limit, crash recovery | Code | `factory/loop.ts` |
| Which tasks to compare a task against | Code | `factory/deps.ts` |
| Writing dependencies, refusing deadlocks | Code | `factory/deps.ts` |
| May this project start a task | Code | `factory/projects.ts` |
| Deleting a task | Code | `factory/delete-task.ts` |
| Do these two tasks clash | Skill | `task-pair-check` |
| A new order's dependencies | Skill | `task-determine-deps` |
| A changed task's dependencies | Skill | `task-update-deps` |
| Doing the work | Skills | `cook`, `taste_test`, `remake` |

A skill never decides whether something may run. Skills write dependencies and their reasons through
`factory deps set`; the loop's code alone decides what starts.

## The visualizer

`bun run viz` serves the visualizer on `127.0.0.1:4600`. It reads every project's queue and audit log, each
repository's PRs, and the agents' transcripts, and polls every half second.

```mermaid
flowchart TB
    subgraph top["Top bar"]
        t1["running agents of cap"]
        t2["factory default mode"]
        t3["pause"]
        t4["usage-limit notice"]
    end
    subgraph proj["One section per project"]
        p1["mode"]
        p2["pause this project"]
        p3["depends on: add, remove"]
        p4["remove project"]
        subgraph card["Session card"]
            c1["mode"]
            c2["delete session"]
            c3["status and needs-you count"]
        end
        comp["Completed: collapsed group"]
    end
    subgraph page["Session page"]
        subgraph row["One row per task"]
            r1["state and mode"]
            r2["each dependency: reason, what it waits for, remove"]
            r3["Retry, Mark completed, Delete, add a dependency"]
        end
        wf["Waterfall of runs, with the run panel and Take over"]
    end

    top --> proj
    card -->|click| page
```

The visualizer writes to the factory's data only through those controls. It also hosts `/customize_order` runs and
can open a Terminal that resumes an agent's conversation.

## Module map

```mermaid
flowchart TD
    cli["cli.ts<br/>the factory command"]
    sup["supervisor.ts<br/>one loop per project"]
    loop["loop.ts<br/>the scheduler"]
    cand["candidates.ts<br/>what is ready, in what order"]
    gate["gate.ts<br/>the start gate"]
    prstate["pr-state.ts<br/>what a PR needs"]
    settings["settings.ts<br/>modes, cap, pause"]
    projects["projects.ts<br/>registry, contexts, project gate"]
    home["home.ts<br/>every path"]
    store["tasks.store.ts + tasks.schema.ts<br/>the queue and its shape"]
    prs["prs.ts<br/>PRs through gh"]
    attempts["pr-attempts.ts<br/>review and patch counts"]
    audit["audit-log.ts<br/>one line per run"]
    wt["worktrees.ts<br/>a checkout per agent"]
    deps["deps.ts + deps-cli.ts<br/>dependency candidates and writes"]
    del["delete-task.ts"]
    vizs["viz/server<br/>API and model"]
    vizc["viz/src<br/>the UI"]

    cli --> sup --> loop
    cli --> deps
    cli --> projects
    loop --> cand --> gate
    cand --> prstate
    gate --> settings
    loop --> wt
    loop --> store
    loop --> prs
    loop --> attempts
    loop --> audit
    sup --> projects --> home
    projects --> store
    settings --> home
    vizs --> projects
    vizs --> del
    vizs --> deps
    vizs --> settings
    vizc --> vizs
```

Tests sit beside each module as `*.test.ts`. `bun test` runs them all.

## Known limits

- **Checks must run with Bun.** Agents may run `bun`, `git`, `gh` and a few read-only commands. `/cook` cannot run a
  repository's checks if they need `npm`, `pytest`, `cargo` or another tool.
- **Usage-limit detection matches known wording.** If Claude Code words the message differently, the run counts as
  an ordinary failure.
- **GitHub only.** A project needs a GitHub `origin` remote.
- **Agents start from `origin/main`.** A change to the skills takes effect for the loop's agents once it is merged.
- **Session and task ids are looked up across projects.** Two repositories using the same task id would confuse the
  visualizer's task actions. Session ids carry a timestamp, so they do not collide in practice.
- **Merging and closing PRs is yours.** No agent does either.
