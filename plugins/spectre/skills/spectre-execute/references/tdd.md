
# tdd

Implement assigned behavior through strict RED → GREEN → REFACTOR. Outcome: tasks done with happy + failure tests passing and only test-forced production code shipped.

## Inputs

- `$ARGUMENTS` or thread context — the assigned implementation task(s). If no clear task, stop and ask.
- The task's acceptance criteria / artifact, if one exists.

## Working Set (late-bound — read at run-time, never inline)

- Target behavior, acceptance criteria, and the smallest affected code/test files.
- Narrow test/lint commands for those files only (`--testPathPattern`, `--findRelatedTests`, per-file lint, or equivalent).
- Existing test helpers, fixtures, stubs, fake timers, seeded-RNG patterns.

## Outputs + DONE

- A todo list with one cycle per Test Opportunity: `RED behavioral cases` → `GREEN minimal impl` → `REFACTOR` → `COMMIT`.
- The implementation diff, focused tests, and (optional) conventional commit `feat({task}): description`.
- A completion report: Summary (tasks done, ✅ happy / ✅ failure test status, files modified); Artifacts (helpers/mocks/fixtures); API Surface (new/modified exports + signatures); Patterns; Deferred coverage gaps.

**DONE when:** every Test Opportunity has a representative happy-path and primary-failure baseline unless the behavior genuinely supports only one; distinct requirement/boundary/regression/material-risk cases are also covered; every new test was observed failing for the expected reason before satisfying implementation; minimal production code makes focused tests pass; refactors stay green; every new observable behavior or nontrivial exported contract is tested; and focused tests + relevant lint pass.

## Method / guardrails

- **Iron Law — YOU MUST confirm RED before GREEN.** No production code before a failing test. If code was written first, **delete it and restart from the tests** — do not keep it as reference, do not adapt it.
- A Test Opportunity is the smallest externally meaningful behavior or contract: a route, bug fix, acceptance criterion, public boundary, or independently risky logic. Private helpers are normally covered through observable behavior unless they contain independently risky logic.
- Start each opportunity with one representative happy-path and one primary-failure test. Add another behavioral case only for a distinct requirement, public/contract boundary, credible regression, or materially different risk. Reject duplicated assertions, implementation-detail tests, and unjustified combinatorial matrices.
- Run the narrowest command and confirm every new test **fails (not errors) for the missing behavior** before production code satisfies it. A test that passes immediately covers existing behavior—fix it or choose uncovered behavior.
- GREEN = the least code to pass the focused tests: no extra branches, params, dependencies, or abstractions unless a test forces them or ≥2 call sites exist (YAGNI).
- Refactor only while green, and only for duplication ≥3 or a material readability gain; if a refactor breaks tests, revert it.
- Resolve lint pressure in order: guard clauses / split compounds → tiny same-file helpers → file constants → orchestrator + helpers → same-directory helper module only if still failing.
- Keep execution scoped — never run repo-wide tests when a focused command exists.
- Prefer the repo's existing anti-flake patterns: fake timers, stubs, seeded RNG, deterministic fixtures.

## Handoff

Return completion report + exact pass/fail commands; `--orchestrated`: no step.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return the RED/GREEN/REFACTOR result and focused checks to the Execute owner, which resumes its current assignment.

## Escalate-If

- The assigned task or its acceptance criteria are unclear → stop and ask.
- You cannot make a meaningful RED test fail for the expected reason.
- The focused test command cannot be isolated to the changed files.
- Test setup dwarfs the behavior under test → the design is too coupled; simplify the interface (or ask) before continuing.
