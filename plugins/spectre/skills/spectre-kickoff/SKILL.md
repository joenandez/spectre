---
name: "spectre-kickoff"
description: "Project kickoff — deep codebase + external research producing an evidence-backed kickoff doc, gap analysis, and MVP path before scoping. Use to start a fresh feature/project from an unclear problem, when the user wants research/options/an MVP recommendation before committing to scope or a plan. Do not trigger once scope is already defined (use /spectre:spectre-scope) or for a single targeted code question (use an analyst agent directly)."
user-invocable: true
disable-model-invocation: true
---

# kickoff

Deep research entry point: investigate the codebase and external best practices, then hand off a written kickoff doc with a gap analysis and MVP path. Clear on WHAT to produce; the research method is yours.

## Inputs
- `$ARGUMENTS` — the project/feature context (the current command arguments). If empty, ask the user for it before any tools.
- Optional explicit managed feature name/root or an artifact beneath one.
- Any docs the user references — read them FULLY in main context (not via subagent): vision, constraints, decisions, open questions.

## Working set (late-bound — read at runtime, never inline)
- Codebase, via read-only research agents (see Method).
- `FEATURE_ROOT = .spectre/features/<feature-name>/`, resolved from the input or proposed below; current git commit/branch for metadata + permalinks.

## Feature root contract

- Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.

## Method / guardrails
1. **Acknowledge first.** Open with a reply naming what we're exploring, the proposed feature name/root, the decision we're heading toward, and what success looks like. No tool calls in this first turn.
2. **Decompose** the project into research areas (components, dirs/files, patterns, data flows, code to extend); track them with TodoWrite.
3. **Research in parallel**, read-only — locator → analyzer-on-findings → breadth. Spawn follow-ups if a thread is shallow. Use Context7 MCP for central 3rd-party libs.

   | Agent | Task | Required output |
   |---|---|---|
   | `@spectre:finder` | relevant files, entry points, handlers, models | file paths by domain |
   | `@spectre:analyst` | data flow, dependencies, behavior, edge cases | file:line for ALL findings |
   | `@spectre:patterns` | similar impls, patterns to follow/avoid | code examples w/ file:line |
   | `@spectre:web-research` | best practices, prior art, pitfalls | findings WITH links |

   Demand file:line evidence (codebase) and links (external). Returns come back as compressed in-thread summaries — no intermediate report files.
4. **Wait for all agents** before synthesizing; update TodoWrite as each lands.
5. **Synthesize → gap → MVP → options.** Connect findings across components with file:line throughout; gap analysis = current capabilities (file refs) vs required, split missing-vs-modify; MVP = core value + minimum slice + what to defer; give 2–3 options each with summary, key decisions, code to leverage (refs), new work, effort, trade-offs; surface decision points and open questions.

## Outputs + DONE
Write the kickoff doc to `{FEATURE_ROOT}/kickoff/{feature-name}_kickoff.md` (`mkdir -p` first; timestamp-suffix if the file exists). The kickoff doc begins below its title with `Feature: <feature-name>` and `Feature Root: .spectre/features/<feature-name>`. **Save it before presenting** the summary.

- YAML frontmatter: date, git_commit, branch, repo, topic, tags, status.
- Required sections, in order: Title · Metadata · Project Context · Research Summary · Detailed Codebase Findings (by area, file:line, snippets) · Code References (table) · Architecture Insights (patterns, conventions, constraints) · External Research (with links) · Gap Analysis · MVP Suggestion · Implementation Options (2–3, with trade-offs) · Decision Points · Open Questions · Related Resources.
- If on `main`/pushed, convert file refs to GitHub permalinks: `https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}`.

**DONE when:** doc saved with every required section populated, all findings carry file:line (or external links), gap analysis and an MVP path are stated, and the saved summary + scoping questions have been presented to the user.

## Handoff
| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Present vision/refs/architecture/learnings/gap/MVP + 1–3 questions; wait/research/fold clarifications into doc. Resolved: Scope resolved kickoff document path + `FROM_KICKOFF=true` + `SKIP_EXPLORATION=true`; authorized skip → Plan context.

## Escalate-If
- No project context supplied and none inferable → ask the user before researching.
- Research stays shallow / no file:line evidence after follow-ups → say so and present partial findings rather than fabricating depth.
- Scoping ambiguities can't be resolved by research → surface them as Open Questions; do not proceed to planning.
