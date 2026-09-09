# Final Adversarial Code Review — Learn v3 Targeted Effectiveness Evaluation

Feature: `learn-v3-targeted-eval`
Feature Root: `.spectre/features/learn-v3-targeted-eval`

## 1. Scope Boundary

**Completed work under review.** Prompt-transport normalization for `userLearnSessions`, a run-time re-derived prompt-hash refusal for selected frozen cells, a frozen table-driven targeted prompt contract test, the committed targeted contract/freeze artifacts, and the published targeted result (JSON + Markdown) carrying the native-result integrity reconciliation, blinded judgment binding, and fixed-rule `NEGATIVE` classification.

**Diff / base.** `e45f5b54be2eeda0b932e7ce3106b7fa76284ad6` → `2832fdeab11677ed3985f3fa724716074145b7cb`, `git diff --binary --full-index --no-ext-diff --no-color --no-renames`. Observed diffstat: 6 files, 2204 insertions, 2 deletions.

**Immutable tuple (unchanged by this review).**

| Field | Value |
| --- | --- |
| BASE_SHA | `e45f5b54be2eeda0b932e7ce3106b7fa76284ad6` |
| HEAD_SHA | `2832fdeab11677ed3985f3fa724716074145b7cb` |
| DIFF_SHA256 | `235b2612d09072ba605885b9cd17b2abc861a710dae4d5468512e1e67dbdde59` (supplied; not recomputed — see Coverage Record) |
| Requirements | `specs/plan.md` @ `05639d749829b9f8daccac6825acbab73c349c49b66158143c1408dc42c98778` (supplied; not recomputed) |
| Authority | `task_context.md` @ `c78d618c2c20939506a9112a2153366ab81ecc46cb7e310835c1a7be247ea6f2` (supplied; not recomputed) |

**Requirements in scope.** `specs/plan.md` Technical Approach sections 1–5, External Dependencies, Verification, Out-of-Bounds.

**Changed files.** `validation/targeted-contract.json`; `validation/targeted-freeze.json`; `validation/targeted-result.json`; `validation/targeted-result.md`; `scripts/evaluate-knowledge.mjs`; `scripts/test_evaluate-knowledge.mjs`.

**Dependencies and tests inspected.** `scripts/knowledge-evaluation-fixtures/manifest.json`; `scripts/knowledge-evaluation-oracle.json`; `scripts/knowledge-evaluation-staging.mjs`; `scripts/knowledge-evaluation-hosts.mjs`; `scripts/test_evaluate-knowledge.mjs`.

**Exclusions.** Prior Learn v3 production implementation and the v15 evaluation; baseline cells; all other fixture families; native reruns; prompt or scoring changes; source-plan edits.

## 2. Verdict

`PASS WITH FINDINGS` — three MEDIUM and two LOW findings. No CRITICAL or HIGH survived verification.

## 3. Findings

