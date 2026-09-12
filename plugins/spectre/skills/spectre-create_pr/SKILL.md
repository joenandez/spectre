---
name: "spectre-create_pr"
description: "Generate a grounded draft pull request from the actual diff and open it via gh. Use when wrapping up a branch or writing a PR description; not to commit/clean (spectre-sweep), rebase (spectre-rebase), or autonomously deliver a request (spectre-delegate)."
user-invocable: true
---

# create_pr

Produce a grounded draft PR.

## Inputs

- `$ARGUMENTS`: `TARGET_BRANCH` (default `origin/main`), feedback focus, verification, all-or-none `EXPECTED_BASE_SHA`/`EXPECTED_HEAD_SHA`/`EXPECTED_DIFF_SHA256`, or `--orchestrated`.
- Orchestrated `--pr-phase pending|final-update`: pending needs complete candidate tuple, local verification `RUNNING`, and returns URL/body; final-update needs its URL/body, same tuple, and `FINAL_VERIFICATION_SUMMARY`, updating existing draft Testing only. A parent may supply work ID. Orchestrated Create PR does not write a work record; an unchanged candidate is a no-op.
- Resolve just-in-time: branch (not `main`/`master`), fetch target and derive `PR_BASE`, `BASE_SHA`, `HEAD_SHA`, canonical `git-diff-v1` `DIFF_SHA256` over binary/full-index/no-color/no-renames `{BASE_SHA}...{HEAD_SHA}`, commits, branch/commit issue ref, `gh`, and unpushed commits.
- Expected fields are all-or-none. After fetch compare live tuple and clean candidate worktree (committed review/proof artifacts allowed; ignored lifecycle excluded). Tracked or non-ignored untracked changes return `PR_CANDIDATE_STALE` before push, create, or edit. Without `gh`, return title/body for manual draft.

## Working Set

The target-to-HEAD diff and commit log, issue reference, and any GitHub PR template (whose required sections win).

## Outputs + DONE

- Conventional `type(scope): summary`: <70 chars, imperative, lowercase after colon, no period; grounded body scales to change. Standalone/pending only opens `gh pr create --draft`; final-update replaces Testing only.

**DONE:** fetched tuple is verified; every factual claim is grounded; Testing honestly reflects diff tests and supplied verification, never turns advisory non-green into pass; sourced/placeholder Why; no secret/credential/PII; only a draft is opened or updated.

## Method / guardrails

1. **Ground:** What is behavior; Why is issue, commits, branch, or `<!-- WHY: motivation not found in commits/issue — fill in -->`; visible How/trade-offs; Testing reports supplied verification, changed tests, or none.
2. **Scale:** trivial What/Why/Closes; standard Summary/Changes/Testing/Closes; complex adds visible trade-offs, breaking/rollback, UI/CLI evidence, and reviewer focus. Derive type/scope from change; add found issue links only.
3. **Verify before side effects:** map every claim to diff/commit/issue, drop unsupported claims/secrets, verify tuple and clean candidate, then push.
4. **Work-record ownership:** in orchestrated mode return PR evidence to Ship without writing a work record. In standalone mode, when no Execute or Ship parent owns the history, invoke `Skill(spectre-work-record)` once at the terminal boundary after the draft exists; report capture failure/recovery input without blocking draft. Refresh a stale parent candidate; a draft is not merged.
5. **Draft lifecycle:** pending grounds `RUNNING`, pushes, creates the draft, and returns its PR identity/URL against the supplied work ID for Ship to associate. Final-update rechecks its tuple/clean candidate; if repairs changed the tuple, refresh candidate-sensitive claims under freshness, grounding, secret gates, verify clean repaired HEAD, pushes, re-resolves/rechecks live tuple, then `gh pr edit` only Testing from `FINAL_VERIFICATION_SUMMARY`; never mark ready.

## Handoff

Return URL/body or `PR_CANDIDATE_STALE`; `--orchestrated`: no user step.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone: review the PR.

## Escalate-If

- Branch is main/master or has no target-ahead commits; candidate tuple is incomplete/different; branch/target/remote is unsafe; or the diff has secrets/PII.
- Large intent is ungrounded: use the Why placeholder and draft, never fabricate.
