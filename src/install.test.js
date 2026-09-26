import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const CLI_PATH = path.resolve('bin/spectre.js');
const CODEX_PLUGIN_ROOT = path.resolve('plugins/spectre-codex');
const ENSURE_AGENTS = path.join(
  CODEX_PLUGIN_ROOT,
  'hooks',
  'scripts',
  'ensure-codex-agents.mjs',
);

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-codex-native-'));
  const projectDir = path.join(root, 'project');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(projectDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, projectDir, codexHome };
}

function runCli(args, fixture) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      HOME: fixture.root,
    },
    encoding: 'utf8',
  });
}

function runAgentSetup(args, fixture) {
  return spawnSync(process.execPath, [ENSURE_AGENTS, ...args, '--json'], {
    cwd: fixture.projectDir,
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      HOME: fixture.root,
      PLUGIN_ROOT: CODEX_PLUGIN_ROOT,
    },
    encoding: 'utf8',
  });
}

function readJson(result) {
  assert.ok(result.stdout.trim(), result.stderr);
  return JSON.parse(result.stdout);
}

function collectFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

test('install, update, and uninstall codex require the native plugin and do not mutate files', (t) => {
  for (const command of ['install', 'update', 'uninstall']) {
    const fixture = makeFixture(t);
    fs.mkdirSync(path.join(fixture.codexHome, 'skills', 'user-owned'), { recursive: true });
    const sentinel = path.join(fixture.codexHome, 'skills', 'user-owned', 'SKILL.md');
    fs.writeFileSync(sentinel, 'user bytes\n');
    const before = collectFiles(fixture.root).map((filePath) => [
      path.relative(fixture.root, filePath),
      fs.readFileSync(filePath, 'utf8'),
    ]);

    const result = runCli([
      command,
      'codex',
      '--scope',
      'project',
      '--project-dir',
      fixture.projectDir,
      '--json',
    ], fixture);

    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      code: 'CODEX_PLUGIN_REQUIRED',
      message: [
        `${command} codex no longer mutates Codex files.`,
        'Codex native plugin installation is required for Spectre 6.0.0.',
        '',
        'Fresh install:',
        '  codex plugin marketplace add joenandez/spectre',
        '  codex plugin add spectre@spectre',
        '',
        'Update:',
        '  codex plugin marketplace upgrade spectre',
        '  codex plugin remove spectre@spectre',
        '  codex plugin add spectre@spectre',
        '',
        'Uninstall:',
        '  Run the bundled spectre-uninstall-codex skill first to remove managed agents.',
        '  codex plugin remove spectre@spectre',
      ].join('\n'),
    });
    const after = collectFiles(fixture.root).map((filePath) => [
      path.relative(fixture.root, filePath),
      fs.readFileSync(filePath, 'utf8'),
    ]);
    assert.deepEqual(after, before);
  }
});

test('managed-agent helper installs, checks, updates, and removes namespaced agents', (t) => {
  const fixture = makeFixture(t);

  const missing = runAgentSetup(['--check'], fixture);
  assert.notEqual(missing.status, 0);
  assert.equal(readJson(missing).ok, false);
  assert.ok(readJson(missing).missing.includes('spectre_dev.toml'));

  const installed = runAgentSetup(['--ensure'], fixture);
  assert.equal(installed.status, 0, installed.stderr);
  const installedPayload = readJson(installed);
  assert.equal(installedPayload.ok, true);
  assert.ok(installedPayload.installed.includes('spectre_dev.toml'));

  const agentPath = path.join(fixture.codexHome, 'agents', 'spectre_dev.toml');
  const original = fs.readFileSync(agentPath, 'utf8');
  assert.match(original, /^# spectre-managed-codex-agent/m);
  assert.match(original, /^name = "spectre_dev"$/m);

  const current = runAgentSetup(['--check'], fixture);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(readJson(current).ok, true);

  fs.writeFileSync(agentPath, original.replace('workspace-write', 'read-only'));
  const repaired = runAgentSetup(['--ensure'], fixture);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.ok(readJson(repaired).updated.includes('spectre_dev.toml'));
  assert.equal(fs.readFileSync(agentPath, 'utf8'), original);

  const removed = runAgentSetup(['--remove'], fixture);
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(readJson(removed).removed.includes('spectre_dev.toml'));
  assert.equal(fs.existsSync(agentPath), false);
});

test('managed-agent helper rejects unowned collisions', (t) => {
  const fixture = makeFixture(t);
  const collidingPath = path.join(fixture.codexHome, 'agents', 'spectre_dev.toml');
  fs.mkdirSync(path.dirname(collidingPath), { recursive: true });
  fs.writeFileSync(collidingPath, 'name = "spectre_dev"\n# user-owned\n');

  const result = runAgentSetup(['--ensure'], fixture);
  assert.notEqual(result.status, 0);
  const payload = readJson(result);
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.collisions, [collidingPath]);
  assert.equal(fs.readFileSync(collidingPath, 'utf8'), 'name = "spectre_dev"\n# user-owned\n');
});

