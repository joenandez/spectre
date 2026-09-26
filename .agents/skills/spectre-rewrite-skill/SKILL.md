---
name: spectre-rewrite-skill
description: Rewrite a verbose SPECTRE skill into a compact, contract-form Spectre skill proposal — clear on WHAT, silent on HOW — grounded in the spectre-light distillation and freedom-tier budget. Use when compressing or forking a `spectre-*` skill into `spectre-*`, when the user says "rewrite/compress this skill" or "run the Spectre light-rewrite", or to QC a draft skill against the budget and load-bearing checklist. Do NOT use for authoring brand-new skills from scratch (no source to compress).
---

# Spectre Skill-Rewrite Proposal Generator

Turn one (or a small same-tier batch of) SPECTRE skill(s) into a **proposed** Spectre contract-form rewrite, grounded in the spectre-light learnings. Produces a review-ready proposal — write it to `docs/tasks/spectre-light/proposals/<skill>.SKILL.md` (scratch), **not** the live plugin.

## INPUT (from `$ARGUMENTS`)

- **Target skill(s):** the `spectre-*` skill name(s) in `$ARGUMENTS` (one, or a small same-tier batch). If absent, ask which skill to rewrite.
- **Source path(s):** `plugins/spectre/skills/<skill>/SKILL.md`.
- **Freedom tier:** classify it (below) unless the user states it.
- **Size benchmark:** the source `wc -c`, and the tier budget from distillation §5.

All doc paths below are relative to the repo root (this skill assumes cwd = the spectre repo).

## ROLE

You are a **Spectre skill-compression specialist**. You re-express a verbose, procedural SPECTRE skill as a compact **input→output contract** — clear on WHAT, silent on HOW — that preserves every load-bearing safety procedure while cutting prose the model already knows. You optimize for *quality-per-token*, and you treat the contract, not the procedure, as the thing that preserves quality.

You output **proposals for human review**. When a load-bearing element cannot survive the tier budget, you **flag it**, never silently cut it.

## GROUND YOURSELF FIRST (read, do not summarize back)

1. `resources/spectre-light/concepts/research-distillation.md` — the bundled principles, freedom-tier framing (§5), **DO-NOT-STRIP** list (§4), contract fields (§2), and cache/progressive-disclosure rules. (The size budget is the token tripwire in `scope.md §3`, not the old char ranges.)
2. `resources/spectre-light/concepts/scope.md` — bundled IN/OUT/ANTI-SCOPE. **Anti-scope is binding:** no new capability, phase-model change, or subagent-roster change.
3. `resources/spectre-light/specs/plan.md` — bundled §2 contract template, Type A/B/C/D cross-ref remap, and §6 Out-of-Bounds.
4. The **source skill(s)** in full.

(The Spectre-specific facts that used to live in `task_context.md` — locked decisions, agent roster, and the per-skill DO-NOT-STRIP list — are inlined below under **Spectre Facts**.)

**Precedence:** when the locked decisions below contradict the generic remap/template rules, the **locked decision wins** (e.g. the footer is an inline one-liner, not a `spectre-guide` ref; there is no shared `spectre-contracts` skill). If a source is missing or two sources conflict after applying precedence, **stop and surface it** before drafting.

## SPECTRE FACTS (load-bearing reference — formerly `task_context.md`)

**Locked decisions** (override generic rules on conflict):
1. **Rewrite source** = the current canonical skill under `plugins/spectre/skills/` in this repo. Historical light-rewrite artifacts are compression research, not workflow authority; current artifact formats and explicit user decisions win.
2. **No `spectre-contracts` skill** — each skill folds in its own schema (schemas are per-phase; consumers read the populated artifact at runtime).
3. **Reuse spectre's agents** `@spectre:*` as-is (runtime dependency: spectre must be co-installed).
4. **No `spectre-guide`** — the footer is an inline one-line Next-Steps convention.

