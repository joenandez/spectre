---
name: "spectre-plan"
description: "Create a repository-grounded aligned draft after confirmed Scope, present its concise alignment brief, and hand it to Execute preflight. Do not use for scoping, bug diagnosis, read-only work, or execution of approved artifacts."
user-invocable: true
disable-model-invocation: true
---

# plan

## Purpose

Turn confirmed Scope into the smallest sufficient aligned draft and user-facing handoff. `spectre-plan-route` alone classifies; the primary owns synthesis, routing, and draft finalization. Scope remains the immutable user contract; the draft is not a reviewed execution source.

## Inputs

- `$ARGUMENTS`: confirmed Scope—thread or managed root/descendant. Ordinary repository-changing work without confirmed Scope returns to `spectre-scope`; reported bugs normally use `spectre-fix`. Read-only diagnosis/review, release, and execution of approved artifacts remain direct.
- Existing `concepts/scope.md`, `specs/prd.md`, `ux.md` (preferred) or legacy `specs/ux.md`, `task_context.md`, and prior plan artifacts.

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Immutable canonical Scope: `concepts/scope.md` when present, else confirmed thread; never narrow, expand, or reinterpret it without explicit scope-change approval.
- Read `references/estimation-guidance.md` only at an applicable gate; each estimate excludes user waits and never delays or blocks the gate.
- Search the actual task with `node "${PLUGIN_ROOT}/hooks/scripts/knowledge-cli.mjs" search <task> --project-dir .`; assess applicability and exact-load applicable knowledge before affected decisions. Retain used IDs and revisions in existing `task_context.md`, excluding preview-only and unloaded candidates.

## Outputs + DONE

Every route produces the aligned `specs/plan.md` and existing `task_context.md` evidence; it produces no review, task/index, or task-review artifact. The plan's response is the alignment surface, not a second durable specification.

DONE when initial and observed routing decisions are recorded; the observed record is transported in `task_context.md` bound to the draft's raw-byte hash and actual authority hash; the draft and protected inputs validate; Scope is unchanged; `plan.completed` records the draft; the response gives the required concise alignment brief and one Execute handoff; telemetry is `complete|degraded`; or unavailable authority/scope change stopped before handoff.

## Method / guardrails

1. Check product readiness: unresolved journeys/states/copy/accessibility route to `spectre-ux`; load-bearing interaction/layout validation routes to `spectre-prototype`.
2. Make one cheap local scan, then invoke `Skill(spectre-plan-route)` in `initial` mode. Run `node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" plan start` with the root/scope hash plus the returned semantic record, size/route, reason codes, design flag, probe flags, and protected boundaries; retain `PLAN_RUN_ID` for `plan.started`. Show size/rationale without asking approval of the label.
3. Gather proportional evidence: XS/S stay local except the route's bounded probe; M uses at most two relevant `@spectre_finder`, `@spectre_analyst`, or `@spectre_patterns`; L/XL cover necessary dimensions. `@spectre_web_research` is only for an external dependency/API/framework decision. Refine knowledge search after affected files are known; load a work body only for a stated question, never reload an unchanged revision in current context, and pass workers compact applicable findings with provenance. Persist accepted evidence and exact loaded IDs/revisions in `task_context.md`.
4. Draft once with the route-mapped depth and no review: XS → `Skill(spectre-create_plan) --depth light --no-review --execution structured`; S → `Skill(spectre-create_plan) --depth light --no-review --execution structured`; M/L → `Skill(spectre-create_plan) --depth standard --no-review --execution structured`; XL → `Skill(spectre-create_plan) --depth comprehensive --no-review --execution structured`. Never run a review, task/index, or task-review pipeline here. XS must use `light`, not `xs`, so its draft never receives `Execution Mode: direct`.
5. Validate the draft, invoke `Skill(spectre-plan-route)` in `observed` mode with `Routing Observations`, emit `plan.reclassified` with plan hash, initial/observed records, and regret, and append the final observed record to existing `task_context.md` with the draft raw-byte hash plus Scope/authority hash. Surface KEEP/RERUN_SMALLER/RERUN_LARGER and wait when changed; never silently rerun paid work. Emit `plan.completed` for this draft with raw-file artifact hashes, counts, and planning elapsed time excluding waits. Any telemetry failure is degraded observation only and never blocks the handoff.
6. Derive the response from `specs/plan.md`: requested outcome, proposed architecture/approach, material decisions, Scope/anti-scope boundaries, credible risks, verification intent, and genuine ordering/shared-contract constraints. Keep it concise. If drafting exposes a Scope change, contradiction with an explicit selected design, missing irreversible decision, or unavailable user authority, withhold the handoff and use the existing authority escalation. Otherwise return exactly one copy-ready fenced command: `spectre-execute <repo-relative plan.md> --origin plan --preflight-plan <xs|light|standard|comprehensive>`. Marker mapping is XS → xs; S → light; M/L → standard; XL → comprehensive. Launching that command is the user's alignment signal. Never pass `--orchestrated` or wait for delivery insurance.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Execute owns assessment/review/tasks/gates/resume. Never generate a goal prompt. Render Execute: resolved absolute plan path, `--origin plan`, resolved preflight depth.

## Escalate-If

- Scope/root is absent or conflicts; drafting reveals a Scope change, explicit-design contradiction, missing irreversible decision, or unavailable authority; or deterministic draft artifacts do not validate.
- Telemetry or a missing estimate never blocks planning; report degraded observation and continue.
