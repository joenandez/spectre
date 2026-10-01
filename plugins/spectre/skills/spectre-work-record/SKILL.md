---
name: "spectre-work-record"
description: "Record one bounded historical account at an owned Execute, Ship, standalone Create PR, blocked-handoff, snapshot, or correction boundary. Use only when exact work ownership is known. Do not use for reusable guidance, task/check batches, routine progress, or orchestrated Create PR."
user-invocable: false
---

# work-record

## Purpose

Preserve concise, truthful work history at existing ownership boundaries. Execution state and telemetry remain authoritative for live progress.

## Inputs

- One permitted boundary and exact run/work identity, plus exact branch, PR, or repository/base/head/diff association as applicable.
- A truthful account, observed lifecycle/PR facts, relevant entry points, tag intent, and prior revision when revising.
- An explicit snapshot or historical correction may occur outside a workflow. Standalone Create PR owns one terminal write only when no Execute or Ship parent owns it.

## Working Set

- Exact verified association, already-discovered/loaded candidates, current revision token, and evidence references. Reuse candidates that answer the same question; refine only an unresolved question.
- Read `references/work-capture-input.json` and `${CLAUDE_PLUGIN_ROOT}/skills/spectre-capture/references/tagging-policy.md`.
- Use relevant files already acquired for typed entry points; focus-read to validate observed lines when needed. Explain actual unavailable/non-code portions; never invent locations or dump files.

## Outputs + DONE

- A created, updated, no-op, conflict, skipped, or surfaced-failure result with exact work ID, revision, and canonical `recordPath` when applicable.
- Keep the incumbent fields, authored as four complementary groups:

| Group | Fields and responsibility |
| --- | --- |
| Requested outcome and scope | `requestedOutcome` says what was asked; `scope` gives meaningful boundaries. Do not repeat the same description. |
| Delivered result and decisions | `actualChanges` states delivered behavior, capability, or concrete artifact. `reasons` contains only non-obvious rationale/trade-offs. At start or blocked handoff, state truthfully what has and has not been delivered. |
| Discoveries and entry points | `discoveries` holds useful findings and links maintained authority when available. Typed locations and bounded references project to `relatedContext`; do not repeat delivery narrative. |
| Verification and remaining implementation | `verification` records checks and observed results; `remainingWork` contains genuine residual implementation. Structured verification and PR lifecycle remain authoritative. |

Keep a short title and routing summary. Required prose may truthfully say no separate rationale, discovery, or residual implementation exists; never add filler. Retain required identity/provenance/status metadata and derive it where reliable. Do not duplicate the input model or repeat account state across fields.

**DONE when:** the permitted boundary has a truthful account or truthful skip/no-op/failure. A capture result never changes Execute, Ship, Create PR, verification, or acceptance authority.

## Method / guardrails

1. Write only at these boundaries: one minimal truthful Execute-start account after exact run/work identity and branch exist; one meaningful blocked handoff or resolution when work cannot safely continue or resume across an authority, control, or context boundary; one Execute completion; one Ship update after the PR exists; or the explicitly owned standalone Create PR terminal boundary. Explicit snapshots and historical corrections are allowed. At Execute start, mark every not-yet-true section `None yet.` in plain prose; never use angle-bracket, `TODO`, or `REPLACE_ME` placeholders. Never write for individual tasks, batches, checks, reviews, commits, ordinary decisions, routine progress, transient remediation, or active-context refreshes.
2. There is one record per exact Execute run. Resume revises only that run's record; distinct runs never fold, even on the same branch, feature, or candidate. Branches and PRs may each reference multiple records. Execute-owned writes include `--source-run-id <exact-run>` with any other identity flag so receipt derivation uses that run's event log.
3. Read the exact current branch using `git rev-parse --abbrev-ref HEAD`. A new semantic work capture requires explicit exact branch evidence; if unavailable, return recovery/skip without guessing. Compare against independent run-start branch evidence when available. Preserve known branch on same-run updates; a historical correction by exact work ID may retain an unknown old branch but must never fill it from today's checkout. A new historical snapshot needs verified original branch evidence.
4. If the resolved record already has a PR identity or URL, run `gh pr view <identity-or-url> --json state` outside every store lock before capture and pass the observed state in `pullRequest`. If unavailable, unknown, contradictory to terminal history, or an unqueryable draft PR lacks identity, return recovery/skip; never guess. Keep execution, verification, and PR states separate. For an authorized terminal Execute write, send `execution.state: finalized` with `remainingWork: "None."` exactly. Blocked, failed, or interrupted work uses a non-final state and genuine scoped residual work. A finalized account without exact `None.` is rejected as `CAPTURE_INPUT_INVALID`; review, CI, PR readiness, merge, and closure never become implementation work.
5. Read `references/work-capture-input.json`, fill its semantic JSON outside the store, then submit through standard input: `knowledge-cli.mjs capture --kind work --input - --branch <exact-branch> --work-id <exact-id>|--source-run-id <exact-run>|--pull-request-id <exact-pr>|--candidate <exact-json> --project-dir <project-dir> --json`. Set `execution`, `verificationState`, and `pullRequest` from observation. States are `unknown|in-progress|implementation-ready|acceptance-pending|blocked|finalized`, `unknown|not-run|checked|passed|failed`, and `unknown|none|draft-open|closed|merged`; bare `open` is invalid. Use `--input <path>` only for explicit manual/advanced capture or returned `recoveryInput`.
6. Include relevant typed entry points at these boundaries: locations carry path, symbol or document section, observed positive line, and role; a specific explanation covers actual unavailable/non-code portions, including locations not yet created at start. At an already-owned terminal boundary, promote only a qualified reusable discovery missing from maintained guidance, or link existing authority. Do not require a knowledge record at every completion or add a scan/write boundary. Reusable guidance belongs to `Skill(spectre-capture)`.
7. Keep every new or revised account under 2,000 estimated rendered tokens; reference evidence instead of copying logs. Unchanged retries are no-ops. Changed records carry the loaded `revisionToken` and preserve omitted tags. Failure/conflict returns recovery input and stays non-blocking.

## Handoff

Return boundary, exact work ID, revision/conflict, canonical `recordPath`, associations, lifecycle facts, and recovery input when applicable.

## Escalate-If

- Boundary or exact ownership is unclear, or authoritative historical facts conflict; skip/surface rather than guessing.
- A write cannot recover through the available path; report recovery without blocking work delivery.
