# Correctness Review — learn-v3-targeted-eval

Stage: Correctness (fresh reviewer, orchestrated)
Date: 2026-09-08

## Metadata and hashes

| Item | Value |
| --- | --- |
| Reviewed plan | `.spectre/features/learn-v3-targeted-eval/specs/plan.md` |
| Scope authority | `.spectre/features/learn-v3-targeted-eval/task_context.md` (confirmed 2026-09-08 thread) |
| Route | `M / M_REVIEWED_DIRECT`, `DIRECT`, `MODERATE` uncertainty |
| Protected boundaries | evaluation-validity, native-isolation, evaluation-budget |
| Edit mode | `--auto-apply scope-safe` |
| plan.md sha256 (supplied) | `7a4f24a108574da43b31aeca08d481cad834a0fb454a778121b111ea553c112b` |
| plan.md sha256 (verified pre-edit) | `7a4f24a108574da43b31aeca08d481cad834a0fb454a778121b111ea553c112b` — MATCH |
| task_context.md sha256 (supplied) | `c78d618c2c20939506a9112a2153366ab81ecc46cb7e310835c1a7be247ea6f2` |
| task_context.md sha256 (verified) | `c78d618c2c20939506a9112a2153366ab81ecc46cb7e310835c1a7be247ea6f2` — MATCH |
| plan.md sha256 (post-edit) | `89e9834026de4337a71c7146d16cc2e1e5c5d1d1bc7d43336bac3bd052bc23a0` |

## Write bounds observed

- Wrote `.spectre/features/learn-v3-targeted-eval/reviews/plan_correctness.md` (authorized).
- Edited `.spectre/features/learn-v3-targeted-eval/specs/plan.md` for scope-safe correctness edits only (authorized).
- No source code, `task_context.md`, `feature.json`, tasks, or generated artifacts modified.
- No native model evaluation cell or command consuming native evaluation budget was run. `evaluateKnowledge` was never invoked; only deterministic reads, one pure `promptContract` render, and the existing `sync-codex --check` were executed.

## Evidence inspected

