#!/usr/bin/env node

/**
 * Tests for handoff-resume.mjs
 *
 * Run with: node --test plugins/spectre/hooks/scripts/test_handoff-resume.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimDailyBanner } from './handoff-resume.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, 'handoff-resume.mjs');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-hr-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function setupGitRepo(tmpPath, branch) {
  branch = branch || 'main';

  execSync(`git init --initial-branch=${branch}`, { cwd: tmpPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpPath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tmpPath, stdio: 'pipe' });

  fs.writeFileSync(path.join(tmpPath, 'README.md'), '# Test');
  execSync('git add README.md', { cwd: tmpPath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: tmpPath, stdio: 'pipe' });

  const sessionDir = path.join(tmpPath, 'docs', 'tasks', branch, 'session_logs');
  fs.mkdirSync(sessionDir, { recursive: true });

  return sessionDir;
}

function runHook(cwd, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env);
  env.CLAUDE_PROJECT_DIR = cwd;
  env.HOME = path.join(cwd, '.test-home');
  env.USERPROFILE = env.HOME;
  // Remove plugin root to avoid side effects in tests
  delete env.CLAUDE_PLUGIN_ROOT;

  if (opts.env) {
    Object.assign(env, opts.env);
  }

  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
      env,
      cwd: opts.processCwd || cwd,
      timeout: 10000,
      encoding: 'utf8',
      input: opts.stdin || ''
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', exitCode: err.status };
  }
}

function writeHandoff(sessionDir, fileName, taskName, branchName = 'main') {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, fileName),
    JSON.stringify({
      version: '1.1',
      timestamp: fileName.replace('_handoff.json', ''),
      branch_name: branchName,
      task_name: taskName,
      progress_update: {
        summary: `${taskName} summary`,
        accomplished: [],
        next_steps: [],
        decisions: [],
        blockers: [],
        confidence: 'high',
        risks: []
      },
      beads: { tasks: [] },
      context: {}
    })
  );
}

// ──────────────────────────────────────────────────────────────────
// Core tests
// ──────────────────────────────────────────────────────────────────

describe('HandoffResume', () => {
  it('maps a raw slashed branch directly and ignores encoded or aliased handoff paths', () => {
    const tmp = createTmpDir();
    const launcherDir = createTmpDir();
    try {
      setupGitRepo(tmp, 'feature/foo');
      const canonicalDir = path.join(
        tmp,
        '.spectre',
        'handoffs',
        'feature',
        'foo'
      );
      writeHandoff(
        canonicalDir,
        '2026-07-23-100000_handoff.json',
        'Canonical explicit project',
        'feature/foo'
      );
      writeHandoff(
        path.join(tmp, '.spectre', 'handoffs', 'feature%2Ffoo'),
        '2026-07-23-120000_handoff.json',
        'Encoded alias must stay hidden',
        'feature/foo'
      );
      writeHandoff(
        path.join(tmp, '.spectre', 'handoffs', 'feature-foo'),
        '2026-07-23-130000_handoff.json',
        'Dashed alias must stay hidden',
        'feature/foo'
      );

      const result = runHook(tmp, { processCwd: launcherDir });
      const output = JSON.parse(result.stdout);

      assert.equal(result.exitCode, 0);
      assert.match(output.systemMessage, /Canonical explicit project/);
      assert.match(
        output.systemMessage,
        /\.spectre\/handoffs\/feature\/foo\/2026-07-23-100000_handoff\.json/
      );
      assert.doesNotMatch(output.systemMessage, /Encoded alias must stay hidden/);
      assert.doesNotMatch(output.systemMessage, /Dashed alias must stay hidden/);
    } finally {
      cleanup(tmp);
      cleanup(launcherDir);
    }
  });

  it('preserves HEAD for detached Git and unknown for a non-Git project', () => {
    const detached = createTmpDir();
    const nonGit = createTmpDir();
    try {
      setupGitRepo(detached);
      execSync('git checkout --detach', { cwd: detached, stdio: 'pipe' });
      writeHandoff(
        path.join(detached, '.spectre', 'handoffs', 'HEAD'),
        '2026-07-23-100000_handoff.json',
        'Detached HEAD handoff',
        'HEAD'
      );
      writeHandoff(
        path.join(nonGit, '.spectre', 'handoffs', 'unknown'),
        '2026-07-23-110000_handoff.json',
        'Non-Git unknown handoff',
        'unknown'
      );

      assert.match(JSON.parse(runHook(detached).stdout).systemMessage, /Detached HEAD handoff/);
      assert.match(JSON.parse(runHook(nonGit).stdout).systemMessage, /Non-Git unknown handoff/);
    } finally {
      cleanup(detached);
      cleanup(nonGit);
    }
  });

  it('prefers canonical branch history over a newer matching legacy handoff', () => {
    const tmp = createTmpDir();
    try {
      const legacyDir = setupGitRepo(tmp);
      const canonicalDir = path.join(tmp, '.spectre', 'handoffs', 'main');
      writeHandoff(
        canonicalDir,
        '2026-07-23-100000_handoff.json',
        'Canonical wins'
      );
      writeHandoff(
        legacyDir,
        '2026-07-23-120000_handoff.json',
        'Newer legacy loses'
      );

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);

      assert.match(output.systemMessage, /Canonical wins/);
      assert.doesNotMatch(output.systemMessage, /Newer legacy loses/);
    } finally {
      cleanup(tmp);
    }
  });

  it('does not fall back when canonical top-level history is malformed', () => {
    const tmp = createTmpDir();
    try {
      const legacyDir = setupGitRepo(tmp);
      const canonicalDir = path.join(tmp, '.spectre', 'handoffs', 'main');
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.writeFileSync(
        path.join(canonicalDir, '2026-07-23-100000_handoff.json'),
        '{ malformed canonical'
      );
      writeHandoff(
        legacyDir,
        '2026-07-23-120000_handoff.json',
        'Legacy must stay hidden'
      );

      const result = runHook(tmp);

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
    } finally {
      cleanup(tmp);
    }
  });

  it('no session dir shows welcome banner', () => {
    const tmp = createTmpDir();
    try {
      // No docs/tasks/{branch}/session_logs exists
      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);
      assert.ok(output.systemMessage);
      assert.ok(output.systemMessage.includes('/spectre:spectre-scope'));
      assert.ok(output.systemMessage.includes('/spectre:spectre-handoff'));
      assert.ok(output.systemMessage.includes('/spectre:spectre-forget'));
    } finally {
      cleanup(tmp);
    }
  });

  it('no handoff files shows welcome banner', () => {
    const tmp = createTmpDir();
    try {
      setupGitRepo(tmp);
      // session_dir exists but is empty
      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);
      assert.ok(output.systemMessage);
      assert.ok(output.systemMessage.includes('/spectre:spectre-scope'));
    } finally {
      cleanup(tmp);
    }
  });

  it('shows the no-handoff banner only once per cwd each day', () => {
    const tmp = createTmpDir();
    try {
      setupGitRepo(tmp);

      const first = runHook(tmp, { stdin: JSON.stringify({ source: 'startup' }) });
      const second = runHook(tmp, { stdin: JSON.stringify({ source: 'clear' }) });

      assert.ok(JSON.parse(first.stdout).systemMessage.includes('Getting Started with SPECTRE:'));
      assert.deepEqual(JSON.parse(second.stdout), {});
    } finally {
      cleanup(tmp);
    }
  });

  it('tracks daily banner markers independently by cwd and local date', () => {
    const tmp = createTmpDir();
    try {
      const firstProject = path.join(tmp, 'first');
      const secondProject = path.join(tmp, 'second');
      const stateRoot = path.join(tmp, 'state');
      fs.mkdirSync(firstProject);
      fs.mkdirSync(secondProject);

      const dayOne = new Date(2026, 6, 19, 8);
      const dayTwo = new Date(2026, 6, 20, 8);

      assert.equal(claimDailyBanner(firstProject, { stateRoot, now: dayOne }), true);
      assert.equal(claimDailyBanner(firstProject, { stateRoot, now: dayOne }), false);
      assert.equal(claimDailyBanner(secondProject, { stateRoot, now: dayOne }), true);
      assert.equal(claimDailyBanner(firstProject, { stateRoot, now: dayTwo }), true);

      const firstProjectMarkers = fs.readdirSync(stateRoot)
        .map(dir => path.join(stateRoot, dir))
        .find(dir => fs.existsSync(path.join(dir, '2026-07-20')));
      assert.deepEqual(fs.readdirSync(firstProjectMarkers), ['2026-07-20']);
    } finally {
      cleanup(tmp);
    }
  });

  it('compact is silent without consuming the daily banner', () => {
    const tmp = createTmpDir();
    try {
      setupGitRepo(tmp);

      const compact = runHook(tmp, { stdin: JSON.stringify({ source: 'compact' }) });
      const startup = runHook(tmp, { stdin: JSON.stringify({ source: 'startup' }) });

      assert.deepEqual(JSON.parse(compact.stdout), {});
      assert.ok(JSON.parse(startup.stdout).systemMessage.includes('Getting Started with SPECTRE:'));
    } finally {
      cleanup(tmp);
    }
  });

  it('malformed hook input retains compatible no-handoff behavior', () => {
    const tmp = createTmpDir();
    try {
      setupGitRepo(tmp);

      const result = runHook(tmp, { stdin: '{not-json' });
      assert.ok(JSON.parse(result.stdout).systemMessage.includes('Getting Started with SPECTRE:'));
    } finally {
      cleanup(tmp);
    }
  });

  it('shows the banner when daily marker state cannot be written', () => {
    const tmp = createTmpDir();
    try {
      setupGitRepo(tmp);
      const homeFile = path.join(tmp, 'not-a-directory');
      fs.writeFileSync(homeFile, 'blocked');

      const result = runHook(tmp, {
        env: { HOME: homeFile, USERPROFILE: homeFile },
        stdin: JSON.stringify({ source: 'startup' })
      });

      assert.ok(JSON.parse(result.stdout).systemMessage.includes('Getting Started with SPECTRE:'));
    } finally {
      cleanup(tmp);
    }
  });

  it('restores an existing handoff during compact', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);
      const handoff = {
        version: '1.0',
        timestamp: '2026-07-19-120000',
        branch_name: 'main',
        task_name: 'Compact Restore',
        progress_update: {
          summary: 'Saved work',
          accomplished: [],
          next_steps: ['Continue'],
          decisions: [],
          blockers: [],
          confidence: 'high',
          risks: []
        },
        beads: { tasks: [] },
        context: { last_commit: 'abc123', wip_state: 'clean' }
      };
      fs.writeFileSync(
        path.join(sessionDir, '2026-07-19-120000_handoff.json'),
        JSON.stringify(handoff)
      );

      const result = runHook(tmp, { stdin: JSON.stringify({ source: 'compact' }) });
      const output = JSON.parse(result.stdout);

      assert.ok(output.systemMessage.includes('Compact Restore'));
      assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    } finally {
      cleanup(tmp);
    }
  });

  it('finds latest handoff by timestamp', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const oldHandoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main',
        task_name: 'old-task',
        progress_update: { summary: 'Old summary', accomplished: ['old thing'], next_steps: ['old step'], decisions: [], blockers: [], confidence: 'low', risks: [] },
        beads: { tasks: [] }, context: { last_commit: 'abc123', wip_state: 'clean' }
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(oldHandoff));

      // Sleep briefly so mtime differs
      const start = Date.now();
      while (Date.now() - start < 50) {} // busy wait for mtime difference

      const newHandoff = {
        version: '1.0', timestamp: '2024-01-02-120000', branch_name: 'main',
        task_name: 'new-task',
        progress_update: { summary: 'New summary', accomplished: ['new thing'], next_steps: ['new step'], decisions: [], blockers: [], confidence: 'high', risks: [] },
        beads: { tasks: [] }, context: { last_commit: 'def456', wip_state: 'uncommitted' }
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-02-120000_handoff.json'), JSON.stringify(newHandoff));

      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);

      assert.ok(output.systemMessage.includes('new-task'));
      assert.ok(output.hookSpecificOutput.additionalContext.includes('new-task'));
    } finally {
      cleanup(tmp);
    }
  });

  it('outputs valid hook JSON structure', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp, 'feature-branch');

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'feature-branch',
        task_name: 'Test Task',
        progress_update: {
          summary: 'We did stuff', accomplished: ['thing 1', 'thing 2'], next_steps: ['next 1'],
          decisions: ['decided X'], blockers: [], confidence: 'high', risks: ['risk 1']
        },
        beads: { workspace_label: 'feature-branch', task_count: 0, epic_id: 'none', epic_title: 'No Epic', tasks: [] },
        context: { last_commit: 'abc123', wip_state: 'clean', key_files: ['file1.py'] }
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);

      assert.ok('systemMessage' in output);
      assert.ok('hookSpecificOutput' in output);
      assert.ok('hookEventName' in output.hookSpecificOutput);
      assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok('additionalContext' in output.hookSpecificOutput);
    } finally {
      cleanup(tmp);
    }
  });

  it('system message contains task and branch', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp, 'my-feature');

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'my-feature',
        task_name: 'Implement Widget',
        progress_update: { summary: 'Working on widget', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'medium', risks: [] },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);

      assert.ok(output.systemMessage.includes('Implement Widget'));
      assert.ok(output.systemMessage.includes('my-feature'));
    } finally {
      cleanup(tmp);
    }
  });

  it('additional context contains session-context tag', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test',
        progress_update: { summary: 'Summary here', accomplished: ['done'], next_steps: ['todo'], decisions: [], blockers: [], confidence: 'high', risks: [] },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.startsWith('<session-context>'));
      assert.ok(ctx.includes('</session-context>'));
    } finally {
      cleanup(tmp);
    }
  });

  it('includes progress update sections', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test',
        progress_update: {
          summary: 'We made good progress today',
          accomplished: ['Finished auth', 'Added tests'],
          next_steps: ['Deploy to staging', 'Review PR'],
          decisions: ['Use JWT tokens'],
          blockers: ['Waiting on API keys'],
          confidence: 'medium',
          risks: ['Timeline tight']
        },
        beads: { tasks: [] }, context: { last_commit: 'abc123', wip_state: 'uncommitted' }
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('We made good progress today'));
      assert.ok(ctx.includes('Finished auth'));
      assert.ok(ctx.includes('Added tests'));
      assert.ok(ctx.includes('Deploy to staging'));
      assert.ok(ctx.includes('Use JWT tokens'));
      assert.ok(ctx.includes('Waiting on API keys'));
      assert.ok(ctx.toLowerCase().includes('medium') || ctx.includes('Confidence'));
      assert.ok(ctx.includes('Timeline tight'));
    } finally {
      cleanup(tmp);
    }
  });

  it('handles malformed JSON gracefully', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), '{ invalid json }');

      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), '');
    } finally {
      cleanup(tmp);
    }
  });

  it('ignores archived sessions', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);
      const archiveDir = path.join(sessionDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });

      // Put handoff in archive only
      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Archived Task',
        progress_update: { summary: 'Old', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'low', risks: [] },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(archiveDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);
      assert.ok(output.systemMessage);
      assert.ok(output.systemMessage.includes('/spectre:spectre-scope'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// V1.1 Schema Fields
// ──────────────────────────────────────────────────────────────────

describe('V1.1 Schema Fields', () => {
  it('goal field appears in output', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: {
          summary: 'Summary text', goal: 'Ship the authentication feature by EOD',
          accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: []
        },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Goal'));
      assert.ok(ctx.includes('Ship the authentication feature by EOD'));
    } finally {
      cleanup(tmp);
    }
  });

  it('now field creates active work section', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: {
          summary: 'Summary text', now: 'Implementing the login form validation',
          accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'medium', risks: []
        },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Active Work (Resume Here)'));
      assert.ok(ctx.includes('**Implementing the login form validation**'));
    } finally {
      cleanup(tmp);
    }
  });

  it('constraints field appears in output', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: {
          summary: 'Summary text',
          constraints: ['Must use existing auth library', 'No breaking API changes'],
          accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: []
        },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Constraints'));
      assert.ok(ctx.includes('Must use existing auth library'));
      assert.ok(ctx.includes('No breaking API changes'));
    } finally {
      cleanup(tmp);
    }
  });

  it('open_questions field appears in output', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: {
          summary: 'Summary text',
          open_questions: ['Should we support OAuth?', 'What timeout value to use?'],
          accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'medium', risks: []
        },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Open Questions'));
      assert.ok(ctx.includes('Should we support OAuth?'));
      assert.ok(ctx.includes('What timeout value to use?'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Working Set Extraction
// ──────────────────────────────────────────────────────────────────

describe('Working Set Extraction', () => {
  it('key_files from working_set', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        working_set: { key_files: ['src/auth.py', 'tests/test_auth.py'], active_ids: [], recent_commands: [] },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Working Set'));
      assert.ok(ctx.includes('Key Files'));
      assert.ok(ctx.includes('src/auth.py'));
      assert.ok(ctx.includes('tests/test_auth.py'));
    } finally {
      cleanup(tmp);
    }
  });

  it('active_ids from working_set', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        working_set: { key_files: [], active_ids: ['TASK-123', 'BUG-456'], recent_commands: [] },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Active IDs'));
      assert.ok(ctx.includes('TASK-123'));
      assert.ok(ctx.includes('BUG-456'));
    } finally {
      cleanup(tmp);
    }
  });

  it('recent_commands from working_set', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        working_set: { key_files: [], active_ids: [], recent_commands: ['npm test', 'npm run build'] },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Recent Commands'));
      assert.ok(ctx.includes('npm test'));
      assert.ok(ctx.includes('npm run build'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// V1.0 Fallback Behavior
// ──────────────────────────────────────────────────────────────────

describe('V1.0 Fallback Behavior', () => {
  it('fallback to context.key_files when no working_set', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        beads: { tasks: [] },
        context: { key_files: ['legacy_file.py', 'old_test.py'], last_commit: 'abc123', wip_state: 'clean' }
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Key Files'));
      assert.ok(ctx.includes('legacy_file.py'));
      assert.ok(ctx.includes('old_test.py'));
    } finally {
      cleanup(tmp);
    }
  });

  it('v1.0 handoff produces valid output', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Legacy Task',
        progress_update: { summary: 'Legacy summary', accomplished: ['Did something'], next_steps: ['Do more'], decisions: [], blockers: [], confidence: 'medium', risks: [] },
        beads: { tasks: [] }, context: { last_commit: 'abc123', wip_state: 'clean' }
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);

      assert.ok('systemMessage' in output);
      assert.ok('hookSpecificOutput' in output);
      assert.ok('additionalContext' in output.hookSpecificOutput);

      const ctx = output.hookSpecificOutput.additionalContext;
      assert.ok(output.systemMessage.includes('Legacy Task'));
      assert.ok(ctx.includes('Legacy summary'));
      assert.ok(ctx.includes('Did something'));
      assert.ok(ctx.includes('Do more'));
    } finally {
      cleanup(tmp);
    }
  });

  it('v1.0 handoff does not show empty v1.1 sections', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        beads: { tasks: [] }, context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(!ctx.includes('Active Work (Resume Here)'));
      assert.ok(!ctx.includes('### Goal\n\n'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Beads Conditional Rendering
// ──────────────────────────────────────────────────────────────────

describe('Beads Conditional Rendering', () => {
  it('beads tasks rendered when available true', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        beads: {
          available: true,
          tasks: [{ id: 'task-1', title: 'Implement feature', completed: false, status: 'open' }]
        },
        context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Beads Tasks'));
      assert.ok(ctx.includes('Implement feature'));
      assert.ok(ctx.includes('task-1'));
    } finally {
      cleanup(tmp);
    }
  });

  it('beads tasks not rendered when available false', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.1', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        beads: {
          available: false,
          tasks: [{ id: 'task-1', title: 'Should not appear', completed: false, status: 'open' }]
        },
        context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(!ctx.includes('Beads Tasks'));
      assert.ok(!ctx.includes('Should not appear'));
    } finally {
      cleanup(tmp);
    }
  });

  it('beads available defaults true for v1.0 compat', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp);

      const handoff = {
        version: '1.0', timestamp: '2024-01-01-120000', branch_name: 'main', task_name: 'Test Task',
        progress_update: { summary: 'Summary', accomplished: [], next_steps: [], decisions: [], blockers: [], confidence: 'high', risks: [] },
        beads: {
          tasks: [{ id: 'v10-task', title: 'V1.0 Task', completed: false, status: 'open' }]
        },
        context: {}
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-01-120000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      const output = JSON.parse(result.stdout);
      const ctx = output.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes('Beads Tasks'));
      assert.ok(ctx.includes('V1.0 Task'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Complete V1.1 Handoff Scenario
// ──────────────────────────────────────────────────────────────────

describe('Complete V1.1 Handoff Scenario', () => {
  it('full v1.1 handoff with all fields', () => {
    const tmp = createTmpDir();
    try {
      const sessionDir = setupGitRepo(tmp, 'feature-auth');

      const handoff = {
        version: '1.1', timestamp: '2024-01-15-143000', branch_name: 'feature-auth',
        task_name: 'Implement OAuth2 Authentication',
        progress_update: {
          summary: 'Made good progress on OAuth2 integration with Google provider.',
          goal: 'Complete OAuth2 flow with refresh token handling',
          constraints: ['Must support existing session middleware', 'Cannot change database schema'],
          accomplished: ['Implemented authorization endpoint', 'Added token exchange logic'],
          now: 'Implementing refresh token rotation',
          next_steps: ['Add token refresh endpoint', 'Write integration tests', 'Update API documentation'],
          decisions: ['Use PKCE for public clients', 'Store refresh tokens encrypted'],
          blockers: ['Waiting on security review approval'],
          open_questions: ['Should we support multiple OAuth providers?', 'Token expiry time for mobile vs web?'],
          confidence: 'high',
          risks: ['Security review might require changes']
        },
        working_set: {
          key_files: ['src/auth/oauth.py', 'src/auth/tokens.py', 'tests/test_oauth.py'],
          active_ids: ['AUTH-42', 'AUTH-43'],
          recent_commands: ['pytest tests/test_oauth.py -v', 'flask run --debug']
        },
        beads: {
          available: true, workspace_label: 'feature-auth',
          tasks: [
            { id: 'auth-1', title: 'Setup OAuth config', completed: true, status: 'closed' },
            { id: 'auth-2', title: 'Implement token refresh', completed: false, status: 'in_progress' }
          ]
        },
        context: { last_commit: 'def789abc', wip_state: 'uncommitted' }
      };
      fs.writeFileSync(path.join(sessionDir, '2024-01-15-143000_handoff.json'), JSON.stringify(handoff));

      const result = runHook(tmp);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);

      // System message
      assert.ok(output.systemMessage.includes('Implement OAuth2 Authentication'));
      assert.ok(output.systemMessage.includes('feature-auth'));

      const ctx = output.hookSpecificOutput.additionalContext;

      // v1.1 specific fields
      assert.ok(ctx.includes('Goal'));
      assert.ok(ctx.includes('Complete OAuth2 flow with refresh token handling'));
      assert.ok(ctx.includes('Active Work (Resume Here)'));
      assert.ok(ctx.includes('**Implementing refresh token rotation**'));
      assert.ok(ctx.includes('Constraints'));
      assert.ok(ctx.includes('Must support existing session middleware'));
      assert.ok(ctx.includes('Open Questions'));
      assert.ok(ctx.includes('Should we support multiple OAuth providers?'));

      // Working set
      assert.ok(ctx.includes('Working Set'));
      assert.ok(ctx.includes('src/auth/oauth.py'));
      assert.ok(ctx.includes('AUTH-42'));
      assert.ok(ctx.includes('pytest tests/test_oauth.py -v'));

      // Standard fields
      assert.ok(ctx.includes('Implemented authorization endpoint'));
      assert.ok(ctx.includes('Add token refresh endpoint'));
      assert.ok(ctx.includes('Use PKCE for public clients'));
      assert.ok(ctx.includes('Waiting on security review approval'));
      assert.ok(ctx.toLowerCase().includes('high'));

      // Beads tasks
      assert.ok(ctx.includes('Beads Tasks'));
      assert.ok(ctx.includes('Setup OAuth config'));
      assert.ok(ctx.includes('Implement token refresh'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Copy Plugin References
// ──────────────────────────────────────────────────────────────────

describe('Copy Plugin References', () => {
  it('copies md files from plugin references to .claude/spectre', () => {
    const tmp = createTmpDir();
    const pluginRoot = path.join(tmp, 'plugin');
    const referencesDir = path.join(pluginRoot, 'references');
    fs.mkdirSync(referencesDir, { recursive: true });

    fs.writeFileSync(path.join(referencesDir, 'next_steps_guide.md'), '# Next Steps Guide\nContent here');
    fs.writeFileSync(path.join(referencesDir, 'other_reference.md'), '# Other Reference\nMore content');

    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir);

    try {
      // Run the bg-copy-refs mode directly
      execFileSync(process.execPath, [SCRIPT_PATH, '--bg-copy-refs'], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: pluginRoot }),
        cwd: projectDir,
        timeout: 10000
      });

      const spectreDir = path.join(projectDir, '.claude', 'spectre');
      assert.ok(fs.existsSync(spectreDir));
      assert.ok(fs.existsSync(path.join(spectreDir, 'next_steps_guide.md')));
      assert.ok(fs.existsSync(path.join(spectreDir, 'other_reference.md')));
      assert.equal(
        fs.readFileSync(path.join(spectreDir, 'next_steps_guide.md'), 'utf8'),
        '# Next Steps Guide\nContent here'
      );
    } finally {
      cleanup(tmp);
    }
  });

  it('returns early when plugin root not set', () => {
    const tmp = createTmpDir();
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir);

    try {
      const env = Object.assign({}, process.env);
      delete env.CLAUDE_PLUGIN_ROOT;

      execFileSync(process.execPath, [SCRIPT_PATH, '--bg-copy-refs'], {
        env,
        cwd: projectDir,
        timeout: 10000
      });

      assert.ok(!fs.existsSync(path.join(projectDir, '.claude', 'spectre')));
    } finally {
      cleanup(tmp);
    }
  });

  it('appends to gitignore when exists and .claude not ignored', () => {
    const tmp = createTmpDir();
    const pluginRoot = path.join(tmp, 'plugin');
    const referencesDir = path.join(pluginRoot, 'references');
    fs.mkdirSync(referencesDir, { recursive: true });
    fs.writeFileSync(path.join(referencesDir, 'guide.md'), '# Guide');

    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir);
    const gitignore = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gitignore, 'node_modules/\n*.log\n');

    try {
      execFileSync(process.execPath, [SCRIPT_PATH, '--bg-copy-refs'], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: pluginRoot }),
        cwd: projectDir,
        timeout: 10000
      });

      const content = fs.readFileSync(gitignore, 'utf8');
      assert.ok(content.includes('.claude/spectre/'));
      assert.ok(content.includes('node_modules/'));
    } finally {
      cleanup(tmp);
    }
  });

  it('skips gitignore when .claude already ignored', () => {
    const tmp = createTmpDir();
    const pluginRoot = path.join(tmp, 'plugin');
    const referencesDir = path.join(pluginRoot, 'references');
    fs.mkdirSync(referencesDir, { recursive: true });
    fs.writeFileSync(path.join(referencesDir, 'guide.md'), '# Guide');

    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir);
    const gitignore = path.join(projectDir, '.gitignore');
    const originalContent = 'node_modules/\n.claude/\n*.log\n';
    fs.writeFileSync(gitignore, originalContent);

    try {
      execFileSync(process.execPath, [SCRIPT_PATH, '--bg-copy-refs'], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: pluginRoot }),
        cwd: projectDir,
        timeout: 10000
      });

      assert.equal(fs.readFileSync(gitignore, 'utf8'), originalContent);
    } finally {
      cleanup(tmp);
    }
  });
});
