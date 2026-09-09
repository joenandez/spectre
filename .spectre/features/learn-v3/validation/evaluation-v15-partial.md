# Learn v3 native evaluation — intentionally partial

## Decision and status

The user directed the team to stop the expensive native comparison, preserve the evidence already collected, and finish the feature. No provider cell was started, resumed, or retried for this report.

This is **not** a completed acceptance run. The planned full matrix was 144 frozen cells. The preserved v15 cache contains 98 cells (68.1%); 93 have a manual semantic judgment tied to the exact deliverable hash. The remaining 46 cells were never run. The full-matrix acceptance criterion is **waived by the user, not passed**. The separate full proof run is **skipped by the user, not passed**.

The complete machine-readable inventory is [evaluation-v15-partial.json](evaluation-v15-partial.json).

## Frozen input and provenance

The report uses only the retained v15 snapshot:

- Freeze: `/var/folders/qm/xyc9f8dj52v72q7bk63q5w9w0000gn/T/learnv3-knowledge-eval-OvzAoq/freeze-v15.json` — `sha256:66ee2c0f020f807532be28a1f7b101cc5d28252dcfe568194ba2cb5570591013`
- Judgment ledger: `/var/folders/qm/xyc9f8dj52v72q7bk63q5w9w0000gn/T/learnv3-knowledge-eval-OvzAoq/primary-judgments-v15.json` — `sha256:3ceb6326a0da37147c8638f665c3b83db41732d180fda71d865827a6a1002b84`
- Baseline: `1cd1f035a253e9d7ef5086693ab9f1d0b11d360b`; frozen native pipeline inputs: `sha256:b221e0839887cc43c9dfd5e1acb8c34e94d7cc0625825aba6681225905bc248e`.

The freeze covers 12 case families, three conditions (`no-knowledge`, `baseline`, `candidate`), two hosts (Claude and Codex), and two repeats. Longitudinal scenarios add fresh-session workflows within their cells.

## Observed data only

| Observation | Count |
| --- | ---: |
| Cached cells | 98 / 144 |
| Cached pending / invalid / failed statuses | 84 / 13 / 1 |
| Exact-hash semantic judgments | 93 |
| Judged correct / incorrect | 53 / 40 |
| `requiredRecallBeforeDecision` true / false | 86 / 7 |
| Judgments with present token metrics | 75 |
| Unnecessary history loads in present metrics | 14 |
| Justified expansions | 3 |

These counts describe the preserved cells and manual judgment ledger; they are not a candidate-versus-baseline result, a threshold result, or a prediction for unrun cells. In particular, the plan requires paired, complete coverage to assess recall, token, and correctness thresholds. Thirteen cached cells are invalid due to missing trace evidence or detected store bypass, so they cannot support a clean acceptance calculation even though their artifacts and any accompanying semantic judgment are retained.

## Cached cells needing attention

Five cached cells have no final manual judgment:

```text
blocker-resolution:baseline:claude:2
blocker-resolution:candidate:claude:1
verified-gotcha:candidate:claude:2
worktree-applicability:candidate:codex:1
worktree-applicability:candidate:codex:2
```

`verified-gotcha:candidate:claude:2` is also the one cached failed cell: its host process exited with code 1 and it has no deliverable. It needs a fresh authorized run, not an artifact-only judgment.

The 13 invalid cached cells are listed in the JSON manifest with their exact integrity reason. They include missing candidate traces, missing load/capture evidence, and direct knowledge-store bypasses; none is silently counted as clean.

## Exact frozen cells not run

These 46 frozen cells are the one-off authorization inventory:

```text
accepted-decision:baseline:codex:1
accepted-decision:baseline:codex:2
accepted-decision:candidate:codex:1
accepted-decision:candidate:codex:2
accepted-decision:no-knowledge:codex:1
blocker-resolution:baseline:codex:1
blocker-resolution:baseline:codex:2
blocker-resolution:candidate:claude:2
blocker-resolution:candidate:codex:1
blocker-resolution:candidate:codex:2
blocker-resolution:no-knowledge:codex:1
blocker-resolution:no-knowledge:codex:2
lifecycle-identity:baseline:claude:1
lifecycle-identity:baseline:claude:2
lifecycle-identity:baseline:codex:1
lifecycle-identity:baseline:codex:2
lifecycle-identity:candidate:claude:2
lifecycle-identity:candidate:codex:2
lifecycle-identity:no-knowledge:claude:1
lifecycle-identity:no-knowledge:claude:2
lifecycle-identity:no-knowledge:codex:1
lifecycle-identity:no-knowledge:codex:2
longitudinal-correction:baseline:claude:1
longitudinal-correction:baseline:claude:2
longitudinal-correction:baseline:codex:1
longitudinal-correction:baseline:codex:2
longitudinal-correction:candidate:claude:1
longitudinal-correction:candidate:claude:2
longitudinal-correction:candidate:codex:1
longitudinal-correction:candidate:codex:2
longitudinal-correction:no-knowledge:claude:1
longitudinal-correction:no-knowledge:claude:2
longitudinal-correction:no-knowledge:codex:1
longitudinal-correction:no-knowledge:codex:2
pattern-speculation:baseline:codex:1
pattern-speculation:baseline:codex:2
pattern-speculation:candidate:codex:1
pattern-speculation:candidate:codex:2
pattern-speculation:no-knowledge:codex:1
pattern-speculation:no-knowledge:codex:2
verified-gotcha:baseline:codex:1
verified-gotcha:baseline:codex:2
verified-gotcha:candidate:codex:1
verified-gotcha:candidate:codex:2
verified-gotcha:no-knowledge:codex:1
verified-gotcha:no-knowledge:codex:2
```

For any future one-off, use the frozen v15 configuration and the specific cell ID from the manifest. A one-off can add evidence for that cell, but it does not retroactively make the full-matrix acceptance criterion pass.
