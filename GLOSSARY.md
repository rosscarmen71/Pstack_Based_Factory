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
A name that groups orders. An order belongs to at most one project.
_Avoid_: folder, group, workspace

**Project box**:
The main-page frame that holds every session of one project, shown as mini cards.
_Avoid_: project section, project group

**Mini card**:
A session card shrunk to fit inside a project box, keeping its "needs you" pill at full size.
_Avoid_: thumbnail, compact card
