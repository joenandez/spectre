---
name: "spectre-task_review"
description: "Review tasks.json for correct, complete, executable translation of its reviewed plan before execute.md is finalized. Use for comprehensive task-graph review or explicit re-review. Do not review plan quality, finished code, index formatting, or change scope."
user-invocable: true
---

# task_review

## Purpose

Run one independent semantic review of the complete task graph, apply authorized task corrections, and prove the reviewed graph can be implemented correctly without avoidable rework. State WHAT must hold; trust the reviewer to determine findings and edits.

## Inputs

- `$ARGUMENTS`: explicit feature root/name or descendant task artifact; `--mode adversarial|full`; optional `--auto-apply scope-safe`; `--review-again` only when the user's latest instruction explicitly requests another completed review.
- Required: reviewed `specs/plan.md` and parseable `specs/tasks.json` (or explicit scoped `.tasks.json`). `execute.md` is not an input.
- Canonical scope/PRD/UX/context/research under the same feature root when present.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- `TASKS_JSON`: selected task graph. `REVIEW_REPORT`: `reviews/task_review.md`, or a timestamped sibling only for authorized `--review-again`.
- `REVIEW_ATTEMPT`: `reviews/task_review_attempt.json`, the durable one-round recovery ledger with `round_status: in_progress|report_ready|complete|incomplete`, report/authorization/route state, allowed writes, and pre/post task hashes.
- `PREFLIGHT_JSON`: `reviews/task_review_safety.json`, produced by the adjacent `scripts/task-review-safety.mjs` helper.

## Outputs + DONE

The reviewer owns `TASKS_JSON` and `REVIEW_REPORT`; no other canonical artifact may change. The report contains:

- feature/root metadata;
- Findings: `# | Severity | Lens | Location | Finding | Suggested Edit`;
- coverage/Out-of-Bounds summary;
- one disposition per finding: `unresolved|applied|skipped|scope-change`, with resulting task edit when applied;
- reviewed artifacts, mode, timestamp, auto-apply setting, runtime/model/effort/route, and fallback reason when applicable.

DONE when the attempt is `complete`; findings preceded edits; every finding has evidence, a concrete consequence/edit, and a disposition; authorized edits touch only the task graph/report; task JSON parses; deterministic report/post-write checks pass; protected plan/scope hashes match; route and pre/post hashes are recorded; and Scope Change Required findings remain unapplied.

## Method / guardrails

1. **Establish safety.** Run the helper's `preflight` before reviewer tokens. Hard failures stop; advisories inform the semantic reviewer. The helper validates consumer safety, not semantic quality, and never authorizes or restarts review work; do not use its retired `impact` operation.
2. **Run one semantic review per authorized round.** A completed report ends the round; only an explicit user `--review-again` authorizes another. Otherwise use the available opposite runtime at pinned medium effort (Codex → Claude `opus`; Claude → Codex `gpt-5.6-sol`). Allow up to 20 minutes; quiet output alone is not failure. Adversarial mode reviews the whole graph in one pass; Full mode may use its permitted lens workers within that same review. If the opposing route fails to produce a usable report, dispatch one clean-context `@spectre_reviewer` as the fallback under the same ledger/report. Resume incomplete or `report_ready` state instead of starting another review.
3. **Judge the translation as a whole.** The goal is not checklist completion: determine whether `tasks.json` correctly and completely translates the reviewed plan into an executable graph that can be implemented once, the right way, without avoidable rework. Use these lenses as guidance, not an exhaustive taxonomy or a limit on evidence-backed reviewer judgment:
   - **Coverage:** every plan verification and Out-of-Bounds obligation is represented.
   - **Executability:** acceptance criteria are falsifiable, behavior-changing builds own RED-before-GREEN, separate RED work is independently dispatchable, and splits reflect outcomes/dependencies rather than file/LOC counts alone.
   - **Integration graph:** real producer/consumer wiring, dependencies, and ordering are correct.
   - **Reference quality:** context points to relevant implementation evidence.

   Reject terminal verification/E2E tasks owned by Execute or Prove unless they produce an explicit prerequisite or product-consumed artifact at a product-owned path.

   The reviewer may raise any evidence-backed translation risk that threatens correctness, completeness, integration, executability, or creates likely rework. Severity is `Blocker|High|Medium|Low|Scope Change Required`. Canonical scope and `plan.md` remain immutable; findings that require changing either are Scope Change Required.
4. **Apply only authorized findings.** Write all findings before edits. With `--auto-apply scope-safe`, apply scope-safe Blocker/High and unambiguous translation-only Medium/Low findings. Otherwise obtain the user's selection and continue the same reviewer route for writeback only. Preserve task IDs when possible. The primary may repair mechanical report/schema metadata from existing reviewer evidence, but may not invent findings, reinterpret them, or perform semantic task edits.
5. **Close deterministically.** Run helper `validate-report`, reparse and postflight the task graph, verify protected inputs, and record hashes/state. Preserve `report_ready` or `incomplete` recovery state when closure fails. The planning caller finalizes `execute.md` only after completion, then runs `validate-pair`.

## Handoff

Return runtime/fallback/findings/dispositions/report/tasks/parse/validation/scope change; `--orchestrated`: no step.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone unresolved Blocker/High stays remediation; resolved review → Execute resolved absolute execute index + `--origin plan`.

## Escalate-If

- Missing/unparseable plan or task graph → `$spectre:spectre-create_plan` or `$spectre:spectre-create_tasks`.
- A correction changes scope or plan meaning → record Scope Change Required and withhold it.
- No route yields a usable report, or deterministic close fails → preserve recovery state and surface the blocker; do not request `--review-again`.
