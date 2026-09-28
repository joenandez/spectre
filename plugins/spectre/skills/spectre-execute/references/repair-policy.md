# Execute repair policy

Load on the first verification failure, review finding, E2E gap, or proof failure; reuse thereafter.

## Verification continuation

- `branch-caused`: group by invariant/root cause, repair, then rerun the failing and affected checks.
- `unrelated`: record or route follow-up work and continue; it cannot block the wave or execution.
- `indeterminate`: reproduce. If a failed repair leaves third-party cause unclear, dispatch `@spectre:web-research` on pinned docs/code/issues, then analogs; revise hypothesis + RED before mutation. Use base SHA only for that check; repair or route.

Expand only across evidenced dependency/consumer/integration/lifecycle boundaries; store coverage locally, exclude raw output from child prompts, and block review until attributable deterministic checks pass.

## Review findings

- Classify CRITICAL/HIGH as `defect` (completed requirement violated; related-file growth allowed), `scheduled` (pending source work owns it), `scope-change` (authority required), or `unrelated`.
- Each triggered intermediate or final review runs once. Group compatible defects into one consolidated root-cause repair pass. `@spectre:dev` owns repairs; the primary may make one localized follow-up to returned work only when it adds no behavior, acceptance criterion, dependency, or workstream.
- Run affected verification, then record `repaired-verified|repaired-unverified|unresolved|scheduled|scope-change|unrelated`. The original review remains unchanged; a failed check creates check work, not another review pass.
- Never dispatch a reviewer solely to validate a repair. A later risk-triggered intermediate or final review may independently rediscover the issue and gets its own pass; there is no global lifetime cap across distinct scheduled reviews.

## Adaptation and proof

- Structured mode appends/updates only required `tasks.json` work and affected index rows. Plan-direct adds only demonstrated plan-backed derivative work and affected map rows; never rewrite the plan or add nice-to-haves.
- Final-review repair gets affected verification and dispositions; never rerun or replace the comprehensive review.
- Classify each non-PASS as `repairable|needs-authority|unrelated`; continue independent work and batch compatible root-cause repairs. Before another full Proof pass, recheck failed and changed-seam public journeys plus Proof's cheap invariants at affected stages. Record seam/row selection and observed results in the local verification ledger; uncertainty expands coverage. Persist sanitized external inputs for replay when repetition warrants it; replay is diagnostic, never live acceptance. Stop only at aggregate `PASS` or when every remainder is `NEEDS_AUTHORITY`; never code-review proof repair.
- `NEEDS_AUTHORITY` only for conflicting acceptance, unavailable authority/capability, required scope change, or unsafe/unauthorized action.
