---
name: "spectre-prove"
description: "Run one acceptance-proof pass over completed work and publish reviewed user-facing evidence. Use from spectre-execute or standalone for acceptance evidence, screenshots/video/logs, or an HTML proof artifact. Do NOT use for implementation checks, repairs, unit tests, planning, or code review."
user-invocable: true
---

# prove

Prove the completed experience against its approved contract. Reports, tests, assertions, and developer claims are leads; observable behavior and reviewed evidence decide.

## Inputs

- `$ARGUMENTS` - optional explicit feature name/root or descendant artifact, explicitly passed source-plan path, scope/UX/prototype/test-guide paths, journey hints, fresh inspected evidence to reuse, an authorized scope hash, and `--orchestrated` when a parent owns the next action.
- Optional `--profile focused`, valid only with `--orchestrated`: use existing proof tools/scenarios only, run no tooling research or dependency-selection gate, and record unavailable proof capability as `PARTIAL` with limitation `PROOF_TOOLING_UNAVAILABLE`.
- Resolve an explicit feature/root, descendant, or unambiguous thread artifact; otherwise derive a concise kebab name and proceed without a naming gate.
- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Resolve acceptance truth in this order: current explicit user instruction; an explicitly passed source plan as an acceptance source; approved scope and UX/prototype; task acceptance criteria; test guide. Derivative execution evidence such as `execution_state.md` may focus proof but is not acceptance truth. Surface contradictions before proving against an invented interpretation.

This skill must work in a fresh session. Read canonical artifacts and live repository state instead of relying on prior conversation.

Each invocation is exactly one proof pass. Derive a candidate key from relevant product inputs, scope hash, and scenario/config definitions; record observed start/finish state excluding generated proof. If product state changes, mark affected rows `PARTIAL` with `PROOF_STATE_CHANGED`; never bind proof to a future candidate.

## Proof Surface

- Inventory existing tools, scripts, runnable interfaces, and scenarios; prefer the established proof stack.
- Match the mechanism to the actual surface: visible app, browser, desktop/mobile runtime, CLI/TUI, API/service, library, or background workflow. Exercise the same public controls and interfaces a user would use.
- When no adequate proof tool exists: focused profile records affected rows `PARTIAL` with `PROOF_TOOLING_UNAVAILABLE` and continues without research or a user gate. Otherwise read `references/proof-tools.md`, use `@spectre:web-research` when available to verify current options against primary sources, then offer the user 2-4 suitable choices with a recommendation, trade-offs, installation impact, and evidence capabilities; hold for selection before adding a dependency or committing to a materially weaker proof method.
- Own the proof path: fix broken or misconfigured proof tooling (helpers, drivers, fixtures, seeds, runner config) in place and rerun; completing established-stack setup is pre-authorized. Record every harness change as a proof-infrastructure finding. Only genuinely absent capability follows the selection gate above.

## Proof Contract

Build a proof matrix first. Each row contains:

- requirement and source;
- realistic start state, user action, and observable result;
- surface (`visual|non-visual`; TUI is visual), mechanism, and evidence ids;
- supporting diagnostics;
- status and limitations.

Use `PASS`, `PARTIAL`, `DIAGNOSTIC_ONLY`, or `FAIL` per row:

- `PASS` - evidence matched the end-to-end contract, including fail-closed outcomes.
- `PARTIAL` - some journey was skipped, fixture-backed, programmatic, or otherwise not proven as the user experiences it.
- `DIAGNOSTIC_ONLY` - code paths, state, logs, or tests were proven without proving the public workflow.
- `FAIL` - observed behavior, pixels, output, persistence, or errors contradict the contract.

For visual work (including TUI), load `references/proof-html.md`: capture, inspect, and embed in `proof.html` actual screenshots and video of each realistic end-to-end journey; paths, links, hashes, manifests, and prose are provenance only. Pixels overrule assertions.

For non-visual work, use the public interface and preserve observable output, persistence, and relevant logs. Do not manufacture visuals. Internal tests/state/logs may support but never replace the promised outcome.

## Proof Pass

1. Reuse fresh inspected primary evidence only when its candidate key and matrix rows match exactly. Run the smallest set of uncovered journeys that completes the matrix. Expensive harness/performance/full qualification allows at most one run per candidate key; rerun only after relevant inputs change or a diagnosed infrastructure failure invalidates it.
2. Inspect primary evidence before reading diagnostic summaries. Then review logs/errors and durable state for silent failures.
3. Classify each finding as product behavior, UX/cosmetic, proof infrastructure, specification ambiguity, or environment/authority constraint. Record the failed claim, expected/observed result, reproduction, evidence paths, fingerprint, and limitation.
4. Repair the proof path, never the verdict: fix harness/tooling defects and rerun affected journeys until each row reflects observed product behavior. A harness defect is never terminal and never the sole basis for `PARTIAL`. Never modify product code to influence an outcome, dispatch an implementer, or invoke TDD. Then write the artifacts and return.

## Outputs + DONE

Write:

- `{FEATURE_ROOT}/proof/proof.json` - compact current-candidate snapshot with `feature`, `feature_root`, acceptance sources, scope hash, candidate key, observed start/finish state, scenarios, matrix, evidence references/hashes, findings, harness changes, limitations, and aggregate status. Replace prior snapshots; git history preserves them. Never embed raw harness output or accumulating run history.
- `{FEATURE_ROOT}/proof/proof.html` - **required**, self-contained review artifact beginning with `Feature: <feature-name>` and `Feature Root: {FEATURE_ROOT}`, then the matrix, findings, required displayed media, redacted diagnostics, current relevant repair dispositions, harness changes, limitations, and final status. Replace the prior current-candidate report; do not publish or share unless asked.

Exclude secrets, credentials, private customer data, and unnecessary local paths. Raw evidence stays tool-owned; proof embeds review renditions and cites original URI/path plus hash.

**DONE when:** both artifacts self-locate; every in-scope row has inspected primary evidence and truthful status; aggregate `PASS` means every row passes; the authorized scope hash matches; observed states and unresolved findings are recorded; every harness change made during the pass is disclosed in both artifacts; and HTML satisfies the proof-HTML contract and presents all limitations. DONE means the pass completed, regardless of status.

## Handoff

Return `PROOF_RESULT`: profile/status/candidate/rows/fingerprints/evidence/limits/authority/journeys/artifacts; `--orchestrated`: parent.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone `PASS` → `/spectre:spectre-ship`; non-PASS → Fix/Scope/UX/prerequisite; proof status alone never gates `/spectre:spectre-ship`. `NEEDS_AUTHORITY` pause → Handoff rows/evidence/resume.

## Escalate-If

- Acceptance sources conflict or omit the observable outcome.
- Outside focused profile, adequate tooling requires a new dependency and the user has not selected an option.
- `--profile focused` is supplied without `--orchestrated`.
- Proof depends on unavailable credentials, external services, OS permissions, hardware, or subjective product judgment.
- Resolving a finding would change approved requirements or needs new authority.
