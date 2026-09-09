---
name: "spectre-execute"
description: "Execute tasks/plans with checks/reviews/proof. Use after planning/resume. Not for planning, unplanned fixes, or pruning."
user-invocable: true
---

# execute

Preserve dependency-safe parallelism, authority, gates, repairs, finalization.

## Inputs

- `$ARGUMENTS`: path; `--origin plan|fix|delegate`; `--preflight-plan <xs|light|standard|comprehensive>`; wave hints; `--orchestrated`; orchestrated-only `--finalization-owner parent`. Default owner: `self`.
- `--review-profile final-only`, valid only with `--orchestrated --finalization-owner parent`; defers intermediate review and requires the orchestrating caller to invoke `Skill(spectre-code_review)` exactly once on the final candidate; caller owns sequencing, never semantic review.
- `structured`: execute index + resolvable `tasks.json`; malformed structured input escalates, never becomes a plan.
- `fix-source`: bug-report path/root or identifying content—not `--origin`—selects `fix`; load `references/fix-source.md`, not Plan preparation.
- `plan-direct`: any explicit readable plan, including paths, Plan handoff markers, legacy `Execution Mode: direct` headers. The explicit supplied plan wins over ambient task artifacts and enters this preparation contract.
- No path: use existing same-run source evidence first, then a plan at the confirmed root, then structured-only fallback. No-path selected plans receive this preparation before dispatch. Never infer from branch/recency.
- `--preflight-plan <depth>` remains a preparation-depth hint, not authorization, classification, or a task-graph switch; a depth hint must not create authority pause. `Execution Mode: direct` is a legacy coordination hint. No selected readable plan needs a completeness/header ceremony.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Keep the invocation checkout.
- Structured detail precedence: declared `Tasks JSON` → adjacent `tasks.json` → sibling `.tasks.json`; else escalate. Read index whole and task detail by targeted slices.
- Structured/plan-direct read `references/telemetry.md`, start/resume one local event run with origin, and follow its primary/worker authority contract. The local workflow store is the sole lifecycle/progress authority; source plans/tasks stay immutable. Summaries retain origin, shape, category, elapsed time, aggregate token measurements only. Plan-direct emits workstream events. Telemetry failure degrades observation, never delivery authority.
- `SCOPE_DOCS`: manifest paths or scope/UX/research cited by the plan.
- On first selected readable-plan use/resume, read `references/plan-direct.md` for preparation state. On the first verification failure, review finding, E2E gap, or proof failure, read `references/repair-policy.md`.
- Maintain compact verification ledger by HEAD, check id, changed/dependency surface, result, attribution, disposition; controls final reruns. Never persist raw output or per-wave evidence/checkpoint/report files.

## Outputs + DONE

- Commit implementation batches and canonical artifacts only. Task/plan definitions stay immutable; Execute evidence, markers, checkpoints, run state, plan-direct execution state stay local and uncommitted.
- `self`: one final comprehensive review, then proof artifacts ending in aggregate `PASS`.
- `parent`: `IMPLEMENTATION_READY` + `ACCEPTANCE_PENDING` manifest; no final review, proof, test guide, or acceptance claim. With `--review-profile final-only`, every phase records `final-only` and the parent receives `FINAL_REVIEW_PENDING`.
- DONE: selected work/adaptations `done|skipped`; current affected verification; each completed phase routed `final-only` or reviewed once for recorded compounding risk under the selected profile; every finding dispositioned; no safe authorized work or stale/uncovered final surface; self-owned final review + end-only proof when applicable; no primary-authored planned work; and structured telemetry complete or honestly `degraded`.

## Method / guardrails