test('managed-agent helper preserves an unowned retired-skill collision', (t) => {
  const fixture = makeFixture(t);
  const skillPath = path.join(
    fixture.codexHome,
    'skills',
    'spectre-recall',
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, 'USER_SENTINEL\n');

  const result = runAgentSetup(['--ensure'], fixture);
  assert.notEqual(result.status, 0);
  const payload = readJson(result);
  assert.equal(payload.ok, false);
  assert.ok(payload.collisions.includes(path.dirname(skillPath)));
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'USER_SENTINEL\n');
});

test('managed-agent helper cleans owned legacy install without removing unrelated config, hooks, skills, or knowledge', (t) => {
  const fixture = makeFixture(t);
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const hooksPath = path.join(fixture.codexHome, 'hooks.json');
  const knowledgePath = path.join(fixture.root, '.spectre', 'projects', 'store', 'knowledge.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, [
    '[features]',
    'custom = true',
    '',
    '# spectre-codex-managed',
    '[agents.spectre_dev]',
    `config_file = ${JSON.stringify(path.join(fixture.codexHome, 'spectre', 'agents', 'dev.toml'))}`,
    '',
    '[agents.user_owned]',
    'description = "keep"',
    '',
  ].join('\n'));
  fs.writeFileSync(hooksPath, `${JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node ${CODEX_HOME}/spectre/hooks/scripts/bootstrap.mjs' },
        { type: 'command', command: 'node /tmp/user-hook.mjs' },
      ] }],
    },
  }, null, 2)}\n`);
  const legacySkill = path.join(fixture.codexHome, 'skills', 'spectre-scope', 'SKILL.md');
  const retiredRecallSkill = path.join(fixture.codexHome, 'skills', 'spectre-recall', 'SKILL.md');
  const retiredFindSkill = path.join(fixture.codexHome, 'skills', 'spectre-find', 'SKILL.md');
  const userSkill = path.join(fixture.codexHome, 'skills', 'user-owned', 'SKILL.md');
  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  fs.writeFileSync(legacySkill, 'legacy\n');
  fs.mkdirSync(path.dirname(retiredRecallSkill), { recursive: true });
  fs.writeFileSync(retiredRecallSkill, 'retired recall\n');
  fs.mkdirSync(path.dirname(retiredFindSkill), { recursive: true });
  fs.writeFileSync(retiredFindSkill, 'retired find\n');
  fs.mkdirSync(path.dirname(userSkill), { recursive: true });
  fs.writeFileSync(userSkill, 'keep\n');
  fs.mkdirSync(path.join(fixture.codexHome, 'spectre', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexHome, 'spectre', 'hooks', 'bootstrap.mjs'), 'legacy\n');
  fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
  fs.writeFileSync(knowledgePath, '{"keep":true}\n');

  const result = runAgentSetup(['--ensure'], fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fixture.codexHome, 'spectre')), false);
  assert.equal(fs.existsSync(path.dirname(legacySkill)), false);
  assert.equal(fs.existsSync(path.dirname(retiredRecallSkill)), false);
  assert.equal(fs.existsSync(path.dirname(retiredFindSkill)), false);
  assert.equal(fs.readFileSync(userSkill, 'utf8'), 'keep\n');
  assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /spectre-codex-managed|agents\.spectre_dev/);
  assert.match(fs.readFileSync(configPath, 'utf8'), /\[features\]\ncustom = true/);
  assert.match(fs.readFileSync(configPath, 'utf8'), /\[agents\.user_owned\]/);
  assert.doesNotMatch(fs.readFileSync(hooksPath, 'utf8'), /spectre\/hooks\/scripts/);
  assert.match(fs.readFileSync(hooksPath, 'utf8'), /user-hook\.mjs/);
  assert.equal(fs.readFileSync(knowledgePath, 'utf8'), '{"keep":true}\n');
});