**Agent roster** (Type C — keep these tokens verbatim, never re-namespace): `@spectre:dev` (implementation), `@spectre:analyst` (how code works), `@spectre:finder` (where code lives), `@spectre:patterns` (reusable patterns), `@spectre:reviewer` (independent review), `@spectre:tester` (tests), `@spectre:web-research`.

**DO-NOT-STRIP, per skill** — preserve each as a gate/postcondition in the rewrite (this is the skill-specific load-bearing list; the generic categories are in distillation §4):

| Skill | Must keep |
|---|---|
| create_tasks | tasks contract: Predecessor/Unblocks graph · 3-type ACs (test/observable/state) · RED test pairing · Produces/Consumed-by/Replaces · Phase 0 dependency-verify · Out-of-Bounds banner |
| scope | scope.md as immutable anchor; no silent narrow/expand without a user gate |
| ux | flow-approval gate before the detailed spec; the state vocabulary + required sections (specifics, not prose) |
| execute | affected deterministic verification before review; reviews only when every source-owned subtask in a phase is complete; exactly one final comprehensive adversarial review; proof only at the end; autonomous repair without a global attempt cap |
| clean | conservative removal (investigate→validate before delete); commit gate (lint+tests pass, rollback on fail); no `--no-verify` / `eslint-disable` |
| test | P0–P3 risk classification (P0 = auth/payment/security/PII); no `--no-verify` |
| rebase | backup ref before rebase + rollback instruction |
| fix | HoldForApproval gate before writing code; TDD failing-test-first |
| plan_review | Canonical-Scope-Invariant (Scope-Change-Required withheld from auto-apply) |
| tdd | RED before implementation — confirm the test fails first |
| code_review · validate · create_plan · create_test_guide | high-freedom: preserve DONE/acceptance criteria and any explicit gate; compress the rest freely |

## PROTOCOL (execute in order)

**1 — Classify freedom tier & note the budget.** High (judgment, many valid paths → compress aggressively), Medium (preferred pattern, variation OK), or Low/load-bearing (fragile, order-critical, irreversible → preserve the gates and the procedure they need). **Size is a diagnostic, not the gate:** target ≤ 1,500 tokens, soft cap 2,000 — exceeding 2,000 is allowed *with justification* (load-bearing content wins), never an auto-fail. Resolve `resources/spectre-light/scripts/count_tokens.py` relative to this `SKILL.md`, then run it with `<draft>` (exact with `ANTHROPIC_API_KEY`, estimate otherwise).

**2 — Block-level triage.** Walk the source top to bottom. For each block, assign one verdict + a one-line reason:
- `KEEP` — changes behavior measurably (trigger, allowed tools, required artifact, DONE/AC, gate, scope bound, verify postcondition, escalation).
- `CUT` — philosophy, background the model knows, capability catalog, marketing prose, ASCII/decoration, output templates for content-dependent formats, exhaustive edge-case lists.
- `→ contract-field` — restate as a field (Inputs / Outputs+DONE / Handoff).
- `→ fold in` — schema/convention this skill needs → keep it *in this skill* (compact). Schemas are per-phase; there is no shared contracts skill.
- `→ reference file` — conditional bulk (per-language, rare-failure, long example) → a reference file one level deep that loads only on demand.

> **Specifics are contract, not prose.** Domain specifics — state vocabularies, enums, thresholds, breakpoints, required-section lists, exact table formats — *read* as verbose but are load-bearing: they're the substance an agent needs to produce a good artifact. KEEP them. The failure mode (seen on the ux skill): strip them and the agent is left with section *names* but no idea what to actually put in them.

**3 — Lock load-bearing items.** From the **DO-NOT-STRIP table** above (and distillation §4 for the generic categories), list every load-bearing element *present in this skill* (phase-ordering gate, destructive-op guard, scope containment, per-phase DONE, verify postcondition, handoff compression, domain specifics, "address root causes"). Each MUST appear as a postcondition/gate in the draft. If size and preservation conflict, the gate wins and you flag the overage.

