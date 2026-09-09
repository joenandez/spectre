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
2. After an accepted execution batch, evaluate worker findings against those triggers. Otherwise skip speculative findings, duplicates, unsupported hypotheses, routine progress, and task completion alone; pending facts belong truthfully in a work account. Absence of corroborating repository evidence does not block the save or require reconfirmation for an explicit authoritative correction; preserve disagreeing repository statements as stale or historical context.
3. Search tags for the actual subject; reuse the returned canonical ID or alias. Define a genuinely new tag with its short description only. For each needed ID, make one successful `knowledge-cli.mjs load <id> --json` body load per unchanged revision and context; reuse its returned record and revisionToken for no-op, proposal, and result. A metadata-only revision check is allowed. If allowance blocks a needed body, request `--allowance-tokens`; never read canonical files to discover the input shape.
4. Read only `references/knowledge-capture-input.json` or `references/work-capture-input.json`, fill it outside the store, then invoke `knowledge-cli.mjs capture --kind knowledge|work --input <filled.json> --project-dir <project-dir> --json`. New inputs need non-empty tag intent. `relatedRecordIds`, knowledge `status`/`blocker`/`applicability`, and truthful work lifecycle state objects are optional semantic fields. The work form has eight required machine fields that render as seven work sections; do not merge requested outcome and scope.
5. For work, carry an exact run, PR, candidate, or prior work ID—never branch or recency—and pass it to capture. Capture resolves aliases to canonical tags, ensures only genuine new tags, owns defaults/validation/allocation/registration, and re-resolve verifies the exact association. Keep execution, verification, and PR state separate; `work.pullRequest.state: draft-open` never implies merged.
6. An unchanged semantic retry is a no-op. Keep any proposal outside the knowledge store; a changed existing record needs its loaded `revisionToken` as `--expected-revision` and reload only for a changed revision, conflict, or new context. When omitted tags are absent on an update, preserve existing tags; a non-empty supplied list intentionally replaces them. Never edit canonical packages, `index.json`, or history.
7. Report the tag and record outcomes. On a failed post-ensure/allocation registration, retain the returned recovery input and stable work ID; do not claim success, retry forever, block a draft PR, or turn zero knowledge into a failure.

## Handoff

Return compact primary-owned capture findings: trigger or skip reason, record/work ID, revision or conflict, applicability, lifecycle state, and evidence references. Worker handoffs contain findings only.

## Escalate-If

- Explicit authoritative directions conflict without a clear latest decision, applicability cannot be determined, or exact work associations are ambiguous.
- A write cannot be recovered after the available repair path; report the failed operation and recovery input without blocking workflow acceptance or PR creation.
