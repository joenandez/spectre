---
name: "spectre-clean"
description: "Meta cleanup utility: orchestrate parallel prune and risk-based tests, then one sweep/commit boundary. Use mid-work or before rebase/create-pr. Do NOT use as Ship's dependency, or for dead-code-only cleanup (spectre-prune), test-only work (spectre-test), commit-only hygiene (spectre-sweep), bug fixes (spectre-fix), or scoping/planning."
user-invocable: true
---

# clean

End-to-end cleanup utility. The primary owns scope, risk, sequencing, and synthesis. Ship calls `spectre-prune`/`spectre-test`/`spectre-sweep` directly, never Clean.

## Inputs

- `$ARGUMENTS` — optional scope hint: commit/SHA, `unstaged`/`staged`, `context`/session, task dir, files, or `--orchestrated` when a parent workflow owns the next step.
- `FEATURE_ROOT` — explicit feature name/root or one descendant feature artifact.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Resolve the same full working set used by prune/test/sweep from committed changes, staged, unstaged, and untracked files. If a provided ref/scope is invalid or ambiguous, stop and ask.
- Keep the resolved file set and primary's compact P0-P3 risk plan in-thread; write no working-set/lifecycle artifact.

## Outputs + DONE

- Parallel prune/test worker results; manual-review/cross-boundary items preserved.
- Primary P0-P3 risk plan, compact check results, one Sweep verification/commit boundary, and `CLEANED_THROUGH_SHA`.
- Report: prune/manual review · risk tiers · tests/checks · routed findings · sweep commits · `CLEANED_THROUGH_SHA` · `NEEDS_AUTHORITY`, if any.
- **DONE when:** the primary followed each phase contract, supplied risk tiers, and finished required analyst/tester batches; phase repairs/routing and manual review are complete, and sweep committed or returned genuine `NEEDS_AUTHORITY`.

## Method / guardrails

1. **Resolve scope once.** Establish files and feature root. Keep dynamic details out of the prompt body; read them live.
2. **Primary risk assessment.** Classify every resolved file P0-P3:
   - **P0:** auth/payment/security/crypto/session/token, PII/permissions/user-data mutation, external handlers, DB migrations, `@critical`.
   - **P1:** feature components, API/state/business logic, fetch/cache, user-visible errors.
   - **P2:** exported real-logic utilities, validators, transformers, adapters, hooks.
   - **P3:** docs/styles/config/types/constants/barrels/pass-throughs/generated files.
   Keep a compact plan in-thread: `- [P{tier}] {file}: {behavior or SKIP reason}`.
3. **Parallel phases.** In this primary load/follow `Skill(spectre-prune)` and `Skill(spectre-test)` with the unchanged set, `{FEATURE_ROOT}`, risk plan, and `--orchestrated`. Skill loading imports instructions, not phase delegation: the primary directly dispatches required leaf analyst/tester batches in one parallel boundary. Return compact paths/checks, manual review, and cross-boundary needs; neither phase stages/commits.
4. **Sweep phase.** Dispatch a sweep lead with the unchanged set and compact phase results. `Skill(spectre-sweep)` runs only stale/uncovered integrated checks, repairs attributable failures, and is the sole pre-rebase commit owner.
5. **Synthesize.** Route repairable/cross-boundary findings; report final state, Sweep commit `CLEANED_THROUGH_SHA`, routes, and genuine authority/safety impasses.

Guardrails:
- Do not inline the bodies of prune/test/sweep; call the skills.
- The primary applies only analyst-supported `CONFIRMED_SAFE` prune edits; tester agents own tests/fixtures; the Sweep child alone stages/commits. Phase repairs continue without a user gate.
- `CONFIRMED_SAFE` cleanup may be applied; `UNCERTAIN`/`UNSAFE` cleanup stays untouched and appears in final manual review.
- `--no-verify`, lint/type suppressions, and forced green are forbidden unless the user explicitly permits them.

## Handoff

`NEEDS_AUTHORITY`: phase/impasse/manual review. Ordinary test/lint/build failures never produce it; repair them. `--orchestrated`: result + `CLEANED_THROUGH_SHA`, no step.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** |Done|
| 📦 **What was just done** |Result|
| ▶️ **Proposed next step** | Render resolved action. |

Standalone: `/spectre:spectre-rebase`; acceptance needed: alternative `/spectre:spectre-prove`.

## Escalate-If

- Scope is ambiguous, a ref is invalid, or no meaningful working set exists.
- A phase skill conflicts with this orchestration contract; surface the conflict instead of improvising.
- P0 coverage exposes a product-requirement or user-authority conflict with no safe executable alternative; ordinary coverage gaps remain in repair/adaptation.
- Sweep finds secrets/PII or cannot commit without bypassing verification.
