---
name: "spectre-fix-core"
description: "Internal diagnosis engine for the Spectre Fix workflow. Use only when invoked by spectre-fix to investigate a reported bug and prepare its Execute handoff. Do NOT invoke directly for user requests."
user-invocable: false
---

# fix-core

## Purpose

Own the diagnostic phase of the bug flow: reproduce the failure, ground the root cause and behavioral blast radius, then return a source-faithful Execute handoff. Execute owns all code changes.

## Inputs

- Bug report: error, stack trace, reproduction, and referenced context.
- `PHASE=diagnose`.
- `--orchestrated` — withhold user-facing routing, never content.

## Working Set

- Read affected paths and recent changes just-in-time.
- Invoking this workflow IS the user's request for subagent investigation: dispatch `@spectre_analyst` for causal and impact traces. Keep returns compact and in-thread, with no scratch reports.

## Outputs + DONE

Experience-contract rows map technical evidence to product behavior: `journey/surface | current experience | expected experience | technical path/consumer | disposition=intended-change|preserved-invariant|collateral-change|unresolved | evidence | verification`.
- `diagnose` → `DIAGNOSIS_READY`: reproduction, root cause, affected files, candidate repair, evidence-backed experience contract, and regression/invariant opportunities; no code writes.

**DONE when:** root cause is grounded and its hypotheses were traced by dispatched analysts; the product and technical direct blast radius was independently explored after the candidate repair boundary was known; no row is `unresolved`; and the parent receives the diagnosis result.

## Method / guardrails

1. **Diagnose.** Generate 5–7 hypotheses; reduce to 1–2 via evidence/data-flow/changes/paths; dispatch parallel `@spectre_analyst` traces; reproduce; synthesize one cause-level repair.
2. **Explore product + technical impact.** Once root cause and candidate repair boundary are grounded, dispatch ≥1 independent read-only `@spectre_analyst`; parallelize separable product journeys or technical boundaries. Trace shared callers, state, and data paths through to user/operator-observable outcomes. Return compact experience-contract rows that explicitly identify experiences that change, remain invariant, or are unresolved; synthesize and deduplicate the results.
3. **Honor phase.** `diagnose` returns `DIAGNOSIS_READY` before any code write.
3. **Contain scope.** Do not propose behavior beyond the reported repair boundary. An `unresolved` row or a new experience-contract row returns to the user for clarification.

## Handoff

Return phase status, hypotheses, diagnosis, experience contract with row-level evidence, proposed repair, limitations, and exact Execute source. Execute owns implementation and verification; the parent owns user-facing Next Steps.

## Escalate-If

- The report is too thin to form testable hypotheses, reproduction is unavailable, no root cause can be grounded, impact evidence conflicts, or desired behavior remains unresolved.
- Evidence contradicts the diagnosis, desired behavior is unclear, or further investigation needs authority.
