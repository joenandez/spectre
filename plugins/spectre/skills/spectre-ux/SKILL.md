---
name: "spectre-ux"
description: "Define user flows, screens, states, copy, and accessibility in ux.md. Two stages: align flows, then specify. Use after scope/PRD for behavioral UX; not backend, scope, or architecture."
user-invocable: true
disable-model-invocation: true
---

# ux

Turn requirements into a behavioral spec — **what users see/do and the system response**, not visual taste. Align flows, then write `ux.md`.

## Inputs

- `$ARGUMENTS` — explicit feature name/root or descendant requirements artifact.
- Requirements — first present, read fully:
  1. `{OUT_DIR}/concepts/scope.md` (canonical, preferred)
  2. `{OUT_DIR}/specs/prd.md`
  3. `{OUT_DIR}/task_summary.md`
- **If none exist → ask for scope context or recommend `/spectre:spectre-scope` first; do not invent scope.**

## Working Set (late-bound — read at run-time, never inline)

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Repair stale feature/root metadata in artifacts this workflow touches.
- `OUT_DIR = FEATURE_ROOT`.
- Existing UI: one Stage-1 `@spectre:patterns` dispatch for similar screens/tokens — ≤~2K in-thread, no files.

## Method / guardrails

**Stage 1 — Flow discovery & alignment (align before specifying).**
- Identify **user segments**: first-time/returning, anon/signed-in, free/paid, role-based.
- Identify goals, entry points, and completion states.
- Narrate each flow: Goal · Entry · **User sees → User does → System responds** · branches · success · Questions; call out segment divergence.
- Present a take and ask for pushback. Every initial or feedback-revised flow presentation ends with the compact handoff table:

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Flow approval. |
| 📦 **What was just done** | Initial or revised flows. |
| ▶️ **Proposed next step** | Render resolved action. |

- `CONTINUATION`: Prototype when interaction, layout, visual validation, or stakeholder review materially matters; otherwise Plan when Scope + flows suffice. Render `/spectre:spectre-prototype {FEATURE_ROOT} FROM_UX=true` or `/spectre:spectre-plan {FEATURE_ROOT}`; at most one explicit conditional alternative.
- Flows approved: complete {OUT_DIR}/ux.md, then Prototype or Plan with resolved values.
- **GATE:** Never write `{OUT_DIR}/ux.md` before explicit flow approval + selected continuation. Feedback without approval → revise and re-present. Ambiguous approval or missing route authority → ask only the unresolved choice.

**Stage 2 — Detailed spec (only after explicit flow approval + selected continuation).**
- That reply clears Stage 1: complete `{OUT_DIR}/ux.md`, then invoke the selected workflow in the same run with no second gate. Resolve from approved flows; ask only for missing irreversible authority.

## Outputs + DONE

Write `{FEATURE_ROOT}/ux.md` with **all 11 sections**. Below its title:

```text
Feature: <feature-name>
Feature Root: .spectre/features/<feature-name>
```

Derive both values from the physical feature directory.

1. **Overview** — problem and primary goal (1 para)
2. **User Segments** — served segments and UX differences
3. **Screens** — name, purpose, navigation
4. **Flows** — Stage 1 plus validation-fail, cancel, network-error, and segment branches
5. **Layouts** — header/main/footer and responsive behavior (**desktop >1024 · tablet 768–1024 · mobile <768**)
6. **Components** — interactive purpose, location, applicable State Vocabulary
7. **Interactions** — table: **Element | Action | Result** (exhaustive)
8. **States** — table: **State | Trigger | Appearance | Available Actions**
9. **Content** — exact titles, buttons, empty/error/confirmation copy
10. **Edge Cases** — limits, data, permission, network, segments
11. **Accessibility** — tab order, Enter/Space/Escape, announcements, focus

**State Vocabulary** — pick relevant states:
- **Visual:** default, hover, focus, active/pressed, disabled; **Data:** empty, loading, partial-loaded, loaded, error, stale/refreshing
- **Form:** pristine, dirty, touched, submitting, submitted-success, submitted-error, per-field validation-error; **Selection:** none, single, multi, partial-selection, all-selected
- **Sync:** optimistic, pending, conflict, resolved; **Network:** online, offline, reconnecting

**DONE when:** the Stage-1 flow gate was cleared (user approved flows); `ux.md` exists with all 11 sections; segments addressed; flows carry alternate paths; Interactions and States tables use the exact column formats above; component states are drawn from the State Vocabulary; layouts state the responsive breakpoints; accessibility and edge cases covered.

## Handoff

| Handoff | Details |
| --- | --- |
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action; no placeholders. |

Confirm UX/doc path. Material visual/interaction/stakeholder/prose-limit → Prototype (apply assumptions to `ux.md`); otherwise confirmed repository-changing work → `/spectre:spectre-plan`. One route/conditional; read-only may stop/Handoff.

## Escalate-If

- No scope/PRD/summary found → stop; get scope context or route to `/spectre:spectre-scope` before specifying.
- User pushes for implementation/architecture decisions → note them, defer to `/spectre:spectre-plan`; keep this pass on behavior.
- Flows won't converge after iterating → surface the specific unresolved divergence (usually a segment conflict) and ask the user to decide before Stage 2.
- Feature has no user-facing surface → this spec adds nothing; route back to `/spectre:spectre-plan`.
