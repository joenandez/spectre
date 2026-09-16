---
name: "spectre-scope"
description: "Scope a feature or improvement into explicit IN / OUT / ANTI-SCOPE boundaries before planning or code — grounds a hypothesis in repo reality, resolves blocking questions, and writes scope.md. Trigger for new or fuzzy work or re-scoping. Do NOT trigger for technical design/research (spectre-plan) or standalone bug diagnosis (spectre-fix)."
user-invocable: true
---

# scope

Turn an unstructured request into clear scope boundaries (IN / OUT / ANTI-SCOPE), user value, load-bearing assumptions, and decisions — **clear on WHAT, silent on HOW.** Boundaries and user value first; defer all technical/implementation questions to `$spectre:spectre-plan`.

## Inputs

- `$ARGUMENTS` — the feature/problem brain-dump. If empty → greet, ask for context, and **WAIT** for the user.
- Existing root/artifact: context for new work; reuse only for the same scope run, `FROM_KICKOFF=true`, or explicit resume/re-scope. On re-scope, read `concepts/scope.md` fully, surface settled decisions and the delta, and confirm before rewriting the immutable downstream anchor.
- `FROM_KICKOFF=true` + `KICKOFF_DOC` → read the doc, extract (Core Problem, User Value, Decisions Made, Remaining Ambiguities, Key Code Refs), then **skip grounding + exploration** and go straight to clarifications. Already-grounded.

## Working Set (late-bound — read at run-time, never inline)

- `FEATURE_ROOT = .spectre/features/<feature-name>/`, resolved from the input or proposed below.
- captured session or current thread memory for this area, if present
- Reuse current-request knowledge results/loads; otherwise follow Project knowledge routing. Search actual task across mixed knowledge/work previews; assess, then exact-load applicable records. Standalone #tag: exact search --tag, assess previews, then exact-load applicable matches; never guessed loads. Refine only for an unresolved question or new subject. Keep IDs/revisions in `concepts/scope.md`; previews/unloaded candidates are not evidence.

## Feature root contract

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.

## Method / guardrails

- **Reply before tools.** Acknowledge first; never go silent to "think." No tool calls in the opening reply except reading `KICKOFF_DOC` when `FROM_KICKOFF=true`.
- **WHAT, not HOW.** Ask only about boundaries, user value, and anti-scope. Defer architecture/trade-offs/integration to `$spectre:spectre-plan`. Exception: scope that is inherently technical (e.g. "migrate DB X→Y").
- **Ground once.** Start with exactly **one** fast lookup to anchor the hypothesis in repo reality — a single `@spectre_finder` query, or one `grep`/`glob`; skip it if slow. Needing broader grounding exceeds this fast scope pass.
- **Use knowledge before affected decisions.** Discovery is per question, not skill: never repeat an equivalent query merely because Scope began. A work body answers only a stated question, including a potentially critical imported constraint without a maintained equivalent. Do not reload an unchanged revision already in context; workers receive compact applicable findings and provenance, never record bodies.
- Lead with a grounded hypothesis (problem, who it affects, proposed feature name/root, IN / OUT / ANTI-SCOPE) and 5–8 questions tagged **(blocking)** / *(optional)*. Iterate boundaries (IN / OUT / ANTI-SCOPE / Unsure) until confirmed, then clarify remaining ambiguity with `AskUserQuestion` (≤4 at a time). No clarification files.

## Outputs + DONE

Write `{FEATURE_ROOT}/concepts/scope.md`, beginning immediately below the title with `Feature: <feature-name>` and `Feature Root: .spectre/features/<feature-name>`, then user value & boundaries before technical detail, with **all** of:

 1. **The Problem** — pain, impact, current state
 2. **Target Users** — primary, secondary, needs
 3. **Success Criteria** — measurable assertions over prose
 4. **User Experience** — journeys, principles, trade-offs
 5. **Scope Boundaries** — **IN / OUT / ANTI-SCOPE / Maybe / Future**
 6. **Load-Bearing Assumptions** — each with a short *"if this is false, …"* consequence
 7. **Constraints** — platform/perf/a11y/scale (user-provided only)
 8. **Decisions** — choices + rationale
 9. **Risks** — UX, scope creep, open questions
10. **Next Steps** — recommended command + complexity S/M/L

**ANTI-SCOPE ≠ OUT.** OUT = not building it (yet/this release). ANTI-SCOPE = a problem we are *intentionally not solving* — the philosophical edge of what the feature is for. Both are required.

**DONE when:** scope.md exists with all 10 sections; IN / OUT / ANTI-SCOPE are explicit; every load-bearing assumption carries its "if false" consequence; the user has confirmed the boundaries.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |
| 🔀 **Alternative** | Pause: `$spectre:spectre-handoff` with the resolved feature when stopping. |

Present boundaries/assumptions/path; unsettled → Scope; UI load-bearing and journeys, segments, states, copy, or accessibility unresolved → UX; interaction/layout/visual validation materially matters → Prototype; otherwise confirmed repository-changing work → `$spectre:spectre-plan`. One route/conditional; edits re-route.

## Escalate-If

- Grounding needs more than one lookup, or the request spans several unknowns → this exceeds a fast scope pass; gather context more fully before proceeding.
- The user pushes for implementation/architecture answers → note them and defer to `$spectre:spectre-plan`; keep this pass on WHAT.
- Boundaries won't converge after iterating → surface the specific unresolved tension and ask the user to decide before writing the doc.
