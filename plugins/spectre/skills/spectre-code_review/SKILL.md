---
name: "spectre-code_review"
description: "Run final adversarial review through a pinned high-effort opposing runtime with one native fallback. Use at the final boundary to falsify correctness, safety, production readiness, and requirement delivery. Do not use for partial checkpoints or implementation; review only."
user-invocable: true
---

# code_review

## Purpose

Try to prove the work wrong, unsafe, unreachable, or unable to meet requirements. Accept correctness only if evidence survives adversarial scrutiny; never defend the implementation.

## Inputs

- `$ARGUMENTS`: feature/root or descendant artifact, focus, diff/base range, source-plan path, immutable `BASE_SHA`/`HEAD_SHA`/`DIFF_SHA256` tuple, and `--orchestrated`.
- Scope: completed changes, changed files, direct dependencies/importers, tests, and requirements/ACs. Source requirements from matching `tasks.json` parents, else an explicit source-plan path before `plan.md`, then request+diff. `execute.md` only locates tasks.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Repair stale feature/root metadata in artifacts this review touches.
- `REVIEW_REPORT={FEATURE_ROOT}/reviews/comprehensive_code_review.md`; replace it for the current candidate. Git history preserves prior decisions without accumulating sibling reports.
- Late-bind diff/base and tuple, changed files, requirement/AC paths and task ids, dependencies/importers, tests, and exclusions. Reviewers read diffs/task graphs.

## Outputs + DONE

`REVIEW_REPORT` follows `references/adversarial-review.md`: bounded scope and tuple; verdict; evidence-backed findings; coverage; per-requirement delivery; scope/dead-path audits; actions; route metadata.

DONE when schema validation passes; scope/tuple are unchanged; every requirement/AC has one evidence-backed status; audit and route metadata exist; findings satisfy identity/evidence rules; and only the report changed.

## Method / guardrails

1. **Dispatch the fixed review prompt.** Read `references/adversarial-review.md` and send it verbatim to one fresh reviewer, followed only by structured context: feature/root and `REVIEW_REPORT`; focus; immutable diff/base tuple; requirement/AC source paths and ids; changed files, direct dependencies/importers, and tests; exclusions; route metadata and fallback reason. Reviewers read the supplied diffs/task graphs; the primary does not paraphrase or augment the template.
2. **Use one external-first review route from repo root; do not probe alternatives.** Codex primary runs:
   `claude -p --model opus --effort high --permission-mode dontAsk --allowedTools "Read,Grep,Glob,LS,Bash(mkdir -p *),Bash(git diff *),Bash(git show *),Bash(git status *),Bash(git rev-parse *),Write" --output-format text "$REVIEW_PROMPT"`
   Claude primary runs:
   `codex exec -C "$PWD" -m gpt-5.6-sol -c 'model_reasoning_effort="high"' -s workspace-write "$REVIEW_PROMPT" < /dev/null`
   Record route metadata as `Claude Code|opus|high|Codex -> Claude Code` or `Codex|gpt-5.6-sol|high|Claude Code -> Codex`. Keep a 20-minute launcher-side poll limit; do not pass duration guidance to the reviewer. Quiet output is not failure. The reviewer writes only `REVIEW_REPORT`. Primary semantic self-review is prohibited.
3. **Fallback once.** Missing/non-zero opposing CLI, report-write failure, or unusable review permits one clean-context `@spectre:reviewer` with the same verbatim template and structured context. It returns the report in-thread for unchanged persistence. Record `native-subagent|runtime-native|inherited|native-fallback` plus reason. A usable review ends semantic review.
4. **Verify deterministically.** A candidate tuple requires all fields and canonical hash recomputation with `git diff --binary --full-index --no-ext-diff --no-color --no-renames` before dispatch and after report creation; mismatch makes the report stale. Validate the template's required sections, scope, exhaustive delivery coverage, and metadata. The primary may mechanically normalize report-only counts, paths, citations, metadata, sections/tables, and severity enums from existing reviewer semantics, but may not originate or materially reinterpret findings. An unusable native report remains incomplete.

## Handoff

`--orchestrated`: verdict, counts, CRITICAL/HIGH evidence/IDs, metadata/report; no step.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone: verdict/runtime/fallback/report + numbered CRITICAL/HIGH; blockers → Fix, else Prove/Test gap/deferred Clean.

## Escalate-If

- Scope remains ambiguous after artifacts and git state are inspected: ask what to review before dispatch.
- A proposed finding changes requirements: label `Scope Change Required` and exclude it from the blocking verdict.

Next step: follow the verdict-specific handoff.