| Claim in plan / task_context | Repository check | Result |
| --- | --- | --- |
| `scripts/evaluate-knowledge.mjs:62` freeze/run entrypoint and `--cell` selection | `usage()` at :62, `argumentsNamed` at :72, `selectFrozenCells` at :111, `cellIds: argumentsNamed(process.argv, '--cell')` at :1613 | CONFIRMED |
| `--cell` rejects unknown frozen IDs | `selectFrozenCells` throws `unknown frozen cell` at :113-116 | CONFIRMED |
| `scripts/evaluate-knowledge.mjs:455` hash-bound cache, concurrency, persistence, failure continuation | `runCells` at :455; `cacheKeyFor` at :458; `total`/`perHost` at :477-478; `launch_failed` path at :512-521 with no automatic retry | CONFIRMED |
| Concurrency four total / two per host | `concurrency: { total: 4, perHost: 2 }` written by `freeze()` at :157 | CONFIRMED |
| `scripts/knowledge-evaluation-staging.mjs:583` isolated candidate/no-knowledge staging | `stageKnowledgeCell` at :584; no-knowledge returns `pluginDir: null`, `storeDir: null`, `sessionStartMeasurement: { availability: 'none' }` at :599-606 | CONFIRMED |
| Candidate uses canonical/Codex plugin outputs | `hostPluginSource` at staging :39-42 resolves `plugins/spectre` / `plugins/spectre-codex` | CONFIRMED |
| Codex connected tools disabled for every condition | `configureCodexExternalTools` at staging :220, called at :597 before the no-knowledge return | CONFIRMED |
| `manifest.json:65` irrelevant-knowledge negative control | `"id": "irrelevant-task"` at :65; warehouse distractor `database-retention-policy`; two accessibility observations with `seedKnowledge: false` | CONFIRMED |
| `manifest.json:191` four-session correction journey | `"id": "longitudinal-correction"` at :191; `longitudinalSteps` length 4; `userLearnSessions: [0, 2]` | CONFIRMED |
| `oracle.json:32` irrelevant-task zero loads | `allowedLoads: 0`, `allowedHistoryLoads: 0` at :32-37 | CONFIRMED |
| `oracle.json:102-113` capture / fresh-reuse / correction / corrected fresh reuse | `requiredStates` at :106-111 | CONFIRMED |
| `test_evaluate-knowledge.mjs:96` named-cell selection and frozen cache behavior | `native qualification selects only named frozen cells` at :95; freeze-hash resume test at :101 | CONFIRMED |
| 16 cells / 40 native sessions | 8 longitudinal cells x 4 steps + 8 irrelevant cells x 1 step = 40; cell ID form `case:condition:host:repeat` matches `freeze()` at :146 | CONFIRMED |
| No-knowledge longitudinal prompt still says "Use Learn" | Rendered `promptContract(longitudinal-correction, 'artifacts/decision.md', 'claude', 'no-knowledge')`: session 0 `"...Use Learn to preserve the incident evidence..."`, session 2 `"...Use Learn to correct retry-ceiling..."`. The rewrite at :99 is gated on `condition !== 'no-knowledge'` | CONFIRMED — the plan's stated defect is real |
| Existing test does not cover the leak | `test_evaluate-knowledge.mjs:172` only asserts the no-knowledge prompt does not *start* with a learn command | CONFIRMED — new test genuinely required |
| Final longitudinal prompt contains neither retry value | Rendered session 3: `"Start a fresh session. Complete the correction artifact using current project evidence..."` — contains neither "three attempts" nor "five attempts" | CONFIRMED — the §2 assertion is satisfiable |
| Irrelevant-task prompts byte-identical across conditions | Rendered candidate and no-knowledge irrelevant prompts are identical | CONFIRMED |
| Evidence carries across the four longitudinal sessions | `staged` is created once per cell at :1467 and every session in the `preparedPrompts` loop runs against the same `staged.projectDir` | CONFIRMED |
| Full-matrix report cannot answer a two-condition question | `pairedReport` at :624 sets `comparable` only when all three conditions exist; `correctnessVsBothControls` returns `'unknown'` whenever `baselineSemantic === null`; `qualityGate` requires `baselineSemantic !== null` | CONFIRMED — the plan's "Addition" justification is evidence-backed |
| 300-token SessionStart cap | `cappedMeasurements(sessionStart, 300)` at :786; `SESSION_START_TOKEN_LIMIT = 300` asserted in `plugins/spectre/hooks/scripts/test_knowledge-retirement.mjs:61` | CONFIRMED |
| Manual judgments bound to exact artifact hashes | `primaryJudgmentReport` at :689; `artifactHashMatches` requires `judgment.artifactHash === cell.runtime.deliverable.hash` and `judgment.artifactEvidence === judgment.artifactHash` | CONFIRMED |
| Invalid infrastructure cannot receive a semantic pass | `cellStatus` at :449 returns the runtime status when not `completed`; `semanticOutcome` at :613 returns `null` without `artifactHashMatches` | CONFIRMED |
| Freeze bound to `plugins/` covers both host trees | `filesHash` at :39 walks recursively; freezing `--candidate plugins` covers `plugins/spectre` and `plugins/spectre-codex` | CONFIRMED |
| Codex mirror currently synced | `npm run sync-codex -- --check --quiet` exit 0 | CONFIRMED (in sync today; no pre-freeze guard in the plan — Finding 2) |
| Freeze gate rejects a changed prompt | `assertFrozenInputs` at :1448 checks fixtures, oracle, configuration, candidate, nativePipelineInputs only. `promptContract` lives in `scripts/evaluate-knowledge.mjs`, which is absent from `NATIVE_PIPELINE_INPUTS` (:17-24) and from every hashed root | **REFUTED — Finding 1** |

## Unknowns

- Native host authentication inside the isolated homes is unverified. Verifying it requires a host call, which is outside this stage's write bounds; the plan already carries it as a pre-execution dependency check.
- Whether the candidate `plugins/` tree will still be sync-clean at freeze time is unknowable now. Finding 2 converts it into a gate.
- Stochastic native outcomes cannot be reviewed in advance; the plan's `INCONCLUSIVE` handling is the correct treatment.

## Retained constraints and tests

Retained unchanged; none of the edits below relaxes any of them.

