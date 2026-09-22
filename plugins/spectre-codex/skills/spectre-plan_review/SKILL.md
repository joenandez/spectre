---
name: "spectre-plan_review"
description: "Correct/simplify post-create; no tasks/code/Scope/speculation."
user-invocable: true
---

# plan_review

## Purpose

smallest correct plan.

## Inputs

- `$ARGUMENTS`: root/path; sources, `--auto-apply scope-safe`, `--orchestrated`.
- Need plan or `$spectre:spectre-create_plan`; authority: Scope/PRD/UX, `task_context.md`, requirements. Pass selection; Plan-origin retains behavior/research.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Review exact selected-plan path; never copy prose, overwrite siblings, or create Scope.
- Reports: `reviews/plan_correctness.md`, `reviews/plan_review.md`; resume only if post-edit plan hash matches, else absent/timestamped sibling.

## Outputs + DONE

- Reports: route/hashes/attempt; evidence/constraints/tests; findings/dispositions/edits; reductions/exceptions, Before → After.
- Reports are deltas; never restate plan.

DONE: both; evidence traces mechanisms/exceptions; plan smaller or no safe reduction; behavior/constraints survive; no correctness Blocker/High; scope withheld; hashes/bounds pass; direct-mode Verification is executable.

## Method / guardrails

**Scope Invariant:** revise means, never Scope; mark boundary change `Scope Change Required`; never auto-apply.

1. **Evidence.** Find unsupported claims; at most one each `@spectre_finder`, `@spectre_analyst`, `@spectre_patterns` for cited evidence/unknowns (≤1,000 tokens).

2. **Correctness.** Read `references/correctness-review.md`; send it verbatim to a fresh reviewer; inject direct-write receipt below into `REVIEW_PROMPT` with plan, Scope, task-context, report paths/hashes, evidence, mode/bounds/metadata.

3. **Simplification.** Correctness closes before simplification: read `references/simplification-review.md`; send it verbatim to a fresh reviewer; inject direct-write receipt below into `REVIEW_PROMPT` with corrected plan, Scope, correctness-report, output-report paths/hashes, selection, bounds/metadata/evidence, spot-check, decisions.

4. **Writeback.** Reviewer writes its report before selected-plan edits, then returns only:
`REVIEW_COMPLETE
ROUTE <stage|runtime|model|effort>
REPORT_SHA256 sha256:<hex>
PLAN_SHA256 sha256:<hex>
DISPOSITION <updated|no-op>
PLAN_REVIEW_<STAGE>_OK`
Primary validates completed route, report, hashes/disposition/bounds; records attempt. Only reports and selected plan may change; `updated` changes plan, `no-op` does not; all else immutable. Primary never writes reviewer findings or plan edits. `--auto-apply scope-safe`: Blocker/High + unambiguous Medium; else ask `all|blockers|IDs|skip`; record `addressed|skipped|unresolved|scope-change`. Stop on unresolved correctness Blocker/High, scope change, unavailable writeback, or failed receipt/hash/scope/bounds. Decisions, even Scope edits, resume at simplification; correctness never reruns.

5. **Route.** Run each stage fresh at high effort (20-minute limit): Codex → Claude Code `opus`: `claude -p --model opus --effort high --permission-mode dontAsk --allowedTools "Read,Grep,Glob,LS,Write,Edit,Bash(shasum -a 256 *)" --output-format text "$REVIEW_PROMPT"`; Claude Code → Codex `gpt-5.6-sol`: `codex exec -C "$PWD" -m gpt-5.6-sol -c 'model_reasoning_effort="high"' -s workspace-write "$REVIEW_PROMPT" < /dev/null`. Record each external attempt: launch route/status, failure class/fallback-used. Quiet output is not failure. Only missing, non-zero, absent/malformed completion receipt, hash mismatch, or out-of-bounds permits fallback: record failure before one fresh clean-context same-runtime CLI fallback with writable mode/prompt/bounds. A usable review is terminal.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return outcome/reports/attempt/Scope/plan (≤1K). `--orchestrated`: return; standalone → `$spectre:spectre-create_tasks` or direct `$spectre:spectre-execute` plan + `--origin plan`.

## Escalate-If

Step 4 stops; missing plan/claim.
