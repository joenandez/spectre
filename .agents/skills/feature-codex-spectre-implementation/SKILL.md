---
name: feature-codex-spectre-implementation
description: Use when modifying the Codex SPECTRE install flow, SessionStart continuity, project skill syncing, registry injection, or Codex-specific runtime files. TRIGGER when: codex, spectre, codex install, sessionstart, agents.override, registry, spectre-learn, spectre-recall, hooks.json, config.toml, doctor
user-invocable: false
---

# Codex SPECTRE Implementation

**Trigger**: codex, spectre, codex install, sessionstart, agents.override, registry, spectre-learn, spectre-recall, hooks.json, config.toml, doctor
**Confidence**: high
**Created**: 2026-03-30
**Updated**: 2026-07-19
**Version**: 5

## Current Design

Codex SPECTRE installs the workflow as Codex-native skills, subagent TOML configs, and generated SessionStart hooks. Project knowledge and session continuity are written into managed `AGENTS.override.md` blocks so hook output stays short.

Reusable project knowledge is both configured as normal skills and injected as a compact trigger registry:

- `spectre-learn` writes project skills under `.agents/skills/{category}-{slug}/SKILL.md`.
- The recall registry lives at `.agents/skills/spectre-recall/references/registry.toon`.
- `spectre-recall` is generated as an explicit search/load skill.
- Project installs sync `.agents/skills/*/SKILL.md` into Codex `[[skills.config]]`.
- `spectre-apply` contains a `{{REGISTRY}}` placeholder that both the hook and `src/lib/knowledge.js` substitute before writing the managed knowledge block.
- `bootstrap` → `handoff-resume` → `load-knowledge` is the required SessionStart order.

Workflow task execution now uses a two-artifact contract:

- `spectre-create_tasks` writes `{OUT_DIR}/specs/execute.md` plus `{OUT_DIR}/specs/tasks.json`.
- `execute.md` is the compact primary-agent index (document manifest, task detail source, execution summary, wave plan, parent-task index, slicing rules).
- `tasks.json` is the full mutable detail/status source (`meta` + `phases[]`); primary execution/review/validation consumers should slice it by parent task id instead of reading the whole file.
- Do not reintroduce the old `specs/tasks.md` task-list flow or a Markdown fallback/converter.

Review gates use one cross-runtime contract:

- `spectre-plan_review` prefers the opposing CLI with an explicit high-effort model: Codex launches Claude Code with `--model claude-opus-5-5 --effort high`; Claude Code launches Codex with `-m gpt-6-sol -c 'model_reasoning_effort="high"'`. The launcher allows each attempt up to 20 minutes, but passes no duration guidance to the reviewer.
- `spectre-task_review` uses a focused medium-effort opposing-runtime contract: Codex launches Claude Code using `--model claude-opus-5-5 --effort medium`; Claude Code launches Codex using `-m gpt-6-sol -c 'model_reasoning_effort="medium"'`. The primary agent runs consumer-safety preflight, explicitly launches and monitors the reviewer for up to 20 minutes, validates the report, allows one repair, owns native fallback and write-back, and passes no duration guidance to the reviewer.
- `spectre-code_review` uses a high-effort opposing-runtime contract: Codex launches Claude Code using `--model claude-opus-5-5 --effort high`; Claude Code launches Codex using `-m gpt-6-sol -c 'model_reasoning_effort="high"'`.
- If the opposing runtime is unavailable or fails validation after one repair attempt, the gate dispatches one native reviewer with the same manifest, adversarial lenses, severity/evidence rules, exclusions, and report schema. This fallback does not block completion and must record its reason plus runtime/model metadata.
- `spectre-code_review` is an adversarial, evidence-gated review for correctness, regressions/integration, security, performance/reliability, overengineering, and test adequacy. It does not use subjective numeric scores.
- `spectre-execute` delegates its final cumulative review to `spectre-code_review --orchestrated`; do not reintroduce a separate final-review prompt inside execute.
- Canonical workflow skills live under `plugins/spectre/skills/`; regenerate `plugins/spectre-codex/` and keep regression assertions in `scripts/test_sync-codex.cjs` aligned with these invariants.

## Install Flow

1. `src/main.js` parses `install codex`, resolves scope, and switches `CODEX_HOME` to `./.codex` for project installs.
2. `installCodex()` in `src/lib/install.js` copies generated Codex assets from `plugins/spectre-codex/`:
   - workflow skills into `CODEX_HOME/skills/`
   - agent TOML configs into `CODEX_HOME/spectre/agents/`
   - generated hooks into `CODEX_HOME/spectre/hooks/`
   - runtime helper scripts into `CODEX_HOME/spectre/tools/`
