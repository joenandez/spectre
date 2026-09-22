---
name: "spectre-plan-route"
description: "Internal semantic classifier for Plan-or-Execute preparation. Use only from Plan or Execute with bounded routing input; never for planning, artifacts, telemetry, or user gates."
user-invocable: false
---

# plan-route

## Purpose

Return plan-routing/v1 to Plan/Execute; caller owns authority.

## Inputs

- Canonical Scope/authority + bounded work, not size.
- Initial; observed uses prior decision + selection before drafting; legacy may include Routing Observations.
- Execute when transported assessment is missing/materially stale.
- Resume-only legacy size is normalized once.

## Working Set

- Bounded scan: topology, uncertainty, evidence, boundaries, graph risk, shipped precedent, user decisions.
- If missing evidence alone would cross a costlier route, use exactly one bounded probe (`@spectre_finder`/`@spectre_patterns`) for one repository question.

## Outputs + DONE

Return `plan-routing/v1`: shape ATOMIC|DIRECT|STRUCTURED; uncertainty LOW|MODERATE|HIGH; evidence SUFFICIENT|PROBE_REQUIRED|PROBED; protected_boundaries[] {type, threatened_invariant, failure_mode}; task_graph_risk LOW|HIGH; design flag, size, route, rationale. Observed adds regret, reason codes, KEEP|RERUN_SMALLER|RERUN_LARGER.

DONE when fields validate; probe is consumed; STRUCTURED names workstreams; HIGH graph risk names an implementation-graph failure; only table derives size/route.

## Method / guardrails

| Semantic result | Size · route |
|---|---|
| ATOMIC + LOW + no changed protected boundary | XS · XS_DIRECT |
| ATOMIC + LOW + changed protected boundary OR DIRECT + LOW | S · S_DIRECT |
| ATOMIC/DIRECT + MODERATE/HIGH | M · M_REVIEWED_DIRECT |
| STRUCTURED + LOW/MODERATE + ordinary graph risk | L · L_STRUCTURED |
| STRUCTURED + HIGH uncertainty or HIGH task-graph risk | XL · XL_REVIEWED_STRUCTURED |

- STRUCTURED requires multiple independently implementable workstreams; render variants of one surface (layout, density, breakpoint, theme), dependencies, supporting artifacts, workflow/acceptance steps, and pilots are not workstreams.
- Two shipped instances of a change-shape make the next DIRECT; its layers are not workstreams; STRUCTURED requires a named delta beyond repetition.
- HIGH graph risk requires a credible implementation ordering/coordination/rollback failure; workflow gates/state transitions do not qualify.
- A protected boundary needs a concrete invariant + credible failure mode; it floors size at S but never creates structure or HIGH graph risk.
- Honor confirmed Scope assumptions and explicit selected-source boundaries. Missing paths/evidence permit at most the one probe; when Scope mandates an abstraction, spend it on whether it ships; classify the real delta. Only unresolved, approach-changing uncertainty affects size.
- Design authority needs unresolved product, compatibility, destructive, migration/rollback, or architecture choice; size and routine placement never create it.
- Observed consumes the completed minimum-solution selection before drafting, reports regret and KEEP|RERUN_SMALLER|RERUN_LARGER, and never repeats work or removes artifacts. The same routing table alone maps selected structural facts, uncertainty, protected boundaries, graph risk, and assurance floor; it does not select solution shape.
- Normalize legacy once: MICRO→XS, LIGHT→S, STANDARD-DIRECT→M, STANDARD→L, COMPREHENSIVE→XL; labels never decide.
- Never use file volume, dependency count, surface counts, or sensitive-domain keywords as size authority, and never let them create workstreams. Never plan, write artifacts, emit telemetry, or present gates.

## Handoff

Return record/probe as data. DONE does not end caller's turn; caller owns persistence, explanation, orchestration, gates, telemetry.

## Escalate-If

- Canonical Scope absent/conflicting, invalid enum, or boundary lacks predicate.
- Material user-authority decision: report `design_authority_required`, never decide.
