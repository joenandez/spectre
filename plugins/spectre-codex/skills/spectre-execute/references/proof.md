
# prove

Prove the completed experience against its approved contract. Reports, tests, assertions, and developer claims are leads; observable behavior and reviewed evidence decide.

## Inputs

- `$ARGUMENTS` - optional explicit feature name/root or descendant artifact, explicitly passed source-plan path, scope/UX/prototype paths, journey hints, fresh inspected evidence to reuse, an authorized scope hash, and `--orchestrated` when a parent owns the next action.
- Optional `--profile focused`, valid only with `--orchestrated`: use existing proof tools/scenarios only, run no tooling research or dependency-selection gate, and record unavailable proof capability as `PARTIAL` with limitation `PROOF_TOOLING_UNAVAILABLE`.
- Resolve an explicit feature/root, descendant, or unambiguous thread artifact; otherwise derive a concise kebab name and proceed without a naming gate.
- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Resolve acceptance truth in this order: current explicit user instruction; an explicitly passed source plan or fix/bug report; approved scope and UX/prototype; task acceptance criteria. Derivative execution evidence such as `execution_state.md` may focus proof but is not acceptance truth. Surface contradictions before proving against an invented interpretation.

This skill must work in a fresh session. Read canonical artifacts and live repository state instead of relying on prior conversation.

Each invocation is exactly one proof pass. Derive a candidate key from relevant product inputs, scope hash, and scenario/config definitions; record observed start/finish state excluding generated proof. If product state changes, mark affected rows `PARTIAL` with `PROOF_STATE_CHANGED`; never bind proof to a future candidate.

## Proof Surface

- Inventory existing tools, scripts, runnable interfaces, and scenarios; prefer the established proof stack.
- Match the mechanism to the actual surface: visible app, browser, desktop/mobile runtime, CLI/TUI, API/service, library, or background workflow. Exercise the same public controls and interfaces a user would use.
- When no adequate proof tool exists: focused profile records affected rows `PARTIAL` with `PROOF_TOOLING_UNAVAILABLE` and continues without research or a user gate. Otherwise read `${PLUGIN_ROOT}/skills/spectre-execute/references/proof/proof-tools.md`, use `@spectre_web_research` when available to verify current options against primary sources, then offer the user 2-4 suitable choices with a recommendation, trade-offs, installation impact, and evidence capabilities; hold for selection before adding a dependency or committing to a materially weaker proof method.
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

For visual work (including TUI), load `${PLUGIN_ROOT}/skills/spectre-execute/references/proof/proof-html.md`: capture, inspect, and embed in `proof.html` actual screenshots and video of each realistic end-to-end journey; paths, links, hashes, manifests, and prose are provenance only. Pixels overrule assertions.

For non-visual work, use the public interface and preserve observable output, persistence, and relevant logs. Do not manufacture visuals. Internal tests/state/logs may support but never replace the promised outcome.

## Proof Pass

Before selecting or observing journeys, invoke `Skill(spectre-validate)` with `--orchestrated`, the same authoritative source path, the resolved `FEATURE_ROOT`, and the complete current `BASE_SHA`, `HEAD_SHA`, and `DIFF_SHA256` tuple. Plans, structured task slices, scope, and fix/bug reports are valid sources. Require a completed report bound to that exact tuple; missing authority, an unusable report, or a stale-candidate result is incomplete. Validation cannot be skipped for atomic work. Require at least one independent analyst and one to eight real requirement areas without fabricating or padding areas. Persist the report path, `Complete` status, and exact tuple in `proof.json` and display them in a Validation section in `proof.html`. Any `Partial`, `Dead Code`, or `Missing` requirement blocks aggregate `PASS`; route attributable gaps through Execute's repair policy and rerun Validate against the repaired candidate. Report genuine authority blocks truthfully. Static definition/connection/reachability evidence remains separate from observed public-interface journeys and their primary evidence.

1. Reuse fresh inspected primary evidence only when its candidate key and matrix rows match exactly. Run the smallest set of uncovered journeys that completes the matrix. Expensive harness/performance/full qualification allows at most one run per candidate key; rerun only after relevant inputs change or a diagnosed infrastructure failure invalidates it.
2. Inspect primary evidence before reading diagnostic summaries. Then review logs/errors and durable state for silent failures.
3. Classify each finding as product behavior, UX/cosmetic, proof infrastructure, specification ambiguity, or environment/authority constraint. Record the failed claim, expected/observed result, reproduction, evidence paths, fingerprint, and limitation.
4. Repair the proof path, never the verdict: fix harness/tooling defects and rerun affected journeys until each row reflects observed product behavior. A harness defect is never terminal and never the sole basis for `PARTIAL`. Never modify product code to influence an outcome, dispatch an implementer, or invoke TDD. Then write the artifacts and return.

## Outputs + DONE

Write:

- `{FEATURE_ROOT}/proof/proof.json` - compact current-candidate snapshot with `feature`, `feature_root`, acceptance sources, scope hash, candidate key, `candidate: {base_sha, head_sha, diff_sha256}`, `validation: {report, status, tuple: {base_sha, head_sha, diff_sha256}}`, observed start/finish state, scenarios, matrix, evidence references/hashes, findings, harness changes, limitations, and aggregate status. A `PASS` requires validation status `Complete` and an exact tuple match to `candidate`. Replace prior snapshots; git history preserves them. Never embed raw harness output or accumulating run history.
- `{FEATURE_ROOT}/proof/proof.html` - **required**, self-contained review artifact beginning with `Feature: <feature-name>` and `Feature Root: {FEATURE_ROOT}`, then the Validation section (report, status, tuple), matrix, findings, required displayed media, redacted diagnostics, current relevant repair dispositions, harness changes, limitations, and final status. Replace the prior current-candidate report; do not publish or share unless asked.

Exclude secrets, credentials, private customer data, and unnecessary local paths. Raw evidence stays tool-owned; proof embeds review renditions and cites original URI/path plus hash.

**DONE when:** both artifacts self-locate; every in-scope row has inspected primary evidence and truthful status; aggregate `PASS` means every row passes and validation status is `Complete` for the exact candidate tuple; the authorized scope hash matches; observed states and unresolved findings are recorded; every harness change made during the pass is disclosed in both artifacts; and HTML satisfies the proof-HTML contract and presents all limitations. DONE means the pass completed, regardless of status.

## Handoff

Return `PROOF_RESULT`: profile/status/candidate/rows/fingerprints/evidence/limits/authority/journeys/artifacts; `--orchestrated`: parent.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Orchestrated: return proof result to Execute. Standalone non-PASS → Fix/Plan/UX/prerequisite. `NEEDS_AUTHORITY` pause → Handoff rows/evidence/resume.

## Escalate-If

- Acceptance sources conflict or omit the observable outcome.
- Outside focused profile, adequate tooling requires a new dependency and the user has not selected an option.
- `--profile focused` is supplied without `--orchestrated`.
- Proof depends on unavailable credentials, external services, OS permissions, hardware, or subjective product judgment.
- Resolving a finding would change approved requirements or needs new authority.
