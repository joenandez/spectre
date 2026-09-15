---
name: "spectre-plan"
description: "Create a repository-grounded aligned draft after confirmed Scope, present its concise alignment brief, and hand it to Execute preflight. Do not use for scoping, bug diagnosis, read-only work, or execution of approved artifacts."
user-invocable: true
disable-model-invocation: true
---

# plan

## Purpose

Turn confirmed Scope into the smallest sufficient draft and handoff. `spectre-plan-route` alone classifies; the primary owns synthesis, routing, and draft finalization. Scope remains the immutable user contract.

## Inputs

- `$ARGUMENTS`: confirmed Scope—thread or managed root/descendant. Repository changes without Scope return to `spectre-scope`; bugs use `spectre-fix`. Read-only diagnosis/review, release, and approved-artifact execution remain direct.
- Existing Scope/PRD, `ux.md` (preferred) or legacy `specs/ux.md`, `task_context.md`, and prior plans.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Immutable canonical Scope: `concepts/scope.md` when present, else confirmed thread; never change it without explicit scope-change approval.
- Read `references/estimation-guidance.md` when applicable; each estimate excludes waits and never delays or blocks the gate.
- Reuse current-request knowledge results/loads; otherwise follow Project knowledge routing. Search actual task across mixed knowledge/work previews; assess, then exact-load applicable records. Standalone #tag: exact search `--tag`, assess previews, then exact-load applicable matches; never guessed loads. Refine only for an unresolved question or new subject. Keep IDs/revisions in `task_context.md`; previews/unloaded candidates are not evidence.

## Outputs + DONE

Every route writes `specs/plan.md` and `task_context.md` with Scope/authority-bound `## Minimum Solution Selection`; no review/task/index/task-review artifacts.

DONE when `task_context.md` binds initial/observed routing to draft/authority hashes; Scope is unchanged; `plan.completed` records draft; handoff gives alignment/Trade-offs; telemetry is `complete|degraded`, or authority/scope stops it.

## Method / guardrails

1. Unresolved journeys/states/copy/accessibility route to `spectre-ux`; load-bearing interaction/layout validation routes to `spectre-prototype`.
2. Scan once; invoke `Skill(spectre-plan-route)` in `initial` mode. Run `node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" plan start` with root/scope hash, returned record, size/route, reasons, design/probe flags, boundaries; retain `PLAN_RUN_ID` for `plan.started`. Show size/rationale, no approval.
3. Gather proportional evidence: XS/S local except probe; M ≤2 relevant `@spectre_finder`, `@spectre_analyst`, or `@spectre_patterns`; L/XL necessary dimensions. In the existing parallel research wave, M reserves one available evidence slot for a fresh evidence-only challenger only for durable state, identity, public contract, migration, dependency, or workflow/lifecycle; L/XL always reserve it. The challenger writes nothing; primary dispatches it with the wave, then persists accepted evidence/IDs/revisions in `task_context.md`. `@spectre_web_research` only decides external API/framework. Refine knowledge search after affected files are known; load a work body only for a stated question, never reload an unchanged revision, and pass workers compact findings with provenance.
4. Read `references/minimum-solution.md` after initial classification. From the returned evidence wave, select incumbent-first and persist `## Minimum Solution Selection` in `task_context.md`, bound to Scope/authority/accepted evidence. XS/S decide locally; primary applies the canonical simpler-wins result.
5. Invoke `Skill(spectre-plan-route)` in `observed` mode with completed selection before drafting. It alone maps selected structural facts, uncertainty, boundaries, graph risk, and assurance floor through unchanged table. Plan automatically uses the observed route with no paid rerun or user tier gate unless Scope, explicit design, or authority conflicts; never silently rerun.
6. Draft once with the observed route-mapped depth: XS → `Skill(spectre-create_plan) --depth light --no-review --execution structured`; S inherits it; M/L → `Skill(spectre-create_plan) --depth standard --no-review --execution structured`; XL → `Skill(spectre-create_plan) --depth comprehensive --no-review --execution structured`. Never review/task here. XS uses `light`, not `xs`, so no `Execution Mode: direct`.
7. Validate Routing Observations and owned concepts conform to selected record; emit `plan.reclassified` with plan hash, records, regret. Append observed record to `task_context.md` with draft raw-byte hash plus Scope/authority hash; emit unchanged `plan.completed` artifact hashes/counts/planning elapsed. Telemetry failure is degraded and never blocks handoff.
8. From `specs/plan.md` derive requested outcome, approach, material decisions, Scope/anti-scope boundaries, credible risks, verification intent, and ordering/shared-contract constraints. Immediately before Execute show Trade-offs verbatim (`None` allowed): Execute accepts them; feedback revises the draft. On Scope change, selected-design conflict, missing irreversible decision, or unavailable authority, withhold the handoff. Otherwise return exactly one copy-ready fenced command: `spectre-execute <repo-relative plan.md> --origin plan --preflight-plan <xs|light|standard|comprehensive>`. observed XS → xs; S → light; M/L → standard; XL → comprehensive. Launching that command is the user's alignment signal. Never pass `--orchestrated` or wait for delivery insurance.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Execute owns assessment/review/tasks/gates/resume. Never generate a goal prompt. Render Execute: resolved absolute plan path, `--origin plan`, resolved preflight depth.

## Escalate-If

- Scope/root conflict; Scope/design contradiction, missing irreversible decision, unavailable authority, or invalid artifacts.
- Telemetry/estimate failure never blocks; report degradation and continue.
