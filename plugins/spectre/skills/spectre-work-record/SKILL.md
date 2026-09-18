---
name: "spectre-work-record"
description: "Use only for one bounded historical account at an explicit ownership boundary, not as proactive project memory. Fires on: Execute start after exact run/work identity exists; a meaningful blocked handoff or its resolution; Execute completion; Ship after the PR exists; standalone Create PR when no Execute or Ship parent owns the record; an explicit user request to snapshot or summarize a body of work; or a historical correction. Workflow ownership or explicit historical intent is required. Not for reusable guidance, routine progress, or orchestrated Create PR."
user-invocable: false
---

# work-record

## Purpose

Preserve one bounded historical account of a body of work at explicit ownership boundaries. Live execution state and telemetry remain authoritative for progress.

## Inputs

- A permitted boundary, exact run, PR, or repository/base/head/diff association, plus an exact branch and prior revision when revising.
- Truthful seven-section account, lifecycle facts, candidate/PR evidence, and tag intent.
- Explicit snapshots and historical corrections may occur outside a workflow; standalone Create PR owns one terminal write only when no Execute or Ship parent owns it.

## Working Set

- Exact verified association, bounded candidate search/load results, current revision token, and evidence references.
- `${CLAUDE_PLUGIN_ROOT}/skills/spectre-capture/references/tagging-policy.md` and `references/work-capture-input.json`; do not duplicate persistence, association, history, or tag logic.

## Outputs + DONE

- A created, updated, no-op, conflict, skipped, or surfaced-failure work result with exact work ID, revision, and canonical `recordPath` where applicable.

**DONE when:** the permitted boundary has a truthful historical account or a truthful skip/no-op/failure; a capture result never changes Execute, Ship, Create PR, verification, or acceptance authority.

## Method / guardrails

1. Automatic boundaries are one minimal truthful Execute-start record after exact branch/run/work identity exists; one meaningful blocked handoff or resolution when execution cannot safely continue or resume across an authority, control, or context boundary; one Execute completion; and one Ship update after the PR exists. Identity is one record per exact Execute run: a resume of the same run revises only that record, distinct runs never fold even on one branch, feature root, or candidate, and a branch and a pull request may each reference many records. Read the exact branch from checkout with `git rev-parse --abbrev-ref HEAD` for `provenance.sourceBranch`; if it cannot be read, skip capture with recovery output rather than guessing. When the resolved record already carries a PR identity or URL, before capture and outside every store lock run `gh pr view <identity-or-url> --json state` and carry the observed state in the capture input under `pullRequest`. If that query is unavailable, unknown, or conflicts with stored terminal history, return recovery/skip for the work capture; it does not block Execute or guess. A draft-open record with no queryable PR identity also skips. At Execute start, state every not-yet-true section in plain prose such as `None yet.`; never use angle-bracket, `TODO`, or `REPLACE_ME` placeholders. If resolution coincides with completion, completion is sufficient.
2. Orchestrated Create PR returns PR evidence to Ship and does not write a work record. Standalone Create PR may write once at its terminal boundary only when no parent owns the record. An explicit user snapshot and historical correction are allowed, but do not replace normal ownership boundaries.
3. Never write for individual tasks, batches, checks, reviews, commits, ordinary decisions, routine progress, transient remediation, or active-context refreshes. Reusable guidance belongs to `Skill(spectre-capture)`.
4. Read the shared tagging policy and work input reference. Select or create tags at the policy's durable area altitude, fill the semantic JSON outside the store, then submit it through standard input: `knowledge-cli.mjs capture --kind work --input - --branch <exact-branch> --work-id <exact-id>|--source-run-id <exact-run>|--pull-request-id <exact-pr>|--candidate <exact-json> --project-dir <project-dir> --json`. Every Execute-owned boundary also passes `--source-run-id <exact-run>` in addition to any other identity flag, because the delivery receipt derives only from that exact run's event log. Use `--input <path>` only for an explicitly manual/advanced capture or a returned `recoveryInput` file. Set `execution`, `verificationState`, and `pullRequest` from observed fact: `execution.state` is one of `unknown|in-progress|implementation-ready|acceptance-pending|blocked|finalized`, `verificationState.state` one of `unknown|not-run|checked|passed|failed`, and `pullRequest.state` one of `unknown|none|draft-open|closed|merged`, so a bare `open` is rejected. At a successful authorized terminal Execute boundary send `"execution": {"state": "finalized"}` with `"remainingWork": "None."`; a blocked, failed, or interrupted run sends a non-final state with truthful scoped residual work. A finalize that omits that exact `None.` string is rejected as `CAPTURE_INPUT_INVALID`. Keep the three dimensions separate; review, CI, PR readiness, merge, and closure are verification or PR facts and never populate `remainingWork`, and a draft PR is never merged.
5. Retain all seven sections and exact associations. Carry the loaded `revisionToken` for changed records, preserve omitted tags, and treat unchanged retries as no-ops. Every new or revised account has a hard 2,000 estimated rendered-token ceiling; compact it and retry when exceeded, referencing evidence rather than copying logs.
6. Return the exact work ID, revision/conflict, canonical `recordPath`, and `recoveryInput` for manual recovery after conflicts or capture failure. Failure is non-blocking and must not prevent Execute, Ship, or PR delivery; later explicit snapshot or historical correction can repair missing historical detail.

## Handoff

Return boundary, work ID, revision/conflict, canonical `recordPath`, exact associations, lifecycle facts, and `recoveryInput` when applicable.

## Escalate-If

- The boundary is not permitted, exact association is ambiguous, or authoritative historical facts conflict.
- A write cannot recover through the available path; report recovery without blocking delivery.