| # | Severity | Lens | Location | Evidence / Reproduction | Impact | Finding Fingerprint | Invariant Family | Smallest Fix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MEDIUM | correctness / integrity-gate | `scripts/evaluate-knowledge.mjs:1458` | `freeze()` writes a per-cell `fixtureHash` at `:147`, but that value is consumed only as a cache-key input at `:460` and is never re-derived at run time. `assertFrozenInputs` hashes `freezeManifest.fixtureRoot` (`:1450`), while the run reads its cases from the independent `options.fixtureRoot` (`:1471`, fed by `--fixtures` at `:1619`) and seeds staging from them (`:1478`). Repro: freeze against checkout A, then run with `--freeze <A freeze>` and `--fixtures <copy of A with a case's `initialFacts` edited but task/workflow/longitudinalSteps unchanged>`. `assertFrozenInputs` passes (it hashes A's root), the new `assertSelectedPromptHashes` passes (prompts are byte-identical), and cache reuse still keys on the frozen `fixtureHash` — so cells stage different seeded knowledge under the original freeze key with no refusal. | The freeze gate the whole harness rests on can be bypassed for every non-prompt fixture input, including seeded knowledge records; results are attributed to a freeze they were not produced under, and cached cells from the original fixtures are silently reused. | pre-image: `plan.md#technical-approach-1-freeze+assertSelectedPromptHashes/cell.fixtureHash+frozen per-cell fixture input not re-derived before host call` (sha256 uncomputed — see Coverage Record) | pre-image: `plan.md#technical-approach-1-freeze+every frozen per-cell derivation must be re-derived and matched before a native host call+evaluateKnowledge pre-run gate` (sha256 uncomputed) | In `assertSelectedPromptHashes`, also compare `hash(JSON.stringify({ entry: fixtureCase, artifactPath: cell.artifactPath }))` against `cell.fixtureHash` and throw on mismatch. |
| 2 | MEDIUM | requirement reachability / decision record | `.spectre/features/learn-v3-targeted-eval/validation/targeted-result.json:10` | `plan.md:82` makes `INCONCLUSIVE` fire when "an integrity gap, missing judgment/usage, **host split**, single unmatched regression, or **mixed result** prevents the rules above from deciding". The decision-eligible subset itself is host-split and mixed: `targeted-result.json:69-72` records Claude pairs as `tie` and `candidate-win` and Codex pairs as two `candidate-loss`. `precedence` at `:10` and `targeted-result.md:42` reconcile only the invalid-cell carve-out from `plan.md:47`; neither addresses the host-split or mixed-result trigger. `counts.usageCoverage` at `:40-43` also records 8 cells with `unknown` usage, matching the "missing … usage" trigger. | The published headline `NEGATIVE` rests on an unstated precedence choice between two predeclared rules that both fire on the same evidence; a reader cannot tell whether the author considered and rejected `INCONCLUSIVE` or overlooked it, and the harm conclusion is the artifact's primary output. | pre-image: `plan.md#technical-approach-5-classify+classification.precedence+NEGATIVE published without reconciling the competing INCONCLUSIVE host-split/mixed-result trigger` (sha256 uncomputed) | pre-image: `plan.md#technical-approach-5-classify+every fired predeclared classification trigger must be reconciled in the decision record+aggregate classification output` (sha256 uncomputed) | Extend `precedence` with one sentence stating that `NEGATIVE` clause 3 says "repeated" while clause 4 says "on both hosts and repeats", so clause 3 is deliberately host-agnostic and outranks the host-split/mixed-result `INCONCLUSIVE` trigger. |
| 3 | MEDIUM | test coverage / remediation validity | `.spectre/features/learn-v3-targeted-eval/validation/targeted-result.md:73` | Invalidity is perfectly correlated with condition and case: 4/4 candidate longitudinal cells `INVALID` with the same reason family (`targeted-result.json:55-58`), 0/4 candidate irrelevant cells invalid (`:47-50`), 0/8 no-knowledge cells invalid (`:51-54,:59-62`). The reason strings all originate from a single branch, `traceWithOperationCrosscheck` at `scripts/evaluate-knowledge.mjs:1201`, which demands a `history-read`/`history-body` event whenever a `load` result is classified as historical by the loose predicates at `:1178-1195`. The report states only that traces "could not be reconciled" and then proposes "a one-off rerun could target only those four invalid candidate correction cells" without establishing whether the cause is candidate behavior or the crosscheck. | The only proposed remediation consumes 16 further authorized native sessions with no stated reason to produce a different disposition; `plan.md:131` requires discovered defects to be reported for a separately authorized repair round, and an undiagnosed harness-side cause is not reported as such. | pre-image: `plan.md#out-of-bounds-report-discovered-defects+targeted-result.md rerun recommendation+condition-and-case-correlated trace invalidity proposed for rerun without cause attribution` (sha256 uncomputed) | pre-image: `plan.md#out-of-bounds-report-discovered-defects+a systematic infrastructure failure must be attributed before remediation is proposed+native-result integrity reconciliation` (sha256 uncomputed) | Add one line to the Integrity findings section naming `scripts/evaluate-knowledge.mjs:1201` as the emitting gate and stating that the rerun is conditional on first diagnosing whether the crosscheck or the candidate produced the mismatch. |
| 4 | LOW | dead computation / orphaned output | `.spectre/features/learn-v3-targeted-eval/validation/targeted-result.json:47` | `plan.md:60` requires "full-cycle native tokens **and elapsed time** when complete" per cell, and `targeted-contract.json:63` lists `elapsedMs` in `judgmentFields`. No cell row in `targeted-result.json:47-62` carries `elapsedMs`, and `targeted-result.md` reports no elapsed time anywhere, yet `targeted-result.md:86` claims the compact JSON "preserves … targeted judgments". The 8 Claude cells have complete usage (`:40-43`), so the value was available for at least half the matrix. | A declared judgment axis has no home in the repository; `plan.md:75`'s descriptive elapsed-time reporting cannot be re-derived from committed evidence, and the Markdown overstates the JSON's completeness. | pre-image: `plan.md#technical-approach-4-adjudicate-elapsed-time+targeted-result.json cell rows+declared elapsedMs judgment field absent from every committed row` (sha256 uncomputed) | pre-image: `plan.md#technical-approach-4-adjudicate-elapsed-time+every declared per-cell judgment field must appear in the committed result+targeted result persistence` (sha256 uncomputed) | Add `elapsedMs` to each cell row (`null` where the host reported no complete cycle), or narrow the `targeted-result.md:86` completeness claim to the fields actually preserved. |
| 5 | LOW | correctness / internal consistency | `.spectre/features/learn-v3-targeted-eval/validation/targeted-result.json:51` | `plan.md:33` requires no-knowledge cells to have no knowledge plugin, store, or SessionStart payload, and every no-knowledge row records `sessionStartTokens: 0` and `loadedBodyTokens: 0`. The same condition is nonetheless labeled three different ways: `knowledgeRelevance: "irrelevant"` at `:51-52`, `"relevant"` at `:59-60`, and `"none"` at `:53-54,:61-62`. The split follows host, not condition. `knowledgeRelevance` is defined nowhere in `plan.md:57` or `targeted-contract.json:49-64`. | The relevance axis that `task_context.md:18` requires the result to distinguish is internally contradictory for the control condition, so it cannot support the relevance claim it exists to carry. No classification rule reads it, so the published result is unaffected. | pre-image: `plan.md#technical-approach-4-adjudicate-knowledgeRelevance+targeted-result.json no-knowledge rows+same condition labeled irrelevant/relevant/none along host lines` (sha256 uncomputed) | pre-image: `plan.md#technical-approach-4-adjudicate-knowledgeRelevance+a per-condition judgment axis must be applied consistently across hosts+blinded judgment record` (sha256 uncomputed) | Define `knowledgeRelevance` in `targeted-contract.json` and set every no-knowledge row to the value that definition implies. |

