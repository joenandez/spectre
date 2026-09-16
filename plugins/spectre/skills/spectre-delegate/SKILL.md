---
name: "spectre-delegate"
description: "Delegate one small, unambiguous feature or reproducible bug fix to Spectre's autonomous TDD→opposite-runtime review→proof→draft-PR flow. Not for ambiguous/multi-area/high-risk/non-code work."
user-invocable: true
disable-model-invocation: true
---

# delegate

## Purpose

Run Spectre autonomously from inferred scope through TDD, adversarial review, proof, and a draft PR. CI owns verification; never merge/deploy/release.

## Inputs

- `$ARGUMENTS`: request, references, optional target, and optional managed feature/root/descendant. Read references fully; if empty, ask and wait. Default: `origin/main`.

## Working Set

- Late-bind checkout, diff, commands, and target.
- **Mini eligibility:** ≤2 dependency-safe workstreams; no auth/payment/permissions, migration/data-loss, public-contract breakage, concurrency/order/retry, destructive operation, new infrastructure, or unresolved product/UX choice. If ineligible, stop before more mutation: fix → `/spectre:spectre-fix`; feature → `/spectre:spectre-plan`.

## Feature root contract

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged. Type `fix` initializes `KIND=bug`; keep `{FEATURE_ROOT}/bug-report.md` as its run record.

## Outputs + DONE

- `SCOPE_FILE` + hash: **Alignment: inferred** · Type `feature|fix` · Objective · IN/OUT/ANTI-SCOPE · ACs · Proof Journeys · Assumptions · Target Branch.
- Collision-safe `QUICK_PLAN_FILE`: Agreed Scope · Research · Approach · 1–2 ordered Workstreams · Success Criteria; map every IN item to implementation/proof.
- RED→GREEN commits, affected-check summary, one opposite-runtime-first `Skill(spectre-code_review)` before focused proof, committed review/proof artifacts, rebase, tuple, `CI: pending`, draft PR.

**DONE:** immutable scope and affected TDD cover the blast radius; one opposite-runtime-first adversarial `Skill(spectre-code_review)` ran after all implementation/checks and before proof; bounded review/proof repairs are dispositioned; required review and proof artifacts are committed while local lifecycle residue is excluded; draft PR URL returned. No root suite, cleanup meta-flow, merge, deploy, release, or public proof publication. Non-green status is disclosed but does not alone prevent a draft PR; CI merge-gates.

## Method / guardrails

1. **Isolate.** Before any artifact or product write, snapshot `git status --porcelain=v1 --untracked-files=all`. A clean linked worktree stays in place on a non-protected branch. For a dirty linked worktree or any primary/local checkout, leave source untouched; create a clean sibling worktree/branch from committed `HEAD`; never stash, reset, commit, copy, or carry pre-existing changes. Route without confirmation; run every child in the selected checkout; never commit to `main`/`master`.
2. **Infer and plan.** Use targeted reads; dispatch a specialist only for material uncertainty. Write/hash `SCOPE_FILE` without confirmation, record assumptions, then write `QUICK_PLAN_FILE`. Scope freezes when mutation begins.
3. **Execute test-first.** Feature: run `Skill(spectre-execute)` in plan-direct mode with the authoritative `QUICK_PLAN_FILE`, `{FEATURE_ROOT}`, explicit `--origin delegate`, `--orchestrated`, `--finalization-owner parent`, and `--review-profile final-only`. Require RED-before-GREEN TDD, assignment commits, affected checks, and `IMPLEMENTATION_READY` + `ACCEPTANCE_PENDING` + `FINAL_REVIEW_PENDING`. Fix: run `Skill(spectre-fix-core)` with the bug report, `PHASE=full`, `PARENT=spectre-delegate`, `PARENT_AUTHORIZATION={SCOPE_FILE}`, `AUTHORIZED_SCOPE_SHA256={SCOPE_SHA256}`, `ALIGNMENT_MODE=inferred`, and `--orchestrated`; then write the report Outcome.
4. **Close out directly.** Never invoke `spectre-create_tasks`, `spectre-clean`, `spectre-test`, `spectre-sweep`, `spectre-prune`, `spectre-validate`, or a root suite. Run `git diff --check`; confirm current affected evidence and no unrelated/sensitive changes; conventionally commit workflow-owned residue. Run `Skill(spectre-rebase)` with target, mandatory backup, `--orchestrated`, and `--verification-owner parent`; require `REBASE_READY`.
5. **Pin and run the final adversarial review.** Do not invoke review until every implementation workstream/task is complete and current affected checks exist. Capture `BASE_SHA`, `HEAD_SHA`, and `DIFF_SHA256=sha256(bytes(git diff --binary --full-index --no-ext-diff --no-color --no-renames {BASE_SHA}...{HEAD_SHA}))`. Run `Skill(spectre-code_review)` exactly once with `{FEATURE_ROOT}`, `SCOPE_FILE`, `QUICK_PLAN_FILE` as the explicit source plan, the candidate tuple, and `--orchestrated`. Its external-first contract owns opposite-runtime selection; accept a native fallback only with its recorded reason. Require the report path, reviewer runtime/model/effort/route, verdict, CRITICAL/HIGH findings, and per-AC delivery coverage. Verify the tuple is unchanged. Attributable findings get ≤1 consolidated repair pass through the same owner: rerun affected checks, commit repair residue, record `repaired-verified|repaired-unverified|unresolved|scope-change|unrelated`, and recapture the tuple. Never rerun or validate the review; disclose persistent findings. Commit the canonical review decision separately after dispositions.
6. **Prove after review.** Only after review findings are dispositioned and affected checks are current, run `Skill(spectre-prove)` with `{FEATURE_ROOT}`, `SCOPE_FILE`, `SCOPE_SHA256`, `QUICK_PLAN_FILE`, `--profile focused`, and `--orchestrated`. Give attributable observable failures ≤1 behavior-repair pass through the same owner, rerun affected checks, commit repair residue, and reprove only failed/impact-linked rows. Never rerun the code review. Commit required `proof.json` and `proof.html`, recapture the tuple, and disclose persistent failures.
7. **Open the boundary.** Build `VERIFICATION_SUMMARY`: TDD/affected scope, dispositions, no root-suite run, `CI: pending`. Run `Skill(spectre-create_pr)` with target, `EXPECTED_BASE_SHA={BASE_SHA}`, `EXPECTED_HEAD_SHA={HEAD_SHA}`, `EXPECTED_DIFF_SHA256={DIFF_SHA256}`, summary, `--draft`, and `--orchestrated`. On `PR_CANDIDATE_STALE`, refresh the tuple and retry without a cap. Never force-push unrelated history, bypass/suppress checks, merge, deploy, or release.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return scope/evidence/review/proof/tuple/rebase/limits/PR. Next: review proof and draft PR.

## Escalate-If

- Mini eligibility fails → `/spectre:spectre-fix` for fixes or `/spectre:spectre-plan` for features; unclear boundaries → `/spectre:spectre-scope`.
- Conflicting acceptance, scope-changing repair, missing authority/capability, unsafe checkout/rebase/remote, or secrets/PII.
- Never escalate solely for repairable/disclosable check, review, proof, or candidate-drift failures.
