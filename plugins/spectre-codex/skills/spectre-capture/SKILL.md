---
name: "spectre-capture"
description: "Capture durable project decisions, accepted corrections, verified reusable patterns or gotchas, disproved guidance, and changed persistent blockers as soon as they matter. The user's correction is sufficient authority without code corroboration. Do not use for routine progress, transient errors, incidental code, task outcomes, or historical work accounts."
user-invocable: false
---

# capture

## Purpose

Maintain concise, reusable project guidance proactively. Capture never gates delivery, verification, acceptance, or PR progression.

## Inputs

- A consequential lasting decision/reversal, accepted correction, verified reusable pattern/gotcha/constraint, disproved guidance, or confirmed persistent-blocker transition.
- Current-request discovery and exact-loaded candidates, when available; host project directory, tag intent, and candidate ID/revision when updating.
- No workflow, feature, run, or PR association: this skill owns maintained knowledge, not work history.

## Working Set

- Reuse discovered/loaded candidates that answer the same future question. Refine only an unresolved question; do not repeat a broad search at the capture boundary.
- Read `references/tagging-policy.md` and `references/knowledge-capture-input.json`. Search tags only to resolve missing aliases, omitted areas, or genuinely new tag intent; exact-load a record only when needed.
- Use relevant files already acquired for entry points. Focus-read to validate observed lines when needed; do not dump files or invent locations.

## Outputs + DONE

- A typed capture result: saved, updated, superseded, retired, no-op, skipped, or surfaced failure, with ID, revision, and canonical `recordPath` when applicable.
- Knowledge content has four distinct responsibilities: applicability (`useWhen`); current conclusion first, with why and practical consequences (`content`); selected code entry points; supporting evidence (`evidence`). Keep the summary a short routing aid rather than a repeat of the guidance. Aim for 250–600 rendered tokens as a soft editing target; split independent questions when useful, and retain required facts and gates over size.

**DONE when:** a supported durable fact is captured through the typed path, or a skip/no-op/failure is reported truthfully without changing workflow authority.

## Method / guardrails

1. Capture facts that change a likely future decision, prevent a repeated failure, or route to relevant code. Routine progress, incidental code observations, transient command errors, and task completion alone do not qualify.
2. An explicit user statement that a lasting decision is current, corrected, or superseded is authoritative. Do not wait for repository corroboration or reconfirmation. When a correction is accepted, rewrite contradictory current guidance and its title, summary, and `useWhen` together; do not leave the old conclusion imperative. Use existing revision-aware updates, statuses, and `relatedRecordIds` to reconcile known competing guidance and preserve history. Surface write/conflict failures accurately; never claim unresolved records were reconciled or sweep the corpus.
3. Bound provider observations by observed version, date, and configuration; state when they need rechecking. Keep phase obligations, experiment settings, and one-session permissions separate from project-wide guidance. Explain genuinely unavailable or non-code entry points; a user correction remains valid even without a known code location.
4. Put `entryPoints` in the semantic input from relevant acquired files: each location has path, symbol or document section, observed positive line, and role. Use a specific explanation for actual unavailable/non-code portions; mixed known and unavailable locations may include both. No file dumps, invented lines, or boilerplate excuses.
5. Submit JSON on standard input: `knowledge-cli.mjs capture --kind knowledge --input - --project-dir <project-dir> --json`. New input needs tag intent; reuse a canonical area or create only under the shared policy. Use `--input <path>` only for explicit manual/advanced capture or returned `recoveryInput`.
6. An unchanged retry is a no-op. Changed records require the loaded `revisionToken` as `--expected-revision`; preserve omitted tags. Never edit canonical packages, `index.json`, or history.
7. A capture failure returns recovery input and remains non-blocking. It never becomes a workflow gate.

## Handoff

Return the trigger or skip reason, tag and record outcome, ID/revision/conflict, canonical `recordPath`, applicability, evidence references, and recovery input when applicable.

## Escalate-If

- Accepted directions conflict without a clear current decision, or applicability cannot be determined; surface the conflict without guessing.
- A write cannot recover through the available path; report recovery input without blocking delivery.
