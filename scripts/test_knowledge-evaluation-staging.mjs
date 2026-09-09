import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { blockKnowledgeRegistration, readSessionStartMeasurement, snapshotKnowledgeCell, stageKnowledgeCell } from './knowledge-evaluation-staging.mjs';
import { compactSnapshot } from './evaluate-knowledge.mjs';
import { createKnowledgeEvaluationSandbox } from './knowledge-evaluation-hosts.mjs';
import { registerCanonicalKnowledge } from '../plugins/spectre/hooks/scripts/knowledge/registration.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-staging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    fixture: {
      task: 'Plan the staged migration.',
      initialFacts: [{ id: 'staged-fact', content: 'Keep both ledgers until reconciliation passes.' }],
    },
    options: { repositoryRoot: REPOSITORY_ROOT, temporaryRoot: root },
  };
}

function runObservedSessionStart(staged) {
  const hooks = JSON.parse(fs.readFileSync(path.join(staged.pluginDir, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooks.hooks.SessionStart.flatMap(group => group.hooks).map(hook => hook.command).find(value => value.includes('knowledge-host-probe-hook.mjs'));
  assert.ok(command, 'staged hook must use the observation wrapper');
  assert.match(command, new RegExp(staged.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(staged.root, 'scripts', 'knowledge-host-probe-hook.mjs')), true);
  return spawnSync('/bin/sh', ['-lc', command], {
    cwd: staged.projectDir,
    env: { ...process.env, SPECTRE_HOME: staged.storeDir, CLAUDE_PROJECT_DIR: staged.projectDir, CLAUDE_PLUGIN_ROOT: staged.pluginDir, PLUGIN_ROOT: staged.pluginDir, CODEX_HOME: staged.codexHome || '' },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: staged.projectDir, session_id: 'staging-test' }),
    encoding: 'utf8',
  });
}

function observedSessionStartCommand(staged) {
  const hooks = JSON.parse(fs.readFileSync(path.join(staged.pluginDir, 'hooks', 'hooks.json'), 'utf8'));
  return hooks.hooks.SessionStart.flatMap(group => group.hooks).map(hook => hook.command).find(value => value.includes('knowledge-host-probe-hook.mjs'));
}

function runSandboxedSessionStart(staged, rawLogDirectory, sessionId) {
  const environment = {
    ...staged.environment, CODEX_HOME: staged.codexHome, CLAUDE_CONFIG_DIR: staged.claudeHome,
    SPECTRE_HOME: staged.storeDir, CLAUDE_PROJECT_DIR: staged.projectDir,
    CLAUDE_PLUGIN_ROOT: staged.pluginDir, PLUGIN_ROOT: staged.pluginDir,
  };
  const sandbox = createKnowledgeEvaluationSandbox({
    preparedFixture: { ...staged, rawDirectory: rawLogDirectory }, command: '/bin/sh', environment,
  });
  return spawnSync(sandbox.command, [...sandbox.args, '-c', observedSessionStartCommand(staged)], {
    cwd: staged.projectDir,
    env: environment,
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: staged.projectDir, session_id: sessionId }),
    encoding: 'utf8',
  });
}

test('stages valid candidate records through the real CLI and native host surfaces', async (t) => {
  const value = fixture(t);
  for (const host of ['claude', 'codex']) {
    const staged = await stageKnowledgeCell({ condition: 'candidate', host }, value.fixture, value.options);
    assert.equal(staged.freshStore, true);
    assert.equal(fs.statSync(staged.claudeHome).isDirectory(), true);
    assert.equal(fs.statSync(staged.codexHome).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(staged.claudePluginDir, 'skills', 'spectre-capture', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(staged.codexPlugin.installedPath, 'skills', 'spectre-capture', 'SKILL.md')), true);
    assert.deepEqual(readSessionStartMeasurement(staged), { availability: 'unavailable', injectedTokens: null, injectedBytes: null });
    assert.equal(staged.probe.search.status, 0, staged.probe.search.stderr);
    assert.equal(staged.probe.load.status, 0, staged.probe.load.stderr);
    assert.equal(staged.probe.search.result.results[0].id, 'staged-fact');
    assert.equal(staged.probe.load.result.record?.id ?? staged.probe.load.result.id, 'staged-fact');
    assert.equal(staged.knownPaths.some((entry) => entry.endsWith('/knowledge/staged-fact/record.json')), true);
    assert.equal(fs.existsSync(path.join(staged.projectDir, '.git')), true);
    assert.equal(fs.existsSync(path.join(staged.pluginDir, 'hooks', 'hooks.json')), true);
    const sessionStart = runObservedSessionStart(staged);
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.ok(JSON.parse(sessionStart.stdout).hookSpecificOutput.additionalContext);
    assert.equal(readSessionStartMeasurement(staged).availability, 'available');
    assert.equal(readSessionStartMeasurement(staged).availability, 'unavailable');
    if (host === 'codex') {
      assert.equal(staged.pluginDir, staged.codexPlugin.installedPath);
      assert.notEqual(staged.pluginDir, staged.sourcePluginDir);
      assert.equal(staged.codexPlugin.listing.installed[0].pluginId, 'spectre@evaluation');
      assert.match(fs.readFileSync(staged.codexPlugin.configPath, 'utf8'), /\[plugins\."spectre@evaluation"\]/);
      assert.equal(fs.existsSync(path.join(staged.codexHome, 'hooks.json')), false);
      assert.equal(fs.existsSync(path.join(staged.pluginDir, 'skills', 'spectre-capture', 'SKILL.md')), true);
    }
  }
});

