---
name: "spectre-capture"
description: "Use whenever a message carries something the project must still know next week—record it immediately and unasked; the user will never say ‘remember this.’ Fires on: a decision made, reaffirmed, or reversed (‘we settled on X’, ‘not sharding after all’, ‘that’s the call’); a correction of you or standing guidance, however blunt or repeated (‘no, that’s wrong; X applies only to Y’); a gotcha, root cause, version pin, constraint, or convention worth handing to whoever hits it next (‘for future reference’, ‘so nobody else hits this’); maintained guidance now disproved; or a persistent blocker newly cleared, confirmed real, or otherwise changed state, even in passing. The user’s word alone is sufficient authority; never wait for repo evidence or an explicit save request. Not for work records or routine progress."
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
- `references/tagging-policy.md` and `references/knowledge-capture-input.json`.
- Worker findings and evidence references only; workers never write records or tags.

## Outputs + DONE

- A saved, updated, superseded, retired, no-op, skipped, or surfaced-failure knowledge result with ID, revision, and canonical `recordPath` where applicable.

**DONE when:** a supported durable fact is recorded through the typed path, or a skip/no-op/failure is reported truthfully without changing workflow authority.

## Method / guardrails

1. Capture accepted lasting decisions, explicit corrections, verified reusable patterns/gotchas/constraints, disproved maintained guidance, and confirmed persistent-blocker transitions. Do not infer a durable fact from incidental code, a transient command failure, a task outcome, or routine progress.
2. Read `references/tagging-policy.md`, then reuse the visible catalog and current-request tag results. Run `knowledge-cli.mjs tags search '<subject>' --project-dir <project-dir> --json` only for unresolved aliases, omitted tags, or genuinely new tag intent; exact-load a candidate only when needed. Select or create tags at the policy's durable area altitude. An explicit user statement that a lasting decision is current, corrected, or superseded is accepted authoritative evidence. Absence of corroborating repository evidence does not block the save or require reconfirmation; retain disagreeing repository statements as stale or historical context.
3. Read `references/knowledge-capture-input.json`, fill its semantic JSON outside the store, then submit it through standard input: `knowledge-cli.mjs capture --kind knowledge --input - --project-dir <project-dir> --json`. New input needs non-empty tag intent; reuse canonical tags or create a qualifying new tag under the shared policy. Use `--input <path>` only for an explicitly manual/advanced capture or a returned `recoveryInput` file.
4. An unchanged retry is a no-op. A changed record needs its loaded `revisionToken` as `--expected-revision`; preserve omitted tags on updates and never edit canonical packages, `index.json`, or history.
5. Return the tag and record outcome, canonical `recordPath`, and ID/revision. A failed write returns `recoveryInput` for manual recovery and remains non-blocking; it never becomes an Execute, Ship, Create PR, verification, or acceptance gate.

## Handoff

Return the trigger or skip reason, knowledge ID, revision/conflict, canonical `recordPath`, applicability, and evidence references. Workers return findings only.

## Escalate-If

- Explicit authoritative directions conflict without a clear latest decision, or applicability cannot be determined.
- A write cannot recover through the available path; report recovery input without blocking delivery.
