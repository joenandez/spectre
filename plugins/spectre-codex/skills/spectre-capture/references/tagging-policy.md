# Tagging Policy

## Purpose

Tags are durable, wiki-level project areas that connect multiple independent knowledge and work records. They are not alternate names for a task, branch, implementation, bug, or individual record.

## Selection

- Assign one primary tag at the broadest stable level that still identifies a meaningful product capability, subsystem, or workflow.
- Add at most one secondary tag when the record materially connects another independently browsable area.
- Reuse a canonical tag when it already represents the concept. Put record-specific detail in the record ID, title, summary, applicability, and body.
- Prefer the durable area over a compound restatement of the current work: `memory` over `memory-hooks` or `codex-hooks-display`; `plan` over `plan-simplification`.

## Creation

Create a new canonical tag when no existing tag represents the area and the proposed tag:

1. Makes sense as an independently browsable wiki page.
2. Is expected to group multiple independent records.
3. Will survive completion or renaming of the current task.
4. Adds useful navigation that its nearest broader tag cannot provide.

Give every new tag a short area description. If the candidate fails this test, use the nearest applicable canonical area and keep the specificity on the record.

## Elevation

- Split downward only after the narrower concept has multiple independent records and demonstrated retrieval or navigation value.
- Merge upward when a tag remains task-shaped, mirrors one record, lacks an independent conceptual identity, or adds no useful distinction from its broader area.
- Preserve merged names through aliases or redirects.