test('records an actual SessionStart observation through the default-deny host boundary', async (t) => {
  const value = fixture(t);
  for (const host of ['claude', 'codex']) {
    const staged = await stageKnowledgeCell({ condition: 'candidate', host }, value.fixture, value.options);
    const rawLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-host-raw-'));
    t.after(() => fs.rmSync(rawLogDirectory, { recursive: true, force: true }));
    const result = runSandboxedSessionStart(staged, rawLogDirectory, `sandbox-staging-${host}`);
    assert.equal(result.status, 0, `${host}: ${result.stderr}`);
    const observation = fs.existsSync(staged.sessionStartObservationPath)
      ? fs.readFileSync(staged.sessionStartObservationPath, 'utf8') : 'missing observation';
    assert.equal(readSessionStartMeasurement(staged).availability, 'available', `${host}: ${result.stdout}\n${result.stderr}\n${observation}`);
  }
});

test('starts the baseline observer within the default-deny boundary', async (t) => {
  const value = fixture(t);
  for (const host of ['claude', 'codex']) {
    const staged = await stageKnowledgeCell({ condition: 'baseline', host }, value.fixture, value.options);
    const rawLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-host-raw-'));
    t.after(() => fs.rmSync(rawLogDirectory, { recursive: true, force: true }));
    const result = runSandboxedSessionStart(staged, rawLogDirectory, `sandbox-baseline-${host}`);
    assert.equal(result.status, 0, `${host}: ${result.stderr}`);
    assert.equal(fs.existsSync(staged.sessionStartObservationPath), true);
    const observation = JSON.parse(fs.readFileSync(staged.sessionStartObservationPath, 'utf8'));
    assert.equal(observation.host, host);
    assert.equal(observation.hookEventName, 'SessionStart');
    const measurement = readSessionStartMeasurement(staged);
    assert.ok(['available', 'unavailable'].includes(measurement.availability));
  }
});

test('stages the pinned baseline as SKILL.md and verifies its own archived runtime', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'baseline', host: 'claude' }, value.fixture, value.options);
  const skillPath = staged.knownPaths[0];
  assert.equal(staged.provenance.baselineRef, '1cd1f035a253e9d7ef5086693ab9f1d0b11d360b');
  assert.match(staged.provenance.sourceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(skillPath), true);
  assert.equal(fs.existsSync(path.join(path.dirname(skillPath), 'record.json')), false);
  const snapshot = snapshotKnowledgeCell(staged);
  assert.equal(snapshot.records[0].source, fs.readFileSync(skillPath, 'utf8'));
  assert.match(snapshot.records[0].sourceFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(staged.probe.search.status, 0, staged.probe.search.stderr);
  assert.equal(staged.probe.load.status, 0, staged.probe.load.stderr);
  assert.equal(staged.probe.load.result.record?.id ?? staged.probe.load.result.id, 'staged-fact');
  assert.equal(
    fs.readFileSync(path.join(staged.root, 'plugins', 'spectre', 'hooks', 'scripts', 'knowledge', 'payload.mjs'), 'utf8'),
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'plugins', 'spectre', 'hooks', 'scripts', 'knowledge', 'payload.mjs'), 'utf8'),
  );
});

