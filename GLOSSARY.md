# Pstack Based Factory

A software factory that turns engineer-written tasks into pull requests, then reviews and fixes them.

## Language

**Task**:
One unit of work in the queue, small enough to deliver as a single pull request.
_Avoid_: ticket, job

**Order**:
The set of tasks written together in one take_order run.
_Avoid_: batch, request

**Session**:
An order as the visualizer shows it, together with the runs and pull requests that came from it.
_Avoid_: run (a run is one agent invocation within a session)

**Project**:
A GitHub repository the factory manages. Exactly one per repository; never created or named by hand.
_Avoid_: folder, group, workspace

**Completed**:
A task whose pull request was merged into main, or that the engineer marked completed. Final.
_Avoid_: done, closed, finished

**Deleted**:
A task the engineer removed for good, with every record of it. Nothing waits for a deleted task.
_Avoid_: archived, hidden

**Dependency**:
A task another task must wait for, because working on both at once is unsafe. Dependent tasks never run together; tasks with no dependency between them run in parallel.
_Avoid_: blocker, prerequisite

**Project dependency**:
A project another project waits for as a whole: none of its tasks start while the other has an unfinished task.

**Hands-on**:
The mode in which a task that depends on this one waits until this one is merged.
_Avoid_: watching, monitoring mode

**Hands-off**:
The mode in which a task that depends on this one may start once this one has passed taste_test cleanly.
_Avoid_: away, autopilot

**Parked**:
A task the loop stopped trying, waiting for the engineer.
_Avoid_: stuck, failed
