import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refreshKnowledgeIndex } from '../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import { resolveProjectStore } from '../plugins/spectre/hooks/scripts/knowledge/store.mjs';

const CLI_PATH = path.resolve('bin/spectre.js');
const GENERATED_PLUGIN_VERSION = JSON.parse(
  fs.readFileSync(path.resolve('plugins/spectre-codex/.codex-plugin/plugin.json'), 'utf8'),
).version;

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-doctor-'));
  const projectDir = path.join(root, 'project');
  const codexHome = path.join(projectDir, '.codex');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, projectDir, codexHome, spectreHome };
}

function runCli(args, fixture, env = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      SPECTRE_HOME: fixture.spectreHome,
      ...env,
    },
    encoding: 'utf8',
  });
}

function doctorJson(fixture, env) {
  const result = runCli([
    'doctor',
    'codex',
    '--scope',
    'project',
    '--project-dir',
    fixture.projectDir,
    '--json',
  ], fixture, env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function writeRegistryRuntime(fixture, {
  hooksEnabled = true,
  sessionHook = true,
  handler = true,
  cli = true,
  stalePromptHook = false,
  trusted = true,
} = {}) {
  fs.mkdirSync(fixture.codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.codexHome, 'config.toml'),
    [
      '[features]',
      `hooks = ${hooksEnabled}`,
      '',
      ...(trusted
        ? [
            `[projects.${JSON.stringify(fixture.projectDir)}]`,
            'trust_level = "trusted"',
            '',
          ]
        : []),
    ].join('\n'),
  );
  const hooks = {
    hooks: {
      ...(sessionHook
        ? {
            SessionStart: [{
              matcher: 'startup|resume|clear|compact',
              hooks: [{
                type: 'command',
                command: `node '${path.join(fixture.codexHome, 'spectre', 'hooks', 'scripts', 'load-knowledge.mjs')}' --host codex`,
              }],
            }],
          }
        : {}),
      ...(stalePromptHook
        ? {
            UserPromptSubmit: [{
              hooks: [{
                type: 'command',
                command: `node '${path.join(fixture.codexHome, 'spectre', 'hooks', 'scripts', 'user-prompt-submit.mjs')}' --host codex`,
              }],
            }],
          }
        : {}),
    },
  };
  fs.writeFileSync(
    path.join(fixture.codexHome, 'hooks.json'),
    `${JSON.stringify(hooks, null, 2)}\n`,
  );
  for (const [present, fileName] of [
    [handler, 'load-knowledge.mjs'],
    [cli, 'knowledge-cli.mjs'],
  ]) {
    if (!present) continue;
    const runtimePath = path.join(
      fixture.codexHome,
      'spectre',
      'hooks',
      'scripts',
      fileName,
    );
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(runtimePath, '// fixture runtime\n');
  }
}

function canonicalRecord(id) {
  return JSON.stringify({
    schemaVersion: 1, id, kind: 'knowledge', title: id,
    summary: `Use when applying ${id}`, tags: [id], applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' },
    relatedRecordIds: [], category: 'pattern', useWhen: `Use when applying ${id}`,
    content: 'Canonical user data.', evidence: 'Doctor fixture.', status: 'active',
  }, null, 2);
}

async function createStore(fixture) {
  return resolveProjectStore(fixture.projectDir, {
    spectreHome: fixture.spectreHome,
  });
}

function writeCanonicalRecord(storePath, id, content = canonicalRecord(id)) {
  const recordPath = path.join(storePath, 'knowledge', id, 'record.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, content);
  return recordPath;
}

function configEntry(skillPath, extra = '') {
  return [
    '[[skills.config]]',
    `path = ${JSON.stringify(skillPath)}`,
    'enabled = true',
    extra,
  ].filter(Boolean).join('\n');
}

test('doctor reports active, absent, disabled, untrusted, and stale SessionStart registry states', { concurrency: false }, async (t) => {
  const active = makeFixture(t);
  writeRegistryRuntime(active);
  const activeStore = await createStore(active);
  writeCanonicalRecord(activeStore.storePath, 'feature-active');
  refreshKnowledgeIndex(activeStore.storePath);

  const activeDoctor = doctorJson(active);
  assert.equal(activeDoctor.knowledge.registry.status, 'active');
  assert.equal(activeDoctor.knowledge.registry.sessionHookConfigured, true);
  assert.equal(activeDoctor.knowledge.registry.handlerPresent, true);
  assert.equal(activeDoctor.knowledge.registry.cliPresent, true);
  assert.equal(activeDoctor.knowledge.registry.promptHookAbsent, true);
  assert.equal(activeDoctor.knowledge.registry.projectTrusted, true);
  assert.equal(activeDoctor.knowledge.store.status, 'valid');
  assert.equal(activeDoctor.knowledge.store.index.status, 'valid');
  assert.equal(activeDoctor.knowledge.nativeDiscovery.status, 'complete');

  for (const [expected, registryOptions] of [
    ['absent', { sessionHook: false, handler: false }],
    ['disabled', { hooksEnabled: false }],
    ['untrusted', { trusted: false }],
    ['stale_prompt_hook', { stalePromptHook: true }],
  ]) {
    const fixture = makeFixture(t);
    writeRegistryRuntime(fixture, registryOptions);
    const doctor = doctorJson(fixture);
    assert.equal(doctor.knowledge.registry.status, expected);
    assert.equal(doctor.knowledge.store.status, 'absent');
  }

  const disabledWithUnrelatedHookSetting = makeFixture(t);
  writeRegistryRuntime(disabledWithUnrelatedHookSetting, { hooksEnabled: false });
  fs.appendFileSync(
    path.join(disabledWithUnrelatedHookSetting.codexHome, 'config.toml'),
    '[user.settings]\nhooks = true\n',
  );
  assert.equal(
    doctorJson(disabledWithUnrelatedHookSetting).knowledge.registry.status,
    'disabled',
  );
});

test('doctor reports native plugin generation, managed agents, and legacy residue', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(path.join(fixture.codexHome, 'agents'), { recursive: true });
  fs.copyFileSync(
    path.resolve('plugins/spectre-codex/agents/spectre_dev.toml'),
    path.join(fixture.codexHome, 'agents', 'spectre_dev.toml'),
  );
  fs.mkdirSync(path.join(fixture.codexHome, 'spectre', 'hooks'), { recursive: true });
  for (const skillName of ['spectre-recall', 'spectre-find']) {
    const skillPath = path.join(fixture.codexHome, 'skills', skillName, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, 'retired managed skill\n');
  }

  const doctor = doctorJson(fixture);
  assert.equal(doctor.nativePlugin.marketplace.targetsGeneratedPlugin, true);
  assert.equal(doctor.nativePlugin.generated.present, true);
  assert.equal(doctor.nativePlugin.generated.version, GENERATED_PLUGIN_VERSION);
  assert.equal(doctor.nativePlugin.generated.hooksUsePluginRoot, true);
  assert.ok(doctor.nativePlugin.generated.agents.includes('spectre_dev.toml'));
  assert.ok(doctor.nativePlugin.agents.installed.includes('spectre_dev.toml'));
  assert.ok(doctor.nativePlugin.agents.missing.includes('spectre_analyst.toml'));
  assert.equal(doctor.nativePlugin.legacyResidue.runtimeDir, true);
  assert.ok(doctor.nativePlugin.legacyResidue.legacySkills.includes('spectre-recall'));
  assert.ok(doctor.nativePlugin.legacyResidue.legacySkills.includes('spectre-find'));
  assert.equal(doctor.nativePlugin.legacyResidue.present, true);
});

test('doctor recognizes the installed native plugin JSON shape and cache capabilities', { concurrency: false }, (t) => {
  const fixture = makeFixture(t);
  const cachePath = path.join(
    fixture.codexHome,
    'plugins',
    'cache',
    'spectre',
    'spectre',
    GENERATED_PLUGIN_VERSION,
  );
  fs.cpSync(path.resolve('plugins/spectre-codex'), cachePath, { recursive: true });
  fs.writeFileSync(
    path.join(cachePath, 'hooks', 'hooks.json'),
    `${JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: 'startup|resume|clear|compact',
          hooks: [{
            type: 'command',
            command: 'node ${PLUGIN_ROOT}/hooks/scripts/load-knowledge.mjs --host codex',
          }],
        }],
      },
    }, null, 2)}\n`,
  );
  fs.copyFileSync(
    path.resolve('plugins/spectre/hooks/scripts/knowledge-cli.mjs'),
    path.join(cachePath, 'hooks', 'scripts', 'knowledge-cli.mjs'),
  );
  fs.rmSync(
    path.join(cachePath, 'hooks', 'scripts', 'user-prompt-submit.mjs'),
    { force: true },
  );
  const targetAgents = path.join(fixture.codexHome, 'agents');
  fs.mkdirSync(targetAgents, { recursive: true });
  for (const entry of fs.readdirSync(path.join(cachePath, 'agents'))) {
    fs.copyFileSync(path.join(cachePath, 'agents', entry), path.join(targetAgents, entry));
  }
  fs.mkdirSync(fixture.codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.codexHome, 'config.toml'),
    `[projects.${JSON.stringify(fixture.projectDir)}]\ntrust_level = "trusted"\n`,
  );

  const fakeBin = path.join(fixture.root, 'bin');
  const fakeCodex = path.join(fakeBin, 'codex');
  fs.mkdirSync(fakeBin, { recursive: true });
  const writeFakeCodex = ({ installed = true, enabled = true } = {}) => {
    fs.writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      "if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.144.6\\n'); process.exit(0); }",
      `process.stdout.write(${JSON.stringify(`${JSON.stringify({
        installed: [{
          pluginId: 'spectre@spectre',
          name: 'spectre',
          marketplaceName: 'spectre',
          version: GENERATED_PLUGIN_VERSION,
          installed,
          enabled,
          source: { source: 'local', path: path.resolve('plugins/spectre-codex') },
        }],
        available: [],
      })}\n`)});`,
    ].join('\n'));
  };
  writeFakeCodex();
  fs.chmodSync(fakeCodex, 0o755);

  const doctor = doctorJson(fixture, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` });
  assert.equal(doctor.nativePlugin.installed.status, 'installed');
  assert.equal(doctor.nativePlugin.installed.versionMatches, true);
  assert.equal(doctor.nativePlugin.installed.installPath, cachePath);
  assert.equal(doctor.nativePlugin.installed.cachePresent, true);
  assert.equal(doctor.nativePlugin.installed.hooks.knowledgeSessionStartConfigured, true);
  assert.equal(doctor.nativePlugin.agents.ready, true);
  assert.equal(doctor.nativePlugin.legacyResidue.present, false);
  assert.equal(doctor.hooks.spectreHooksConfigured, true);
  assert.equal(doctor.hooks.hiddenContextInjection, 'native_plugin_hooks');
  assert.equal(doctor.capabilities.exactWorkflowSkillsInstalled, true);
  assert.equal(doctor.capabilities.subagentsInstalled, true);
  assert.equal(doctor.knowledge.registry.status, 'active');

  writeFakeCodex({ enabled: false });
  const disabled = doctorJson(fixture, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` });
  assert.equal(disabled.nativePlugin.installed.status, 'disabled');
  assert.equal(disabled.nativePlugin.installed.active, false);
  assert.equal(disabled.nativePlugin.installed.cachePresent, true);
  assert.equal(disabled.nativePlugin.installed.hooks.knowledgeSessionStartConfigured, true);
  assert.equal(disabled.hooks.spectreHooksConfigured, false);
  assert.equal(disabled.hooks.hiddenContextInjection, 'none');
  assert.equal(disabled.capabilities.exactWorkflowSkillsInstalled, false);
  assert.equal(disabled.knowledge.registry.status, 'disabled');

  writeFakeCodex({ installed: false });
  const notInstalled = doctorJson(fixture, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` });
  assert.equal(notInstalled.nativePlugin.installed.status, 'not_installed');
  assert.equal(notInstalled.nativePlugin.installed.active, false);
  assert.equal(notInstalled.hooks.spectreHooksConfigured, false);
  assert.equal(notInstalled.hooks.hiddenContextInjection, 'none');
  assert.equal(notInstalled.capabilities.exactWorkflowSkillsInstalled, false);
  assert.equal(notInstalled.knowledge.registry.status, 'absent');
});

test('doctor reports malformed indexes and invalid canonical records without repairing the store', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  writeRegistryRuntime(fixture);
  const resolved = await createStore(fixture);
  const invalidRecordPath = writeCanonicalRecord(
    resolved.storePath,
    'feature-invalid',
    '{"schemaVersion":1}',
  );
  const indexPath = path.join(resolved.storePath, 'index.json');
  fs.writeFileSync(indexPath, '{malformed');
  const indexBytes = fs.readFileSync(indexPath);

  const doctor = doctorJson(fixture);
  assert.equal(doctor.knowledge.store.status, 'invalid');
  assert.equal(doctor.knowledge.store.index.status, 'malformed');
  assert.equal(doctor.knowledge.store.invalidRecords.length, 1);
  assert.equal(doctor.knowledge.store.invalidRecords[0].path, invalidRecordPath);
  assert.match(doctor.knowledge.store.invalidRecords[0].message, /id/);
  assert.deepEqual(fs.readFileSync(indexPath), indexBytes);
});

test('doctor reports corrupt activity and stale transport without mutating either', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  writeRegistryRuntime(fixture);
  const resolved = await createStore(fixture);
  writeCanonicalRecord(resolved.storePath, 'feature-active');
  refreshKnowledgeIndex(resolved.storePath);
  const activityPath = path.join(resolved.storePath, 'activity.json');
  fs.writeFileSync(activityPath, '{broken activity');
  const activityBytes = fs.readFileSync(activityPath);
  const ledgerPath = path.join(resolved.storePath, 'runtime', 'sessions', 'legacy.json');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, 'legacy ledger bytes\n');
  const overridePath = path.join(fixture.projectDir, 'AGENTS.override.md');
  fs.writeFileSync(overridePath, [
    'User bytes.',
    '<!-- spectre-knowledge:start -->',
    'stale knowledge transport',
    '<!-- spectre-knowledge:end -->',
  ].join('\n'));
  const overrideBytes = fs.readFileSync(overridePath);

  const doctor = doctorJson(fixture);
  assert.equal(doctor.knowledge.store.status, 'invalid');
  assert.equal(doctor.knowledge.store.activity.status, 'corrupt');
  assert.equal(doctor.knowledge.store.activity.code, 'KNOWLEDGE_ACTIVITY_CORRUPT');
  assert.equal(doctor.knowledge.stale.status, 'cleanup_required');
  assert.equal(doctor.knowledge.stale.overrideBlockPresent, true);
  assert.equal(doctor.knowledge.stale.promptLedgerPresent, true);
  assert.deepEqual(fs.readFileSync(activityPath), activityBytes);
  assert.deepEqual(fs.readFileSync(overridePath), overrideBytes);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), 'legacy ledger bytes\n');
});

test('doctor reports migration debt and grandfathered Claude native discovery in JSON and human output', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  writeRegistryRuntime(fixture);
  const resolved = await createStore(fixture);
  refreshKnowledgeIndex(resolved.storePath);

  const legacyDir = path.join(
    fixture.projectDir,
    '.claude',
    'skills',
    'feature-grandfathered',
  );
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, 'SKILL.md'),
    `---\nname: feature-grandfathered\ndescription: Grandfathered\n---\n${'x'.repeat(9_100)}\n`,
  );
  fs.writeFileSync(
    path.join(resolved.storePath, 'migration-report.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      grandfatheredClaudeNativeDiscoveryIncomplete: true,
      entries: [{
        id: 'feature-grandfathered',
        code: 'OVERSIZED',
        sourcePaths: [legacyDir],
        registryPaths: [],
        destinationPath: path.join(
          resolved.storePath,
          'knowledge',
          'feature-grandfathered',
        ),
        grandfatheredClaudeNativeDiscovery: true,
      }],
    }, null, 2)}\n`,
  );
  const currentRegistryPath = path.join(
    fixture.projectDir,
    '.agents',
    'skills',
    'spectre-recall',
    'references',
    'registry.toon',
  );
  fs.mkdirSync(path.dirname(currentRegistryPath), { recursive: true });
  fs.writeFileSync(
    currentRegistryPath,
    'feature-late-registry|feature|late registry|Added after the report\n',
  );

  const doctor = doctorJson(fixture);
  assert.equal(doctor.knowledge.migration.status, 'debt');
  assert.equal(doctor.knowledge.migration.unresolvedCount, 2);
  assert.deepEqual(
    doctor.knowledge.migration.issues.find(
      ({ code }) => code === 'UNCLASSIFIED_LEGACY',
    ),
    { code: 'UNCLASSIFIED_LEGACY', count: 1 },
  );
  assert.deepEqual(
    doctor.knowledge.nativeDiscovery.grandfatheredClaudeExceptions.map(({ id }) => id),
    ['feature-grandfathered'],
  );
  assert.equal(
    doctor.knowledge.nativeDiscovery.grandfatheredClaudeExceptions[0]
      .nativeDiscoveryEligible,
    true,
  );
  assert.equal(doctor.knowledge.nativeDiscovery.status, 'grandfathered_claude');

  const human = runCli([
    'doctor',
    'codex',
    '--scope',
    'project',
    '--project-dir',
    fixture.projectDir,
  ], fixture);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Migration debt: 2 unresolved/);
  assert.match(
    human.stdout,
    /Native discovery retirement: incomplete \(1 grandfathered Claude exception\)/,
  );
  assert.match(human.stdout, /feature-grandfathered/);
  assert.match(human.stdout, /still eligible for Claude native discovery/);
});