test('no-knowledge stages normal repository evidence without a Spectre plugin or store', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'no-knowledge', host: 'codex' }, value.fixture, value.options);
  assert.equal(staged.pluginDir, null);
  assert.deepEqual(readSessionStartMeasurement(staged), { availability: 'none', injectedTokens: 0, injectedBytes: 0 });
  assert.equal(staged.storeDir, null);
  assert.equal(staged.knownPaths.length, 0);
  assert.equal(fs.existsSync(path.join(staged.projectDir, '.git')), true);
  assert.equal(fs.existsSync(path.join(staged.projectDir, 'TASK.md')), true);
  assert.equal(fs.existsSync(path.join(staged.root, 'plugin')), false);
  assert.equal(fs.existsSync(path.join(staged.root, 'spectre-home')), false);
  assert.equal(fs.statSync(staged.claudeHome).isDirectory(), true);
  assert.equal(fs.statSync(staged.codexHome).isDirectory(), true);
  assert.equal(staged.claudePluginDir, null);
  assert.equal(staged.codexPlugin, null);
  assert.equal(fs.existsSync(path.join(staged.codexHome, 'plugins')), false);
  const config = fs.readFileSync(staged.codexConfigPath, 'utf8');
  assert.match(config, /^web_search\s*=\s*"disabled"$/m);
  assert.match(config, /\[features\][\s\S]*\bapps\s*=\s*false/);
  assert.match(config, /\[features\][\s\S]*\benable_mcp_apps\s*=\s*false/);
  assert.match(config, /\[features\][\s\S]*\bweb_search_request\s*=\s*false/);
});

