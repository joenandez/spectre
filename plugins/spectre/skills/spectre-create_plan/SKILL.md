---
name: "spectre-create_plan"
description: "Create the smallest evidence-backed plan for confirmed Scope. Use for HOW after scope or when Plan routes here; not for scope, UX, tasks, or implementation."
user-invocable: true
---

# create_plan

## Purpose

Turn confirmed Scope into the smallest correct implementation plan. Behavioral scope is binding; implementation means are not. The primary owns synthesis and `plan.md`; research agents return evidence only.

## Inputs

- `$ARGUMENTS`: confirmed Scope—thread, root, or descendant—plus `--depth {xs|light|standard|comprehensive}` (default `standard`), `--no-review`, and `--execution {direct|structured}` (default `structured`).
- Existing scope/PRD/UX and substantive `task_context.md` research. Orchestrated calls reuse router research; never redispatch it.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged. Repair touched stale metadata.
- Read repository rules and real code. Reuse evidence first; otherwise use `@finder`, `@analyst`, and `@patterns` only for unresolved material questions. They do not write planning artifacts.
- Treat confirmed IN/OUT/ANTI-SCOPE, success criteria, constraints, and approved design as authoritative. Never silently change them.
- Search the actual task with `spectre knowledge search <task> --project-dir .`, assess applicability, and exact-load applicable guidance before affected decisions. Keep only exact loaded IDs/revisions in existing `task_context.md`; previews and unloaded candidates are not evidence.

## Outputs + DONE

Write `{FEATURE_ROOT}/specs/plan.md`, self-locating below its title with `Feature:` and `Feature Root:` derived from the physical directory. Add `Execution Mode: direct` for `--execution direct` or `--depth xs`.

Every plan contains:

1. **Overview** — requested outcome and smallest viable solution shape.
2. **Technical Approach** — thinnest end-to-end path, current data flow, closest `file:line` reuse anchors, decisions, and any complexity exceptions.
3. **Critical Files** — 1–7 verified files tagged Core logic / Pattern / Interface / Test.
4. **External Dependencies — Verify Before Implementation** — exact package versions plus existence commands, or `No new packages`.
5. **Verification — How We Know This Works** — 1–3 falsifiable test/observable/state signals per major behavior; direct-mode signals are executable.
6. **Out-of-Bounds — DO NOT add** — carry forward canonical OUT/ANTI-SCOPE and only evidence-backed technical exclusions; never pad a generic list.
7. **Risks & Filled Assumptions** — current credible risks with minimum mitigation or accept-and-monitor; silent-spec defaults only.
8. **Routing Observations** — exact `## Routing Observations` heading with workstream count, independent workstreams, dependency sequencing, shared-contract consumers, staged rollout/migration, new abstraction, unresolved material decision, and observed uncertainty; observations only, never route selection.

For `comprehensive`, add sections only when triggered: Current State for a non-obvious existing path; Implementation Phases for real dependency gates; Component/Data Architecture for persisted state or cross-component invariants; API Design for changed public/external contracts; Migration Plan for data/compatibility change; Testing Strategy for risk not captured by Verification. Omit untriggered sections; do not emit `N/A` ceremony.

DONE when every planned mechanism maps to a current requirement, constraint, prerequisite, or verified repository fact; every new complexity boundary carries a valid exception; all success criteria and Verification signals remain covered; speculative work is absent; Routing Observations are present; and the plan is executable at its routed depth.

## Method / guardrails

- Start with one cohesive vertical slice using the closest established local pattern. Keep cross-layer work together when splitting would create foundations or handoffs with no independent value.
- Refine retrieval after affected files are known. Inspect work previews within the shared budget; load a work body only to answer a stated question, including a critical imported constraint without a maintained equivalent. Do not reload an unchanged revision already in context. Workers receive compact applicable findings and provenance, never record bodies.
- A new abstraction/layer, public interface, dependency, persistence model, configuration surface, process, migration/compatibility mechanism, telemetry surface, or extension point is admitted only when a current requirement/constraint requires it or the simpler local approach demonstrably fails. Record under Technical Approach: `Addition | Required now by | Simpler local option | Why it fails now | Verification`. No valid row means delete or defer it.
- Reversible decisions take the local default without research or alternatives. For a material irreversible/public/persisted decision, compare at most two realistic options. Unknown feasibility becomes a bounded spike with a question, evidence, and stop condition—not production architecture.
- Keep one representative happy-path and primary-failure test per distinct required behavior; add cases only for another requirement, public boundary, credible regression, or materially different risk.
- Ask only about undiscoverable decisions that materially change behavior or an irreversible boundary; otherwise use a conservative local default and record it. XS/light never stop for clarification or enumerate alternatives.

## Handoff

`--no-review` / `--orchestrated` returns path, depth, assumptions, exceptions, and findings only.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone awaits approval: Approved direct → `/spectre:execute`; Approved XS structured override → `/spectre:create_tasks --depth xs`; Approved light structured → `/spectre:create_tasks`; Approved standard/comprehensive → `/spectre:plan_review`; unresolved behavior → UX/Prototype. One primary/conditional/pause.

## Escalate-If

Scope cannot be planned without changing it, a material irreversible decision remains unresolved, evidence cannot justify required complexity, or any write would escape `FEATURE_ROOT`.
