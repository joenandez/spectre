#!/usr/bin/env node

/**
 * bootstrap.mjs
 *
 * SessionStart hook that removes stale files from older plugin versions.
 *
 * When users update the plugin via marketplace, old files that were deleted
 * from the repo may still linger in their cached copy. This script runs on
 * every session start and cleans them up.
 *
 * To add new files to the cleanup list, append to STALE_PATHS below.
 * Paths are relative to CLAUDE_PLUGIN_ROOT.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinWithTimeout } from './lib.mjs';
import { cleanupAllWorkflowStores } from './workflow/retention.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ──────────────────────────────────────────────────────────────────
// Stale paths to remove (relative to CLAUDE_PLUGIN_ROOT)
// ──────────────────────────────────────────────────────────────────

const STALE_PATHS = [
  // Python scripts replaced by JS hook equivalents (v3.x migration)
  'hooks/scripts/capture-todos.py',
  'hooks/scripts/handoff-resume.py',
  'hooks/scripts/load-knowledge.py',
  'hooks/scripts/precompact-warning.py',
  'hooks/scripts/precompact-warning.mjs',
  'hooks/scripts/register_learning.py',
  'hooks/scripts/test_handoff_resume.py',
  'hooks/scripts/test_load_knowledge.py',

  // Retired prompt-time knowledge transport
  'hooks/scripts/user-prompt-submit.mjs',
  'hooks/scripts/knowledge/matcher.mjs',

  // Retired skill directories
  'skills/spectre-recall',
  'skills/spectre-find',
  'skills/spectre-next-steps',
  'skills/spectre-guide',
  'skills/spectre-evaluate',
  'skills/spectre-architecture_review',
];

// ──────────────────────────────────────────────────────────────────
// Cleanup logic
// ──────────────────────────────────────────────────────────────────

function cleanupStalePaths(pluginRoot) {
  let removed = 0;

  for (const relPath of STALE_PATHS) {
    const fullPath = path.join(pluginRoot, relPath);

    try {
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed++;
      } else {
        fs.unlinkSync(fullPath);
        removed++;
      }
    } catch (_) {
      // File doesn't exist or can't be removed — skip silently
    }
  }

  return removed;
}

function ensureCodexAgents(pluginRoot) {
  if (!process.env.PLUGIN_ROOT) {
    return null;
  }
  const scriptPath = path.join(
    pluginRoot,
    'hooks',
    'scripts',
    'ensure-codex-agents.mjs',
  );
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      message: `missing managed-agent setup helper: ${scriptPath}`,
    };
  }
  const result = spawnSync(process.execPath, [scriptPath, '--ensure', '--json'], {
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    return {
      ok: false,
      message: (result.stderr || result.stdout || 'managed-agent setup failed').trim(),
    };
  }
  try {
    const payload = JSON.parse(result.stdout);
    return {
      ok: true,
      changed:
        (payload.installed?.length || 0) +
        (payload.updated?.length || 0) +
        (payload.removed?.length || 0) +
        (payload.cleaned?.length || 0),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildBootstrapOutput({ removed, agentSetup, workflowCleanup }) {
  if ((agentSetup && !agentSetup.ok) || !workflowCleanup.ok) {
    const failures = [];
    if (agentSetup && !agentSetup.ok) failures.push(`agent setup: ${agentSetup.message}`);
    if (!workflowCleanup.ok) failures.push(`workflow cleanup: ${workflowCleanup.error}`);
    return {
      systemMessage: `bootstrap: Spectre maintenance skipped: ${failures.join('; ')}`,
    };
  }
  if (removed > 0) {
    return {
      systemMessage: `bootstrap: cleaned ${removed} stale file${removed > 1 ? 's' : ''}`,
    };
  }
  return {};
}

// ──────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────

async function main() {
  // Drain stdin so the hook system doesn't hang
  await readStdinWithTimeout();

  const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');

  const removed = cleanupStalePaths(pluginRoot);
  const agentSetup = ensureCodexAgents(pluginRoot);
  const workflowCleanup = await cleanupAllWorkflowStores().catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  process.stdout.write(`${JSON.stringify(buildBootstrapOutput({
    removed,
    agentSetup,
    workflowCleanup,
  }))}\n`);

  process.exit(0);
}

export { buildBootstrapOutput, cleanupStalePaths, ensureCodexAgents, STALE_PATHS };

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename)) {
  main();
}