## 4. Coverage Record

**Inspected.**

- Prompt normalization hunk `scripts/evaluate-knowledge.mjs:97-100` traced against `scripts/knowledge-evaluation-fixtures/manifest.json:190-210` (`longitudinal-correction`, `userLearnSessions: [0,2]`) and `:64-86` (`irrelevant-task`). Confirmed the no-knowledge branch removes the impossible "Use Learn" instruction while retaining the factual claim and artifact obligation, and the candidate branch still prefixes the host-correct Learn command.
- `assertSelectedPromptHashes` (`:1458-1465`) against `freeze()`'s `promptHash` derivation (`:146`) — identical inputs and identical `hash(JSON.stringify(...))` shape; call site `:1476` sits after `selectFrozenCells` and before `runCells`, with no host invocation in between.
- `NATIVE_PIPELINE_INPUTS` (`:17-24`) confirms `scripts/evaluate-knowledge.mjs` is outside the frozen pipeline hash, so `plan.md:23`'s premise for the new gate holds and the gate is not redundant with `assertFrozenInputs`.
- Cache-key construction `:459-470` and cached-cell replay `:486-509`; the frozen `promptHash` reaches the key only after the new gate has matched it against current code.
- All 16 selected `promptHash` and `fixtureHash` values in `targeted-freeze.json:487-1889` reconciled by inspection against `targeted-contract.json:31-48`; all match. `targeted-freeze.json:6-12` reconciled against `targeted-contract.json:12-18`; all five hashes match.
- Full arithmetic reconciliation of `targeted-result.json`: 16 unique cell IDs equal to the contract's selected set; 8 × 1 + 8 × 4 = 40 sessions; `taskOutcome` totals 13/1/2; `integrityValid` 12 and `integrityInvalid` 4; `usageCoverage` 8 complete (all Claude) / 8 unknown; all four non-null `nativeTokenDelta` values recomputed from the paired cell rows (−16,588; −4,070; +1,236,862; +833,797). Every Markdown table figure matches the JSON.
- New tests `scripts/test_evaluate-knowledge.mjs:175-195` and `:197-221`: the table-driven test proves prompt equality modulo the candidate command line on both hosts and proves neither retry value appears in the final prompt; the hash-gate test proves refusal with `hostCalls === 0`.
- `judgeCell` load/history predicates (`:300-356`), `traceWithOperationCrosscheck` (`:1126-1218`), `primaryJudgmentReport` artifact binding (`:690-714`), and `pairedReport` (`:625-660`).

