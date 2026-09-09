---
name: "spectre-learn"
description: "User-invoked front door for durable capture. Use when the user invokes /learn or asks to remember, correct, preserve, or summarize consequential project work; interpret the request and delegate persistence to Capture. Do not use for autonomous capture, routine progress, unsupported hypotheses, personal preferences, or knowledge lookup."
user-invocable: true
disable-model-invocation: true
---

# learn

## Purpose

Turn an explicit user capture request into a qualified knowledge or work-record request. Learn owns user intent and routing; `Skill(spectre-capture)` owns persistence. Do not revive knowledge-skill authoring, proposal gates, dossiers, or SessionStart output.

## Inputs

- An explicit user capture request, `$ARGUMENTS`, and the current conversation; bare invocation means review the conversation for consequential, evidenced knowledge.
- User intent: an insight or correction targets maintained knowledge; `summarize this work` or a broad feature account targets a typed work record.
- The current project directory and any exact record/work identity already in context. A Spectre feature root is not required.

## Working Set

- Search metadata and exact verified loads needed to identify a maintained record or answer a stated work question.
- Current evidence. An explicit user statement that a lasting decision is current, corrected, or superseded is accepted authoritative evidence for that decision. Investigate only genuinely missing material evidence; do not seek independent corroboration or reconfirmation for that statement, reconstruct a conversation, or manufacture a durable fact.

## Outputs + DONE

- `Skill(spectre-capture)` returns a saved, updated, or no-op result. Report its record kind, exact ID, and outcome.
- A broad account always uses the seven-section work record form. No Learn output creates a knowledge skill, separate dossier, or SessionStart entry.
- DONE when qualifying evidence has reached Capture or bare Learn truthfully reports a no-op.

## Method / guardrails

1. Identify intent from the request. A bare request scans the conversation for accepted consequential decisions, verified reusable constraints, corrections, or confirmed blockers/resolutions. An explicit user correction is already-authorized evidence, not an unsupported hypothesis; routine progress and model-generated hypotheses are no-ops.
2. For an insight or correction, provide Capture the evidence, its authority, and the maintained-knowledge target. For an explicit user correction, cite that direction as the evidence, revise the current record, and retain disagreeing repository statements only as stale or historical context; absence of repository corroboration is not missing evidence. For work summary intent, provide the exact run/PR/candidate association and only truthful lifecycle facts.
3. Tell `Skill(spectre-capture)` which kind applies, the evidence, exact identity, and tag intent. Capture reads `references/knowledge-capture-input.json` or `references/work-capture-input.json`, searches/reuses tags, and owns construction, revisions, saving, and recovery. Learn does not duplicate that SOP or write records. Already-authorized facts need no new proposal or approval loop.

## Handoff
| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return the compact Capture result: `knowledge|work`, ID, and `saved|updated|no-op`. Surface conflicts with explicit user decisions and missing evidence.

## Escalate-If

The request is ambiguous, would persist a model-generated or unaccepted third-party claim, cannot identify an ambiguous work association, or contains conflicting explicit authoritative directions without a clear latest decision.