1. **Plan preparation.** For any selected readable plan (explicit or no-path-resolved), resolve root, selected plan, Scope, depth hint, and local state before run creation. Reuse applicable `task_context.md` assessment by selected-plan raw-byte/authority hashes; after scope-safe byte-only review edits, mechanically rebind hashes when topology/uncertainty is unchanged; reroute only if absent or material observations invalidate it. Missing assessment dispatches `Skill(spectre-plan-route)` to a fresh child agent for one classification; child classifies only. Every selected readable plan, including XS/ATOMIC, needs a closed correctness+simplification review chain before first dispatch unless a valid closed chain is reused; partial correctness follows existing hash rules, otherwise dispatch `Skill(spectre-plan_review) --auto-apply scope-safe --orchestrated` once for the selected path to a fresh child agent. Mechanical repairs stay local; semantic corrections use the child. Scope/explicit-design changes remain withheld; scope-safe result proceeds without a second user gate. ATOMIC/DIRECT use the bounded local workstream/Active Wave pattern. For STRUCTURED, pass finalized plan path/hash, closed review evidence, and assessment depth; STRUCTURED invokes existing `Skill(spectre-create_tasks) --orchestrated` by fresh child-agent dispatch (L → standard, XL → comprehensive). No automatic task review. Select only validated pair bound to finalized plan and closed review chain. For all preparation children, consume child DONE inside the same Execute run before proceeding; child outputs never replace or terminalize Execute.
2. **Resolve and resume.** Persistent execution authority: on initial entry and every continuation/resume, including after compaction, reload this contract with original source arguments and continue same durable run; never implement from memory or substitute another workflow. Rebuild the frontier from the store, never from the source: `run start` with the original `--source` returns the same `runId`, then `run status --run-id <id> --json` reports it. Compare selected source/preparation hashes before trusting affected mappings; `references/plan-direct.md` owns hash-bound pair reuse and source-mode continuity. Fresh structured selection persists its resolved JSON event source so resubmitting the plan resumes the same run. Trust only `completed` and `skipped`; every other value is redo-or-verify. An `INVALID_TASK_TRANSITION` rejection means the log is ahead of your read—re-read, never force the event. Preserve source order absent dependency evidence; detail only the ready frontier.
3. **Batch and dispatch.** Dispatch when dependencies are accepted; waves are hints, phases review boundaries, and only unaccepted dependencies block. Batch at most three sequential parents or bounded plan-direct workstreams. Every source-owned workstream, including single/sequential work, goes to `@spectre_dev`. The primary only orchestrates, verifies, accepts, and records state; it never implements planned work. For `risk`, request Claude `claude-opus-5` or Codex `gpt-5.6-sol`; otherwise use defaults. Give exact assignment/scope/prior context, never whole tasks/unrelated ids; include the named threatened invariant and shared contract slice. Structured dispatch includes exact `<workflow_telemetry>`. Require `Skill(spectre-tdd)`, focused checks, commits, compressed insights, E2E `Complete|Gap|Adaptation`.
4. **Gate accepted batches.** Before any reviewer, the primary independently runs affected lint/typecheck/build and native focused non-harness tests selected from the returned diff and demonstrated dependency/consumer boundaries; gate completed batches while other assignments remain in flight, and let early parents ride the next covering gate. Never run a repository baseline/root suite, full app harness, benchmark, or broad qualification here. Record stable check ids/result against current HEAD without raw output or new evidence files. Attribute failures and follow `references/repair-policy.md`; implementation reports are leads only.
5. **Capture accepted batches.** Workers return compact findings/evidence; after each accepted batch the primary invokes `Skill(spectre-capture)` only for qualifying knowledge, otherwise continues. At completion it writes the seven-section work record: self records reached execution/verification/PR states; parent remains `IMPLEMENTATION_READY`/`ACCEPTANCE_PENDING`; failed/incomplete work is not completed. Capture reports saves without changing verification, review, proof, or lifecycle authority.
6. **Record and adapt.** Record accepted child/parent completion only in local workflow state, then emit primary-owned completion against the passing gate; worker submission is never acceptance. Never mutate source task/plan artifacts for lifecycle state. Add/split/skip/reorder only source-required derivative work; amend the canonical graph only when its definition was wrong. New derivative tasks join the same run when assigned.
7. **Route intermediate review by compounding risk or final-only profile.** With `--review-profile final-only`, record each verified completed phase as `final-only` without loading review routing or dispatching a reviewer. Otherwise a phase may be reviewed only after all source-owned tasks/workstreams and adaptations are `done|skipped` under current affected verification; completion alone is not a trigger. On first phase completion, read `references/review-routing.md`.
   - Inputs: triggered phase diff/commits/files, risk, scope, and verbatim requirement/AC slices—no dev rationale, pending phases, or unrelated files.
   - Check the named risk, Defined → Connected → Reachable, E2E completeness, security/correctness, dead/orphaned outputs, duplicate sources, and old active paths.
   - Return `CLEAN` or evidence-backed CRITICAL/HIGH with `file:line`, invariant, observable scenario, evidence chain, and smallest fix in-thread. Persist only the local route/dispositions, never an intermediate review report. Follow the repair policy: one consolidated pass, affected verification, and no repair re-review.