**Unverified, with reasons.**

- `DIFF_SHA256`, the `plan.md`/`task_context.md` authority digests, and the `targeted-freeze.json` digest could not be recomputed: `shasum`, `openssl dgst`, and `node -e` were all denied by the session permission mode. Content-level reconciliation was performed instead (freeze ↔ contract ↔ result cross-checks above). For the same reason, the `finding_fingerprint` and `invariant_family` digests are published as their exact pre-image strings rather than fabricated hex; the pre-images are stable and re-hashable.
- The local evidence root `/tmp/learnv3-targeted-eval.zeg03j` could not be listed (denied), so `unjudgedReportSha256`, `reviewedReportSha256`, `primaryJudgmentsSha256`, `blindJudgmentsSha256`, and `rawLogTreeSha256` in `targeted-result.json:20-27` are accepted as supplied. Blinding order, the 80 raw log files, and the per-cell `artifactEvidence` binding required by `evaluate-knowledge.mjs:694-695` are therefore unverified from the repository.
- No test or native command was executed. The supplied verification evidence (93/93 tests, `sync-codex --check`, zero-model staging, native run, replay) is accepted as reported and was not re-run.
- The root cause of the 4/4 candidate longitudinal trace invalidity was investigated as far as `evaluate-knowledge.mjs:1178-1205`. The `returnedRevision` fallback (`:1094-1096`) was ruled out — no source in `plugins/spectre` emits `materialized at revision:` or `--- current revision ---`. The `wrappedLoadEvidence` path (`:1066-1072`) uses substring predicates loose enough to classify an ordinary wrapped `load` as historical, but confirming that requires the raw logs, which are unreachable. Finding 3 is therefore written against the report's missing attribution, not against a proven harness defect.

## 5. Requirement Delivery Coverage

