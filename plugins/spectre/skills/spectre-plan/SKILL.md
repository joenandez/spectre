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

- `$ARGUMENTS`: confirmed Scope—thread or managed root/descendant. Ordinary repository-changing work without confirmed Scope returns to `spectre-scope`; reported bugs normally use `spectre-fix`. Read-only diagnosis/review, release, and execution of approved artifacts remain direct.
- Existing `concepts/scope.md`, `specs/prd.md`, `ux.md` (preferred) or legacy `specs/ux.md`, `task_context.md`, and prior plan artifacts.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Immutable canonical Scope: `concepts/scope.md` when present, else confirmed thread; never change it without explicit scope-change approval.
- Read `references/estimation-guidance.md` only at an applicable gate; each estimate excludes waits and never delays or blocks the gate.
- Reuse current knowledge; otherwise follow Project knowledge routing: search actual task across mixed previews, assess, exact-load applicable. Standalone #tag: exact `--tag` search, assess/load matches; never guess. Refine only for a new question; retain IDs/revisions in `task_context.md`; previews are not evidence.

## Outputs + DONE

Every route produces `specs/plan.md` and `task_context.md`, with Scope/authority-bound `## Minimum Solution Selection`; never review, task/index, or task-review artifacts.

DONE when `task_context.md` binds initial/observed routing to draft raw-byte/authority hashes; Scope is unchanged; `plan.completed` records draft; handoff gives alignment/Trade-offs; telemetry is `complete|degraded`, or authority/scope stops it.

## Method / guardrails

1. Check product readiness: unresolved journeys/states/copy/accessibility route to `spectre-ux`; load-bearing interaction/layout validation routes to `spectre-prototype`.
2. Scan once; invoke `Skill(spectre-plan-route)` in `initial` mode. Run `spectre-workflow plan start` with root/scope hash, returned record, size/route, reasons, design/probe flags, boundaries; retain `PLAN_RUN_ID` for `plan.started`. Show size/rationale without approval.
3. Gather proportional evidence: XS/S local except probe; M ≤2 relevant `@spectre:finder`, `@spectre:analyst`, or `@spectre:patterns`; L/XL necessary dimensions. `@spectre:web-research` only decides external API/framework. Refine after affected files; load work only for stated question; pass compact findings/provenance. Persist accepted evidence/IDs/revisions in `task_context.md`.
4. Read `references/minimum-solution.md` after initial classification. In existing parallel research wave select incumbent-first and persist `## Minimum Solution Selection` in `task_context.md`, bound to Scope/authority/accepted evidence. XS/S local; M uses fresh evidence-only challenger only for durable state, identity, public contract, migration, dependency, or workflow/lifecycle; L/XL always. It replaces one available evidence slot, writes nothing; primary applies simpler-wins—not a serial challenger.
5. Invoke `Skill(spectre-plan-route)` in `observed` mode with completed selection before drafting. It alone maps selected structural facts, uncertainty, boundaries, graph risk, and assurance floor through unchanged table. Plan automatically uses the observed route with no paid rerun or user tier gate unless Scope, explicit design, or authority conflicts; never silently rerun.
6. Draft once with the observed route-mapped depth: XS → `Skill(spectre-create_plan) --depth light --no-review --execution structured`; S inherits it; M/L → `Skill(spectre-create_plan) --depth standard --no-review --execution structured`; XL → `Skill(spectre-create_plan) --depth comprehensive --no-review --execution structured`. Never review/task here. XS uses `light`, not `xs`, so no `Execution Mode: direct`.
7. Validate Routing Observations and owned concepts conform to selected record; emit `plan.reclassified` with plan hash, records, regret. Append observed record to `task_context.md` with draft raw-byte hash plus Scope/authority hash; emit unchanged `plan.completed` artifact hashes/counts/planning elapsed. Telemetry failure is degraded and never blocks handoff.
8. From `specs/plan.md` derive requested outcome, material decisions, Scope/anti-scope boundaries, credible risks, verification intent, and ordering/shared-contract constraints. Immediately before Execute show Trade-offs verbatim (`None` allowed): Execute accepts them; feedback revises the draft. On Scope change, selected-design conflict, missing irreversible decision, or unavailable authority, withhold the handoff. Otherwise return exactly one copy-ready fenced command: `/spectre:execute <repo-relative plan.md> --origin plan --preflight-plan <xs|light|standard|comprehensive>`. XS → xs; S → light; M/L → standard; XL → comprehensive. Launching that command is the user's alignment signal. Never pass `--orchestrated` or wait for delivery insurance.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Execute owns assessment/review/tasks/gates/resume. Never generate a goal prompt. Render Execute: resolved absolute plan path, `--origin plan`, resolved preflight depth.

## Escalate-If

- Scope/root conflicts; drafting reveals Scope change, explicit-design contradiction, missing irreversible decision, unavailable authority, or invalid artifacts.
- Telemetry/estimate failure never blocks planning; report degraded observation and continue.