test('uninstall codex hard cut preserves canonical, unresolved, and unrelated state', { concurrency: false }, async (t) => {
  const fixture = makeFixture(t);
  const resolved = await createStore(fixture);
  const canonicalPath = writeCanonicalRecord(resolved.storePath, 'feature-canonical');
  refreshKnowledgeIndex(resolved.storePath);
  const canonicalBytes = fs.readFileSync(canonicalPath);

  const unresolvedPath = path.join(
    fixture.projectDir,
    '.agents',
    'skills',
    'feature-unresolved',
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(unresolvedPath), { recursive: true });
  fs.writeFileSync(
    unresolvedPath,
    `---\nname: feature-unresolved\ndescription: Unresolved\n---\n${'x'.repeat(9_100)}\n`,
  );
  const unresolvedBytes = fs.readFileSync(unresolvedPath);
  const registryPath = path.join(
    fixture.projectDir,
    '.agents',
    'skills',
    'spectre-recall',
    'references',
    'registry.toon',
  );
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    'feature-unresolved|feature|unresolved|Unresolved legacy record\n',
  );
  const registryBytes = fs.readFileSync(registryPath);

  const unrelatedSkillPath = path.join(
    fixture.projectDir,
    '.agents',
    'skills',
    'team-owned',
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(unrelatedSkillPath), { recursive: true });
  fs.writeFileSync(unrelatedSkillPath, 'team-owned bytes\n');
  const unrelatedSkillBytes = fs.readFileSync(unrelatedSkillPath);

  fs.mkdirSync(fixture.codexHome, { recursive: true });
  const unresolvedConfigEntry = configEntry(
    unresolvedPath,
    '# preserve unresolved native discovery',
  );
  const unrelatedConfigEntry = configEntry(
    unrelatedSkillPath,
    'custom_key = "preserve"',
  );
  fs.writeFileSync(
    path.join(fixture.codexHome, 'config.toml'),
    [
      '# spectre-codex-managed',
      '[features]',
      'hooks = true',
      'skills = true',
      'multi_agent = true',
      '',
      '[agents.spectre_dev]',
      'description = "managed"',
      'config_file = "/managed/dev.toml"',
      '',
      '[user.settings]',
      'keep = "exact"',
      '',
      unresolvedConfigEntry,
      '',
      unrelatedConfigEntry,
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(fixture.codexHome, 'hooks.json'),
    `${JSON.stringify({
      custom: 'preserve',
      hooks: {
        Stop: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'echo unrelated-stop' }],
        }],
        UserPromptSubmit: [{
          hooks: [{
            type: 'command',
            command: `node '${path.join(fixture.codexHome, 'spectre', 'hooks', 'scripts', 'user-prompt-submit.mjs')}' --host codex`,
          }],
        }],
      },
    }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(fixture.codexHome, 'spectre', 'hooks', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.codexHome, 'spectre', 'hooks', 'scripts', 'user-prompt-submit.mjs'),
    '// managed runtime\n',
  );
  fs.mkdirSync(path.join(fixture.projectDir, '.spectre'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.projectDir, '.spectre', 'manifest.json'),
    '{"scope":"project"}\n',
  );
  const configBytes = fs.readFileSync(path.join(fixture.codexHome, 'config.toml'));
  const hooksBytes = fs.readFileSync(path.join(fixture.codexHome, 'hooks.json'));
  const runtimeBytes = fs.readFileSync(
    path.join(fixture.codexHome, 'spectre', 'hooks', 'scripts', 'user-prompt-submit.mjs'),
  );

  const uninstalled = runCli([
    'uninstall',
    'codex',
    '--scope',
    'project',
    '--project-dir',
    fixture.projectDir,
    '--json',
  ], fixture);
  assert.notEqual(uninstalled.status, 0);
  assert.equal(JSON.parse(uninstalled.stdout).code, 'CODEX_PLUGIN_REQUIRED');

  assert.deepEqual(fs.readFileSync(canonicalPath), canonicalBytes);
  assert.deepEqual(fs.readFileSync(unresolvedPath), unresolvedBytes);
  assert.deepEqual(fs.readFileSync(registryPath), registryBytes);
  assert.deepEqual(fs.readFileSync(unrelatedSkillPath), unrelatedSkillBytes);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.codexHome, 'config.toml')),
    configBytes,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.codexHome, 'hooks.json')),
    hooksBytes,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(fixture.codexHome, 'spectre', 'hooks', 'scripts', 'user-prompt-submit.mjs'),
    ),
    runtimeBytes,
  );
  assert.equal(fs.existsSync(path.join(fixture.projectDir, '.spectre', 'manifest.json')), true);
});
