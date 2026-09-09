# Simplification Review — learn-v3-targeted-eval

Stage: Simplification (second fresh reviewer, orchestrated)
Date: 2026-09-08

## Metadata and hashes

| Item | Value |
| --- | --- |
| Reviewed plan | `.spectre/features/learn-v3-targeted-eval/specs/plan.md` |
| Scope authority | `.spectre/features/learn-v3-targeted-eval/task_context.md` |
| Correctness report | `.spectre/features/learn-v3-targeted-eval/reviews/plan_correctness.md` |
| Route | `M / M_REVIEWED_DIRECT`, `DIRECT`, `MODERATE` uncertainty |
| Protected boundaries | evaluation-validity, native-isolation, evaluation-budget |
| Edit mode | `--auto-apply scope-safe` |
| plan.md sha256 (supplied and verified pre-edit) | `89e9834026de4337a71c7146d16cc2e1e5c5d1d1bc7d43336bac3bd052bc23a0` — MATCH |
| plan_correctness.md sha256 (supplied and verified) | `f8eb457d0b8037c879378d6d479c5cf325a146769a0154852ec298617e673562` — MATCH |
| task_context.md sha256 (supplied and verified) | `c78d618c2c20939506a9112a2153366ab81ecc46cb7e310835c1a7be247ea6f2` — MATCH |
| plan.md sha256 (post-edit) | `05639d749829b9f8daccac6825acbab73c349c49b66158143c1408dc42c98778` |

No native model cell or native-budget-consuming command was run. Review evidence was limited to the three authorized documents and the already-cited repository evidence in the correctness report; no additional anchor spot-check was needed.

## Must Delete

- Delete `Risks & Filled Assumptions`. Each mitigation is already a binding instruction in Technical Approach, Verification, Out-of-Bounds, or the scope authority; retaining a second normative rendering creates drift without adding behavior.
- Delete `Routing Observations`. It is planning provenance already recorded in `task_context.md`, not an execution mechanism, prerequisite, artifact, or test.

## Collapse / Reuse / Defer

- Collapse the literal 16-line cell inventory to the exact Cartesian product of the two cases, two conditions, two hosts, and two repeats. The frozen-contract test remains responsible for expanding and checking the 16 unique IDs and 40 sessions.
- Collapse the single-row “Addition” table to one retained-complexity exception in the required contract form.
- Reuse the existing table-driven prompt-contract verification for candidate transport, no-knowledge transport, evidence equivalence, and final-session answer-leak assertions; do not create separate test mechanisms for those prompt variants.
- Defer nothing. Authentication qualification, canary execution, native execution, adjudication, and reporting are all required by the approved evaluation.

## Retained complexity exceptions

| Boundary | Exception proof |
| --- | --- |
| Feature-local targeted contract/result schema | required now by: a two-condition causal result with separate correctness, stale-safety, grounding, relevance, and cost axes \| simpler local option: use the existing full-matrix report unchanged \| why it fails now: that report requires the retired baseline and collapses the targeted dimensions \| removal failure: the selected run cannot yield the requested classification |
| Re-derived `promptHash` gate | required now by: post-freeze prompt integrity \| simpler local option: rely on the existing freeze hashes/cache key \| why it fails now: prompt transport is outside frozen roots and the cache consumes the stored hash \| removal failure: changed prompts can run or reuse cache under an old freeze |
| Separate two-cell canary invocation | required now by: native-isolation and evaluation-budget safeguards \| simpler local option: launch all 16 cells once \| why it fails now: the runner has no interior stop and may launch four cells concurrently \| removal failure: contamination can spend additional budget before detection |
| Extended primary-judgment entry | required now by: targeted axes plus existing artifact binding \| simpler local option: replace the existing judgment shape \| why it fails now: the evaluator requires `artifactEvidence`, `correct`, `relevant`, and `requiredRecallBeforeDecision` to reach reviewed status \| removal failure: judgments remain pending or require a second binding mechanism |

The isolation boundary, invalidation rules, fixed 16-cell/40-session ceiling, blinded hash-bound scoring, and exhaustive classification remain binding correctness constraints rather than optional complexity.

## Test reductions

