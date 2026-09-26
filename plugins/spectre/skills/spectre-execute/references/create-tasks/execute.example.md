# Execute Index — Example Feature

Feature: Example Feature
Feature Root: .spectre/features/example-feature

## Document Manifest
Read these docs before execution:
- Scope: `concepts/product-scope.md`
- UX: `ux.md`
- Prototype: `prototypes/example-flow.html`
- Plan: `specs/plan.md`
- Research: `task_context.md`

## Task Detail Source
Do not read this file whole:
- Feature Root: `.spectre/features/example-feature`
- Tasks JSON: `specs/tasks.json`

Use targeted parsing only: selected parent-task slices and reviewer criteria/context slices. Task definitions are immutable; progress lives in the local workflow store.

## Execution Summary
- Phases: 2
- Parent tasks: 2
- Subtasks: 2
- Waves: 2

## Wave Plan
- Wave 1: `{ id: "wave-1", label: "Define Contract", parent_task_ids: ["1.1"], after: [], rationale: "The detail contract must exist before consumers can reference it." }`
- Wave 2: `{ id: "wave-2", label: "Consumer Slice", parent_task_ids: ["2.1"], after: ["wave-1"], rationale: "Dispatch behavior depends on the fixture contract." }`

## Parent Task Index
- Phase 1 — Define Contract
  - `{ id: "1.1", title: "Example detail artifact", subtasks: ["1.1.1"], predecessor: "none", unblocks: "2.1" }`
- Phase 2 — Consumer Slice
  - `{ id: "2.1", title: "Inline selected parent tasks into dispatch", subtasks: ["2.1.1"], predecessor: "1.1", unblocks: "terminal", risk: "shared-contract: dispatch slice must preserve the consumer-visible task contract" }`

## Slicing Rules
Read this index to plan waves. For each owner, choose selected parent task ids from the Wave Plan and batching rules, then query only those parent tasks from `tasks.json` using `jq`, `node -e`, or direct targeted mechanics. Inline the selected parent-task slice under `<task_assignment>`.

Do not load the full task detail JSON into orchestration context. Do not require dispatch boundaries to match phase boundaries. Never write lifecycle status or validation data into `tasks.json`; update this index only when the immutable task graph changes before execution.
