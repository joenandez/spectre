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

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged. Repair touched stale metadata.
- Read repository rules and real code. Reuse evidence first; otherwise use `@spectre_finder`, `@spectre_analyst`, and `@spectre_patterns` only for unresolved material questions. They do not write planning artifacts.
- Treat confirmed IN/OUT/ANTI-SCOPE, success criteria, constraints, and approved design as authoritative. Never silently change them.
- Reuse current-request knowledge results/loads; otherwise follow Project knowledge routing. Search actual task across mixed knowledge/work previews; assess, then exact-load applicable records. Standalone #tag: exact search --tag, assess previews, then exact-load applicable matches; never guessed loads. Refine only for an unresolved question or new subject. Keep IDs/revisions in `task_context.md`; previews/unloaded candidates are not evidence.

## Outputs + DONE

Write `{FEATURE_ROOT}/specs/plan.md`, self-locating below its title with `Feature:` and `Feature Root:` derived from the physical directory. Add `Execution Mode: direct` for `--execution direct` or `--depth xs`.

Every plan contains:

1. **Overview** — requested outcome and smallest viable solution shape.
2. **Technical Approach** — thinnest end-to-end path, current data flow, closest `file:line` reuse anchors, decisions, and any complexity exceptions.
3. **Trade-offs** — 0–3 material user choices as `Choice | Simpler option | Gives up | Acceptable now because | Revisit when`; use `None` when none and omit speculative benefits of generality.
4. **Critical Files** — 1–7 verified files tagged Core logic / Pattern / Interface / Test.
5. **External Dependencies — Verify Before Implementation** — exact package versions plus existence commands, or `No new packages`.
6. **Verification — How We Know This Works** — 1–3 falsifiable test/observable/state signals per major behavior; direct-mode signals are executable.
7. **Out-of-Bounds — DO NOT add** — carry forward canonical OUT/ANTI-SCOPE and only evidence-backed technical exclusions; never pad a generic list.
8. **Risks & Filled Assumptions** — current credible risks with minimum mitigation or accept-and-monitor; silent-spec defaults only.
9. **Routing Observations** — exact `## Routing Observations` heading with workstream count, independent workstreams, dependency sequencing, shared-contract consumers, staged rollout/migration, new abstraction, unresolved material decision, and observed uncertainty; observations only, never route selection.

For `comprehensive`, add sections only when triggered: Current State for a non-obvious existing path; Implementation Phases for real dependency gates; Component/Data Architecture for persisted state or cross-component invariants; API Design for changed public/external contracts; Migration Plan for data/compatibility change; Testing Strategy for risk not captured by Verification. Omit untriggered sections; do not emit `N/A` ceremony.

DONE when the plan stops at the first solution that satisfies Scope, safety, and Verification; every new owned concept has a valid admission row; all success criteria and Verification signals remain covered; material trade-offs are explicit; speculative work is absent; Routing Observations are present; and the plan is executable at its routed depth.

## Method / guardrails

- Trace the current flow, start with zero new owned concepts, and stop at the first shape covering Scope, safety, and Verification: nothing new → reuse owner/lifecycle/state/operation → extend one boundary and derive state → existing platform/dependency → minimum new mechanism. Prefer deletion, consolidation, and one source of truth.
- Keep one cohesive vertical slice using the closest established local pattern. Keep cross-layer work together when splitting would create foundations or handoffs with no independent value.
- Refine retrieval after affected files are known. Inspect work previews within the shared budget; load a work body only to answer a stated question, including a critical imported constraint without a maintained equivalent. Do not reload an unchanged revision already in context. Workers receive compact applicable findings and provenance, never record bodies.
- Owned concepts include layers/interfaces/dependencies, tables/persisted facts/states/operations/processes, and configuration/migration/telemetry/extension points. Admit one only when the simpler shape fails a current requirement, safety constraint, or verified prerequisite; record `Addition | Requirement failing without it | Repository evidence | Why reuse/derivation fails | Verification`. Future flexibility, optional diagnostics, and hypothetical scale are not evidence; no valid row means delete or defer.
- Default to the simpler qualifying option. Reject it if it violates Scope, safety, or correctness; otherwise record its concrete consequence and revisit trigger without an alternatives menu. Reversible decisions take the local default without research or alternatives; compare at most two realistic options only for a material irreversible/public/persisted decision. Unknown feasibility becomes a bounded spike with a question, evidence, and stop condition—not production architecture.
- Keep one representative happy-path and primary-failure test per distinct required behavior; add cases only for another requirement, public boundary, credible regression, or materially different risk.
- Ask only about undiscoverable decisions that materially change behavior or an irreversible boundary; otherwise use a conservative local default and record it. XS/light never stop for clarification or enumerate alternatives.

## Handoff

`--no-review` / `--orchestrated` returns path, depth, assumptions, exceptions, and findings only.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone awaits approval: Approved direct → `spectre-execute`; Approved XS structured override → `spectre-create_tasks --depth xs`; Approved light structured → `spectre-create_tasks`; Approved standard/comprehensive → `spectre-plan_review`; unresolved behavior → UX/Prototype. One primary/conditional/pause.

## Escalate-If

Scope cannot be planned without changing it, a material irreversible decision remains unresolved, evidence cannot justify required complexity, or any write would escape `FEATURE_ROOT`.
