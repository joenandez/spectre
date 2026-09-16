---
name: "spectre-prototype"
description: "Create one self-contained HTML prototype to resolve ambiguity, validate flows, or render UX before planning. Use for prototype/mockup/preview requests and UX Stage 1→2; not for production code, multi-file apps, scope, or planning."
user-invocable: true
disable-model-invocation: true
---

# prototype

## Purpose

Produce one HTML prototype at `{FEATURE_ROOT}/prototypes/{slug}_{MMDDYY}.html`. The primary owns it; agents provide evidence only.

## Inputs

- `$ARGUMENTS`: feature root/name or descendant, description, optional `--explore`; markers `FROM_UX=true`, `FROM_KICKOFF=true`.
- Read existing `concepts/scope.md`, `specs/prd.md`, `ux.md`, then legacy `specs/ux.md` fully before questions.
- Silently read repo-root `product.md` when present, plus `design.md` or fallback `design/design.md`; apply them; do not mention missing files.

| Mode | Signal | Fidelity | Contract |
|---|---|---|---|
| `post-ux` | complete `ux.md`: Screens, Layouts, Components, Interactions, States, Content | high | render faithfully; exact documented copy; no invented screens |
| `flows-only ux` | `FROM_UX=true` or flows without complete Stage 2 | mid | preserve approved flows; choose UI details |
| `explore` | `--explore` | low, grayscale/layout-only | visualize an unvalidated concept |
| `post-scope` | scope, no UX | mid | validate scope |
| `standalone` | no artifact | mid | establish what to prototype |

## Working Set

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `Skill(spectre-feature-root)` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.
- Repair stale feature/root metadata in artifacts this workflow touches.

## Outputs + DONE

The single HTML file contains:

- `<!DOCTYPE html>`, viewport metadata, inline CSS, and inline end-of-body JavaScript.
- A top-of-head comment beginning `Feature:` and `Feature Root:`, followed by Fidelity, Generated, Flow covered, Screens/states, Visual anchor, Source spec, Key assumptions, post-UX Filled assumptions, NOT included, and Next step.
- A design-token comment for Primary, Accent, Surface, Text, Font, Border-radius, Spacing, mirrored as `:root` custom properties.
- If multi-screen, vanilla-JS `display:block/none` navigation; one ordered `<section>` per screen, each with happy path plus an empty, error, or loading state.

DONE when mode/fidelity/anchor are explicit; available context and research preceded generation; the primary authored and validated the file; documented UX is faithful; content is realistic; components reuse named classes; interactions have no console errors; and states, reuse, and portability pass. Surface failures as caveats.

## Method / guardrails

1. Reply before tools, except `FROM_UX=true` may begin by reading `ux.md`; if no arguments or context, ask what to prototype.
2. Ask 2–4 focused questions. Confirm fidelity and a visual anchor (colors, fonts, URL, or named aesthetic); if skipped, declare one. **Gate: wait unless `FROM_UX=true`.**
3. After the gate, dispatch in parallel; each returns ≤2,000 tokens in-thread and writes no files:
   - `@spectre_web_research`: 2–3 current references, interaction convention, and concrete palette/type/layout values; <400 words with citations.
   - `@spectre_analyst`: post-UX extracts required sections and copy verbatim, marking spec-silent details as filled assumptions; otherwise synthesizes flow, screen states, realistic content, and components.
   - `@spectre_patterns`: only for an existing app; return actual tokens and interaction conventions.
4. After all findings return, the primary alone creates, edits, and validates the HTML; not even `@spectre_dev` modifies it.

Use inline SVG/data URIs/CSS shapes only: no remote images, relative assets, custom WOFF, filler, Inter/Roboto defaults, purple-on-white gradients, broken `href="#"`, happy-path-only screens, or inline restyling of recurring components. Use one Google family (≤2 weights) or system fonts. Tailwind CDN is mid/high-fi only.

## Handoff

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Return path/screens/fidelity/anchor/assumptions/NOT included; opens/shareable; revalidate edits/research; promote post-UX to `ux.md`. explore → Scope; flows-only UX → Stage 2; post-UX contradiction/assumption → UX, else Plan; post-scope unresolved UX → UX, post-scope validated scope → `$spectre:spectre-plan`; standalone no scope → Scope, else reclassify as `post-scope`. One route/conditional/pause.

## Escalate-If

- A post-UX contradiction exists: ask which is authoritative, update `ux.md` and HTML together, then revalidate.
- A required mode artifact is missing/unreadable, or neither the user nor context supplies a usable visual anchor/aesthetic.

Next step: follow the mode-specific handoff above.
