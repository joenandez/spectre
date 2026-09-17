---
name: "spectre-plan_review"
description: "Correct and aggressively simplify plan.md after create_plan. Do not review tasks/code, change Scope, or add speculative completeness."
user-invocable: true
---

# plan_review

## Purpose

Produce the smallest correct plan: evidence, correctness, subtraction-first simplification.

## Inputs

- `$ARGUMENTS`: feature root/name or exact plan path; optional authority sources, `--auto-apply scope-safe`, `--orchestrated`.
- Need plan or `$spectre:spectre-create_plan`; authority: Scope/PRD/UX, `task_context.md`, or plan requirements without Scope. Pass selected minimum-solution record; Plan-origin selection retains behavior; reuse research.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Review exact selected plan path. Never copy prose into another authority, overwrite a sibling, or make a second Scope document.
- Reports: `reviews/plan_correctness.md`, `reviews/plan_review.md`; resume correctness only when post-edit hash matches selected plan, else canonical absent path/timestamped sibling.

## Outputs + DONE

- `plan_correctness.md`: route/hashes, evidence, retained constraints/tests, findings/dispositions/edits.
- `plan_review.md`: correctness path/hash, reductions/exceptions/tests, findings/dispositions, Before → After.
- Reports are deltas; never restate the plan.

DONE: both stages; one research wave; authority traces mechanisms/exceptions; plan smaller or no safe reduction; behavior/constraints survive; no correctness Blocker/High; scope withheld; findings disposed; hashes/bounds pass; direct-mode Verification is executable.

## Method / guardrails

**Scope Invariant:** revise means, never Scope. Mark boundary change `Scope Change Required`; never auto-apply.

1. **Evidence.** Find unsupported claims; if needed, at most one each `@spectre_finder`, `@spectre_analyst`, `@spectre_patterns` in parallel for cited evidence/unknowns (≤1,000 tokens).

2. **Correctness.** Read `references/correctness-review.md`; send it verbatim to a fresh reviewer; inject exact envelope below into `REVIEW_PROMPT` with plan, Scope, task-context, report paths/hashes, evidence, mode/bounds, route metadata. Run Route; close after valid writeback.

3. **Simplification.** Correctness closes before simplification: read `references/simplification-review.md`; send it verbatim to a second fresh reviewer; inject exact envelope below into `REVIEW_PROMPT` with corrected plan, Scope, correctness-report, output-report paths/hashes, selection, bounds/metadata/evidence, one cited spot-check. Run Route.

4. **Writeback.** Read-only reviewers return exactly:
`REPORT_BEGIN
<verbatim report>
REPORT_END
ROUTE <stage|runtime|model|effort>
HASHES <name>=sha256:<hex>[,...]
PATCH_BEGIN
<exact unified diff|NOOP>
PATCH_END`
Orchestrator verifies pre-hashes/bounds, persists report verbatim, mechanically applies only patch, verifies post-hashes/bounds; never invents findings/semantic edits. Scope/context/tasks/code immutable. `--auto-apply scope-safe` permits Blocker/High + unambiguous Medium; else ask `all|blockers|IDs|skip`, continue same route; record `addressed|skipped|unresolved|scope-change`. Stop unresolved correctness Blocker/High, scope change, unavailable writeback, or failed schema/hash/scope/Out-of-Bounds checks.

5. **Route.** Run each stage fresh at high effort (20-minute limit): Codex → Claude Code `opus`: `claude -p --model opus --effort high --permission-mode dontAsk "$REVIEW_PROMPT"`; Claude Code → Codex `gpt-5.6-sol`: `codex exec -C "$PWD" -m gpt-5.6-sol -c 'model_reasoning_effort="high"' -s read-only "$REVIEW_PROMPT"`. Record stage/runtime/model/effort/route. Only missing, non-zero, absent/malformed envelope, hash mismatch, or out-of-bounds permits fallback: record failure before one clean-context native `@spectre_reviewer` with same template/context; it returns verbatim report body + exact unified patch/no-op, never writes. A usable review is terminal; fallback once.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return outcome/reports/Scope/plan (≤1K). `--orchestrated`: return; standalone → `$spectre:spectre-create_tasks` or direct `$spectre:spectre-execute` plan + `--origin plan`.

## Escalate-If

Escalate: missing plan, unknowable claim, scope change, correctness Blocker/High, unavailable writeback, bounds failure.
