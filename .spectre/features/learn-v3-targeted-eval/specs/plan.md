# Learn v3 Targeted Effectiveness Evaluation Plan

Feature: `learn-v3-targeted-eval`
Feature Root: `.spectre/features/learn-v3-targeted-eval`
Execution Mode: direct

## Overview

Determine whether current Learn v3 is more effective than no knowledge at all with the smallest causal comparison that covers both benefit and harm. Freeze the current candidate once, run only `longitudinal-correction` and `irrelevant-task` for candidate and no-knowledge on Claude and Codex with two repeats, adjudicate separate outcome dimensions, and publish one result as `POSITIVE`, `NEUTRAL`, `NEGATIVE`, or `INCONCLUSIVE`.

This is a 16-cell ceiling containing 40 native sessions. It does not resume the 144-cell matrix, compare the retired baseline, or run during planning.

## Technical Approach

### 1. Freeze a targeted contract against the current candidate

Create a feature-local evaluation contract that records the exact 16 cell IDs, the current repository/candidate HEAD, fixture/oracle/configuration/native-pipeline hashes, the scoring fields below, and the fixed decision rules. Use the existing full-manifest freeze implementation, then select only the named cells through repeated `--cell` arguments.

Before freezing, normalize the existing no-knowledge transport for `userLearnSessions`: candidate prompts invoke Learn, while no-knowledge prompts receive the same factual evidence and artifact obligation using ordinary project evidence without mentioning or attempting Learn. The present prompt contract leaves the literal “Use Learn” instruction in no-knowledge longitudinal sessions, which would bias the control with an impossible action. Cover the candidate and no-knowledge prompt forms with one table-driven deterministic test.

The authorized cells are the exact Cartesian product `{longitudinal-correction, irrelevant-task} × {candidate, no-knowledge} × {claude, codex} × {1, 2}`, using IDs in `case:condition:host:repeat` order. This expands to 16 unique cells and 40 sessions.

Do not reuse v15 candidate artifacts as current evidence. Any candidate, fixture, oracle, configuration, or native-pipeline change after freeze is refused by the existing hash gate before a host call. That gate does not cover the prompt-transport code itself: `promptContract` lives in `scripts/evaluate-knowledge.mjs`, which is in neither the frozen roots nor `NATIVE_PIPELINE_INPUTS`, and the cache key consumes the frozen `promptHash` value rather than re-deriving it. The run must therefore re-derive each selected cell's `promptHash` and refuse the mismatch itself, as required by the gate in step 2.

Retained complexity — feature-local targeted contract and result schema: required now by a two-condition causal conclusion with separate correctness, stale-safety, grounding, relevance, and cost axes | simpler local option: use the existing full-matrix report unchanged | why it fails now: it requires candidate, baseline, and no-knowledge and collapses the targeted dimensions | removal failure: the selected run cannot yield the requested classification. Verify by recomputing the result from the committed targeted JSON and exact paired rows.

### 2. Qualify causality without native model calls

Before `--allow-native`, stage all selected condition/host shapes and assert:

- candidate and no-knowledge receive byte-identical ordinary repository evidence and task state;
- candidate Learn sessions and no-knowledge ordinary-recording sessions contain the same factual claims and output obligations, while no no-knowledge prompt contains `Learn`, `spectre-learn`, or a missing workflow command;
- no-knowledge has no Spectre knowledge plugin, store, SessionStart payload, or connected external tools;
- each selected cell's `promptHash`, re-derived from the current `promptContract`, equals its frozen value;
- candidate uses the synced canonical/Codex plugin outputs from the frozen candidate;
- the final longitudinal session does not contain either “three attempts” or “five attempts” in its prompt, while both values remain discoverable through the condition's ordinary accumulated project evidence;
- the irrelevant task contains the two accessibility observations for both conditions, while only candidate has the unrelated warehouse-retention knowledge record;
- selected IDs contain no baseline or other case family and total exactly 16 cells / 40 prepared sessions;
- host homes, Git/GitHub fixtures, network/socket restrictions, credentials, raw logs, and trace paths remain isolated under the already-tested staging boundary.