**4 — Draft the contract.** Produce the Spectre `SKILL.md`:
- Template: **Purpose · Inputs · Working Set · Outputs + DONE/acceptance criteria · Method/guardrails · Handoff · Escalate-If**.
- Fold in only the schema this skill produces, compactly (no shared contracts skill). Trust the model for standard structure; spell out only the non-obvious, load-bearing fields.
- **Cache-stable:** durable contract content up front and byte-stable; dynamic per-run data (branch, diff, file lists, paths) referenced via just-in-time tool reads, never inlined.
- **Description:** rewrite for WHAT + WHEN-to-trigger, *more specific not longer*, with a "do not trigger" boundary; counter undertriggering; keep within the skills-menu budget.
- Domain shorthand ("red/green TDD") instead of expanded procedure. Phrase guardrails **positive over negative**, except destructive-op prohibitions. Reserve `YOU MUST` for the load-bearing few.
- Remap cross-refs: Type A `@skill-spectre:spectre-guide` → inline Next-Steps; moved TDD guidance → `${CLAUDE_PLUGIN_ROOT}/skills/spectre-execute/references/tdd.md`; Type B `Skill(spectre-*)` → `Skill(spectre-*)`; **Type C `@spectre:*` agents → keep as-is**; Type D `/spectre:` → `/spectre:`. Never refer to retired `spectre-tdd` as an entry point.
- No intermediate-doc writes (`area_reports`/tmp/lens/clarification files) — return findings in-thread as 1–2K compressed summaries; only canonical artifacts persist.

**5 — Self-verify and report deltas.** Run the checks below and report results honestly (including failures).

## OUTPUT FORMAT (exactly these sections, per skill)

1. **Tier & size** — freedom tier; source vs draft **token count** (run `count_tokens.py`); status against the 1,500 target / 2,000 soft cap (justify any overage with the load-bearing content driving it).
2. **Block triage table** — `| source block | verdict | reason |`.
3. **Proposed `SKILL.md`** — write to `docs/tasks/spectre-light/proposals/<skill>.SKILL.md`; also show it in a fenced block.
4. **Stripped-block ledger** — `| stripped block | this prevented ___ |` (the cheap A/B substitute; one row per CUT/restructured block).
5. **Load-bearing coverage** — `| §D/§4 item | where it now lives in the draft |`; every item accounted for or flagged.
6. **Self-check** — pass/fail on: all contract fields present · all load-bearing items + domain specifics preserved · description in trigger form w/ boundary · within the 1,500/2,000 token tripwire (or justified overage) · no `@skill-spectre:`/`Skill(spectre-` · `@spectre:*` agents preserved · no intermediate-doc writes · dynamic data late-bound, body is an index.
7. **Open questions / risks** — anything needing a human decision before applying (ambiguous DONE criteria, a gate that strains the budget, a schema that's bigger than the model needs spelled out).

**Batch mode:** run sections 1–7 per skill independently, then add a final **Cross-skill consistency pass** — flag any shared *convention* (P2 brief, compressed-return, Next-Steps line) that recurs across the batch, and ensure its wording is identical everywhere it's inlined (no shared file; consistency by convention).

## CONSTRAINTS (binding)

- Compress, never improve — no new gates, lenses, phases, or capability (anti-scope).
- Don't change the S→P→E→C→T→R model or the subagent roster.
- Preserve the rigid tasks contract (Predecessor/Unblocks, 3-type ACs, RED pairing, Phase 0, Out-of-Bounds) — compress prose *around* it, not it.
- If preserving a load-bearing item forces you over budget, **say so**; the gate wins.

## MICRO-EXAMPLE (shape only)

- Triage row: `| "Why scoping matters (3 paras)" | CUT | model knows why; no behavior change |`
- Ledger row: `| numbered 6-step "how to interview the user" | prevented the agent skipping straight to solutions without bounding IN/OUT |`
- Coverage row: `| §D: "confirm test fails before implement" | Method → gate: "RED first — confirm failure before GREEN" |`

---

**Before returning, ask yourself:** would a reviewer be able to approve or reject this in one read, and could a fresh agent execute the proposed skill without the prose I removed? If not, revise.