- 16 cells / 40 native sessions ceiling; no baseline condition; no other scenario family; no v15 resumption.
- Byte-identical ordinary repository evidence across candidate and no-knowledge; the knowledge subsystem is the only removed variable.
- No answer leakage into the final longitudinal prompt.
- Isolated homes, local Git/GitHub fixtures, disabled connected tools, ordered evidence, no automatic retry.
- Invalid cells stay `INVALID`; no imputation of missing pairs; no post-hoc tuning reusing the same freeze.
- No modification of production Learn behavior during evaluation.
- Existing tests retained: `test_evaluate-knowledge.mjs` cell selection and freeze-hash resume; `test_knowledge-evaluation-staging.mjs` cross-condition evidence identity.

## Findings

| # | Severity | Category | Location | Finding | Consequence | Suggested Edit |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | High | evaluation-validity | `specs/plan.md:42`, `specs/plan.md:125` | The plan states that a **prompt** change after freeze invalidates the affected cache and that freeze verification rejects a changed prompt before a host call. Neither holds for the prompt-transport code. `assertFrozenInputs` (`scripts/evaluate-knowledge.mjs:1448-1454`) hashes only fixtures, oracle, configuration, candidate and `nativePipelineInputs`; `NATIVE_PIPELINE_INPUTS` (`:17-24`) lists hosts, staging, probe-hook, verify-hosts, evaluation-trace and payload, and excludes `scripts/evaluate-knowledge.mjs`, where `promptContract` lives. `cacheKeyFor` (`:458-471`) consumes the *frozen* `cell.promptHash` value and never re-derives it. The plan's own Step 1 edits exactly this function. | An edit to `promptContract` after freeze changes the prompts actually sent to both hosts while every gate passes and cached cells replay under an unchanged freeze key. Out-of-Bounds line 145 ("do not tune prompts after seeing results and then reuse the same freeze") becomes unenforceable, and the invalidity is undetectable from the committed JSON. | Require the run to re-derive each selected cell's `promptHash` from the current `promptContract` and abort before any host call on mismatch. This is exact and minimal: `evaluateKnowledge` already builds the identical value at `scripts/evaluate-knowledge.mjs:1488`, so `hash(JSON.stringify(preparedPrompts))` equals the frozen `promptHash` by construction. Correct the two overstated claims to describe the gate that will exist. |
| 2 | Medium | verification-gap | `specs/plan.md:53`, `specs/plan.md:124` | §2 asserts as a gate that "candidate uses the synced canonical/Codex plugin outputs from the frozen candidate", but no executable verification backs it. `filesHash` freezes `plugins/` as found. A desynced `plugins/spectre-codex` would be frozen in silently. | The Codex arm would measure a stale candidate while the Claude arm measures the current one, so a cross-host difference could not be attributed to the candidate. Risk line 157 already names candidate drift after v15 repairs as live. | Add a pre-freeze verification that `npm run sync-codex -- --check --quiet` passes. (Verified clean at review time, exit 0.) |
| 3 | Medium | mechanism-gap | `specs/plan.md:65` | The canary safeguard requires continuing only after the first candidate/no-knowledge irrelevant pair is clean, while adding no extra calls. `runCells` (`:455-543`) launches up to four cells concurrently with no interior gate, so a single 16-cell `run` cannot honour it. | Read literally as one invocation, the stated safeguard silently does not exist and a boundary failure would surface only after many cells had already burned native budget. | State that the canary is a first bounded `run` limited to the two irrelevant `--cell` IDs, and that the full 16-cell `run` reuses their cached results under the same freeze key — the resume behaviour covered by `test_evaluate-knowledge.mjs:101`. |
| 4 | Medium | interface-mismatch | `specs/plan.md:71-80` | The targeted per-cell field set (`taskOutcome`, `currentConstraint`, `staleValueUsed`, `grounding`, `knowledgeRelevance`, `artifactHash`) omits the fields the cited hash-binding mechanism requires. `primaryJudgmentReport` (`:689-712`) computes `artifactHashMatches` from `artifactHash` **and** `artifactEvidence`, and reports `pending` unless `correct`, `relevant` and `requiredRecallBeforeDecision` are all non-null. | A ledger carrying only the targeted axes never reaches `reviewed`, so the Verification claim "hash-bound blinded judgments on every declared axis" is not satisfied by the existing evaluator and the binding has to be reinvented mid-adjudication. | State that each targeted judgment record is written as a `--primary-judgments` entry that retains `artifactHash`, `artifactEvidence`, `correct`, `relevant` and `requiredRecallBeforeDecision`, and adds the targeted axes. |
| 5 | Medium | decidability | `specs/plan.md:100` | The four classification rules are not exhaustive. A run where candidate wins two longitudinal pairs, loses none and ties two fires no rule: `POSITIVE` needs three strict wins, `NEGATIVE` needs two losses, `NEUTRAL` needs tied outcomes, and the `INCONCLUSIVE` clause enumerates conditions rather than acting as a stated residual. | The Overview requires publishing exactly one of four results together with "the exact rule that selected the classification"; an unfired rule set leaves the deliverable undefined. | Make `INCONCLUSIVE` the explicit residual classification when no `POSITIVE`, `NEGATIVE` or `NEUTRAL` rule fires. |
| 6 | Medium | execution-precondition | `specs/plan.md:63-65`, `specs/plan.md:116` | `run` rejects any invocation without `--baseline-plugin` (`:1605`), even when zero baseline cells are selected. The plan never states this, and Out-of-Bounds line 142 ("do not run baseline cells") invites the opposite reading. | The execution step fails at the CLI usage check, or an implementer treats the required argument as a boundary violation and stalls. No native budget is consumed either way, but the run is blocked. | Note that `--baseline-plugin` is a required `run` argument that stages nothing for unselected cells, so passing it does not run baseline cells. |