| Requirement / AC | Status | Consumer / outcome evidence | Gap / Finding |
| --- | --- | --- | --- |
| §1 Freeze a targeted contract against the current candidate | Delivered | `targeted-freeze.json:6-16` written by `freeze()` (`evaluate-knowledge.mjs:150-164`); `targeted-contract.json:7-19` pins `candidateSourceHead` `d2932eb` and the five freeze hashes | — |
| §1 Normalize the no-knowledge `userLearnSessions` transport before freeze | Delivered | `evaluate-knowledge.mjs:97-100` consumed at run time by `promptContract` at `:1499`; no-knowledge session 0/2 text carries the factual claim and artifact obligation with no Learn reference | — |
| §1 Cover candidate and no-knowledge prompt forms with one table-driven deterministic test | Delivered | `test_evaluate-knowledge.mjs:175-195` iterates both hosts and asserts exactly 2 candidate Learn invocations, zero no-knowledge Learn references, and prompt equality modulo the command line | — |
| §1 Exact 16-cell Cartesian selection, 40 sessions, `case:condition:host:repeat` IDs | Delivered | `targeted-contract.json:31-48` (16 IDs, 8+8 sessions arithmetic) reconciled against `targeted-freeze.json:487-1889` and `targeted-result.json:46-62` | — |
| §1 Run re-derives each selected cell's `promptHash` and refuses a mismatch | Delivered | `evaluate-knowledge.mjs:1458-1465` invoked at `:1476` before `runCells`; refusal proven by `test_evaluate-knowledge.mjs:197-221` with `hostCalls === 0` | — |
| §2 Zero-model qualification gate over all selected shapes before `--allow-native` | Partial | Supplied evidence reports 8 shapes, byte-identical ordinary evidence, 16 cells / 40 sessions; the prompt half is frozen by `test_evaluate-knowledge.mjs:175-195` | Non-prompt frozen per-cell inputs are not re-derived before a host call — Finding 1 |
| §2 No no-knowledge prompt contains `Learn`, `spectre-learn`, or a missing workflow command | Delivered | `test_evaluate-knowledge.mjs:186` asserts `/learn\|spectre-learn\|missing workflow command/i` does not match the joined no-knowledge prompt set; `manifest.json:64-86` shows `irrelevant-task` has no placeholders or Learn text | — |
| §2 Final longitudinal prompt contains neither "three attempts" nor "five attempts" | Delivered | `test_evaluate-knowledge.mjs:190-191` for both conditions and both hosts, against `manifest.json:207` | — |
| §3 Run the frozen cells once under the existing bounds, no automatic replacement | Delivered | `targeted-result.json:29-44` records 16 cells, 40 sessions, 16 runtime-completed, `automaticRetries: 0`; concurrency enforced at `evaluate-knowledge.mjs:476-484` | — |
| §3 Invalid cells stay `INVALID`; aggregate is `INCONCLUSIVE` unless valid pairs independently satisfy a terminal rule | Delivered | `targeted-result.json:55-58` retains `INVALID` alongside non-null `taskOutcome`; `:10` invokes the `plan.md:47` carve-out; `:11-12` keeps correction benefit `INCONCLUSIVE` with no imputation | — |
| §4 Record all declared per-cell judgment axes with `artifactHash` and evidence reference | Partial | `targeted-result.json:47-62` carries `artifactHash`, `taskOutcome`, `currentConstraint`, `staleValueUsed`, `grounding`, `knowledgeRelevance`, integrity disposition, and tokens for every cell | `elapsedMs` absent from every row — Finding 4 |
| §4 Blind adjudication bound to each artifact hash | Delivered | Binding enforced by `evaluate-knowledge.mjs:694-695` (`artifactEvidence === artifactHash === deliverable.hash`); `targeted-result.json:20-23` records the separate blind and primary judgment digests | Digest verification blocked — see Coverage Record |
| §4 Do not collapse constraint use and secondary elaboration into one boolean | Delivered | `targeted-result.json:57-58` show `correct-complete` coexisting with `noncritical-elaboration`, and `:62` shows `correct-complete` with `critical-unsupported-claim` | — |
| §4 Relevance axis distinguishes retrieval relevance | Partial | `knowledgeRelevance` present on all 16 rows | Host-inconsistent for the control condition — Finding 5 |
| §5 Pair by case, host, repeat and apply the fixed lexicographic order | Delivered | `targeted-result.json:64-72` lists all 8 pairs keyed `case:host:repeat`; `targeted-contract.json:65-70` freezes the order; deltas recomputed and confirmed | — |
| §5 Publish one aggregate result using rules fixed before native execution | Partial | `targeted-result.json:3-13` and `targeted-result.md:3-9` publish `NEGATIVE` with `decidingRule` and two evidence rows, against `targeted-contract.json:71-76` | Competing `INCONCLUSIVE` trigger unreconciled — Finding 2 |
| §5 Reports show every pair, both repeats, raw counts, invalid cells, token coverage, deltas, and the deciding rule | Delivered | `targeted-result.md:13-25` (counts), `:31-40` (all 8 pairs, both repeats, deltas), `:54-59` (invalid cells), `:63-67` (token coverage), `:42` (deciding rule) | — |
| §5 No upgrade by extrapolating from missing cells | Delivered | `targeted-result.json:65-68` marks all four longitudinal pairs `validForDecision: false`; `:76-77` and `targeted-result.md:61` refuse the invalid stale-five cell as deciding evidence | — |
| External Dependencies — no new packages; `--baseline-plugin` required and stages nothing unselected | Delivered | No dependency change in the diff; `evaluate-knowledge.mjs:1616` requires `--baseline-plugin`; staging is driven only by `selectedFreeze.cells` via `runCells` at `:1477` | — |
| Verification — deterministic 16-ID expansion, 8 candidate / 8 no-knowledge, no other family | Delivered | `targeted-contract.json:31-48` and `targeted-result.json:46-62` contain only `irrelevant-task` and `longitudinal-correction` IDs, 8 per condition, zero baseline | — |
| Verification — `sync-codex --check` passes before freeze | Delivered | Reported pass in the supplied evidence; no `plugins/` change in the diff, so the frozen candidate hash at `targeted-contract.json:16` still describes the mirror | Not re-run — see Coverage Record |
| Verification — independent recomputation reproduces the classification without the 144-cell threshold | Delivered | All counts, pair directions, and token deltas recomputed from `targeted-result.json` in this review and matched; the v15 acceptance threshold appears nowhere in the artifacts | — |
| Out-of-Bounds — no baseline/other-family cells, ≤16 cells / 40 sessions, no v15 reuse, no production Learn change | Delivered | Selected-ID audit above; `targeted-result.json:30-31,:44`; `candidateSourceHead` `d2932eb` is this branch's normalization commit, not a v15 artifact; diff touches no `plugins/` file | — |
| Out-of-Bounds — report discovered defects for a separately authorized round | Partial | `targeted-result.md:73` and `targeted-result.json:79` state that a rerun needs explicit authorization and a fresh freeze | Systematic invalidity proposed for rerun without cause attribution — Finding 3 |
| Out-of-Bounds — no statistical-generalization claim | Delivered | `targeted-result.json:75` caveat and `targeted-result.md:71` both restrict the result to a narrow directional finding | — |

