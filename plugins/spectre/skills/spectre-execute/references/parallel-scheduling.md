# Implementation scheduling

Use for every execution source before the first implementation dispatch and whenever the ready frontier changes. Execute owns scheduling; the selected plan, tasks, or fix report owns requirements. Route, phase, workstream, parent, and change-set labels do not set worker count.

## Objective

Minimize elapsed time to an integrated, verified candidate with proportional agent tokens and coordination. Dispatch all safely ready work likely to shorten delivery time; more agents alone are not a benefit.

## Schedule from existing evidence

1. Read the selected source, Scope, applicable `task_context.md`, available `execute.md` wave hints, and current execution state. Derive only the ready frontier from their stated work, dependencies, and shared contracts. Do not launch another research wave, dispatch research agents, broadly rescan the repository, or delay ready work to optimize the schedule.
2. Look for independent assignments across or within a change set, workstream, or parent. Only unaccepted prerequisites block their consumers. A consumer can begin when the contract it needs is stable; unrelated work and whole-phase completion are not prerequisites.
3. Give each concurrent worker a bounded source-backed assignment: objective, source anchor, owned files or interface, required shared contract, output, focused checks, and handoff. Avoid overlapping edits unless one owner and an integration method are explicit. Batch short or tightly coupled steps with one worker when splitting adds more delay than it saves.
4. Dispatch the ready assignments together. In the existing wave state, record owners, prerequisites/shared contracts, and the concrete reason any apparently ready independent slice remains serialized. Keep the record compact; do not build a complete future graph for Plan Direct.

## Refresh the frontier

- When a worker finishes or a prerequisite becomes usable, start newly ready assignments without waiting for unrelated workers. Reconcile shared contracts and verify the integrated candidate through Execute's existing gates.
- Let the implementation worker investigate details needed for its assignment. If one unknown makes concurrent edits unsafe, continue independent work and resolve only that question before dispatching the affected assignments.
- Preserve source authority, stable task/workstream IDs, and existing telemetry granularity. Assignment boundaries create no new requirement, acceptance criterion, or synthetic Plan Direct task event.
- One worker is correct when the work is coupled or concurrent dispatch has no credible wall-clock benefit. Record the reason when the source appears to contain independent ready work.
