---
name: "spectre-validate"
description: "Validate that completed implementation actually delivers the scope/tasks requirements — chunks the work into areas, dispatches parallel @spectre:analyst validators that trace each requirement from user action to render, and writes one actionable validation_gaps.md ranking what's Delivered / Partial / Dead Code / Missing. Trigger after execute (or any build) when you need to confirm requirements are met before clean/test/ship. Do NOT trigger to fix the gaps (spectre-fix), to run the test suite (spectre-test), or to remove dead code (spectre-prune)."
user-invocable: true
---

# validate

Post-implementation requirement validation. Verify the built work against scope docs and `tasks.json` slices, dispatch parallel validators per area, and produce one actionable gap-remediation document. **Validation only — never fix.**

## Core principle (load-bearing)

> **Definition ≠ Connection ≠ Reachability.** A requirement is only delivered if all three hold:
> 1. **Defined** — code exists in a file.
> 2. **Connected** — it is imported/called by other code.
> 3. **Reachable** — a user action can trigger the code path.

Level 1 without 2/3 is **dead code that happens to match the description** — not complete. Always trace past "X exists" → "X is called by Z at file:line" → "Z fires when the user does W."

## Inputs

- `$ARGUMENTS` — explicit feature name/root or descendant artifact, scope docs, an explicit arbitrary plan as a requirement source, and/or `tasks.json` to validate against (paths, or "use thread context"), plus optional `execution_state.md` focus evidence, an immutable `BASE_SHA`/`HEAD_SHA`/`DIFF_SHA256` candidate tuple, and `--orchestrated` when a parent workflow owns remediation and the next step. Requirement context is **REQUIRED**. If absent, ask for a scope or plan path, the task detail JSON path, or "use thread context" — then wait.
- Treat the plan as authoritative when passed. Otherwise use task acceptance slices, scope docs, then usable thread context. Read the authoritative source in full. For `tasks.json`, extract validation slices from `phases[]` (parent title/description plus child acceptance criteria/context); do not use `execute.md` as the validation source except to locate the JSON path.

## Working Set (late-bound — read at run-time, never inline)

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Repair stale feature/root metadata in artifacts this workflow touches.
- `VALIDATION_REPORT = {FEATURE_ROOT}/validation/validation_gaps.md`; create its parent directory.
- Read the actual code, diff, and explicitly supplied requirement artifacts just-in-time.

## Method / guardrails

- **Chunk into 3–8 validation areas:** one per parent task in `tasks.json`; derive areas from plan outcomes/workstreams when tasks are absent; else use one per "In Scope" item in scope.md, then one per discussed feature. Merge small, split large.
- **Execution state is derivative:** `execution_state.md` is evidence/focus only for cross-wave wiring, scope-creep, and dead-computation checks; it is never requirements or acceptance authority.
- **Dispatch one `@spectre:analyst` per area, ALL in parallel in a single message.** Brief each with: the area, its source requirement (exact text), expected deliverables, branch, and the status enum + evidence + reachability rules below. Subagents return compressed findings in-thread — no per-area files.
- **Status enum (each requirement):** ✅ **Delivered** (defined AND connected AND reachable) · ⚠️ **Partial** (exists, broken/missing connection) · 🔌 **Dead Code** (exists, zero usage sites) · ❌ **Missing** (does not exist).
- **Evidence rule (YOU MUST):** every requirement cites **both** a definition site (`file:line`) and a usage site (`file:line`). Definition only, no usage → status is ⚠️ or 🔌, never ✅.
- **Delivered evidence stays strict:** every Delivered result still needs definition plus usage/reachability evidence.
- **Reachability + render-backward trace:** for UI features, trace from the final render *backward* — JSX ← variable ← source (hook/prop/computed) ← user action. A broken link anywhere = ⚠️. Grep for *usage* not just definition (`fnName(`, `<Component`, `useHook(`, `prop={`).
- **Dead-computation + old-path audit:** flag any computed value that never reaches a render (🔌), and any old code path still active after new code replaced it (⚠️, new path bypassed / duplicate data source).
- **Note scope creep** — anything built beyond the requirements.
- **Final wiring check before any ✅:** consumer connected? render chain unbroken? old path removed? no orphaned computation? single data source? Any failure downgrades ✅ → ⚠️ and adds a gap task.
- **No fixes.** Report and hand back.
- **Candidate pin.** When any candidate field is supplied, require all three; recompute the canonical hash using `git diff --binary --full-index --no-ext-diff --no-color --no-renames` before dispatch and after report creation. Record the unchanged tuple in the report; otherwise return a stale-candidate result.

## Outputs + DONE

Write `VALIDATION_REPORT`. Required sections:

`VALIDATION_REPORT` begins with its title followed immediately by the Feature/Feature Root metadata below.

0. **Self-location metadata** — immediately below the title: `Feature: <feature-name>` and `Feature Root: .spectre/features/<feature-name>`.
1. **Summary** — overall status (Complete | Needs Work | Significant Gaps) · {X of Y} delivered · gap count · scope-creep count · supplied candidate tuple.
2. **Gap Remediation Tasks** — phased by priority (Critical / Medium / Low). Each gap: requirement · current state · gap; each action carries **Produces / Consumed by / Replaces** and verifiable check-box outcomes.
3. **Scope Creep Review** — items beyond scope (Keep+document / Remove / Discuss) with evidence.
4. **Validation Coverage** table — Area · Status · Definition · Usage · Render Chain.
5. **Dead Computations Found** table — Variable · File · Computed By · Should Be Consumed By.
6. **Old Code Paths Still Active** table — Old Path · Location · Replaced By · Impact.

**DONE when:** validation_gaps.md exists with all six numbered sections plus self-location metadata; every area has a status from the enum with definition+usage evidence; any supplied candidate tuple is recorded and unchanged; gaps are actionable (Produces/Consumed-by/Replaces); scope creep noted; no code was modified.

## Handoff

Return status/delivered/gap/scope-creep/findings/report; `--orchestrated`: summary/gaps only.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone `Needs Work`/`Significant Gaps` → `/spectre:spectre-fix` then revalidate; Standalone `Complete` → `/spectre:spectre-prove`. Boundary ambiguity → Scope; flow/state/copy ambiguity → UX; pause → Handoff; Test/Clean only when proof is deferred.

## Escalate-If

- No scope/tasks docs and no usable thread context → ask before dispatching.
- A gap implies a scope/requirements change rather than a wiring defect → surface to the user; do not silently re-scope.
