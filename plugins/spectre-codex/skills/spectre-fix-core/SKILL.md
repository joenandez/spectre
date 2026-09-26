---
name: "spectre-fix-core"
description: "Internal diagnose-and-repair engine for the Spectre Fix workflow. Use only when invoked by spectre-fix with an explicit phase and authorization contract. Do NOT invoke directly for user requests."
user-invocable: false
---

# fix-core

## Purpose

Own one reusable bug flow: reproduce the failure, ground the root cause and behavioral blast radius, then implement a verified RED-before-GREEN repair. Standalone Fix owns the Execute handoff; orchestrated parents supply scope-bound authorization.

## Inputs

- Bug report: error, stack trace, reproduction, and referenced context.
- `PHASE=diagnose | full`.
- `full` requires `PARENT=spectre-fix`, `PARENT_AUTHORIZATION={scope.md}`, `AUTHORIZED_SCOPE_SHA256`, and `ALIGNMENT_MODE=inferred`.
- `--orchestrated` — withhold user-facing routing, never content.

## Working Set

- Read affected paths and recent changes just-in-time.
- Invoking this workflow IS the user's request for subagent investigation: dispatch `@spectre_analyst` for causal and impact traces. Keep returns compact and in-thread, with no scratch reports.
- In parent-authorized `full`, read the scope artifact before any code write.

## Outputs + DONE

Experience-contract rows map technical evidence to product behavior: `journey/surface | current experience | expected experience | technical path/consumer | disposition=intended-change|preserved-invariant|collateral-change|unresolved | evidence | verification`.
- `diagnose` → `DIAGNOSIS_READY`: reproduction, root cause, affected files, candidate repair, evidence-backed experience contract, and regression/invariant opportunities; no code writes.
- `full` → `FIX_COMPLETE`: diagnosis, row-level contract evidence, confirmed RED, implementation, GREEN checks, `[🪳 TEMP {TOPIC}]` diagnostic logging, changed files, and limitations.

**DONE when:** root cause is grounded and its hypotheses were traced by dispatched analysts; the product and technical direct blast radius was independently explored after the candidate repair boundary was known; no row is `unresolved`; for `full`, authorization is valid, the intended regression is RED→GREEN, affected checks have no attributable failure, and unrelated findings are routed; and the parent receives the result.

## Method / guardrails

1. **Diagnose.** Generate 5–7 hypotheses; reduce to 1–2 via evidence/data-flow/changes/paths; dispatch parallel `@spectre_analyst` traces; reproduce; synthesize one cause-level repair.
2. **Explore product + technical impact.** Once root cause and candidate repair boundary are grounded, dispatch ≥1 independent read-only `@spectre_analyst`; parallelize separable product journeys or technical boundaries. Trace shared callers, state, and data paths through to user/operator-observable outcomes. Return compact experience-contract rows that explicitly identify experiences that change, remain invariant, or are unresolved; synthesize and deduplicate the results.
3. **Honor phase.** `diagnose` returns `DIAGNOSIS_READY` before any code write.
4. **Verify authorization before repair.**
   - `full` proceeds only when Delegate supplies a readable scope artifact whose recomputed SHA-256 equals `AUTHORIZED_SCOPE_SHA256`, whose alignment mode is `inferred`, and the diagnosis, repair, and every experience-contract row remain inside it.
   - An `unresolved` row or out-of-scope collateral change blocks repair.
5. **Repair test-first.** Confirm the intended-change regression RED for the diagnosed reason; capture risk-proportional preserved-invariant checks; implement the smallest root-cause fix plus `[🪳 TEMP {TOPIC}]` logging; then prove the contract and affected deterministic checks GREEN.
6. **Attribute and continue.** Classify extras `branch-caused|unrelated|indeterminate`; repair, route, or focus-check. If failed repair leaves third-party cause unclear, dispatch `@spectre_web_research` on pinned docs/code/issues, then analogs; revise hypotheses + RED before mutation. Broad baseline red never blocks.
7. **Contain scope.** Do not broaden behavior, hide failures, weaken assertions, bypass checks, or treat an unrelated defect as authorized. A new or changed experience-contract row or repair boundary returns to authorization.

## Handoff

Return the phase status, the hypothesis set, diagnosis, experience contract with row-level evidence, authorization path/hash/mode, RED/GREEN evidence, changed files, checks, limitations, and exact validation steps. The parent owns all user-facing Next Steps.

## Escalate-If

- The report is too thin to form testable hypotheses, reproduction is unavailable, no root cause can be grounded, impact evidence conflicts, or desired behavior remains unresolved.
- Authorization is absent, stale, unreadable, hash/mode-mismatched, does not match the diagnosis/experience contract, or the repair exceeds the authorized scope.
- The regression cannot establish the cause, evidence contradicts it, or further safe action needs authority. Never escalate for unrelated red checks, unavailable broad suites, attempt count, or authorized related-file growth.
