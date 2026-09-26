
# sweep

Prepare uncommitted or recently-changed work for check-in: a fast, formulaic hygiene pass, then descriptive conventional commits. No subagents, no approval gates — execute each step and move on.

## Inputs
- `$ARGUMENTS` (optional scope/intent hint, compact Prune/Test check results, plus `--orchestrated` when a parent owns the next step). Read the live working tree at runtime (`git status`, `git diff`) — do not assume a prior phase ran.

## Working Set
Changed files only. Opportunistic, not forensic — do not hunt beyond the diff.

## Outputs + DONE
One or more conventional commits covering the changes. Sweep is the sole pre-rebase commit owner in orchestrated Ship/Clean mode. DONE when:
- Diff reviewed: no unintended edits, no out-of-scope staged files, **no secrets/keys/credentials/PII**.
- Debug/temp logging removed; intentional logs (errors, key state transitions) kept at production-appropriate levels.
- Commented-out code, session-introduced TODO/FIXME/HACK, and hardcoded test values resolved or documented.
- Lint passes with **zero violations fixed by suppression** — refactor structural issues, never `eslint-disable` or equivalent. `.gitignore` covers temp/build/IDE artifacts.
- Stale/uncovered integrated lint/typecheck/build/related checks have no branch-caused failure; unrelated findings are recorded/routed.
- Staging includes canonical specs/research/decisions/final reviews, `bug-report.md`, and required `proof/proof.json` + `proof/proof.html`, but excludes Execute evidence, verification reports, checkpoints, runs, markers, working-set/cleanup summaries, and local lifecycle state. Product/CI-consumed qualification artifacts belong at product-owned paths and may be staged.
- Work committed as `type(scope): description` conventional commits, split by concern.

## Method / guardrails
1. **Diff sanity and artifact tenancy** — scan the full diff for accidental edits, stray staged files, secrets, and local lifecycle residue. Ensure local artifact patterns are ignored; never stage or commit them.
2. **Log + code hygiene** — strip debug logging, commented-out code, leftover TODO/FIXME from this work, hardcoded test values; keep intentional logs.
3. **Opportunistic dead code (changed files only)** — orphaned imports, unused vars/functions, debugger statements. No deep investigation.
4. **Strict lint** — fix all violations by correcting code; YOU MUST NOT suppress or `--no-verify`. Refactor for size/complexity thresholds.
5. **Integrated verification** — use received compact Prune/Test results to run only stale/uncovered lint/typecheck/build/related tests across demonstrated dependency boundaries. Never run a repository-wide baseline or full suite. A failure is repair or routing work, not a blocker: fix branch-caused failures and reverify; record/route unrelated failures and continue; reproduce only the failing check/test at the base SHA when attribution is indeterminate. Do NOT author new tests — this is a sweep, not a test pass.
6. **Commit** — group by concern into conventional commits.
   - Types: feat · fix · refactor · test · chore · docs · style · perf.
   - Subject answers what changed and why; include scope (`feat(auth): add token refresh on 401`). Optional body for motivation/trade-offs.
   - One concern per commit — if it spans concerns, split it. Treat commits as durable context for future readers/LLMs; never `fix: updates` / `refactor: clean up`.

## Handoff
`--orchestrated`: commit hashes/verification, no user step.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Ship resumes with Rebase and the post-rebase verification sequence.

## Escalate-If
- A secret/credential appears in the diff — stop, surface it, do not commit until resolved.
- No safe repair/routing action exists without suppression, changing product requirements, or unavailable user authority → return `NEEDS_AUTHORITY`; ordinary lint/test failures remain in repair flow.
