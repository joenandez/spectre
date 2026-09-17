# Selected-plan state

Use for selected-plan preparation/resume/reconciliation.

## Paths and authority

- `PLAN_SOURCE` is the sole requirements authority. Never rewrite it or durably copy its prose for progress.
- `EXECUTION_STATE = {FEATURE_ROOT}/execution_state.md`. It is compact local/gitignored resume state. If another plan is recorded, use `{plan-stem}-{short-sha256-of-plan-path}.execution_state.md`.
- Record repo-relative path. Derivative state is not acceptance authority. Pointers: selected/final plan+authority hashes, assessment, review paths/hashes or `not-required:<XS|S>`, derived pair paths/hashes, resolved event source/run identity; refresh applicable byte-only bindings before run creation/dispatch.

## Required document

Place `Feature: <feature-name>` and `Feature Root: .spectre/features/<feature-name>` below title, then:

1. **Source Plan** — canonical path; full-byte SHA-256; byte length; HEAD; mode; baseline SHA; scope docs; selected plan/authority hashes; objective, boundary, workstream, verification anchors; plus `The source plan is the sole requirements authority.`
2. **Runtime Status** — `pending|running|repairing|needs-authority|done`; current/last wave; timestamps; HEAD; finalization owner; source coverage. Cumulative diff is only `baseline..HEAD`.
3. **Workstream Map** — one coarse row per plan-native phase/workstream/item: stable id, source anchor, local status, dependencies/shared contracts/change surfaces, readiness reason.
4. **Active Wave** — only currently dispatchable bounded assignments, owners, source anchors, outputs/consumers/replacements, verification signals.
5. **Verification Ledger** — completions/checks; assessment; Plan Review state (`not-required:<XS|S>|closed`) report paths/hashes; `closed`: external-attempt/recorded-failure+fallback provenance, completed routes, finalized plan hash/disposition, protected files unchanged; finalized pair hashes; repairs/failures/E2E. No raw output or report prose.
6. **Plan-Backed Adaptations** — discovered gap, source-plan relationship, disposition, affected workstream.
7. **Final Quality State** — intermediate/final review reports and verdicts, final verification/requirement-delivery coverage, proof runs/result, unresolved findings.

No parallel JSON graph, future-subtask enumeration, manufactured acceptance criteria, or persisted Active Wave plan excerpts. Stop when next safe wave is dispatchable.

## Lifecycle

- Before task generation or implementation dispatch, persist finalized assessment/review bindings and coarse map; includes plan-origin STRUCTURED. Before implementation dispatch, add resulting pair bindings, resolved event source/run identity and bounded Active Wave.
- Reread state before every wave; update after dispatch, gate, review-routing, review, or adaptation.
- Dev assignments contain transient verbatim plan text only for active workstreams plus exact Active Wave slice. Never persist it.
- On resume, recompute plan SHA-256/length. Unchanged: continue. Changed: current plan is authoritative; refresh affected derivatives, preserve Wave History, record reconciliation.
- A generated pair is reusable only when both artifact hashes bind to the finalized plan and closed review chain. Filename, feature-root coincidence, and `generated_at` alone are insufficient. If binding is absent and cannot be established, preserve the pair and regenerate only necessary preparation with the child's collision convention.
- For an existing direct run, preserve its Markdown event source and stable workstream IDs. Existing JSON runs retain their source and accepted IDs; JSON runs add derivative work only through source-required definition repair under the existing adaptation contract, with no lifecycle writes.
- Do not mutate historical completion events or clear accepted state.
- After a wave, replace Active Wave detail with ledger entries, clear it, and derive only the next safe assignments.
- DONE requires every mapped workstream and adaptation `done|skipped`, with Runtime Status reporting complete source-plan coverage.
- STRUCTURED outcomes use only source/preparation bindings; JSON task events remain governed by structured telemetry.

## Authority handling

Use risk-responsive investigation, ordering, verification, task detail. Escalate only when concrete action needs missing authority or a cross-workstream contract the selected plan lacks; name why safe investigation or alternatives cannot resolve it and continue independent authorized work.

## Telemetry

For Markdown event sources, follow `references/telemetry.md` with `--source "$PLAN_SOURCE"`. Assign each coarse-map row stable `ws-<n>` id and use it as the task id for dispatches, `task start`/`submit`/`complete`, and gates. Workstream granularity only — never synthetic subtask events. Record `RUN_ID` in Runtime Status.
