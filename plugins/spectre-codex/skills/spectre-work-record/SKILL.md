---
name: "spectre-work-record"
description: "Create or revise one bounded historical work record at Execute start, a meaningful blocked handoff or its resolution, Execute completion, Ship after PR creation, standalone Create PR terminal ownership, an explicit user snapshot, or a historical correction. Do not use for routine progress, task or batch updates, checks, reviews, commits, live context management, reusable guidance, or orchestrated Create PR."
user-invocable: false
---

# work-record

## Purpose

Preserve one bounded historical account of a body of work at explicit ownership boundaries. Live execution state and telemetry remain authoritative for progress.

## Inputs

- A permitted boundary, exact work ID or exact run, PR, or repository/base/head/diff association, and prior revision when revising.
- Truthful seven-section account, lifecycle facts, candidate/PR evidence, and tag intent.
- Explicit snapshots and historical corrections may occur outside a workflow; standalone Create PR owns one terminal write only when no Execute or Ship parent owns it.

## Working Set

- Exact verified association, bounded candidate search/load results, current revision token, and evidence references.
- The shared `../spectre-capture/references/work-capture-input.json`; do not duplicate persistence, association, history, or tag logic.

## Outputs + DONE

- A created, updated, no-op, conflict, skipped, or surfaced-failure work result with exact work ID and revision where applicable.

**DONE when:** the permitted boundary has a truthful historical account or a truthful skip/no-op/failure; a capture result never changes Execute, Ship, Create PR, verification, or acceptance authority.

## Method / guardrails

1. Automatic boundaries are one minimal truthful Execute-start record after exact run/work identity exists; one meaningful blocked handoff or resolution when execution cannot safely continue or resume across an authority, control, or context boundary; one Execute completion; and one Ship update after the PR exists. If resolution coincides with completion, completion is sufficient.
2. Orchestrated Create PR returns PR evidence to Ship and does not write a work record. Standalone Create PR may write once at its terminal boundary only when no parent owns the record. An explicit user snapshot and historical correction are allowed, but do not replace normal ownership boundaries.
3. Never write for individual tasks, batches, checks, reviews, commits, ordinary decisions, routine progress, transient remediation, or active-context refreshes. Reusable guidance belongs to `Skill(spectre-capture)`.
4. Read the shared work input reference, fill it outside the store, then invoke `knowledge-cli.mjs capture --kind work --input <filled.json> --work-id <exact-id>|--source-run-id <exact-run>|--pull-request-id <exact-pr>|--candidate <exact-json> --project-dir <project-dir> --json`. Keep execution, verification, and PR state separate; a draft PR is never merged.
5. Retain all seven sections and exact associations. Carry the loaded `revisionToken` for changed records, preserve omitted tags, and treat unchanged retries as no-ops. Every new or revised account has a hard 2,000 estimated rendered-token ceiling; compact it and retry when exceeded, referencing evidence rather than copying logs.
6. Return recovery input for conflicts or capture failure. Failure is non-blocking and must not prevent Execute, Ship, or PR delivery; later explicit snapshot or historical correction can repair missing historical detail.

## Handoff

Return boundary, work ID, revision/conflict, exact associations, lifecycle facts, and recovery input when applicable.

## Escalate-If

- The boundary is not permitted, exact association is ambiguous, or authoritative historical facts conflict.
- A write cannot recover through the available path; report recovery without blocking delivery.
