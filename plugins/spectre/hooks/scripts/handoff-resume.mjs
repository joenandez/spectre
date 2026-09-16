#!/usr/bin/env node

/**
 * handoff-resume.mjs
 *
 * SessionStart hook that injects context from the last /spectre:spectre-handoff.
 * Consolidates the previous session-resume-hook.sh + format-resume-context.py.
 *
 * Outputs JSON for Claude Code hook system:
 * - systemMessage: User-visible notice
 * - hookSpecificOutput.additionalContext: Full session context in <session-context> tags
 *
 * Background modes:
 * - --bg-copy-refs: Copy plugin references (fork #1)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinWithTimeout, getGitBranch } from './lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPluginRoot() {
  return process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
}

function parseHookInput(rawInput) {
  if (!rawInput) return {};

  try {
    const parsed = JSON.parse(rawInput);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function localDateKey(date) {
  const value = date || new Date();
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function canonicalProjectDir(projectDir) {
  try {
    return fs.realpathSync(projectDir);
  } catch (_) {
    return path.resolve(projectDir);
  }
}

function claimDailyBanner(projectDir, options) {
  options = options || {};

  const dateKey = localDateKey(options.now);
  const stateRoot = options.stateRoot ||
    path.join(
      process.env.SPECTRE_HOME || path.join(os.homedir(), '.spectre'),
      'state',
      'session-start-banner',
    );
  const cwdHash = crypto
    .createHash('sha256')
    .update(canonicalProjectDir(projectDir))
    .digest('hex');
  const markerDir = path.join(stateRoot, cwdHash);
  const markerPath = path.join(markerDir, dateKey);

  try {
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  } catch (_) {
    return true;
  }

  try {
    for (const entry of fs.readdirSync(markerDir)) {
      if (entry !== dateKey) {
        fs.rmSync(path.join(markerDir, entry), { recursive: true, force: true });
      }
    }
  } catch (_) {
    // Cleanup is best-effort and must not suppress the current notice.
  }

  let markerFd;
  try {
    markerFd = fs.openSync(markerPath, 'wx', 0o600);
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  } finally {
    if (markerFd != null) {
      try { fs.closeSync(markerFd); } catch (_) {}
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Plugin reference copying (background fork #1)
// ──────────────────────────────────────────────────────────────────

function copyPluginReferences() {
  const pluginRoot = getPluginRoot();
  if (!pluginRoot) return;

  const referencesSrc = path.join(pluginRoot, 'references');
  if (!fs.existsSync(referencesSrc)) return;

  const referencesDst = path.join('.claude', 'spectre');
  fs.mkdirSync(referencesDst, { recursive: true });

  const files = fs.readdirSync(referencesSrc).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const dst = path.join(referencesDst, file);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(referencesSrc, file), dst);
    }
  }

  // Append to .gitignore if it exists and .claude/ not already ignored
  const gitignorePath = '.gitignore';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (!content.includes('.claude/') && !content.includes('.claude/spectre/')) {
      fs.appendFileSync(gitignorePath, '\n# spectre plugin files\n.claude/spectre/\n');
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Session discovery
// ──────────────────────────────────────────────────────────────────

function findLatestHandoff(sessionDir) {
  if (!fs.existsSync(sessionDir)) return null;

  // Only look at top-level files, not in archive/
  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('_handoff.json'))
    .map(f => ({
      name: f,
      full: path.join(sessionDir, f),
      mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].full : null;
}

// ──────────────────────────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────────────────────────

function formatList(items, prefix) {
  prefix = prefix != null ? prefix : '- ';
  if (!items || !items.length) return `${prefix}None`;
  return items.map(item => `${prefix}${item}`).join('\n');
}

function buildCheckboxTree(tasks) {
  if (!tasks || !tasks.length) return 'No tasks found.';

  const byParent = {};
  for (const task of tasks) {
    const parent = task.parent || null;
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push(task);
  }

  function renderTask(task, indent) {
    indent = indent || 0;
    const lines = [];
    const prefix = '  '.repeat(indent);
    const checkbox = task.completed ? '[x]' : '[ ]';
    const status = task.status || 'open';
    const title = task.title || 'Untitled';
    const taskId = task.id || 'unknown';

    if (task.completed) {
      lines.push(`${prefix}- ${checkbox} ${title} (${taskId}) - COMPLETED`);
    } else {
      const cmd = task.resume_command || `bd update ${taskId} --status in_progress`;
      const statusBadge = status !== 'open' ? `[${status}]` : '';
      lines.push(`${prefix}- ${checkbox} ${title} (${taskId}) ${statusBadge} - \`${cmd}\``);
    }

    // Render children
    const childrenIds = task.children || [];
    if (childrenIds.length) {
      for (const childTask of tasks) {
        if (childrenIds.includes(childTask.id) || childTask.parent === taskId) {
          lines.push(...renderTask(childTask, indent + 1));
        }
      }
    }

    return lines;
  }

  // Start with root tasks (no parent or parent is null)
  const rootTasks = (byParent[null] || []).concat(byParent['null'] || []);

  // If no root tasks found, just list all tasks flat
  const startTasks = rootTasks.length ? rootTasks : tasks;

  const lines = [];
  const renderedIds = new Set();

  for (const task of startTasks) {
    if (!renderedIds.has(task.id)) {
      const taskLines = renderTask(task);
      lines.push(...taskLines);
      renderedIds.add(task.id);
      for (const t of tasks) {
        if (t.parent === task.id) {
          renderedIds.add(t.id);
        }
      }
    }
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────
// Main context formatter
// ──────────────────────────────────────────────────────────────────

function formatContext(data, opts) {
  opts = opts || {};
  const handoffPath = opts.handoffPath;

  const taskName = data.task_name || 'unknown';
  const branchName = data.branch_name || 'unknown';

  // Progress update fields (v1.1 schema)
  const progress = data.progress_update || {};
  const summary = progress.summary || 'No summary available.';
  const goal = progress.goal || '';
  const constraints = progress.constraints || [];
  const decisions = progress.decisions || [];
  const accomplished = progress.accomplished || [];
  const now = progress.now || '';
  const nextSteps = progress.next_steps || [];
  const blockers = progress.blockers || [];
  const openQuestions = progress.open_questions || [];
  const confidence = progress.confidence || 'unknown';
  const risks = progress.risks || [];

  // Working set (v1.1 schema) - fall back to context.key_files for v1.0
  const workingSet = data.working_set || {};
  let keyFiles = workingSet.key_files || [];
  const activeIds = workingSet.active_ids || [];
  const recentCommands = workingSet.recent_commands || [];

  // Fall back to old context structure if working_set not present
  if (!keyFiles.length) {
    const ctx = data.context || {};
    keyFiles = ctx.key_files || [];
  }

  // Beads tasks
  const beads = data.beads || {};
  const beadsAvailable = beads.available != null ? beads.available : true;
  const tasks = beads.tasks || [];

  // Context
  const context = data.context || {};
  const lastCommit = context.last_commit || 'unknown';
  const wipState = context.wip_state || 'unknown';

  // Build checkbox tree for beads tasks
  const checkboxTree = (beadsAvailable && tasks.length) ? buildCheckboxTree(tasks) : '';

  // User-visible notice
  const noticeLines = ['\ud83d\udc7b SPECTRE'];
  noticeLines.push(`\n\ud83d\udd04 Session Resumed: ${taskName} | Branch: ${branchName}`);

  if (goal) {
    noticeLines.push(`\n\ud83c\udfaf Goal: ${goal}`);
  }

  noticeLines.push(`\n\ud83d\udcdd Summary: ${summary}`);

  if (nextSteps.length) {
    noticeLines.push('\n\u27a1\ufe0f Next Steps:');
    for (const step of nextSteps) {
      noticeLines.push(`  - ${step}`);
    }
  }

  if (handoffPath) {
    noticeLines.push(`\n\ud83d\udcc1 Full details: ${handoffPath}`);
  }

  noticeLines.push('\n\ud83d\udca1 Run /spectre:spectre-forget to clear session memory and start fresh.');

  const visibleNotice = noticeLines.join('\n');

  // Build the hidden context sections
  const sections = [];

  sections.push(`# Session Context: ${taskName}`);

  // Last session summary
  sections.push(`\n## Last Session Summary\n${summary}`);

  // Goal (if available - v1.1)
  if (goal) {
    sections.push(`\n### Goal\n${goal}`);
  }

  // Constraints (if available - v1.1)
  if (constraints.length) {
    sections.push(`\n### Constraints\n${formatList(constraints)}`);
  }

  // What we accomplished
  sections.push(`\n### What We Accomplished\n${formatList(accomplished)}`);

  // What we were working on (critical for resume - v1.1)
  if (now) {
    sections.push(`\n### Active Work (Resume Here)\n**${now}**`);
  }

  // What's next
  sections.push(`\n### What's Next\n${formatList(nextSteps)}`);

  // Blockers
  if (blockers.length) {
    sections.push(`\n### Blockers\n${formatList(blockers)}`);
  }

  // Open questions (v1.1)
  if (openQuestions.length) {
    sections.push(`\n### Open Questions\n${formatList(openQuestions)}`);
  }

  // Decisions
  if (decisions.length) {
    sections.push(`\n### Decisions Made\n${formatList(decisions)}`);
  }

  // Confidence and risks
  const risksStr = risks.length ? formatList(risks, '') : 'None identified';
  sections.push(`\n**Confidence**: ${confidence} | **Risks**: ${risksStr}`);

  // Working set (v1.1)
  const wsLines = [];
  if (keyFiles.length) {
    wsLines.push(`- **Key Files**: ${keyFiles.join(', ')}`);
  }
  if (activeIds.length) {
    wsLines.push(`- **Active IDs**: ${activeIds.join(', ')}`);
  }
  if (recentCommands.length) {
    wsLines.push(`- **Recent Commands**: ${recentCommands.join(', ')}`);
  }

  if (wsLines.length) {
    sections.push('\n### Working Set\n' + wsLines.join('\n'));
  }

  // Context
  sections.push(
    '\n---\n\n' +
    '## Context\n' +
    `- **Branch**: ${branchName}\n` +
    `- **Last Commit**: ${lastCommit}\n` +
    `- **WIP State**: ${wipState}`
  );

  // Beads tasks (if available)
  if (beadsAvailable && checkboxTree) {
    sections.push(`\n### Beads Tasks\n${checkboxTree}`);
  }

  const hiddenContext = `<session-context>\n${sections.join('')}\n</session-context>`;

  return {
    systemMessage: visibleNotice,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: hiddenContext
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────

async function main() {
  // Handle background fork modes
  if (process.argv[2] === '--bg-copy-refs') {
    try { copyPluginReferences(); } catch (_) {}
    process.exit(0);
  }

  // Read stdin
  const hookInput = parseHookInput(await readStdinWithTimeout());

  // Fork to copy plugin references in background (non-blocking)
  const copyChild = fork(__filename, ['--bg-copy-refs'], {
    detached: true,
    stdio: 'ignore'
  });
  copyChild.unref();

  // Get project directory from environment or cwd
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Get branch name
  const branchName = getGitBranch(projectDir);

  // Canonical history is the cutover marker. Only fall back while it is absent.
  const canonicalDir = path.join(projectDir, '.spectre', 'handoffs', branchName);
  const canonicalHandoff = findLatestHandoff(canonicalDir);
  const latestHandoff = canonicalHandoff || findLatestHandoff(
    path.join(projectDir, 'docs', 'tasks', branchName, 'session_logs')
  );

  if (!latestHandoff) {
    if (hookInput.source === 'compact' || !claimDailyBanner(projectDir)) {
      process.stdout.write('{}\n');
      process.exit(0);
    }

    // No session to resume - show welcome banner with tips
    const banner = '\ud83d\udc7b SPECTRE';
    const tips = [
      '',
      'Getting Started with SPECTRE:',
      '',
      '\u2699\ufe0f  Tip: Turn off auto-compact via /config \u2014 SPECTRE works best with manual context management',
      '\ud83d\udcbe  Use /spectre:spectre-handoff when context is getting full but you\'re still going \u2014 saves state for the next session',
      '\ud83e\uddf9  Use /spectre:spectre-forget to clear session memory and start fresh',
      '\ud83d\ude80  Use /spectre:spectre-scope to start building features with the full SPECTRE workflow',
      '\ud83c\udf93  Use /spectre:spectre-learn to create a documentation skill that your Agent will auto-load when relevant.'
    ].join('\n');

    const welcome = {
      systemMessage: banner + '\n' + tips
    };
    process.stdout.write(JSON.stringify(welcome) + '\n');
    process.exit(0);
  }

  // Read and parse handoff JSON
  let data;
  try {
    data = JSON.parse(fs.readFileSync(latestHandoff, 'utf8'));
  } catch (_) {
    process.exit(0);
  }

  // Compute relative path to handoff for user reference
  let handoffRelative;
  try {
    handoffRelative = path.relative(projectDir, latestHandoff);
  } catch (_) {
    handoffRelative = latestHandoff;
  }

  // Format and output context
  const output = formatContext(data, {
    handoffPath: handoffRelative
  });
  process.stdout.write(JSON.stringify(output) + '\n');

  process.exit(0);
}

export {
  copyPluginReferences,
  formatContext,
  buildCheckboxTree,
  parseHookInput,
  localDateKey,
  claimDailyBanner
};

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename)) {
  main();
}
