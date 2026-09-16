#!/usr/bin/env node
/**
 * Gate 1 — Static/structural integrity of the canonical plugin tree.
 *
 * Everything here is cheap and pure-filesystem, so it runs on every change.
 * The theme: a broken plugin usually fails silently at runtime (a skill that
 * never triggers, a hook that never fires, a placeholder shipped raw), so we
 * assert the invariants that would otherwise only surface in a user's session.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Gate, REPO, run, frontmatter } from './lib.mjs';

const g = new Gate('1 structure');
const PLUGIN = path.join(REPO, 'plugins', 'spectre');
const SKILLS = path.join(PLUGIN, 'skills');
const AGENTS = path.join(PLUGIN, 'agents');
const HERE = path.dirname(new URL(import.meta.url).pathname);

// --- skills -----------------------------------------------------------------
const skillDirs = fs.existsSync(SKILLS)
  ? fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  : [];

g.check(skillDirs.length > 0, 'skills directory is populated', `found none under ${SKILLS}`);

const skillNames = new Set(skillDirs);
for (const dir of skillDirs) {
  const skillPath = path.join(SKILLS, dir, 'SKILL.md');
  if (!g.check(fs.existsSync(skillPath), `${dir}/SKILL.md exists`)) continue;

  const fm = frontmatter(fs.readFileSync(skillPath, 'utf8'));
  if (!g.check(fm !== null, `${dir} frontmatter parses`, 'missing or malformed --- block')) continue;

  // A name/dir mismatch is the classic silent failure: the skill loads under a
  // name nothing references, so every Skill(...) call to it misses.
  g.check(fm.name === dir, `${dir} frontmatter name matches directory`, `name: "${fm.name}"`);
  g.check(Boolean(fm.description), `${dir} has a description`, 'description drives triggering; empty means it never fires');
}

// --- expected-skills manifest ----------------------------------------------
// Guards against silent loss. Skills are deleted deliberately, never by accident,
// so a drop here should force someone to update the manifest on purpose.
const manifestPath = path.join(HERE, '..', 'references', 'expected-skills.txt');
if (fs.existsSync(manifestPath)) {
  const expected = fs.readFileSync(manifestPath, 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const missing = expected.filter((s) => !skillNames.has(s));
  const unlisted = skillDirs.filter((s) => !expected.includes(s));

  g.check(missing.length === 0, 'no expected skill is missing', `absent: ${missing.join(', ')}`);
  g.check(unlisted.length === 0, 'no unlisted skill present',
    `not in manifest: ${unlisted.join(', ')} — add them to references/expected-skills.txt if intentional`);
}

// --- agents -----------------------------------------------------------------
const agentFiles = fs.existsSync(AGENTS)
  ? fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort()
  : [];
const agentNames = new Set(agentFiles.map((f) => path.basename(f, '.md')));

for (const file of agentFiles) {
  const fm = frontmatter(fs.readFileSync(path.join(AGENTS, file), 'utf8'));
  const base = path.basename(file, '.md');
  if (!g.check(fm !== null, `agent ${file} frontmatter parses`)) continue;
  g.check(fm.name === base, `agent ${file} name matches filename`, `name: "${fm.name}"`);
  g.check(Boolean(fm.description), `agent ${file} has a description`);
}

// --- hooks ------------------------------------------------------------------
const hooksPath = path.join(PLUGIN, 'hooks', 'hooks.json');
if (g.check(fs.existsSync(hooksPath), 'hooks.json exists')) {
  let hooks = null;
  try {
    hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    g.check(true, 'hooks.json parses');
  } catch (error) {
    g.check(false, 'hooks.json parses', error.message);
  }

  if (hooks) {
    g.check(
      !Object.hasOwn(hooks.hooks || {}, 'UserPromptSubmit'),
      'UserPromptSubmit knowledge delivery is retired',
      'hooks.json still registers UserPromptSubmit'
    );
    const sessionStart = hooks.hooks?.SessionStart || [];
    const commands = sessionStart.flatMap((m) => (m.hooks || []).map((h) => h.command || ''));

    // Order is load-bearing: bootstrap seeds state, handoff-resume reads it,
    // load-knowledge injects on top. Shuffle them and the resume notice can
    // land before the state it describes exists.
    const EXPECTED = ['bootstrap.mjs', 'handoff-resume.mjs', 'load-knowledge.mjs'];
    const scriptForCommand = (command) =>
      command.split(/\s+/).find((token) => token.endsWith('.mjs')) || '';
    const actual = commands.map((command) => path.basename(scriptForCommand(command)));
    g.check(
      JSON.stringify(actual) === JSON.stringify(EXPECTED),
      'SessionStart hooks registered in the expected order',
      `expected ${EXPECTED.join(' -> ')}, found ${actual.join(' -> ') || '(none)'}`
    );

    for (const command of commands) {
      const script = scriptForCommand(command);
      const resolved = script.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN);
      g.check(fs.existsSync(resolved), `hook script exists: ${path.basename(resolved)}`, `not found at ${resolved}`);
    }
  }
}

g.check(
  !fs.existsSync(path.join(PLUGIN, 'hooks', 'scripts', 'user-prompt-submit.mjs')),
  'user-prompt-submit.mjs prompt runtime is retired'
);
g.check(
  !fs.existsSync(path.join(PLUGIN, 'hooks', 'scripts', 'knowledge', 'matcher.mjs')),
  'prompt matcher runtime is retired'
);
g.check(
  !skillNames.has('spectre-recall'),
  'active spectre-recall skill is retired'
);

// --- template placeholders --------------------------------------------------
// Registry substitution is retired. No active skill may ship its placeholder.
const stray = [];
for (const dir of skillDirs) {
  const skillPath = path.join(SKILLS, dir, 'SKILL.md');
  if (fs.existsSync(skillPath) && fs.readFileSync(skillPath, 'utf8').includes('{{REGISTRY}}')) {
    stray.push(dir);
  }
}
g.check(stray.length === 0, '{{REGISTRY}} appears in no active SKILL.md',
  `raw placeholder would reach the model from: ${stray.join(', ')}`);

// --- stale fork naming ------------------------------------------------------
// The suite's own docs discuss the fork by name; excluding them keeps this
// check about the shipped tree rather than the tooling that inspects it.
const caspar = run('git', ['grep', '-il', 'caspar', '--', '.',
  ':!docs/tasks', ':!.agents/skills/verify-spectre']);
const casparFiles = caspar.stdout.split('\n').filter(Boolean);
g.check(casparFiles.length === 0, 'no stale caspar naming outside docs/tasks',
  `found in: ${casparFiles.slice(0, 10).join(', ')}`);

// --- cross-references resolve ----------------------------------------------
// A dangling Skill(spectre-foo) or @spectre:bar fails at runtime with nothing
// but a confused agent to show for it, so resolve them statically.
const dangling = [];
for (const dir of skillDirs) {
  const skillPath = path.join(SKILLS, dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) continue;

  // Prompts contain fill-in-the-blank templates like `{/spectre:spectre-command or action}`.
  // Those braces mean "substitute something here", not "call this" — stripping
  // them first is what keeps this check from crying wolf on every output template.
  const body = fs.readFileSync(skillPath, 'utf8').replace(/\{[^{}\n]*\}/g, '');

  for (const [, name] of body.matchAll(/Skill\((spectre-[a-z0-9_-]+)\)/g)) {
    if (!skillNames.has(name)) dangling.push(`${dir}: Skill(${name})`);
  }
  for (const [, name] of body.matchAll(/\/spectre:([a-z0-9_-]+)/g)) {
    if (!name.startsWith('spectre-')) {
      dangling.push(`${dir}: legacy /spectre:${name} (use /spectre:spectre-${name})`);
    } else if (!skillNames.has(name)) {
      dangling.push(`${dir}: /spectre:${name}`);
    }
  }
  // `@spectre:` addresses an *agent*. Pointing it at a skill name is a real bug:
  // the dispatch silently resolves to nothing.
  for (const [, name] of body.matchAll(/@spectre:([a-z0-9_-]+)/g)) {
    if (!agentNames.has(name)) {
      const hint = skillNames.has(name) ? ` (that's a skill — use Skill(${name}))` : '';
      dangling.push(`${dir}: @spectre:${name}${hint}`);
    }
  }
}
g.check(dangling.length === 0, 'all skill/agent cross-references resolve',
  `dangling: ${[...new Set(dangling)].slice(0, 12).join(' | ')}`);

// --- version lockstep -------------------------------------------------------
const versionFiles = {
  'package.json': (j) => j.version,
  '.claude-plugin/marketplace.json': (j) => j.version,
  '.agents/plugins/marketplace.json': (j) => j.version,
  'plugins/spectre/.claude-plugin/plugin.json': (j) => j.version,
};
const versions = {};
for (const [file, pick] of Object.entries(versionFiles)) {
  const full = path.join(REPO, file);
  if (!fs.existsSync(full)) {
    g.check(false, `${file} exists`);
    continue;
  }
  versions[file] = pick(JSON.parse(fs.readFileSync(full, 'utf8')));
}
const distinct = [...new Set(Object.values(versions))];
g.check(distinct.length === 1, 'four canonical version files agree',
  Object.entries(versions).map(([f, v]) => `${f}=${v}`).join(', '));

// Each marketplace nests a second copy of the version — both drift easily.
for (const relativePath of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
  const marketplacePath = path.join(REPO, relativePath);
  if (!fs.existsSync(marketplacePath)) continue;
  const mk = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  g.check(mk.plugins?.[0]?.version === mk.version, `${relativePath} nested plugin version matches top-level`,
    `top=${mk.version}, plugins[0]=${mk.plugins?.[0]?.version}`);
}

g.done();
