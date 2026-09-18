---
name: "spectre-prune"
description: "Find and remove confirmed-safe dead production/source code and artifacts from a scoped working set while surfacing uncertain items for manual review. Use standalone or as the prune phase inside spectre-clean/ship. Do NOT trigger for tests (spectre-test), final commit hygiene (spectre-sweep), bug fixes (spectre-fix), or broad behavior-changing refactors."
user-invocable: true
---

# prune

Find/remove dead code from recent work; validate before deletion and report uncertainty in-thread.

## Inputs

- `$ARGUMENTS` — optional scope. A `commit_id`/SHA, `unstaged`/`staged`, `context`/session, a scoped file list, or `--orchestrated` when a parent workflow owns the next step. If ambiguous -> ask which scope mode. If a provided `commit_id` is invalid or not in history -> stop and ask for a valid ref.
- `FEATURE_ROOT` — explicit feature name/root or one descendant feature artifact.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Resolve scope late at runtime:
  - **commit_range**: union of committed files from `{commit_id}^..HEAD` (including the commit), staged, unstaged, and untracked. If `commit_id == HEAD`, use staged + unstaged + untracked.
  - **unstaged/staged**: union of staged + unstaged + untracked.
  - **context**: ask for the session files and wait.
- Respect `.gitignore`, package/tsconfig context, generated-file boundaries, and repo-local conventions. Paths are repo-root relative in reports.

## Outputs + DONE

- Confirmed-safe cleanup edits only; in orchestrated mode, production/source only—never tests/fixtures.
- In-thread summary: safe removals (`file:line`, what, why), manual review, exclusions, impact, ESLint debt. Write no cleanup/evidence artifact.
- **DONE when:** required analysts finish for non-trivial sets; removals are `CONFIRMED_SAFE`; `UNCERTAIN`/`UNSAFE` items remain untouched and in Manual Review; standalone affected checks pass or failed edits are rolled back; no `--no-verify`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error` was introduced; and the summary is complete.

## Method / guardrails

- Detect -> investigate -> validate -> remove. Production code is deleted only with concrete evidence.
- **Orchestrated Ship/Clean mode:** edit production/source only; do not edit tests/fixtures, stage, or commit; run no affected suite. Use reference/usage evidence, return changed paths and any test/cross-boundary need to the parent.
- Signals: orphaned imports/exports, unused functions/vars, large commented-out blocks, debug artifacts, temp/dev logging, dead branches, duplicate abandoned implementations, test artifacts (`.only`, skipped tests), AI slop (`any` casts to dodge types, defensive noise, over-commenting).
- Duplication: flag copy-pasted logic (>5 lines, 2+ instances), near-identical functions, repeated validate/transform/fetch patterns. Ignore fixtures/generated code. Consolidate only when low-risk and confirmed safe; otherwise report.
- For non-trivial sets, the calling primary directly dispatches up to 4 read-only leaf `@spectre:analyst` agents by file/module. Return only evidenced `SAFE_TO_REMOVE`, `NEEDS_VALIDATION`, or `KEEP` verdicts in-thread.
- Every function/file/export deletion gets a second usage search for dynamic imports, string refs, reflection, tests, and external entrypoints. Remove only `CONFIRMED_SAFE`; downgrade uncertainty to manual review.
- Standalone: run affected lint/tests after removals. If a cleanup edit causes failure, roll it back and document the reason.
- No staging or commits. `/spectre:spectre-sweep` owns final hygiene and commit grouping.
- ESLint-debt scan is diagnostic only: group bypasses in the working set and report a future refactor plan; do not refactor debt during prune.

## Handoff

Report analyzed/removed/excluded counts, lint/test, manual review; `--orchestrated`: no user step.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone concrete coverage risk → `/spectre:spectre-test`; otherwise `/spectre:spectre-sweep`; one result-tied route.

## Escalate-If

- Scope or commit ref is ambiguous/invalid.
- A removal touches behavior, public API, persistence, auth/security/payment/PII, or generated code without a clean signal.
- Lint/tests fail and rollback is not straightforward.
