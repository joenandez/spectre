# Learn v3 targeted effectiveness evaluation — planning context

Feature: `learn-v3-targeted-eval`
Feature Root: `.spectre/features/learn-v3-targeted-eval`

## Confirmed scope authority

The 2026-09-08 thread confirms a targeted causal comparison of current Learn v3 against not using knowledge at all. The evaluation is limited to the existing `longitudinal-correction` benefit case and `irrelevant-task` harm control, on Claude and Codex, with two repeats per condition and host. Planning does not authorize native execution.

The intended pass contains 16 cells and 40 native sessions:

- eight `longitudinal-correction` cells, four sequential fresh sessions each;
- eight `irrelevant-task` cells, one session each;
- conditions `candidate` and `no-knowledge` only;
- hosts Claude and Codex;
- repeats 1 and 2.

The result must distinguish task correctness, stale-value safety, unsupported elaboration, retrieval integrity, relevance, and full-cycle cost. It must not repeat the prior binary-scoring mistake where correct constraint recall was obscured by a secondary unsupported detail.

## Repository evidence

- `scripts/evaluate-knowledge.mjs:62-117` already accepts repeated `--cell` selectors and rejects unknown frozen IDs.
- `scripts/evaluate-knowledge.mjs:75-101` rewrites explicit Learn transport only when knowledge is installed. In the current `longitudinal-correction` no-knowledge prompt, the literal instruction “Use Learn” survives even though no plugin exists. The targeted pass must replace that with behaviorally equivalent ordinary-project evidence recording before freeze and cover both prompt forms with a deterministic test.
- `scripts/evaluate-knowledge.mjs:120-163` freezes fixture, oracle, configuration, candidate, prompt, and native-pipeline hashes; the full manifest can be frozen once and a named subset selected at execution.
- `scripts/evaluate-knowledge.mjs:455-535` binds cache reuse to those hashes and enforces the configured total/per-host concurrency.
- `scripts/evaluate-knowledge.mjs:1448-1473` refuses changed frozen inputs and native calls without `allowNative`.
- `scripts/evaluate-knowledge.mjs:624-657` pairs by case, host, and repeat, but assumes all three historical conditions; the targeted two-condition conclusion therefore needs a feature-local aggregation contract rather than the existing full-matrix threshold status.
- `scripts/evaluate-knowledge.mjs:689-712` binds manual judgments to exact artifact hashes.
- `scripts/knowledge-evaluation-staging.mjs:583-649` creates fresh isolated condition stores/homes and installs no plugin for `no-knowledge`; candidate staging copies the current host plugin and enables trace evidence.
- `scripts/knowledge-evaluation-fixtures/manifest.json:65-85` defines the irrelevant warehouse-retention distractor and the accessibility facts that must drive the artifact.
- `scripts/knowledge-evaluation-fixtures/manifest.json:191-209` defines the four-session retry-ceiling capture, reuse, correction, and corrected-reuse journey.
- `scripts/knowledge-evaluation-oracle.json:32-36` requires zero knowledge/history loads for the irrelevant case.
- `scripts/knowledge-evaluation-oracle.json:102-113` requires capture, fresh reuse, correction, and corrected fresh reuse of the current revision.
- `scripts/knowledge-evaluation-config.json` pins Claude Opus 5 and Codex GPT-5.6 Sol at high effort with bounded timeouts.
- `scripts/test_evaluate-knowledge.mjs:96-139` covers exact cell selection and hash-bound cache invalidation.
- `scripts/test_knowledge-evaluation-staging.mjs:282-307` verifies identical ordinary repository task evidence across conditions; additional targeted assertions must prove the final correction prompt does not reveal the current value.

## Prior evidence and interpretation

The v15 report is intentionally partial: 98/144 cells cached, 93 exact-hash semantic judgments, 46 cells unrun, 13 invalid, and one failed without a deliverable. Its raw correctness totals cannot answer the present question. Most incorrect artifacts retained the core constraint but added unsupported mechanics; all `longitudinal-correction` cells were unrun. The existing evidence therefore classifies Learn effectiveness as inconclusive, not negative.

The v15 irrelevant-task candidate and no-knowledge rows are useful diagnostic history but are not accepted as current results because the final candidate hash and the targeted scoring contract must be frozen together.

## Knowledge search

`spectre knowledge search "targeted Learn v3 effectiveness evaluation candidate no-knowledge longitudinal correction irrelevant task" --project-dir .` returned no applicable maintained records. No knowledge body or revision was loaded for planning.

## Initial routing

- Schema: `plan-routing/v1`
- Shape: `DIRECT`
- Uncertainty: `MODERATE`
- Evidence: `SUFFICIENT`
- Protected boundaries: evaluation validity, native isolation/provenance, fixed evaluation budget
- Task graph risk: `LOW`
- Design authority required: `false`
- Size / route: `M / M_REVIEWED_DIRECT`
- Reason codes: `DIRECT_CHANGE`, `MODERATE_UNCERTAINTY`, `PROTECTED_BOUNDARY`
- Plan telemetry: `plan_run_0ccade4d-b73a-4415-93a5-9c18b3fd5b9e`

## Filled assumptions

- “Not using Learn” means no knowledge plugin or store, while retaining the same ordinary repository evidence and task artifacts; it is not an intentionally helpless control.
- Candidate sessions may invoke Learn; matched no-knowledge sessions receive the same factual evidence and artifact obligation but must not mention or attempt Learn. They preserve evidence through ordinary project artifacts instead.
- Each repeat is a separate cell. A longitudinal cell contains four sequential native sessions; an irrelevant-task cell contains one.
- An infrastructure-invalid cell is reported as invalid. It is not silently retried outside the 16-cell/40-session authorization.
- This small pass supports a directional product conclusion, not a statistically general claim about all tasks or models.