8. **Repeat** until the selected completion projection is satisfied.

## Finalization

Compute coverage from the local ledger. Run only stale or uncovered checks; never blanket-rerun cumulative verification or a root suite. Expensive harness/performance/full qualification runs only for the final relevant candidate, unless a source task explicitly produces a prerequisite or product-consumed qualification artifact that blocks downstream work. Cache it by `candidate definition hash = relevant inputs + scenario/config + command`; permit one run per hash, and rerun only after those inputs change or a diagnosed infrastructure failure invalidates the run.

- `parent`: require wave gates/review dispositions. Return diff/base, commits/files, test roots, coverage, review route, repair ledger, requirement slices, findings, and `ACCEPTANCE_PENDING`; add `FINAL_REVIEW_PENDING` for final-only, requiring one opposite-runtime-first `Skill(spectre-code_review)` before proof.
- `self`: invoke `Skill(spectre-code_review)` exactly once, high effort, over cumulative diff + requirements/scope without implementer rationale. Structured mode passes completed requirement/AC slices; plan-direct passes `PLAN_SOURCE` plus relevant `EXECUTION_STATE` evidence as routing only. It owns delivery/reachability, scope-creep, dead-computation, old-path, and single-source audits; never also invoke `spectre-validate`. Record its result as a review gate. Give attributable CRITICAL/HIGH one consolidated repair pass, affected verification, and honest dispositions—never a validation reviewer.
- After review dispositions are recorded, invoke `Skill(spectre-prove)` once over final requirements, passing fresh inspected primary evidence bound to the candidate hash so it runs only uncovered journeys, and record its result as a proof gate. Non-PASS follows the repair policy; do not terminalize until aggregate `PASS` or every remainder is `NEEDS_AUTHORITY`. Proof is always the last acceptance gate. Formatting, lint, artifact, rebase, or commit-only changes do not trigger reproof. Finish structured runs with the truthful terminal event.
- After that authoritative terminal status, follow the telemetry reference to emit one non-authoritative `plan.execution_outcome`; Plan/Execute artifact joins use SHA-256 hashes of raw artifact file bytes, and join failure only degrades telemetry.

## Handoff

Parent: machine `IMPLEMENTATION_READY`/`ACCEPTANCE_PENDING` (+ `FINAL_REVIEW_PENDING`), no table. Self terminal: returns counts/coverage/review/dispositions/owner/proof/findings/`RUN_ID`/telemetry. Companion opens same resolved local file beside conversation; outside same clickable link/no failure; Never publish/share proof.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Complete/recovery. |
| 📦 **What was just done** | Delivery/impact. |
| ▶️ **Proposed next step** | Render resolved action. |
| 🔎 **Review proof** | Render Markdown [Review proof](/absolute/resolved-feature-root/proof/proof.html); substitute absolute FEATURE_ROOT. |

`What was just done` contains delivered capability + user impact only; must not include test/review/proof verdicts. Put counts/coverage/review/dispositions/owner/RUN_ID/telemetry outside the table.

High → Fix; coverage → Test; else `spectre-ship`; blocked/failed → same table/exact resolved recovery action.

## Escalate-If

- Structured index/task detail is missing or malformed → `spectre-create_tasks`; unreadable source or genuine authority/safety impasse → `NEEDS_AUTHORITY` against that source.
- A supplied source is unreadable; Scope changes; a correctness Blocker/High remains unresolved; an explicit-design contradiction or unavailable authority appears; or the generated pair does not validate → `NEEDS_AUTHORITY` before task generation or delivery as applicable.
- Invalid parent ownership; `--review-profile final-only` without an orchestrated caller that explicitly owns the one final `Skill(spectre-code_review)` invocation; unsafe/unrelated prompt slice; conflicting acceptance; unavailable authority/capability; required scope change; or unauthorized destructive action.
- Never escalate solely for check failure, unavailable/red baseline, review/proof finding, diff growth, or related-file changes; continue independent work and terminalize only when every remaining non-PASS row is `NEEDS_AUTHORITY`.
