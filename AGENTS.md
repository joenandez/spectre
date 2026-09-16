# AGENTS.md

Guidance for coding agents working in this repository.

## Source Of Truth

- `plugins/spectre/` is the canonical plugin source.
- `plugins/spectre-codex/` is generated Codex output. Do not hand-edit it.
- After changing canonical skills, agents, hooks, or plugin assets that ship to Codex, run:
  ```bash
  npm run sync-codex -- --quiet
  npm run sync-codex -- --check --quiet
  ```
- If generated output is wrong, fix the canonical source or the translator under `scripts/`; do not patch `plugins/spectre-codex/` directly.

## Change Workflow

1. Check `git status --short --branch` before editing.
2. Identify the change type:
   - workflow skill: edit `plugins/spectre/skills/<skill>/SKILL.md`
   - subagent: edit `plugins/spectre/agents/*.md`
   - learning/runtime helper: edit `plugins/spectre/hooks/scripts/*`
   - Codex install/update behavior: edit `src/` and load the project skill `feature-codex-spectre-implementation` first
   - translator behavior: edit `scripts/translators/*` and `scripts/sync-codex.cjs`
3. Make changes only in the canonical source tree unless the target is installer or translator code.
4. Run `npm run sync-codex -- --quiet`.
5. Run `npm run sync-codex -- --check --quiet`.
6. Run the smallest relevant test command; use `npm test` when translators, installer behavior, or shared runtime helpers changed.
7. Review the diff. Generated `plugins/spectre-codex/` changes are expected after sync; manual edits there are not.

## Skill Editing Rules

- Keep skills in compact contract form: Purpose, Inputs, Working Set, Outputs + DONE, Method/guardrails, Handoff, Escalate-If.
- Prefer prompts that call focused prompts over duplicating another skill's body.
- Keep dynamic data late-bound: branch names, diffs, file lists, and task paths should be read at runtime, not baked into skill text.
- Preserve load-bearing gates explicitly: scope boundaries, destructive-operation guards, verification postconditions, DONE criteria, and no-suppression rules.
- For skill rewrites or compression, use the `spectre-rewrite-skill` guidance as the quality bar before editing.

## Generated Codex Details

The sync translator rewrites Claude-style references for Codex:

- `/spectre:spectre-foo` -> `$spectre:spectre-foo`
- `@skill-spectre:spectre-foo` -> `Skill(spectre-foo)`
- `@spectre:tester` -> `@tester`
- `.claude/skills/` paths -> `.agents/skills/`

Do not try to maintain those differences manually.
