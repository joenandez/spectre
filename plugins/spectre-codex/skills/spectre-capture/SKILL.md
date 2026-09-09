---
name: "spectre-capture"
description: "Proactively preserve consequential project knowledge and work context without waiting for a user request. Use as the primary agent whenever a lasting decision is accepted, an explicit correction is given, a reusable cause, constraint, or pattern is verified, maintained guidance is disproved, a persistent blocker changes state, or Execute, Ship, Create PR, or Learn requests a work record. Do not use for routine progress, transient failures, speculation, task completion alone, knowledge lookup, or worker-owned writes."
user-invocable: false
---

# capture

## Purpose

Proactively preserve qualifying project knowledge and work context as it emerges during normal agent work. Capture is the sole record-writing contract and never becomes an approval, acceptance, or PR gate.

## Inputs

- The current conversation and workflow evidence for a primary-observed qualifying event; an explicit user capture request is not required.
- Accepted decisions, explicit corrections, verified reusable findings, disproved guidance, persistent blocker transitions, or workflow-requested work summaries.
- The current project directory used to resolve the project-scoped knowledge store. This is the host workspace or repository root, not a Spectre feature root, and defaults to the current working directory.
- For maintained knowledge, project applicability requires no workflow, feature, run, or PR association. For work records only, provide an exact run, PR, or repository/base/head/diff association and carry a prior work ID when available.
- Candidate evidence, authority, and any known record ID/revision.

## Working Set

- Bounded task/tag search results; exact verified candidate loads; current revision tokens.
- Explicit applicability context (`project` or exact work/run) and the current work lifecycle state.
- Worker findings and evidence references only. Workers never write records or tags.

## Outputs + DONE

- A saved, updated, superseded, retired, no-op, skipped, or surfaced-failure result with record ID/revision where applicable.
- Work summaries retain all seven sections: requested outcome/scope; actual changes/components; reasons/decisions; discoveries/approaches; verification/evidence; remaining work/unknowns; related knowledge/source context.

**DONE when:** the primary has either recorded supported durable facts through the typed preconditioned path, or truthfully returned a skip/no-op/failure; capture never changes Execute acceptance, verification authority, or PR progression.

## Method / guardrails

1. Proactively capture without waiting for a user request when: a user accepts a lasting decision; the primary verifies a reusable cause, constraint, or pattern; verified evidence contradicts maintained guidance; or an ongoing blocker is confirmed/resolved. An explicit user statement that a lasting decision is current, corrected, or superseded is accepted authoritative evidence for that decision. An incidental code shape is not a general pattern; a transient failed command is not an ongoing blocker.
2. After an accepted execution batch, evaluate worker findings against those triggers. Otherwise skip speculative findings, duplicates, unsupported hypotheses, routine progress, and task completion alone; pending facts belong truthfully in a work account.
3. Resolve/carry the exact work ID, search related knowledge and tags, and assess applicability. For each needed ID, make one successful `knowledge-cli.mjs load <id> --json` body load per unchanged revision and context; reuse its `record` and `revisionToken` for assessment, no-op, proposal, registration, and result. A metadata-only revision check is allowed; reload only for a changed revision, conflict, or new context. If allowance blocks a needed body, request `--allowance-tokens` expansion; never read canonical files.
4. To revise, materialize that returned record as `<proposal-root>/<exact-id>/record.json` outside the knowledge store and register it with `--expected-revision`; never edit canonical packages, `index.json`, or history, and preserve failed proposals. For an explicit user correction, cite the direction in the record evidence, keep schema-valid provenance, and preserve disagreeing repository statements as stale or historical context. Absence of corroborating repository evidence does not block the save or require reconfirmation. Reconcile other stale evidence by reloading and comparing it; surface unresolved authority conflicts. Already-authorized accepted facts need no new proposal or approval loop.
5. For work, carry the exact ID from a run, PR, or candidate—never branch or recency. Register exact `work.associations`, then re-resolve it; an operandless or unrelated-run miss never allocates work. Keep execution, verification, and PR state separate; `work.pullRequest.state: draft-open` never implies merged. Knowledge may retain source run references until the work account links them without rewriting it.
6. Report a recoverable conflict or an unrecoverable save failure with retained recovery input. Do not retry forever, claim success, block a draft PR, or turn zero knowledge into a failure.

## Handoff

Return compact primary-owned capture findings: trigger or skip reason, record/work ID, revision or conflict, applicability, lifecycle state, and evidence references. Worker handoffs contain findings only.

## Escalate-If

- Explicit authoritative directions conflict without a clear latest decision, applicability cannot be determined, or exact work associations are ambiguous.
- A write cannot be recovered after the available repair path; report the failed operation and recovery input without blocking workflow acceptance or PR creation.