## 6. Scope and Dead-Path Audit

### Scope creep

| Item | Location | Assessment |
| --- | --- | --- |
| None found | — | The diff touches exactly one production function (`promptContract`), adds one gate function and its call site, adds two tests, and writes four feature-local artifacts. No fixture, oracle, configuration, model, or `plugins/` change accompanies the result. |

### Dead computations / orphaned outputs

| Item | Location | Assessment |
| --- | --- | --- |
| `knowledgeRelevance` | `targeted-result.json:47-62` | Recorded on all 16 rows and required by `plan.md:57`, but read by no rule in `targeted-contract.json:65-76`. Required by the plan, so not removable; its inconsistency is Finding 5. |
| `elapsedMs` | `targeted-contract.json:63` | Declared in the frozen `judgmentFields` but never emitted to any committed row — Finding 4. |
| `cell.fixtureHash` | `evaluate-knowledge.mjs:147` → `:460` | Produced at freeze and consumed only as a cache-key input; never re-derived or asserted, unlike its sibling `promptHash` — Finding 1. |

### Old active paths

| Item | Location | Assessment |
| --- | --- | --- |
| None found | — | The prior candidate-only rewrite text ("Complete the requested on-demand capture") is fully replaced at `evaluate-knowledge.mjs:98`; no alternate prompt-construction path survives. `promptContract` has exactly two callers (`:146` freeze, `:1499` run) plus the new gate at `:1462`, all with identical arguments. |

### Duplicate data sources

| Item | Location | Assessment |
| --- | --- | --- |
| Freeze hashes duplicated into the contract | `targeted-freeze.json:6-12` and `targeted-contract.json:12-18` | Intentional and reconciled — the contract is the human-readable pin and carries the freeze file's own digest at `:10`. Verified identical by inspection. |
| Selected-cell `promptHash` duplicated into the contract | `targeted-freeze.json:487-1889` and `targeted-contract.json:31-48` | Intentional; all 16 verified identical. Only the freeze copy is authoritative at run time (`evaluate-knowledge.mjs:1463`). |
| Result published as both JSON and Markdown | `targeted-result.json` and `targeted-result.md` | Required by `plan.md:84`. Every shared figure was recomputed and matches; the JSON is authoritative. |

## 7. Prioritized Actions

1. Close the `fixtureHash` gate hole in `assertSelectedPromptHashes` (`scripts/evaluate-knowledge.mjs:1458`) so every frozen per-cell derivation is re-verified before a host call — Finding 1.
2. Attribute the 4/4 candidate longitudinal trace invalidity to either the candidate or `traceWithOperationCrosscheck` (`scripts/evaluate-knowledge.mjs:1201`) and make the proposed rerun conditional on that diagnosis — Finding 3.
3. Reconcile the fired `NEGATIVE` clause against the plan's competing host-split / mixed-result `INCONCLUSIVE` trigger in `classification.precedence` — Finding 2.
4. Emit `elapsedMs` on every committed cell row, or narrow the completeness claim at `targeted-result.md:86` — Finding 4.
5. Define `knowledgeRelevance` in the contract and apply one consistent value to the no-knowledge rows — Finding 5.

## 8. Review Metadata

- Timestamp: `2026-09-08T00:00:00Z`
- Review Mode: `final`
- Runtime route: `Claude Code | opus | high | Codex -> Claude Code`
- Fallback reason: `none`
- Route note: the session permission mode denied `shasum`, `openssl`, `node -e`, `ls`, and `git status`, so no digest was recomputed and no command was executed. Findings rest on file inspection and arithmetic reconciliation only; fingerprint pre-images are published in place of digests.
