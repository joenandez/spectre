---
name: "spectre-plan_review"
description: "Correct/simplify post-create; no tasks/code/Scope/speculation."
user-invocable: true
---

# plan_review

## Purpose

smallest correct plan: evidence-led, subtraction-first simplification.

## Inputs

- `$ARGUMENTS`: root/path; authority sources, `--auto-apply scope-safe`, `--orchestrated`.
- Need plan or `$spectre:spectre-create_plan`; authority: Scope/PRD/UX, `task_context.md`, requirements. Pass selected minimum-solution record; Plan-origin selection retains behavior/research.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Review exact selected plan path. Never copy prose, overwrite a sibling, or make a second Scope document.
- Reports: `reviews/plan_correctness.md`, `reviews/plan_review.md`; resume only if post-edit hash matches selected plan, else absent/timestamped sibling.

## Outputs + DONE

- Reports: route/hashes/attempt; evidence/retained constraints/tests; findings/dispositions/edits; simplification reductions/exceptions, Before → After.
- Reports are deltas; never restate plan.

DONE: both stages; evidence traces mechanisms/exceptions; plan smaller or no safe reduction; behavior/constraints survive; no correctness Blocker/High; scope withheld; findings/hashes/bounds pass; direct-mode Verification is executable.

## Method / guardrails

**Scope Invariant:** revise means, never Scope. Mark boundary change `Scope Change Required`; never auto-apply.

1. **Evidence.** Find unsupported claims; at most one each `@spectre_finder`, `@spectre_analyst`, `@spectre_patterns` in parallel for cited evidence/unknowns (≤1,000 tokens).

2. **Correctness.** Read `references/correctness-review.md`; send it verbatim to a fresh reviewer; inject exact envelope below into `REVIEW_PROMPT` with plan, Scope, task-context, report paths/hashes, evidence, mode/bounds/metadata. Run; close after valid writeback.

3. **Simplification.** Correctness closes before simplification: read `references/simplification-review.md`; send it verbatim to a second fresh reviewer; inject exact envelope below into `REVIEW_PROMPT` with corrected plan, Scope, correctness-report, output-report paths/hashes, selection, bounds/metadata/evidence, cited spot-check. Run.

4. **Writeback.** Read-only reviewers return exactly:
`REPORT_BEGIN
<verbatim report>
REPORT_END
ROUTE <stage|runtime|model|effort>
HASHES <name>=sha256:<hex>[,...]
PATCH_BEGIN
<exact unified diff|NOOP>
PATCH_END`
Envelope `HASHES` contains only injected pre-edit hashes. Orchestrator verifies pre-hashes/bounds; persists report verbatim before applying its patch; records external-attempt; mechanically applies only patch; computes/records post-write hashes/bounds, verifies them; never invents findings/semantic edits. Only two canonical reports and selected plan may change; patch targets only selected plan; execution state/all other artifacts immutable. `--auto-apply scope-safe`: Blocker/High + unambiguous Medium; else ask `all|blockers|IDs|skip`, continue same route; record `addressed|skipped|unresolved|scope-change`. Stop unresolved correctness Blocker/High, scope change, unavailable writeback, or failed schema/hash/scope/bounds.

5. **Route.** Run each stage fresh at high effort (20-minute limit): Codex → Claude Code `opus`: `claude -p --model opus --effort high --permission-mode dontAsk --allowedTools "Read,Grep,Glob,LS" --output-format text "$REVIEW_PROMPT"`; Claude Code → Codex `gpt-5.6-sol`: `codex exec -C "$PWD" -m gpt-5.6-sol -c 'model_reasoning_effort="high"' -s read-only "$REVIEW_PROMPT"`. Record each external attempt: launch route/status, failure class/fallback-used. Quiet output is not failure. Only missing, non-zero, absent/malformed envelope, hash mismatch, or out-of-bounds permits fallback: record failure before one clean-context native `@spectre_reviewer` with same template/context; it returns verbatim report body + exact unified patch/no-op, never writes. A usable review is terminal; fallback once.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return outcome/reports/attempt/Scope/plan (≤1K). `--orchestrated`: return; standalone → `$spectre:spectre-create_tasks` or direct `$spectre:spectre-execute` plan + `--origin plan`.

## Escalate-If

Escalate: missing plan/claim, scope change, correctness Blocker/High, unavailable writeback/bounds.