## Dispositions and resulting edits

| # | Severity | Disposition | Resulting edit |
| --- | --- | --- | --- |
| 1 | High | addressed | Rewrote `specs/plan.md:42` to state the true coverage of the freeze gate; added a `promptHash` re-derivation assertion to §2's zero-model gate; corrected the Verification bullet under "Frozen selection and evidence symmetry". |
| 2 | Medium | addressed | Added a pre-freeze `sync-codex --check` verification bullet under "Frozen selection and evidence symmetry". |
| 3 | Medium | addressed | Rewrote the canary sentence in §3 to name the two-invocation mechanism and the freeze-key cache reuse. |
| 4 | Medium | addressed | Added a sentence to §4 stating that targeted judgment records extend the existing `primaryJudgments` entry shape. |
| 5 | Medium | addressed | Extended the `INCONCLUSIVE` rule at §5 with an explicit residual clause. |
| 6 | Medium | addressed | Added the `--baseline-plugin` precondition to "External Dependencies — Verify Before Implementation". |

No finding was skipped, left unresolved, or classified as `Scope Change Required`. Scope, success criteria, protected boundaries, the 16-cell / 40-session ceiling, and the Out-of-Bounds list are unchanged. Every edit tightens or clarifies an existing obligation; none adds a new requirement, cell, session, or dependency.

## Out-of-Bounds and direct-mode verification

- Out-of-Bounds section present with eight entries; all three protected boundaries are bound. Budget: lines 141 and 144. Evaluation validity: lines 142, 143, 145, 146, 147. Native isolation: line 141 plus the §2 gate and the §3 `INVALID` rules; the isolation constraints are additionally retained at line 158. Production behavior: line 148. No edit weakened any entry.
- Direct-mode executable verification present and executable: deterministic cell-count and prompt-contract tests over the exported `promptContract`; staging snapshot assertions; the freeze gate; run-inventory and concurrency checks; and independent recomputation of the classification from committed JSON. Findings 1-3 converted three assertions that had no executable backing into executable ones.

## Post-edit plan hash

`plan.md` sha256 after edits: `89e9834026de4337a71c7146d16cc2e1e5c5d1d1bc7d43336bac3bd052bc23a0`

Pre-edit: `7a4f24a108574da43b31aeca08d481cad834a0fb454a778121b111ea553c112b`
Post-edit: `89e9834026de4337a71c7146d16cc2e1e5c5d1d1bc7d43336bac3bd052bc23a0`

`task_context.md` unchanged at `c78d618c2c20939506a9112a2153366ab81ecc46cb7e310835c1a7be247ea6f2`.
