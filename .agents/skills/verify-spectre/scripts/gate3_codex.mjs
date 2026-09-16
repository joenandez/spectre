#!/usr/bin/env node
/**
 * Gate 3 — Codex translation.
 *
 * plugins/spectre-codex/ is generated, never hand-edited. The failure mode this
 * gate exists for: someone edits a canonical skill, forgets `npm run sync-codex`,
 * and every Codex user runs the previous version indefinitely. Nothing else
 * catches that — the tests pass, the plugin loads, the content is just stale.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Gate, REPO, run } from './lib.mjs';

const g = new Gate('3 codex');
const MIRROR = path.join(REPO, 'plugins', 'spectre-codex');

// --check regenerates into a temp tree and diffs against the committed mirror.
// Run it BEFORE any sync — running sync first would mask the staleness we're
// trying to detect.
const check = run('npm', ['run', 'sync-codex', '--', '--check']);
g.check(check.code === 0, 'committed Codex mirror is in sync with canonical source',
  `sync-codex --check failed — run \`npm run sync-codex\` and commit the result.\n        ${(check.stderr || check.stdout).trim().split('\n').slice(-3).join('\n        ')}`);

g.check(fs.existsSync(MIRROR), 'Codex mirror directory exists');

// --- generated hooks --------------------------------------------------------
const mirrorHooks = path.join(MIRROR, 'hooks', 'hooks.json');
if (fs.existsSync(mirrorHooks)) {
  let hooks = null;
  try {
    hooks = JSON.parse(fs.readFileSync(mirrorHooks, 'utf8'));
    g.check(true, 'generated hooks.json parses');
  } catch (error) {
    g.check(false, 'generated hooks.json parses', error.message);
  }

  if (hooks) {
    const commands = Object.values(hooks.hooks || {})
      .flat()
      .flatMap((m) => (m.hooks || []).map((h) => h.command || ''));

    // Codex runs .mjs. A .cjs reference here means the translator regressed and
    // the hook will fail to load at session start.
    const cjs = commands.filter((c) => c.includes('.cjs'));
    g.check(cjs.length === 0, 'generated hooks reference .mjs, never .cjs', `found: ${cjs.join(', ')}`);

    for (const command of commands) {
      const match = command.match(/\$\{CODEX_HOME\}\/spectre\/(\S+)/);
      if (!match) continue;
      const resolved = path.join(MIRROR, match[1]);
      g.check(fs.existsSync(resolved), `generated hook script present: ${path.basename(resolved)}`,
        `referenced but missing from the mirror: ${match[1]}`);
    }
  }
}

const mirrorHookScripts = path.join(MIRROR, 'hooks', 'scripts');
const untranslatedHookCommands = [];
if (fs.existsSync(mirrorHookScripts)) {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      if (entry.isFile() && /\/spectre:[a-z0-9_-]+/.test(fs.readFileSync(file, 'utf8'))) {
        untranslatedHookCommands.push(path.relative(mirrorHookScripts, file));
      }
    }
  };
  visit(mirrorHookScripts);
}
g.check(
  untranslatedHookCommands.length === 0,
  'Codex hook prompts use $spectre:spectre-* commands, not /spectre: commands',
  `untranslated in: ${untranslatedHookCommands.join(', ')}`,
);

// --- generated skills -------------------------------------------------------
// The translator rewrites Claude-shaped references into Codex-shaped ones.
// If either rewrite regresses, Codex agents get paths and commands that don't
// exist in their runtime — and they'll cheerfully act on them anyway.
const mirrorSkills = path.join(MIRROR, 'skills');
if (fs.existsSync(mirrorSkills)) {
  const untranslatedPaths = [];
  const untranslatedCommands = [];

  for (const dir of fs.readdirSync(mirrorSkills)) {
    const file = path.join(mirrorSkills, dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, 'utf8');
    if (body.includes('.claude/skills/')) untranslatedPaths.push(dir);
    if (/\/spectre:[a-z0-9_-]+/.test(body)) untranslatedCommands.push(dir);
  }

  g.check(untranslatedPaths.length === 0, 'Codex skills use .agents/skills/, not .claude/skills/',
    `untranslated in: ${untranslatedPaths.join(', ')}`);
  g.check(untranslatedCommands.length === 0, 'Codex skills use $spectre:spectre-* commands, not /spectre: commands',
    `untranslated in: ${untranslatedCommands.join(', ')}`);
}

g.done();
