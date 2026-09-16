---
name: "spectre-plan_review"
description: "Correct and aggressively simplify plan.md after create_plan. Do not review tasks/code, change Scope, or add speculative completeness."
user-invocable: true
---

# plan_review

## Purpose

Produce the smallest correct plan through one evidence wave, correctness review, then subtraction-first simplification.

## Inputs

- `$ARGUMENTS`: feature root/name or exact selected plan path; optional explicit authority sources, `--auto-apply scope-safe`, `--orchestrated`.
- Require the selected plan or route to `/spectre:spectre-create_plan`. Authority sources are `concepts/scope.md`, `specs/prd.md`, `specs/ux.md`, explicit `task_context.md` requirements, or the selected plan's explicit requirements/boundaries when no separate Scope exists. When present, pass the selected minimum-solution record from `task_context.md`; plans without a Plan-origin selection retain existing behavior. Reuse existing research.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Review the exact selected plan path. Never copy its prose into another authoritative plan, overwrite a sibling plan, or manufacture a second Scope document.
- Reports: `reviews/plan_correctness.md` and `reviews/plan_review.md`. Resume a sole correctness report only when its post-edit hash matches the selected plan; otherwise use absent canonical paths or timestamped siblings.

## Outputs + DONE

- `plan_correctness.md`: route/model metadata and hashes; evidence/unknowns; findings; retained constraints/tests; dispositions and resulting edits.
- `plan_review.md`: correctness path/hash; deletions, collapses, reuse, deferrals, retained exceptions, test reductions, findings/dispositions, and structural Before → After.
- Reports are deltas; never restate the plan.

DONE when both stages complete; research ran once at most; every mechanism traces to a current requirement, constraint, prerequisite, or verified fact; every new complexity boundary has a valid exception; the plan is smaller in mechanisms, surfaces, process, or tests—or proves no safe reduction; behavior and constraints survive; no correctness Blocker/High remains; scope changes are withheld; findings are disposed; hashes/write bounds pass; and direct-mode Verification is executable.

## Method / guardrails

**Canonical Scope Invariant:** correct and simplify implementation means without narrowing, expanding, or reinterpreting Scope. Mark boundary changes `Scope Change Required`; never auto-apply them.

1. **Evidence.** Identify unsupported material claims. If needed, use at most one each `@spectre:finder`, `@spectre:analyst`, and `@spectre:patterns`, in parallel, for citation-first evidence/unknowns only (≤1,000 tokens total).

2. **Correctness.** Read `references/correctness-review.md` and send it verbatim to a fresh reviewer with: plan, Scope, task-context, and report paths/hashes; compiled evidence/unknowns; edit mode and write bounds; route metadata.

3. **Simplification.** After correctness writeback, read `references/simplification-review.md` and send it verbatim to a second fresh reviewer with: corrected plan, Scope, correctness-report, and output-report paths/hashes; selected minimum-solution record when present; edit mode/write bounds; route metadata. Supply existing evidence; one cited spot-check.

4. **Writeback.** Reviewers write only their report and the selected plan, with the report written before plan edits; scope/context/tasks/code remain immutable. `--auto-apply scope-safe` permits Blocker/High and unambiguous Medium edits; otherwise ask `all|blockers|IDs|skip`, then continue on the same route. Record `addressed|skipped|unresolved|scope-change`. Stop on unresolved correctness Blocker/High, scope change, unavailable writeback, or failed schema/hash/scope/Out-of-Bounds checks. The primary may normalize mechanics, never semantics.

5. **Route.** Run each stage fresh at high effort (20-minute limit): Codex → Claude Code `opus`; Claude Code → Codex `gpt-5.6-sol`. Record stage/runtime/model/effort/route. If unusable, use one clean-context native `@spectre:reviewer` with the same template and context. A usable review is terminal.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return routes/correctness/deletions/exceptions/delta/dispositions/reports/withheld scope/plan (≤1K). `--orchestrated`: return; standalone → `/spectre:spectre-create_tasks` or direct `/spectre:spectre-execute` resolved plan + `--origin plan`.

## Escalate-If

Plan missing; a material claim remains unknowable; scope change is required; correctness Blocker/High remains; writeback is unavailable; or schema/hash/scope/Out-of-Bounds checks fail.
