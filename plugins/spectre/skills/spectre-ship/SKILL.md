---
name: "spectre-ship"
description: "Turn completed branch work into a reviewer-ready PR: directly coordinate cleanup, rebase, one advisory full suite, repair/route failures, and spectre-create_pr. Use when asked to ship finished work. Proof is optional. Do NOT use for implementation, main/master pushes, releases, or autonomous request-to-PR delivery."
user-invocable: true
disable-model-invocation: true
---

# ship

Own cleanup, rebase, advisory suite, and draft PR.

## Inputs

- `$ARGUMENTS`: optional feature root/artifact, target (default `origin/main`), feedback focus, or `--draft`; live branch/tree/remotes/PR state.

## Feature root

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.

## Proof independence

Proof is optional: do not inspect, infer, invoke, or gate on it. Only authority/publication-safety impasses prevent PR creation.

## Outputs + DONE

- Return PR URL, commits, rebase/tested SHA, verification/repairs, `CI: pending`, measurement, and `PR_OPENED` status `PASS|REPAIRED|PRE_EXISTING_FAILURES|INDETERMINATE|KNOWN_FAILURES_REMAIN`.

**DONE when:** Prune analysts/Test testers finish their gates, then Sweep, rebase, one full suite, repair/routing, measurement relay/degradation, and PR URL. Non-green verification never prevents DONE.

## Method / guardrails

1. **Resolve once.** Confirm branch/target/set; reject `main`/`master`. Read the exact branch; never derive work identity from branch, recency, or ambient roots — selection binds to the frozen post-rebase candidate. `FEATURE_ROOT` is artifact-only. Reuse unambiguous ancestral `CLEANED_THROUGH_SHA`. Invoke `spectre-workflow measure start --label Ship`; below, `measure` means `spectre-workflow measure`.
2. **Parallel cleanup boundary.** Classify P0-P3; invoke `measure start` for Prune/Test. In this primary load/follow `Skill(spectre-prune)` and `Skill(spectre-test)` with the set/risk/`FEATURE_ROOT`/`--orchestrated`. Skill loading imports instructions, not phase delegation: the primary owns both contracts and makes one parallel dispatch of leaf `@spectre:analyst`/`@spectre:tester` batches; no phase child spawns agents. Neither stages/commits. Invoke `measure finish` after all batches, attaching a child identity only when singular; relay compact paths/checks and repair/route cross-boundary needs unless `NEEDS_AUTHORITY`.
3. **Sweep.** Start `measure start --label "Sweep"`; run `Skill(spectre-sweep)` with `--orchestrated`, unchanged set, and both results. It alone integrates stale/uncovered checks, repairs attributable failures, and commits; invoke `measure finish` for the Sweep snapshot.
4. **Rebase.** Start `measure start --label "Rebase"`; run `Skill(spectre-rebase)` with target, `--orchestrated --verification-owner parent`; retain backup summary. No checks; invoke `measure finish` for the Rebase snapshot.
5. **Observe one full suite after rebase.** At `FULL_SUITE_SHA`, derive and freeze candidate `{repository, base, head, diff}` as `EXPECTED_BASE_SHA`/`EXPECTED_HEAD_SHA`/`EXPECTED_DIFF_SHA256`. Before the first PR side effect, select against that frozen tuple with `knowledge-cli.mjs work membership --branch <exact-branch> --candidate <tuple-json>`; freeze its `selected` work-ID set and report `excluded`/`ambiguous` without substituting recency. Still before Create PR, invoke `Skill(spectre-work-record)` per selected record: finalize a complete one with `execution.state` `finalized` and `remainingWork` exactly `None.`; refresh a blocked/incomplete one truthfully and never finalize it. No PR, CI, review, or readiness value enters `remainingWork`. Then invoke `measure start --label "Full suite"` and `measure start --label "Create PR"`. In parallel run the full-suite lane and `Skill(spectre-create_pr)` pending with target, `--orchestrated --pr-phase pending`, the frozen set, and the tuple; it returns a draft with local verification `RUNNING`. At each end invoke `measure finish` with child identity when available. No duplicate suites or raw child output.
   - Attribute failures `branch-caused|unrelated|indeterminate`, preferring target-SHA CI and otherwise reproducing only the failing check at target.
   - Repair branch-caused families; rerun only failing/affected checks, never the full suite. Route unrelated/indeterminate findings; record repaired HEAD and `CI: pending`.
   - Verification is evidence, never a stop condition.
6. **Create PR and measure.** After suite call `Skill(spectre-create_pr)` with target, `--orchestrated --pr-phase final-update`, URL/body, the same frozen set, refreshed tuple, and `FINAL_VERIFICATION_SUMMARY`; change Testing only. Refresh claims after repairs; on `PR_CANDIDATE_STALE`, refresh and retry. Once PR identity exists, re-run `work membership` against the final tuple after any repair; a record it no longer proves is reported, not associated. Annotate the still-selected set through one `work associate --work-id <id> … --pull-request-id <id> --candidate <final-json> --pull-request <json>`, replaying `retry.expectedRevisions` via `--expected-revisions` until `associated`/`noop` and reporting `partial` `remaining`. Association annotates only: it never confers finality, PR state is `draft-open`, never merged, and a later Execute run on this branch keeps its own record and joins this same PR only when the updated candidate proves membership. Ambiguity or capture failure returns recovery input but does not block PR. Run `measure summary --rows … --outer-snapshot … --persist --project-dir … --feature-root "$FEATURE_ROOT" --base-sha "$EXPECTED_BASE_SHA" --head-sha "$EXPECTED_HEAD_SHA" --diff-sha256 "$EXPECTED_DIFF_SHA256"`; relay table, persistence status, and history path. Persistence degradation never blocks PR completion; never inspect transcripts, track clocks, or calculate. Unattributed Prune/Test and Full suite/Create PR use one exact parallel-group total; unavailable measurement never blocks Ship.

Never use `--no-verify`, force-push over unrelated remote history, suppress failures, or publish evidence containing secrets/PII.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return PR URL + `PR_OPENED`/verification; review PR, CI owns merge-gating full-suite. Terminal: no handoff.

## Escalate-If

- Cleanup/rebase/create-PR reports `NEEDS_AUTHORITY`: no safe path exists without new user authority.
- Ambiguous branch/target, unexpected remote divergence, or secrets/PII.
- Never escalate solely for test/lint/type/build failures, full-suite status, repair count, diff growth, or candidate drift that can be refreshed.
