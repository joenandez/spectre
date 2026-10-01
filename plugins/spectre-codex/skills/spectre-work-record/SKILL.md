---
name: "spectre-work-record"
description: "Record bounded history at owned Execute, Ship, standalone Create PR, blocked-handoff, snapshot or correction boundaries. Requires exact ownership. Not for reusable guidance, routine progress, batches or orchestrated Create PR."
user-invocable: false
---

# work-record

## Purpose

Truthful work history; workflow state/telemetry own live progress. Capture never changes delivery, verification or acceptance authority.

## Inputs

- Exact run/work identity and applicable branch, PR or repository/base/head/diff association; observed lifecycle, account, entry points, tag intent and prior revision.
- Owned boundary: one Execute start/completion; meaningful blocked handoff/resolution when authority, control or context prevents safe continuation/resumption; Ship after PR creation; standalone Create PR terminal write only without an Execute/Ship owner; explicit snapshot/correction, including outside workflows.

## Working Set

- Reuse applicable discoveries/loads; refine only unresolved questions. Read `references/work-capture-input.json` and `${PLUGIN_ROOT}/skills/spectre-capture/references/tagging-policy.md`.
- Use acquired entry points; focus-read as needed: path, symbol/document section, observed positive line, role. Explain unavailable/non-code portions, including uncreated start locations; never invent locations or dump files.

## Outputs + DONE

Short title/routing summary and required identity/provenance/status metadata, derived reliably. Complementary fields:

- `requestedOutcome`: request; `scope`: boundaries.
- `actualChanges`: delivered behavior/artifacts; `reasons`: non-obvious rationale/trade-offs. Start/blocked accounts distinguish delivered from undelivered.
- `discoveries`: findings and maintained-authority links; `relatedContext`: typed entry points and bounded references.
- `verification`: observed checks; `remainingWork`: residual implementation. Structured verification and PR lifecycle remain authoritative.

State absence truthfully; omit filler, duplicated narrative/state. New/revised accounts stay under 2,000 estimated rendered tokens; reference evidence, not logs.

**DONE:** permitted boundary has a truthful account or surfaced skip/no-op/conflict/failure, with exact work ID, revision and canonical `recordPath` when applicable.

## Method / guardrails

1. One record per exact Execute run: resume revises it; distinct runs never fold regardless of branch/feature/candidate. Branches/PRs may reference multiple records. Execute-owned writes include `--source-run-id <exact-run>` alongside other identity flags for receipt derivation.
2. Execute start requires exact identity/branch; every not-yet-true section says `None yet.`, not placeholders (`TODO`, `REPLACE_ME`, angle brackets). Capture only the Inputs boundaries, never tasks, batches, checks, reviews, commits, ordinary decisions, routine progress, transient remediation or context refreshes.
3. New/current-run writes read `git rev-parse --abbrev-ref HEAD`, require explicit exact branch evidence, compare independent run-start evidence when available and preserve known same-run branch. Return recovery/skip if unavailable. Exact historical corrections may preserve unknown original branch by omitting `--branch`; never backfill from today's checkout. New historical snapshots require verified original branch.
4. Existing PR identity/URL requires `gh pr view <identity-or-url> --json state` outside store locks. Pass observed `pullRequest`; unavailable/unknown state, terminal-history contradiction or unqueryable draft without identity returns recovery/skip. Execution, verification and PR states stay separate:
   - `execution`: `unknown|in-progress|implementation-ready|acceptance-pending|blocked|finalized`.
   - `verificationState`: `unknown|not-run|checked|passed|failed`.
   - `pullRequest`: `unknown|none|draft-open|closed|merged`; bare `open` is invalid.
5. Authorized terminal Execute uses `execution.state: finalized`, `remainingWork: "None."` exactly (otherwise `CAPTURE_INPUT_INVALID`). Blocked/failed/interrupted accounts stay non-final with scoped residual work; review, CI, PR readiness, merge and closure are not implementation work.
6. Fill semantic JSON outside the store; submit on stdin:
   `knowledge-cli.mjs capture --kind work --input - --project-dir <project-dir> --json`.
   New/current-run writes add `--branch <exact-branch>` and exact identity via `--work-id <id>`, `--source-run-id <run>`, `--pull-request-id <pr>` or `--candidate <exact-json>`. Historical corrections require `--work-id <id> --expected-revision <revision>`. Changed records require loaded `revisionToken` as `--expected-revision` and preserve omitted tags; unchanged retries are no-ops. `--input <path>` is only for explicit manual/advanced capture or returned `recoveryInput`.
7. At owned terminal boundaries, promote only qualified reusable discoveries absent from maintained guidance via `$spectre:spectre-capture`, or link existing authority. No mandatory knowledge record per completion or added scan/write boundary. Capture failure/conflict returns recovery input without blocking delivery.

## Handoff

Boundary, exact work ID, revision/conflict, canonical `recordPath`, associations, lifecycle facts and applicable recovery input.

## Escalate-If

Unclear ownership/boundary, conflicting historical authority or unrecoverable write: surface recovery/skip without guessing or blocking delivery.
