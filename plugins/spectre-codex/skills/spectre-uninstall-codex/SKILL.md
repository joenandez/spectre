---
name: "spectre-uninstall-codex"
description: "Codex-only Spectre uninstall workflow. Use when the user wants to uninstall the native spectre@spectre Codex plugin; cleans expired workflow data and removes managed Spectre custom agents before native plugin removal while preserving marketplace registration and project knowledge."
user-invocable: true
---

# uninstall-codex

Clean expired local workflow data, remove only Spectre-managed Codex custom agents, then remove the native plugin. Preserve marketplace registration, project knowledge, handoffs, and unrelated Codex config. Unexpired workflow history is retained unless the user explicitly requests its purge.

## Method
1. From the current project, run and retain the JSON result:
   ```bash
   node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" cleanup --project-dir "$PWD" --json
   ```
   Report `remainingBytes`. If the user explicitly requested removal of local workflow history too, run this before uninstalling:
   ```bash
   node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" purge --project-dir "$PWD" --yes --json
   ```
2. Run:
   ```bash
   node "${PLUGIN_ROOT}/hooks/scripts/ensure-codex-agents.mjs" --remove --json
   ```
3. If the helper reports `collisions`, stop and report the paths. Do not delete unowned files.
4. Run:
   ```bash
   codex plugin remove spectre@spectre
   ```

## DONE
Expired workflow data was cleaned, retained bytes were reported (or explicit purge completed), managed `spectre_*.toml` agents were removed or confirmed absent, the native plugin removal command completed, and no project knowledge/session data was deleted.
