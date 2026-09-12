---
name: "spectre-capture"
description: "Proactively preserve maintained project knowledge when a lasting decision is accepted, an explicit correction is given, a reusable pattern, gotcha, cause, or constraint is verified, maintained guidance is disproved, or a persistent blocker changes state. Do not use for work summaries, workflow progress, task completion, historical work records, transient failures, speculation, lookup, or worker-owned writes."
user-invocable: false
---

# capture

## Purpose

Proactively preserve consequential project knowledge without waiting for a user request. This skill owns reusable maintained knowledge records only and never gates acceptance, delivery, or PR progression.

## Inputs

- Primary-observed authority and evidence for a qualifying durable fact.
- The host project directory, exact candidate ID/revision when updating, and tag intent; this is not a Spectre feature root.
- Maintained knowledge requires no workflow, feature, run, or PR association. Do not attach candidates, feature state, or work lifecycle.

## Working Set

- Bounded tag/task search results, exact verified loads, and current revision tokens.
- Worker findings and evidence references only; workers never write records or tags.

## Outputs + DONE

- A saved, updated, superseded, retired, no-op, skipped, or surfaced-failure knowledge result with ID and revision where applicable.

**DONE when:** a supported durable fact is recorded through the typed path, or a skip/no-op/failure is reported truthfully without changing workflow authority.

## Method / guardrails

1. Capture accepted lasting decisions, explicit corrections, verified reusable patterns/gotchas/constraints, disproved maintained guidance, and confirmed persistent-blocker transitions. Do not infer a durable fact from incidental code, a transient command failure, a task outcome, or routine progress.
2. Search tags for the actual subject; exact-load a candidate only when needed. An explicit user statement that a lasting decision is current, corrected, or superseded is accepted authoritative evidence. Absence of corroborating repository evidence does not block the save or require reconfirmation; retain disagreeing repository statements as stale or historical context.
3. Read only `references/knowledge-capture-input.json`, fill it outside the store, then invoke `knowledge-cli.mjs capture --kind knowledge --input <filled.json> --project-dir <project-dir> --json`. New input needs non-empty tag intent; reuse canonical tags and create only genuinely new tags.
4. An unchanged retry is a no-op. A changed record needs its loaded `revisionToken` as `--expected-revision`; preserve omitted tags on updates and never edit canonical packages, `index.json`, or history.
5. Return the tag and record outcome. A failed write returns recovery input and remains non-blocking; it never becomes an Execute, Ship, Create PR, verification, or acceptance gate.

## Handoff

Return the trigger or skip reason, knowledge ID, revision/conflict, applicability, and evidence references. Workers return findings only.

## Escalate-If

- Explicit authoritative directions conflict without a clear latest decision, or applicability cannot be determined.
- A write cannot recover through the available path; report recovery input without blocking delivery.
