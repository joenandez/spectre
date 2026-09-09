# Learn v3 Targeted Effectiveness Result

## Result: INCONCLUSIVE

The targeted pass is **INCONCLUSIVE under the predeclared rules**. The valid irrelevant-task pairs split by host (Claude tie/win; Codex loss/loss), Codex did not preserve complete full-cycle usage, and all four candidate correction cells failed the trace-integrity gate.

The repeated valid Codex irrelevant-task grounding losses remain a **negative signal**: both candidate artifacts added noncritical elaboration while their no-knowledge controls were grounded. Both candidate artifacts were task-correct and did not load the irrelevant knowledge body, but that signal does not override the host split, incomplete usage, and correction integrity gaps.

No retries or replacement cells were run.

## What ran

| Measure | Result |
| --- | ---: |
| Frozen cells | 16 / 16 |
| Native sessions | 40 / 40 |
| Runtime-completed cells | 16 |
| Integrity-valid cells | 12 |
| Integrity-invalid cells | 4 |
| Correct-complete artifacts | 13 |
| Safe deferrals | 1 |
| Incorrect artifacts | 2 |
| Complete full-cycle token records | 8 (all Claude) |
| Unknown full-cycle token records | 8 (all Codex) |
| Preserved full-cycle elapsed records | 0 (all rows `elapsedMs: null`) |
| Automatic retries | 0 |

The 13/16 correct-complete count is descriptive only. It must not be read as a candidate win because it combines conditions, includes four integrity-invalid candidate artifacts, and ignores paired grounding differences.

## Paired results

| Case | Host | Repeat | Integrity-valid pair | Candidate | No knowledge | Direction | Native token delta (candidate − control) |
| --- | --- | ---: | --- | --- | --- | --- | ---: |
| longitudinal correction | Claude | 1 | No | safe deferral; missing current value; critical unsupported claim | correct three; noncritical elaboration | candidate loss, artifact-only | +1,236,862 |
| longitudinal correction | Claude | 2 | No | incorrect stale five; critical unsupported claim | correct three; noncritical elaboration | candidate loss, artifact-only | +833,797 |
| longitudinal correction | Codex | 1 | No | correct three; grounded | incorrect; current value missing | candidate win, artifact-only | unknown |
| longitudinal correction | Codex | 2 | No | correct three; noncritical elaboration | correct three; critical unsupported claim | candidate win, artifact-only | unknown |
| irrelevant task | Claude | 1 | Yes | correct; grounded | correct; grounded | tie | −16,588 |
| irrelevant task | Claude | 2 | Yes | correct; grounded | correct; noncritical elaboration | candidate win | −4,070 |
| irrelevant task | Codex | 1 | Yes | correct; noncritical elaboration | correct; grounded | candidate loss | unknown |
| irrelevant task | Codex | 2 | Yes | correct; noncritical elaboration | correct; grounded | candidate loss | unknown |

The two valid Codex losses are a repeated negative signal, but the valid irrelevant-task pair directions split by host and Codex usage is incomplete. Together with the four integrity-invalid candidate correction cells, those predeclared conditions select `INCONCLUSIVE`; no invalid correction pair was imputed.

## Integrity findings

All eight no-knowledge cells and all four irrelevant-task candidate cells were integrity-valid. Candidate irrelevant-task behavior also met the retrieval-harm boundaries:

- zero knowledge-body and history-body loads in every candidate irrelevant cell;
- SessionStart payloads of 185, 185, 199, and 200 tokens, all below the 300-token cap;
- complete artifacts, isolated homes/filesystems, and no bypass findings.

All four candidate correction cells were invalid because `traceWithOperationCrosscheck` could not reconcile their recorded traces with native history-read evidence. Three also carried shell-read bypass findings:

| Cell | Trace disposition | Bypass findings | Artifact outcome |
| --- | --- | ---: | --- |
| `longitudinal-correction:candidate:claude:1` | missing native history-read evidence | 1 | safe deferral; current value missing |
| `longitudinal-correction:candidate:claude:2` | missing native history-read evidence | 2 | incorrect; stale five used as current |
| `longitudinal-correction:candidate:codex:1` | missing native history-read evidence | 0 | correct three |
| `longitudinal-correction:candidate:codex:2` | missing native history-read evidence | 1 | correct three |

The stale-five Claude artifact is a serious directional warning, but it cannot decide the result because that cell is integrity-invalid. The repeated valid Codex irrelevant-task grounding regression is likewise retained only as a negative signal; the aggregate remains `INCONCLUSIVE` for the reasons above.

## Cost signal

Claude reported complete full-cycle usage. On the irrelevant task, candidate was modestly cheaper in both repeats (−16,588 and −4,070 tokens). On the invalid correction cells, candidate was much more expensive (+1,236,862 and +833,797 tokens), but those deltas are not accepted effectiveness evidence because the candidate cells failed integrity.

Codex reported session counts but not complete native token totals, so no cross-host cost conclusion is allowed.

## Interpretation

This pass does not validate Learn v3 as more effective than no persisted knowledge. Under the deliberately strict, precommitted rule set its aggregate result is `INCONCLUSIVE`; the repeated Codex grounding losses are retained as a negative signal rather than generalized into an outcome.

It also does not establish that durable learning is broadly harmful. The correction artifacts show a host split, and the candidate-side trace failures prevent accepting either the Claude losses or Codex wins as causal evidence. Before any separately authorized fresh evaluation, diagnose whether `traceWithOperationCrosscheck` or candidate behavior caused the correction trace mismatch; no rerun is proposed from this evidence alone.

## Provenance

- Plan: `.spectre/features/learn-v3-targeted-eval/specs/plan.md` (`05639d749829b9f8daccac6825acbab73c349c49b66158143c1408dc42c98778`)
- Candidate source: `d2932ebec28cb61d37ac061edab7afd9a146d746`
- Frozen contract: `.spectre/features/learn-v3-targeted-eval/validation/targeted-contract.json`
- Freeze artifact: `.spectre/features/learn-v3-targeted-eval/validation/targeted-freeze.json` (`36f2a88d0d3e3d2c3465f0e338507521297e63b7b982d3a6070fe3048c8f4e78`)
- Machine-readable result: `.spectre/features/learn-v3-targeted-eval/validation/targeted-result.json`
- Local reviewed evidence: `/tmp/learnv3-targeted-eval.zeg03j/full-report-reviewed.json` (`900ce218544299782aa0d8e093f3b61d14f3aebb348a0c7ec6fbb28322fbe3ae`)
- Local blinded judgments: `/tmp/learnv3-targeted-eval.zeg03j/blind-judgments.json` (`a552596515c1555d70ef0eba4d5b15b3a83fe2e8e3965b82ae579e45bcc0fa07`)
- Raw logs: `/tmp/learnv3-targeted-eval.zeg03j/raw` (40 stdout + 40 stderr; tree hash `sha256:89b22275158da2673835156cac9a3a9357f9c5c11ede095022a432a58f11bf88`)

The compact JSON preserves all 16 cell rows, all eight pairs, artifact hashes, integrity dispositions, targeted judgments, token coverage, and the exact deciding rule. Full-cycle elapsed time was not preserved, so every row records `elapsedMs: null` rather than inventing one. The larger local evidence remains hash-bound but is intentionally not added to the repository.