- Treat prompt transport and answer-leak coverage as one table-driven prompt-contract test surface across condition/session variants.
- Retain separate representative tests/checks for: exact selected-set expansion and session count; staged ordinary-evidence identity; Codex mirror sync; frozen-input and re-derived-prompt rejection; native inventory/concurrency/integrity; and independent classification recomputation. Each protects a distinct failure mode, so removing another would weaken evaluation validity, isolation, or budget enforcement.
- No native test or evaluation cell is added or run by this review.

## Findings and dispositions

| # | Severity | Action | Location | Finding | Why Safe | Suggested Edit |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Medium | Collapse | `specs/plan.md`, §1 authorized cells | Sixteen copied IDs encode a four-axis Cartesian product already asserted by the contract test. | The exact set remains `{longitudinal-correction, irrelevant-task} × {candidate, no-knowledge} × {claude, codex} × {1, 2}`; no cell or session changes. | Replace the fenced enumeration with the exact product expression and retain the 16-ID/40-session expansion check. |
| 2 | Medium | Collapse | `specs/plan.md`, §1 Addition table | A one-row table creates a separate surface for the only new contract exception. | The same necessity, rejected simpler option, failure reason, and removal consequence fit the required exception form without losing a constraint. | Replace the table with one compact retained-complexity exception line. |
| 3 | Medium | Delete | `specs/plan.md`, Risks & Filled Assumptions | Seven risks repeat already-binding gates and mitigations, including repeat count, evidence symmetry, answer-leak prevention, separated axes, fresh freeze, and isolation. | Every operational obligation survives in §§1–5, Verification, Out-of-Bounds, or the approved scope; deletion removes no mechanism or failure handling. | Delete the section rather than maintaining duplicate normative wording. |
| 4 | Medium | Delete | `specs/plan.md`, Routing Observations | Planning telemetry and route commentary do not direct execution and are already authoritative in `task_context.md`. | The direct dependency order remains embodied by numbered §§1–5, and route/protected-boundary metadata remains in scope and both reviews. | Delete the section. |

Final dispositions: Findings 1–4 are `addressed`. No finding was skipped or left unresolved, and no `High` or `Scope Change Required` finding exists.

## Structural Before → After

| Surface | Before | After |
| --- | --- | --- |
| Authorized-cell representation | 16 copied IDs | Exact 4-axis Cartesian product expanding to the same 16 IDs |
| New-complexity rationale | One five-column table | One contract-form exception |
| Risk/assumption recap | Seven duplicate mitigation bullets | Deleted; binding instructions remain at their execution/verification sites |
| Routing recap | Eight provenance bullets | Deleted; numbered execution sequence and `task_context.md` retain the route |
| Mechanisms / phases / artifacts | Freeze → qualify → canary/run → adjudicate → classify; targeted contract and two reports | Unchanged |
| Tests/checks | Distinct selection, prompt, staging, sync, freeze, integrity, and classification checks | Same distinct behaviors; prompt variants explicitly share one table-driven surface |

## Boundary and completion checks

- Scope is unchanged: candidate versus no-knowledge only, two named cases, Claude and Codex, two repeats, 16 cells, 40 native sessions.
- The correctness report's retained constraints all survive: evidence symmetry, no answer leakage, isolated homes/local fixtures/disabled connected tools, ordered evidence, no retry, `INVALID` preservation, no imputation, no post-hoc freeze reuse, and no production Learn modification.
- Out-of-Bounds remains present and unchanged.
- Direct-mode executable Verification remains present, including deterministic prompt/selection tests, staging checks, sync verification, current prompt-hash rejection, run inventory/concurrency checks, and independent JSON classification recomputation.
- Write bounds remain limited to this report and scope-safe edits to the selected plan.

## Post-edit plan hash

Pre-edit: `89e9834026de4337a71c7146d16cc2e1e5c5d1d1bc7d43336bac3bd052bc23a0`

Post-edit: `05639d749829b9f8daccac6825acbab73c349c49b66158143c1408dc42c98778`

The plan decreased from 173 to 131 lines. Final verification reconfirmed the correctness-report and task-context hashes, the exact scope/cardinality and budget phrases, unchanged Out-of-Bounds entries, direct-mode executable Verification, and the authorized two-file write boundary.