test('isolates login shells, Git config, and GitHub commands for every condition', async (t) => {
  const value = fixture(t);
  for (const condition of ['candidate', 'baseline', 'no-knowledge']) {
    const staged = await stageKnowledgeCell({ condition, host: 'claude' }, value.fixture, value.options);
    const environment = { ...process.env, ...staged.environment };
    const expectedGh = path.join(staged.root, 'bin', 'gh');
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const result = spawnSync(shell, ['-lc', 'command -v gh; printf "TMP=%s\\n" "$TMPDIR"; gh auth status >/dev/null; gh repo view --json nameWithOwner --jq .nameWithOwner; git config --global --list'], {
        cwd: staged.projectDir, env: environment, encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${condition} ${shell}: ${result.stderr}`);
      assert.equal(result.stdout.split('\n')[0], expectedGh);
      assert.equal(result.stdout.includes(`TMP=${staged.environment.TMPDIR}`), true);
      assert.match(result.stdout, /evaluation-fixture\/knowledge-evaluation/);
    }
    const created = spawnSync('/bin/zsh', ['-lc', 'gh pr create --draft --head evaluation/knowledge-cell --base main --title fixture --body fixture'], {
      cwd: staged.projectDir, env: environment, encoding: 'utf8',
    });
    assert.equal(created.status, 0, `${condition}: ${created.stderr}`);
    assert.match(created.stdout, /github\.com\/evaluation-fixture\/knowledge-evaluation\/pull\/1/);
    assert.match(fs.readFileSync(staged.ghLogPath, 'utf8'), /pr create/);
    assert.equal(JSON.parse(fs.readFileSync(staged.ghStatePath, 'utf8')).pullRequests.length, 1);
    assert.notEqual(staged.environment.HOME, os.homedir());
    assert.notEqual(staged.environment.GIT_CONFIG_GLOBAL, path.join(os.homedir(), '.gitconfig'));
    assert.equal(staged.environment.TMPDIR, staged.environment.TMP);
    assert.equal(staged.environment.TMPDIR, staged.environment.TEMP);
    assert.equal(staged.environment.SSL_CERT_FILE, path.join(staged.root, 'trust', 'cert.pem'));
    assert.equal(fs.readFileSync(staged.environment.SSL_CERT_FILE, 'utf8').includes('BEGIN CERTIFICATE'), true);
  }
});

test('restores pristine activity after preflight and snapshots bounded durable evidence', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'claude' }, value.fixture, value.options);
  const snapshot = snapshotKnowledgeCell(staged);

  assert.deepEqual(snapshot.activity.records, {});
  assert.deepEqual(snapshot.activity.search, { matches: 0, misses: 0, recordMatches: {} });
  const [{ record, recordHash, ...recordMetadata }] = snapshot.records;
  assert.deepEqual(recordMetadata, {
    id: 'staged-fact', kind: 'knowledge', revisionToken: snapshot.records[0].revisionToken,
    status: 'active', applicability: { scope: 'project' },
  });
  assert.equal(record.content, 'Keep both ledgers until reconciliation passes.');
  assert.match(recordHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.workRecords, []);
  assert.match(snapshot.records[0].revisionToken, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.history, []);
  assert.equal(JSON.stringify(snapshot).includes(staged.storePath), false);
  assert.equal(JSON.stringify(snapshot).includes('Keep both ledgers'), true);
});

test('retains captured canonical record evidence after compaction and fixture cleanup', async (t) => {
  const value = fixture(t);
  value.fixture.scaleDistractors = 10;
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'claude' }, value.fixture, value.options);
  const before = snapshotKnowledgeCell(staged);
  const source = JSON.parse(fs.readFileSync(staged.knownPaths.find(entry => entry.endsWith('/staged-fact/record.json')), 'utf8'));
  source.id = 'captured-delivery-note';
  source.title = 'Captured delivery note';
  source.summary = 'Captured factual delivery evidence.';
  source.useWhen = 'Use when reviewing the completed staged delivery.';
  source.content = 'SPECTRE_CAPTURED_DELIVERY_NOTE_BODY';
  const proposal = path.join(staged.root, 'captured-delivery-note');
  fs.mkdirSync(proposal);
  fs.writeFileSync(path.join(proposal, 'record.json'), `${JSON.stringify(source, null, 2)}\n`);
  const registered = await registerCanonicalKnowledge({
    projectDir: staged.projectDir, spectreHome: staged.storeDir, recordPath: proposal,
  });
  assert.equal(registered.status, 'created');

  const compact = compactSnapshot(snapshotKnowledgeCell(staged), ['staged-fact'], before);
  const captured = compact.records.find(record => record.id === 'captured-delivery-note');
  assert.equal(captured.record.content, 'SPECTRE_CAPTURED_DELIVERY_NOTE_BODY');
  assert.match(captured.recordHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(compact.records.some(record => record.id === 'telemetry-checkpoint-00001'), false);

  fs.rmSync(staged.root, { recursive: true, force: true });
  assert.equal(captured.record.content, 'SPECTRE_CAPTURED_DELIVERY_NOTE_BODY');
  assert.match(captured.recordHash, /^sha256:[a-f0-9]{64}$/);
});

test('stages imported work, scoped disputed knowledge, retired status, and tag aliases as real records', async (t) => {
  const value = fixture(t);
  value.fixture.initialFacts = [
    { id: 'legacy-work', kind: 'work', content: 'Historic work source.', tags: ['migration'], aliases: ['migrate'], applicability: { scope: 'work', workId: 'migration-42' } },
    { id: 'unverified-mobile', content: 'Confirm device evidence.', status: 'disputed', tags: ['mobile'], applicability: { scope: 'work', workId: 'mobile-7' } },
    { id: 'retired-pattern', content: 'Prior pattern was replaced.', status: 'superseded', tags: ['retired'] },
  ];
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'codex' }, value.fixture, value.options);
  const snapshot = snapshotKnowledgeCell(staged);
  const byId = Object.fromEntries(snapshot.records.map(record => [record.id, record]));
  const catalog = JSON.parse(fs.readFileSync(path.join(staged.storePath, 'tags.json'), 'utf8'));

  assert.deepEqual(byId['legacy-work'].applicability, { scope: 'work', workId: 'migration-42' });
  assert.deepEqual(byId['legacy-work'].lifecycle, {
    execution: 'unknown', verification: 'unknown', pullRequest: 'unknown',
    associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] },
  });
  assert.deepEqual(snapshot.workRecords, [{
    id: 'legacy-work', revisionToken: byId['legacy-work'].revisionToken,
    execution: 'unknown', verification: 'unknown', pullRequest: 'unknown',
  }]);
  assert.equal(byId['unverified-mobile'].status, 'disputed');
  assert.deepEqual(byId['unverified-mobile'].applicability, { scope: 'work', workId: 'mobile-7' });
  assert.equal(byId['retired-pattern'].status, 'superseded');
  assert.deepEqual(catalog.tags.migration.aliases, ['migrate']);
});


test('stages one concrete pending factual delivery task for every condition', async (t) => {
  const value = fixture(t);
  for (const condition of ['candidate', 'baseline', 'no-knowledge']) {
    const staged = await stageKnowledgeCell({ condition, host: 'claude' }, value.fixture, value.options);
    const branch = spawnSync('git', ['branch', '--show-current'], { cwd: staged.projectDir, encoding: 'utf8' });
    const base = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: staged.projectDir, encoding: 'utf8' });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: staged.projectDir, encoding: 'utf8' });
    const implementation = fs.readFileSync(path.join(staged.projectDir, 'IMPLEMENTATION.md'), 'utf8');
    const execute = fs.readFileSync(path.join(staged.repository.featureRoot, 'specs', 'execute.md'), 'utf8');
    const tasks = JSON.parse(fs.readFileSync(path.join(staged.repository.featureRoot, 'specs', 'tasks.json'), 'utf8'));

    assert.equal(branch.stdout.trim(), 'evaluation/knowledge-cell');
    assert.equal(staged.isolatedGitWorkflow, true);
    assert.equal(base.status, 0, base.stderr);
    assert.equal(base.stdout.trim(), head.stdout.trim(), 'Execute must have the required change still to make');
    assert.equal(fs.existsSync(path.join(staged.repository.originDir, 'HEAD')), true);
    assert.match(implementation, /Task: Plan the staged migration\./);
    assert.match(implementation, /Delivery note: pending\./);
    assert.match(execute, /Source evidence: `TASK\.md` and `EVIDENCE\.md`\./);
    assert.match(execute, /Target: `IMPLEMENTATION\.md` only\./);
    assert.match(execute, /Delivery note: pending\./);
    assert.match(tasks.phases[0].parents[0].description, /IMPLEMENTATION\.md/);
    const neutralEvidence = fs.readFileSync(path.join(staged.projectDir, 'docs', 'task-context.md'), 'utf8');
    assert.match(neutralEvidence, /Keep both ledgers until reconciliation passes/);
    assert.equal(neutralEvidence.includes('knowledge/'), false);
  }
});

test('does not seed future accepted evidence but requires its factual incorporation when supplied', async (t) => {
  const value = fixture(t);
  value.fixture.initialFacts = [];
  value.fixture.workflow = 'Accepted review evidence: stable cursor required; offset pagination rejected.';
  const staged = await stageKnowledgeCell({ condition: 'no-knowledge', host: 'claude' }, value.fixture, value.options);
  const execute = fs.readFileSync(path.join(staged.repository.featureRoot, 'specs', 'execute.md'), 'utf8');
  const allRepositoryBytes = ['TASK.md', 'EVIDENCE.md', 'IMPLEMENTATION.md']
    .map(name => fs.readFileSync(path.join(staged.projectDir, name), 'utf8')).join('\n');

  assert.match(execute, /currently supplied accepted or verified evidence/);
  assert.equal(allRepositoryBytes.includes('stable cursor required'), false);
  assert.equal(allRepositoryBytes.includes('offset pagination rejected'), false);
});

test('can force an actual registration failure without blocking existing reads', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'claude' }, value.fixture, value.options);
  const proposal = path.join(staged.root, 'write-failure-probe');
  fs.mkdirSync(proposal);
  const record = JSON.parse(fs.readFileSync(staged.knownPaths[0], 'utf8'));
  record.id = 'write-failure-probe';
  record.title = 'write-failure-probe';
  fs.writeFileSync(path.join(proposal, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  const fault = blockKnowledgeRegistration(staged);
  try {
    const environment = { ...process.env, SPECTRE_HOME: staged.storeDir };
    const failedSave = spawnSync(process.execPath, [staged.cliPath, 'register', '--record', proposal, '--project-dir', staged.projectDir, '--json'], { cwd: staged.projectDir, env: environment, encoding: 'utf8' });
    const readExisting = spawnSync(process.execPath, [staged.cliPath, 'load', 'staged-fact', '--project-dir', staged.projectDir, '--json'], { cwd: staged.projectDir, env: environment, encoding: 'utf8' });

    assert.notEqual(failedSave.status, 0);
    assert.match(JSON.parse(failedSave.stdout).code, /^(?:EACCES|EPERM|KNOWLEDGE_REGISTRATION_FAILED)$/);
    assert.equal(readExisting.status, 0, readExisting.stderr);
    assert.equal(JSON.parse(readExisting.stdout).record.id, 'staged-fact');
  } finally {
    fault.restore();
  }
});


test('adds neutral deterministic operational notes without publishing a repository catalog', async (t) => {
  const value = fixture(t);
  value.fixture.scaleDistractors = [10, 100];
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'claude' }, value.fixture, value.options);
  const snapshot = snapshotKnowledgeCell(staged);
  const neutralEvidence = fs.readFileSync(path.join(staged.projectDir, 'docs', 'task-context.md'), 'utf8');

  assert.equal(snapshot.records.length, 101);
  assert.equal(snapshot.records.some(record => record.id === 'staged-fact'), true);
  assert.equal(snapshot.records.some(record => record.id === 'telemetry-checkpoint-00100'), true);
  assert.equal(neutralEvidence.includes('telemetry-checkpoint'), false);
  const recordBytes = fs.readFileSync(path.join(staged.storePath, 'knowledge', 'telemetry-checkpoint-00100', 'record.json'), 'utf8').toLocaleLowerCase();
  assert.equal(/distractor|irrelevant|unrelated/.test(recordBytes), false);
});


test('installs the frozen Codex baseline through its isolated marketplace', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'baseline', host: 'codex' }, value.fixture, value.options);

  assert.equal(staged.codexPlugin.listing.installed[0].pluginId, 'spectre@evaluation');
  assert.equal(staged.pluginDir, staged.codexPlugin.installedPath);
  assert.equal(staged.probe.search.status, 0, staged.probe.search.stderr);
  assert.equal(staged.probe.load.status, 0, staged.probe.load.stderr);
  assert.deepEqual(readSessionStartMeasurement(staged), { availability: 'unavailable', injectedTokens: null, injectedBytes: null });
  assert.equal(fs.existsSync(path.join(staged.pluginDir, 'skills', 'spectre-execute', 'SKILL.md')), true);
});


test('stages a frozen historical baseline even when its retired discovery cannot inspect it', async (t) => {
  const value = fixture(t);
  value.fixture.initialFacts[0].status = 'archived';
  const staged = await stageKnowledgeCell({ condition: 'baseline', host: 'claude' }, value.fixture, value.options);

  assert.equal(staged.probe.historical, true);
  assert.equal(staged.probe.search.status, 0);
  assert.notEqual(staged.probe.load.status, 0);
});


test('keeps neutral facts outside the knowledge store when seedKnowledge is false', async (t) => {
  const value = fixture(t);
  value.fixture.initialFacts[0].seedKnowledge = false;
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'claude' }, value.fixture, value.options);

  assert.equal(staged.probe, null);
  assert.deepEqual(snapshotKnowledgeCell(staged).records, []);
  assert.match(fs.readFileSync(path.join(staged.projectDir, 'docs', 'task-context.md'), 'utf8'), /Keep both ledgers/);
});


test('stages the opposing provider plugin mirror without sharing a live home', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'baseline', host: 'codex' }, value.fixture, value.options);

  assert.notEqual(staged.claudePluginDir, staged.pluginDir);
  assert.equal(fs.existsSync(path.join(staged.claudePluginDir, 'skills', 'spectre-execute', 'SKILL.md')), true);
  assert.equal(staged.codexPlugin.installedPath, staged.pluginDir);
  assert.equal(fs.existsSync(path.join(staged.codexHome, 'plugins', 'cache')), true);
});

test('persists disabled Codex Apps and MCP Apps while retaining the isolated plugin', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'claude' }, value.fixture, value.options);
  const config = fs.readFileSync(path.join(staged.codexHome, 'config.toml'), 'utf8');

  assert.match(config, /\[features\][\s\S]*\bapps\s*=\s*false/);
  assert.match(config, /\[features\][\s\S]*\benable_mcp_apps\s*=\s*false/);
  assert.equal(staged.codexPlugin.listing.installed[0].pluginId, 'spectre@evaluation');

  const environment = { ...process.env, ...staged.environment, CODEX_HOME: staged.codexHome };
  const configCheck = spawnSync('codex', ['--strict-config', '--version'], { env: environment, encoding: 'utf8' });
  assert.equal(configCheck.status, 0, configCheck.stderr);
  const features = spawnSync('codex', ['features', 'list'], { env: environment, encoding: 'utf8' });
  assert.equal(features.status, 0, features.stderr);
  assert.match(features.stdout, /^apps\s+stable\s+false$/m);
  assert.match(features.stdout, /^enable_mcp_apps\s+under development\s+false$/m);
  const mcp = spawnSync('codex', ['mcp', 'list'], { env: environment, encoding: 'utf8' });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.match(mcp.stdout, /No MCP servers configured/);
});


test('keeps the relevant payment record reachable among ten thousand neutral operational notes', async (t) => {
  const value = fixture(t);
  value.fixture.initialFacts = [{ id: 'payments-dual-settlement', content: 'Keep the legacy and new settlement ledgers in parallel until reconciliation passes.' }];
  value.fixture.scaleDistractors = 10_000;
  const staged = await stageKnowledgeCell({ condition: 'candidate', host: 'claude' }, value.fixture, value.options);

  assert.equal(staged.knownPaths.length, 10_001);
  assert.equal(staged.probe.search.status, 0, staged.probe.search.stderr);
  assert.equal(staged.probe.search.result.results[0].id, 'payments-dual-settlement');
  const bytes = fs.readFileSync(path.join(staged.storePath, 'knowledge', 'telemetry-checkpoint-10000', 'record.json'), 'utf8').toLocaleLowerCase();
  assert.equal(/distractor|irrelevant|unrelated/.test(bytes), false);
});

test('stages a stateful local GitHub fixture for draft lifecycle operations', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'no-knowledge', host: 'claude' }, value.fixture, value.options);
  const execute = (args) => spawnSync('gh', args, {
    cwd: staged.projectDir, env: { ...process.env, ...staged.environment }, encoding: 'utf8',
  });

  const auth = execute(['auth', 'status']);
  assert.equal(auth.status, 0, auth.stderr);
  assert.match(auth.stdout, /evaluation-fixture/);

  const version = execute(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^gh version .*evaluation fixture/m);

  const createHelp = execute(['pr', 'create', '--help']);
  assert.equal(createHelp.status, 0, createHelp.stderr);
  assert.match(createHelp.stdout, /Usage: gh pr create/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(staged.ghStatePath, 'utf8')).pullRequests, []);

  const repository = execute(['repo', 'view', '--json', 'owner,name,defaultBranchRef']);
  assert.equal(repository.status, 0, repository.stderr);
  assert.deepEqual(JSON.parse(repository.stdout), {
    owner: { login: 'evaluation-fixture' }, name: 'knowledge-evaluation', defaultBranchRef: { name: 'main' },
  });
  const repositoryName = execute(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  assert.equal(repositoryName.status, 0, repositoryName.stderr);
  assert.equal(repositoryName.stdout, 'evaluation-fixture/knowledge-evaluation\n');
  const unsupportedProjection = execute(['repo', 'view', '--json', 'name', '--jq', '.missing']);
  assert.equal(unsupportedProjection.status, 1);

  const missing = execute(['pr', 'view', '--json', 'url,state,isDraft,headRefName,baseRefName']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no open pull request/i);
  const empty = execute(['pr', 'list', '--json', 'url,state,isDraft,headRefName,baseRefName']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), []);

  const bodyPath = path.join(staged.root, 'draft-body.md');
  fs.writeFileSync(bodyPath, 'Opening note.\n\nTesting: pending.\n');
  const created = execute(['pr', 'create', '--draft', '--head', 'evaluation/knowledge-cell', '--base', 'main', '--title', 'Fixture draft', '--body-file', bodyPath]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout.trim(), /^https:\/\/github\.com\/evaluation-fixture\/knowledge-evaluation\/pull\/1$/);

  const viewedUrl = execute(['pr', 'view', '--json', 'url', '--jq', '.url']);
  assert.equal(viewedUrl.status, 0, viewedUrl.stderr);
  assert.equal(viewedUrl.stdout, created.stdout);
  const createdBody = execute(['pr', 'view', '--json', 'body', '--jq', '.body']);
  assert.equal(createdBody.status, 0, createdBody.stderr);
  assert.equal(createdBody.stdout, 'Opening note.\n\nTesting: pending.\n\n');
  const editedBodyPath = path.join(staged.root, 'edited-draft-body.md');
  fs.writeFileSync(editedBodyPath, 'Opening note.\n\nTesting:\n- focused checks passed\n');
  const edited = execute(['pr', 'edit', '--body-file', editedBodyPath]);
  assert.equal(edited.status, 0, edited.stderr);
  const editedBody = execute(['pr', 'view', '--json', 'body', '--jq', '.body']);
  assert.equal(editedBody.status, 0, editedBody.stderr);
  assert.equal(editedBody.stdout, 'Opening note.\n\nTesting:\n- focused checks passed\n\n');
  const viewed = execute(['pr', 'view', '--json', 'url,state,isDraft,headRefName,baseRefName']);
  assert.equal(viewed.status, 0, viewed.stderr);
  assert.deepEqual(JSON.parse(viewed.stdout), {
    url: created.stdout.trim(), state: 'OPEN', isDraft: true,
    headRefName: 'evaluation/knowledge-cell', baseRefName: 'main',
  });
  const listed = execute(['pr', 'list', '--json', 'url,state,isDraft,headRefName,baseRefName']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), [JSON.parse(viewed.stdout)]);
  assert.equal(JSON.parse(fs.readFileSync(staged.ghStatePath, 'utf8')).pullRequests[0].body, 'Opening note.\n\nTesting:\n- focused checks passed\n');

  const duplicate = execute(['pr', 'create', '--draft', '--head', 'evaluation/knowledge-cell', '--base', 'main', '--title', 'Duplicate', '--body', 'Duplicate']);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already has an open pull request/i);

  const closed = execute(['pr', 'close', '1']);
  assert.equal(closed.status, 0, closed.stderr);
  const closedByNumber = execute(['pr', 'view', '1', '--json', 'url,state,isDraft,headRefName,baseRefName']);
  assert.equal(closedByNumber.status, 0, closedByNumber.stderr);
  assert.deepEqual(JSON.parse(closedByNumber.stdout), {
    url: created.stdout.trim(), state: 'CLOSED', isDraft: true,
    headRefName: 'evaluation/knowledge-cell', baseRefName: 'main',
  });
  const closedByUrl = execute(['pr', 'view', created.stdout.trim(), '--json', 'url', '--jq', '.url']);
  assert.equal(closedByUrl.status, 0, closedByUrl.stderr);
  assert.equal(closedByUrl.stdout, created.stdout);
  const noCurrentDraft = execute(['pr', 'view', '--json', 'url']);
  assert.equal(noCurrentDraft.status, 1);

  const recreated = execute(['pr', 'create', '--draft', '--head', 'evaluation/knowledge-cell', '--base', 'main', '--title', 'Second draft', '--body', 'Second body']);
  assert.equal(recreated.status, 0, recreated.stderr);
  assert.match(recreated.stdout.trim(), /\/pull\/2$/);
  const otherBranch = execute(['pr', 'create', '--draft', '--head', 'evaluation/other-branch', '--base', 'main', '--title', 'Other draft', '--body', 'Other body']);
  assert.equal(otherBranch.status, 0, otherBranch.stderr);
  const closedOtherByUrl = execute(['pr', 'close', otherBranch.stdout.trim()]);
  assert.equal(closedOtherByUrl.status, 0, closedOtherByUrl.stderr);
  const state = JSON.parse(fs.readFileSync(staged.ghStatePath, 'utf8'));
  assert.deepEqual(state.pullRequests.map(({ number, state: pullState }) => ({ number, state: pullState })), [
    { number: 1, state: 'CLOSED' }, { number: 2, state: 'OPEN' }, { number: 3, state: 'CLOSED' },
  ]);
  const unsupported = execute(['api', 'repos/example/example']);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /unsupported local gh fixture command/i);
});

test('infers the local draft head under the default-deny host boundary', async (t) => {
  const value = fixture(t);
  const staged = await stageKnowledgeCell({ condition: 'no-knowledge', host: 'claude' }, value.fixture, value.options);
  const rawLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-host-raw-'));
  t.after(() => fs.rmSync(rawLogDirectory, { recursive: true, force: true }));
  const environment = {
    ...process.env, ...staged.environment,
    CODEX_HOME: staged.codexHome, CLAUDE_CONFIG_DIR: staged.claudeHome,
  };
  const sandbox = createKnowledgeEvaluationSandbox({
    preparedFixture: { ...staged, rawDirectory: rawLogDirectory }, command: '/bin/zsh', environment,
  });
  const branch = spawnSync(sandbox.command, [
    ...sandbox.args, '-lc', `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const result = require('node:child_process').spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' }); process.stdout.write(JSON.stringify({ status: result.status, stdout: result.stdout, error: result.error?.message ?? null }));")}`,
  ], { cwd: staged.projectDir, env: environment, encoding: 'utf8' });
  assert.equal(branch.status, 0, branch.stderr);
  assert.deepEqual(JSON.parse(branch.stdout), {
    status: 0, stdout: 'evaluation/knowledge-cell\n', error: null,
  });
  const created = spawnSync(sandbox.command, [
    ...sandbox.args, '-lc', 'gh pr create --draft --base main --title fixture --body fixture',
  ], { cwd: staged.projectDir, env: environment, encoding: 'utf8' });

  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /\/pull\/1\s*$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(staged.ghStatePath, 'utf8')).pullRequests, [{
    number: 1, url: 'https://github.com/evaluation-fixture/knowledge-evaluation/pull/1',
    state: 'OPEN', isDraft: true, headRefName: 'evaluation/knowledge-cell', baseRefName: 'main',
    title: 'fixture', body: 'fixture',
  }]);
});