Fail this gate before any native call if evidence differs, the answer leaks, a prompt hash moved, the candidate mirror is stale, or the selected count expands.

### 3. Run the frozen cells once under the existing bounds

Run the exact selected set with the frozen Claude/Codex models and effort, maximum four simultaneous sessions and two per host. The run launches up to four cells at once and has no interior stop, so the canary is a separate first invocation restricted to the two `irrelevant-task` candidate/no-knowledge `--cell` IDs. Continue only if both artifacts, isolation evidence, and host provenance are clean. The full 16-cell invocation then reuses those two cached cells under the same freeze key, so the canary remains part of the 16 cells and creates no extra calls.

Persist every cell result, raw-log location, deliverable hash, session usage, snapshots, ordered operations/results, trace, and freeze key. Do not start a replacement cell automatically. A launch failure, timeout, missing deliverable, unavailable required candidate trace, direct-store bypass, connected-tool access, hash mismatch, or incomplete full-cycle usage is `INVALID` and makes the aggregate result `INCONCLUSIVE` unless the already-completed valid pairs independently satisfy a terminal rule without imputing the missing pair.

### 4. Adjudicate effectiveness on separate axes

Blind manual adjudication to condition labels until each artifact hash is bound. Record these fields per cell:

- `taskOutcome`: `correct-complete | safe-deferral | incorrect`;
- `currentConstraint`: `three | five | missing | not-applicable`;
- `staleValueUsed`: boolean;
- `grounding`: `grounded | noncritical-elaboration | critical-unsupported-claim`;
- `knowledgeRelevance`: `relevant | irrelevant | none`;
- `artifactHash` and exact evidence reference;
- structural/integrity disposition from the existing evaluator;
- full-cycle native tokens and elapsed time when complete.

For longitudinal cells, `correct-complete` requires using the current ceiling of three, not using five as current, and completing the requested artifact. A safe request for missing evidence is better than a wrong or stale answer but less effective than correct completion. For irrelevant cells, correctness requires both accessibility findings and no warehouse-retention policy; candidate must perform zero knowledge-body and history-body loads.

Write each judgment as a primary-judgment entry that keeps the existing `artifactHash`, `artifactEvidence`, `correct`, `relevant`, and `requiredRecallBeforeDecision` fields and adds the targeted axes above. The existing evaluator binds a judgment to its artifact only through those fields, so the targeted schema extends that entry rather than replacing it.

Do not collapse correct constraint use and a secondary unsupported detail into one opaque boolean. Grounding remains a real quality dimension and a critical unsupported claim can still make `taskOutcome` incorrect, but noncritical elaboration is reported separately.

### 5. Pair and classify the result

Pair candidate and no-knowledge by case, host, and repeat. Compare longitudinal pairs lexicographically:

1. `taskOutcome`: correct-complete > safe-deferral > incorrect;
2. stale safety: any current use of five loses the pair;
3. grounding: grounded > noncritical elaboration > critical unsupported claim;
4. when semantic outcomes tie, lower complete native full-cycle token usage wins; report elapsed time as descriptive rather than a tie-breaker.

Publish one aggregate result using rules fixed before native execution:

- `POSITIVE`: all four candidate longitudinal cells are valid, use three, and avoid stale five; candidate is never worse and strictly wins at least three of four longitudinal pairs, or ties semantic outcomes while having a lower paired median full-cycle token cost; all four candidate irrelevant cells match control correctness, load no knowledge/history body, and remain within the 300-token SessionStart cap.
- `NEGATIVE`: candidate uses stale five in any valid final artifact; loses at least two longitudinal pairs on semantic outcome; introduces a repeated irrelevant-task correctness/grounding regression; or has no semantic benefit while complete paired full-cycle cost is consistently higher on both hosts and repeats.
- `NEUTRAL`: every required cell is valid, longitudinal semantic outcomes tie, no stale or irrelevant-task regression occurs, and token results show neither consistent advantage nor disadvantage.
- `INCONCLUSIVE`: an integrity gap, missing judgment/usage, host split, single unmatched regression, or mixed result prevents the rules above from deciding without adding runs. `INCONCLUSIVE` is also the residual result whenever no `POSITIVE`, `NEGATIVE`, or `NEUTRAL` rule fires.