3. `installCodex()` removes the fork-era sibling runtime and agent tables before writing current `[agents.spectre_*]` definitions.
4. `ensureSpectreHooksConfigured()` enables `features.hooks`, `features.skills`, and `features.multi_agent`, then materializes generated SessionStart commands into `CODEX_HOME/hooks.json` without clobbering unrelated handlers.
5. For project installs, `installProjectFiles()` creates `.spectre/manifest.json`, initializes recall files, clears stale managed blocks, and calls `syncProjectSkillsConfigured()`.
6. On SessionStart, the hooks refresh session and knowledge blocks only when the workspace has the relevant Spectre surface.

## Key Files

- `plugins/spectre/skills/`
  Canonical Claude/Codex-compatible workflow skill sources.
- `plugins/spectre-codex/`
  Generated Codex bundle. Regenerate with `npm run sync-codex -- --quiet`.
- `src/lib/install.js`
  Main installer/uninstaller.
- `src/lib/config.js`
  Owns `config.toml`, `hooks.json`, agent tables, and project skill sync.
- `src/lib/project.js`
  Owns `.spectre/manifest.json`, handoff lookup, managed override blocks, and legacy cleanup.
- `src/lib/knowledge.js`
  Owns recall generation and Codex-side `{{REGISTRY}}` substitution.
- `src/lib/doctor.js`
  Verifies installed runtime/config state and reports stale hook remnants.

## Common Tasks

### Add or change a workflow skill

1. Edit `plugins/spectre/skills/spectre-*/SKILL.md`.
2. Run:
   ```bash
   npm run sync-codex -- --quiet
   npm run sync-codex -- --check --quiet
   ```
3. Run focused tests when installer or translator behavior changed:
   ```bash
   node --test src/install.test.js src/config.test.js scripts/test_sync-codex.cjs
   ```
4. If changing `spectre-create_tasks` task artifacts, also validate both task fixtures parse:
   ```bash
   node -e "JSON.parse(require('fs').readFileSync('plugins/spectre/skills/spectre-create_tasks/references/tasks.example.json','utf8'))"
   ```

### Add a learned project skill and make sure Codex sees it

1. Write the skill under `.agents/skills/{category}-{slug}/SKILL.md`.
2. Register it in `.agents/skills/spectre-recall/references/registry.toon`.
3. Regenerate `.agents/skills/spectre-recall/SKILL.md`.
4. Refresh project install state:
   ```bash
   npx @codename_inc/spectre update codex --scope project --project-dir "$PWD"
   ```

### Debug why a project skill is not being used

Check, in order:

1. The skill exists at `.agents/skills/{name}/SKILL.md`.
2. Its frontmatter description contains concrete trigger language.
3. `config.toml` contains a `[[skills.config]]` entry for the skill path.
4. If explicit search is needed, the registry entry exists in `.agents/skills/spectre-recall/references/registry.toon`.
5. `hooks.json` contains SessionStart commands for `bootstrap.mjs`, `handoff-resume.mjs`, and `load-knowledge.mjs`.
6. `AGENTS.override.md` contains an inlined registry and no raw `{{REGISTRY}}`.
7. Run:
   ```bash
   npx @codename_inc/spectre doctor codex --scope project
   ```

## Expected Install Artifacts

After `npx @codename_inc/spectre install codex --scope project`, expect files like:

```text
.codex/config.toml
.codex/hooks.json
.codex/skills/spectre-apply/SKILL.md
.codex/skills/spectre-scope/SKILL.md
.codex/spectre/hooks/hooks.json
.codex/spectre/hooks/scripts/bootstrap.mjs
.codex/spectre/hooks/scripts/handoff-resume.mjs
.codex/spectre/hooks/scripts/load-knowledge.mjs
.codex/spectre/hooks/scripts/register_learning.mjs
.codex/spectre/agents/dev.toml
.spectre/manifest.json
.agents/skills/spectre-recall/SKILL.md
.agents/skills/spectre-recall/references/registry.toon
```

Do not reintroduce:

- `spectre-guide`
- `spectre-evaluate`
- `spectre-architecture_review`
- fork-name CLI aliases or duplicate runtime trees
- raw `{{REGISTRY}}` in generated or installed context
- startup payloads in `additionalContext`; use managed `AGENTS.override.md` blocks