The final Markdown and JSON reports must show every pair, both repeats, raw counts, invalid cells, token coverage, candidate/no-knowledge deltas, and the exact rule that selected the classification. A result may not be upgraded by extrapolating from missing cells.

## Critical Files

- `scripts/evaluate-knowledge.mjs:62` — **Core logic:** freeze/run entrypoint and exact `--cell` selection.
- `scripts/evaluate-knowledge.mjs:455` — **Core logic:** hash-bound cache, concurrency, persistence, and failure continuation.
- `scripts/knowledge-evaluation-staging.mjs:583` — **Core logic:** isolated candidate/no-knowledge staging boundary.
- `scripts/knowledge-evaluation-fixtures/manifest.json:65` — **Pattern:** irrelevant-knowledge negative control.
- `scripts/knowledge-evaluation-fixtures/manifest.json:191` — **Pattern:** four-session correction journey.
- `scripts/knowledge-evaluation-oracle.json:32` — **Interface:** load/capture expectations requiring targeted semantic augmentation.
- `scripts/test_evaluate-knowledge.mjs:96` — **Test:** named-cell selection and frozen cache behavior.

## External Dependencies — Verify Before Implementation

No new packages. Before native execution, confirm the pinned Claude and Codex CLIs authenticate inside the isolated homes and the existing Node test/runtime dependencies resolve from this checkout. The `run` command also requires `--baseline-plugin`; it stages nothing for unselected cells, so supplying it does not run baseline cells.

## Verification — How We Know This Works

### Frozen selection and evidence symmetry

- A deterministic test expands the targeted contract to exactly 16 unique IDs, 8 candidate and 8 no-knowledge, with no baseline/other-family ID and exactly 40 prompt sessions.
- The table-driven prompt-contract test shows exactly two Learn invocations in each candidate correction cell, zero Learn references in no-knowledge cells, equivalent factual evidence/output obligations across each paired session, and neither retry value in the final correction prompt.
- Staging snapshots show identical ordinary evidence per paired cell and prove the final correction prompt contains neither retry value.
- `npm run sync-codex -- --check --quiet` passes before freeze, so the frozen candidate contains a Codex mirror matching canonical.
- Freeze verification rejects any changed fixture, oracle, configuration, candidate, or pipeline input before a host call, and the run separately rejects any selected cell whose re-derived `promptHash` differs from its frozen value.

### Native integrity and bounded execution

- All accepted cells have matching freeze keys, completed host status, persisted artifact hashes, complete ordered evidence, clean sandbox/connected-tool checks, and required candidate traces.
- The run inventory contains only the 16 authorized IDs and no more than 40 native sessions; concurrency never exceeds four total or two per host.
- Invalid infrastructure evidence remains `INVALID` and cannot receive a semantic pass.

### Effectiveness conclusion

- Four longitudinal candidate/no-knowledge pairs and four irrelevant pairs have hash-bound blinded judgments on every declared axis.
- The report recomputes the fixed pair ordering and aggregate classification from JSON and shows the deciding rows and complete token-coverage status.
- Independent recomputation from the committed JSON yields the same classification and never uses the prior 144-cell acceptance threshold as a substitute.

## Out-of-Bounds — DO NOT add

- Do not run native models or consume the 40-session allowance during planning.
- Do not run baseline/current-Spectre cells or any of the other ten scenario families.
- Do not resume, complete, or relabel the v15 144-cell matrix.
- Do not exceed 16 cells or 40 native sessions; invalid cells require separate user authorization before any one-off retry.
- Do not tune Learn, prompts, fixtures, oracle, scoring rules, or models after seeing results and then reuse the same freeze.
- Do not treat v15 cached candidate artifacts as current-candidate evidence.
- Do not turn this directional two-model experiment into a statistical-generalization claim.
- Do not modify production Learn behavior as part of evaluation execution; discovered defects are reported for a separately authorized repair/evaluation round.
