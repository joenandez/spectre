#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { refreshKnowledgeIndex } from './knowledge/records.mjs';
import { registerCanonicalKnowledge } from './knowledge/registration.mjs';
import { resolveProjectStore } from './knowledge/store.mjs';
import { resolveOrAllocateWorkIdentity } from './knowledge/work.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const NPM_CLI = path.join(REPOSITORY_ROOT, 'bin', 'spectre.js');
const BUNDLED_CLI = path.join(SCRIPT_DIR, 'knowledge-cli.mjs');
const REGISTER_WRAPPER = path.join(SCRIPT_DIR, 'register_learning.mjs');
const MIGRATE_WRAPPER = path.join(SCRIPT_DIR, 'migrate_knowledge.mjs');

function typedRecord(id, tags = ['cli-test']) {
  return {
    schemaVersion: 1, id, kind: 'knowledge', title: 'Public CLI record',
    summary: 'Typed fixture for public CLI parity.', tags, applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' },
    relatedRecordIds: [], category: 'pattern', useWhen: 'Testing public knowledge callers.',
    content: 'SPECTRE_TYPED_CLI_SENTINEL', evidence: 'A typed CLI test fixture.', status: 'active',
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
  const id = 'typed-cli-record';
  const recordPath = path.join(storePath, 'knowledge', id, 'record.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(typedRecord(id), null, 2)}\n`);
  fs.writeFileSync(path.join(storePath, 'tags.json'), JSON.stringify({
    schemaVersion: 1,
    tags: { 'cli-test': { description: 'Public CLI test coverage.', aliases: ['cli'] } },
    redirects: {},
  }, null, 2));
  refreshKnowledgeIndex(storePath);
  return { root, projectDir, spectreHome, storePath, id };
}

function run(kind, args, value, { json = true } = {}) {
  const command = kind === 'npm' ? NPM_CLI : BUNDLED_CLI;
  const prefix = kind === 'npm' ? ['knowledge'] : [];
  return spawnSync(process.execPath, [command, ...prefix, ...args, '--project-dir', value.projectDir, ...(json ? ['--json'] : [])], {
    cwd: value.projectDir, env: { ...process.env, SPECTRE_HOME: value.spectreHome }, encoding: 'utf8',
  });
}

function runHelp(kind) {
  const command = kind === 'npm' ? NPM_CLI : BUNDLED_CLI;
  const prefix = kind === 'npm' ? [] : [];
  return spawnSync(process.execPath, [command, ...prefix, 'help'], { encoding: 'utf8' });
}

function writeInput(value, name, input) {
  const inputPath = path.join(value.root, name);
  fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  return inputPath;
}

function runWrapper(script, args, value) {
  return spawnSync(process.execPath, [script, ...args, '--project-dir', value.projectDir, '--json'], {
    cwd: value.projectDir, env: { ...process.env, SPECTRE_HOME: value.spectreHome }, encoding: 'utf8',
  });
}

function output(result) {
  assert.notEqual(result.stdout.trim(), '', result.stderr);
  return JSON.parse(result.stdout);
}

describe('typed public knowledge CLI parity', () => {
  it('sends repeated tags and paths to equivalent search callers, then exact-loads the typed package', async (t) => {
    const value = await fixture(t);
    const args = ['search', 'public CLI', '--tag', 'cli', '--tag', 'cli-test', '--path', 'src', '--path', 'plugins'];
    const bundled = run('bundled', args, value);
    const npm = run('npm', args, value);
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.equal(npm.status, 0, npm.stderr);
    assert.deepEqual(output(bundled), output(npm));
    assert.deepEqual(output(npm).results.map(result => result.id), [value.id]);

    for (const kind of ['bundled', 'npm']) {
      const loaded = run(kind, ['load', value.id, '--work-id', 'work-cli', '--run-id', 'run-cli', '--allowance-tokens', '1500'], value);
      assert.equal(loaded.status, 0, loaded.stderr);
      assert.equal(output(loaded).record.content, 'SPECTRE_TYPED_CLI_SENTINEL');
    }
  });

  it('labels historical previews and routes inactive exact loads to deliberate inspection', async (t) => {
    const value = await fixture(t);
    const inactiveId = 'notification-batch-history';
    const inactive = typedRecord(inactiveId);
    inactive.summary = 'Archived notification batch history.';
    inactive.useWhen = 'Use when investigating notification batch history.';
    inactive.content = 'SPECTRE_ARCHIVED_NOTIFICATION_BODY';
    inactive.status = 'archived';
    const inactivePath = path.join(value.storePath, 'knowledge', inactiveId, 'record.json');
    fs.mkdirSync(path.dirname(inactivePath), { recursive: true });
    fs.writeFileSync(inactivePath, `${JSON.stringify(inactive, null, 2)}\n`);
    refreshKnowledgeIndex(value.storePath);

    const human = run('bundled', ['search', 'notification batch history'], value, { json: false });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /notification-batch-history \[knowledge\] \[historical: inactive-history\]/);
    assert.match(human.stdout, /load notification-batch-history --inspect-historical --project-dir <project-dir>/);

    const json = run('bundled', ['search', 'notification batch history'], value);
    assert.equal(json.status, 0, json.stderr);
    const preview = output(json).results.find(result => result.id === inactiveId);
    assert.equal(preview.activation, 'inactive-history');
    assert.match(preview.loadCommand, /load notification-batch-history --inspect-historical --project-dir <project-dir>/);

    const blocked = run('bundled', ['load', inactiveId], value);
    assert.equal(blocked.status, 1);
    assert.equal(output(blocked).code, 'KNOWLEDGE_NOT_ACTIVE');
    assert.match(output(blocked).inspectionCommand, /load notification-batch-history --inspect-historical --project-dir <project-dir>/);

    const inspected = run('bundled', ['load', inactiveId, '--inspect-historical'], value);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(output(inspected).historical, true);
    assert.equal(output(inspected).record.content, 'SPECTRE_ARCHIVED_NOTIFICATION_BODY');
  });

  it('has matching safe JSON failures and forwards guarded registration revision', async (t) => {
    const value = await fixture(t);
    for (const kind of ['bundled', 'npm']) {
      const missing = run(kind, ['inspect', value.id], value);
      assert.equal(missing.status, 1);
      assert.equal(output(missing).code, 'KNOWLEDGE_INVALID');
    }
    const proposal = path.join(value.root, 'proposal', 'typed-cli-record');
    fs.mkdirSync(proposal, { recursive: true });
    fs.writeFileSync(path.join(proposal, 'record.json'), JSON.stringify(typedRecord(value.id, ['replacement'])));
    for (const kind of ['bundled', 'npm']) {
      const rejected = run(kind, ['register', '--record', proposal, '--expected-revision', 'sha256:0000000000000000000000000000000000000000000000000000000000000000'], value);
      assert.equal(rejected.status, 1);
      assert.equal(output(rejected).code, 'KNOWLEDGE_REVISION_CONFLICT');
    }
  });

  it('exposes structured tag ensure and merge commands in both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const ensured = run(kind, ['tags', 'ensure', '--input', writeInput(value, `${kind}-ensure.json`, {
        operation: 'ensure',
        tags: [{ id: 'cli-extra', description: 'An additional public CLI tag.', aliases: ['extra-cli'] }],
      })], value);
      assert.equal(ensured.status, 0, ensured.stderr);
      assert.equal(output(ensured).tags[0].id, 'cli-extra');

      const merged = run(kind, ['tags', 'merge', '--input', writeInput(value, `${kind}-merge.json`, {
        operation: 'merge', from: ['cli-extra'], into: 'cli-test', revision: 'ignored',
        expectedRevision: output(ensured).revision,
      })], value);
      assert.equal(merged.status, 0, merged.stderr);
      assert.deepEqual(output(merged).retired, ['cli-extra']);
      assert.equal(output(merged).redirects['cli-extra'], 'cli-test');

      const help = runHelp(kind);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /tags ensure --input <json>/);
      assert.match(help.stdout, /tags merge --input <json>/);
      assert.match(help.stdout, /work and inactive records require --inspect-historical/);
    }
  });

  it('resolves an exact source run through either supported public flag', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const work = await resolveOrAllocateWorkIdentity({
        projectDir: value.projectDir, spectreHome: value.spectreHome, sourceRunId: 'run-cli-alias',
      });
      const sourceRun = run(kind, ['work', 'resolve', '--source-run-id', 'run-cli-alias'], value);
      const runAlias = run(kind, ['work', 'resolve', '--run-id', 'run-cli-alias'], value);
      assert.equal(sourceRun.status, 0, sourceRun.stderr);
      assert.equal(runAlias.status, 0, runAlias.stderr);
      assert.deepEqual(output(runAlias), output(sourceRun));
      assert.equal(output(runAlias).workId, work.workId);

      const conflict = run(kind, ['work', 'resolve', '--source-run-id', 'run-cli-alias', '--run-id', 'run-other'], value);
      assert.equal(conflict.status, 1);
      assert.equal(output(conflict).code, 'WORK_SOURCE_RUN_CONFLICT');
    }
  });

  it('preserves create, noop, and typed registration precondition errors across public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const proposal = path.join(value.root, 'proposals', `${kind}-created`);
      fs.mkdirSync(proposal, { recursive: true });
      fs.writeFileSync(path.join(proposal, 'record.json'), JSON.stringify(typedRecord(`${kind}-created`)));
      const created = run(kind, ['register', '--record', proposal], value);
      assert.equal(created.status, 0, created.stderr);
      assert.equal(output(created).status, 'created');
      const noop = run(kind, ['register', '--record', proposal], value);
      assert.equal(noop.status, 0, noop.stderr);
      assert.equal(output(noop).status, 'noop');

      const replacement = path.join(value.root, 'replacement', value.id);
      fs.mkdirSync(replacement, { recursive: true });
      fs.writeFileSync(path.join(replacement, 'record.json'), JSON.stringify(typedRecord(value.id, ['replacement'])));
      const missingExpected = run(kind, ['register', '--record', replacement], value);
      assert.equal(missingExpected.status, 1);
      const missing = output(missingExpected);
      assert.deepEqual(Object.keys(missing).sort(), ['code', 'currentRevision', 'message', 'ok', 'status']);
      assert.equal(missing.code, 'KNOWLEDGE_REVISION_REQUIRED');
      assert.equal(missing.status, 'conflict');
      assert.match(missing.currentRevision, /^sha256:[a-f0-9]{64}$/);

      const staleRevision = `sha256:${'0'.repeat(64)}`;
      const staleExpected = run(kind, ['register', '--record', replacement, '--expected-revision', staleRevision], value);
      assert.equal(staleExpected.status, 1);
      const stale = output(staleExpected);
      assert.deepEqual(Object.keys(stale).sort(), ['code', 'currentRevision', 'expectedRevision', 'message', 'ok', 'status']);
      assert.equal(stale.code, 'KNOWLEDGE_REVISION_CONFLICT');
      assert.equal(stale.status, 'conflict');
      assert.equal(stale.expectedRevision, staleRevision);
      assert.equal(stale.currentRevision, missing.currentRevision);
    }
  });

  it('keeps register and migrate wrapper results aligned with the canonical typed CLI', async (t) => {
    const value = await fixture(t);
    const proposalId = 'wrapper-typed-record';
    const proposal = path.join(value.root, 'proposal', proposalId);
    fs.mkdirSync(proposal, { recursive: true });
    fs.writeFileSync(path.join(proposal, 'record.json'), JSON.stringify(typedRecord(proposalId)));

    const registered = runWrapper(REGISTER_WRAPPER, ['--record', proposal], value);
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(output(registered).status, 'created');
    const noop = run('bundled', ['register', '--record', proposal], value);
    assert.equal(noop.status, 0, noop.stderr);
    assert.equal(output(noop).status, 'noop');

    const wrappedMigration = runWrapper(MIGRATE_WRAPPER, [], value);
    const canonicalMigration = run('bundled', ['migrate'], value);
    assert.equal(wrappedMigration.status, 0, wrappedMigration.stderr);
    assert.equal(canonicalMigration.status, 0, canonicalMigration.stderr);
    assert.deepEqual(output(wrappedMigration), output(canonicalMigration));

    const invalid = path.join(value.root, 'invalid-proposal');
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, 'record.json'), '{"schemaVersion":1}\n');
    const wrapperFailure = runWrapper(REGISTER_WRAPPER, ['--record', invalid], value);
    const canonicalFailure = run('bundled', ['register', '--record', invalid], value);
    assert.equal(wrapperFailure.status, 1);
    assert.equal(canonicalFailure.status, 1);
    assert.equal(output(wrapperFailure).code, output(canonicalFailure).code);
    assert.match(output(wrapperFailure).message, /<exact-id>\/record\.json/);
    assert.match(output(canonicalFailure).message, /<exact-id>\/record\.json/);
  });
});

const FIXTURE_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Spectre Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@spectre.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
  GIT_COMMITTER_NAME: 'Spectre Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@spectre.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function gitRaw(repoDir, args, input) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd: repoDir, encoding: 'utf8', env: { ...process.env, ...FIXTURE_GIT_ENV },
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

function git(repoDir, args, input) {
  return gitRaw(repoDir, args, input).trim();
}

function patchIdOf(repoDir, sha) {
  const patch = gitRaw(repoDir, ['diff-tree', '-p', '--no-color', '--root', '--full-index', '--binary', '--no-ext-diff', '--no-textconv', sha]);
  if (!patch.trim()) return null;
  const [id] = git(repoDir, ['patch-id', '--stable'], patch).split(/\s+/);
  return id || null;
}

function commit(repoDir, message, files) {
  for (const [relativePath, contents] of Object.entries(files)) fs.writeFileSync(path.join(repoDir, relativePath), contents);
  git(repoDir, ['add', '--all']);
  git(repoDir, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function workFixtureRecord(id, { sourceRunId, receipt, pullRequestIds = [], sourceBranch }) {
  return {
    schemaVersion: 1, id, kind: 'work', title: `Work record ${id}`,
    summary: 'A typed work fixture that owns exact identity associations.', tags: [],
    applicability: { scope: 'work', workId: id },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z', ...(sourceBranch ? { sourceBranch } : {}) },
    relatedRecordIds: [],
    work: {
      requestedOutcome: 'Record one exact work association.', scope: 'The identity fixture only.',
      actualChanges: 'Registered the typed fixture.', reasons: 'Verify the public delivery CLI.',
      discoveries: 'Associations belong to the verified work record.', verification: 'Focused node tests.',
      remainingWork: 'None.', relatedContext: 'Test fixture.',
      execution: { state: 'acceptance-pending' }, verificationState: { state: 'not-run' },
      pullRequest: { state: 'none' },
      associations: { sourceRunIds: [sourceRunId], pullRequestIds, candidates: [] },
      ...(receipt ? { deliveryReceipt: receipt } : {}),
    },
  };
}

/** One branch carrying selectable work, already-delivered work, and a receipt-less legacy record. */
async function deliveryFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-cli-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  git(projectDir, ['init', '--quiet', '-b', 'main']);
  const seed = commit(projectDir, 'seed', { 'README.md': 'seed\n' });
  git(projectDir, ['checkout', '--quiet', '-b', 'feature']);
  const alpha = commit(projectDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
  const beta = commit(projectDir, 'run B: beta', { 'beta.txt': 'b1\n' });
  const candidate = {
    repository: 'github.com/example/spectre',
    base: git(projectDir, ['merge-base', 'main', 'HEAD']),
    head: git(projectDir, ['rev-parse', 'HEAD']),
    diff: `sha256:${'c'.repeat(64)}`,
  };
  const receipt = (runId, startHead, terminalHead) => ({
    runId, branch: 'feature', startHead, terminalHead, acceptedCommits: [terminalHead],
    acceptedPatchIds: [patchIdOf(projectDir, terminalHead)],
  });
  const records = [
    workFixtureRecord('work-beta', { sourceRunId: 'run-beta', receipt: receipt('run-beta', alpha, beta) }),
    workFixtureRecord('work-legacy', { sourceRunId: 'run-legacy', sourceBranch: 'feature' }),
    workFixtureRecord('work-shipped', {
      sourceRunId: 'run-shipped', pullRequestIds: ['github:example/spectre#7'], receipt: receipt('run-shipped', alpha, beta),
    }),
    workFixtureRecord('work-alpha', { sourceRunId: 'run-alpha', receipt: receipt('run-alpha', seed, alpha) }),
  ];
  for (const record of records) {
    const proposal = path.join(root, 'proposals', record.id);
    fs.mkdirSync(proposal, { recursive: true });
    fs.writeFileSync(path.join(proposal, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
    await registerCanonicalKnowledge({ projectDir, spectreHome, recordPath: proposal });
  }
  return { root, projectDir, spectreHome, candidate, branch: 'feature' };
}

const PULL_REQUEST_ID = 'github:example/spectre#12';

function membershipArgs(value) {
  return ['work', 'membership', '--branch', value.branch, '--candidate', JSON.stringify(value.candidate)];
}

function associateArgs(value, { workIds, expectedRevisions }) {
  return [
    'work', 'associate',
    ...workIds.flatMap(workId => ['--work-id', workId]),
    '--pull-request-id', PULL_REQUEST_ID,
    '--candidate', JSON.stringify(value.candidate),
    '--pull-request', JSON.stringify({ state: 'draft-open', identity: PULL_REQUEST_ID, url: 'https://example.invalid/pull/12' }),
    ...(expectedRevisions ? ['--expected-revisions', JSON.stringify(expectedRevisions)] : []),
  ];
}

describe('public delivery CLI parity', () => {
  it('answers one branch and candidate tuple with deterministic selected, excluded, and ambiguous ids', async (t) => {
    const bundledFixture = await deliveryFixture(t);
    const npmFixture = await deliveryFixture(t);
    const bundled = run('bundled', membershipArgs(bundledFixture), bundledFixture);
    const npm = run('npm', membershipArgs(npmFixture), npmFixture);
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.equal(npm.status, 0, npm.stderr);
    assert.equal(bundled.stdout, npm.stdout);

    const selection = output(bundled);
    assert.equal(selection.ok, true);
    assert.equal(selection.branch, 'feature');
    assert.deepEqual(selection.selected, ['work-alpha', 'work-beta']);
    assert.deepEqual(selection.excluded, ['work-legacy', 'work-shipped']);
    assert.deepEqual(selection.ambiguous, []);
    assert.deepEqual(
      selection.evaluations.filter(entry => entry.verdict === 'excluded').map(entry => [entry.workId, entry.reason]),
      [['work-legacy', 'receipt-absent'], ['work-shipped', 'pull-request-associated']],
    );

    const repeated = run('bundled', membershipArgs(bundledFixture), bundledFixture);
    assert.equal(repeated.stdout, bundled.stdout);
  });

  it('rejects a membership query without exact branch and candidate evidence in both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await deliveryFixture(t);
      const missingBranch = run(kind, ['work', 'membership', '--candidate', JSON.stringify(value.candidate)], value);
      assert.equal(missingBranch.status, 1);
      assert.equal(output(missingBranch).code, 'WORK_QUERY_INVALID');

      const malformed = run(kind, ['work', 'membership', '--branch', value.branch, '--candidate', '{not json'], value);
      assert.equal(malformed.status, 1);
      assert.equal(output(malformed).code, 'WORK_DELIVERY_INPUT_INVALID');
    }
  });

  it('keeps singular exact-run resolution answering one work id beside the plural query', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await deliveryFixture(t);
      const resolved = run(kind, ['work', 'resolve', '--source-run-id', 'run-alpha'], value);
      assert.equal(resolved.status, 0, resolved.stderr);
      assert.deepEqual(output(resolved), { status: 'resolved', workId: 'work-alpha' });
    }
  });

  it('associates one pull request with a frozen work-id set and returns per-record revisions', async (t) => {
    const results = [];
    for (const kind of ['bundled', 'npm']) {
      const value = await deliveryFixture(t);
      const args = associateArgs(value, { workIds: ['work-beta', 'work-alpha'] });
      const associated = run(kind, args, value);
      assert.equal(associated.status, 0, associated.stderr);
      const noop = run(kind, args, value);
      assert.equal(noop.status, 0, noop.stderr);
      results.push([associated.stdout, noop.stdout]);

      const payload = output(associated);
      assert.equal(payload.status, 'associated');
      assert.equal(payload.pullRequestId, PULL_REQUEST_ID);
      assert.deepEqual(payload.succeeded.map(entry => entry.workId), ['work-alpha', 'work-beta']);
      for (const entry of payload.succeeded) assert.match(entry.revision, /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(payload.remaining, []);
      assert.equal(payload.retry, null);
      assert.equal(output(noop).status, 'noop');
    }
    assert.deepEqual(results[0], results[1]);
  });

  it('passes partial recovery, including retry, through both public CLIs intact', async (t) => {
    const outputs = [];
    for (const kind of ['bundled', 'npm']) {
      const value = await deliveryFixture(t);
      const stale = run(kind, associateArgs(value, {
        workIds: ['work-alpha', 'work-beta'],
        expectedRevisions: { 'work-beta': `sha256:${'0'.repeat(64)}` },
      }), value);
      assert.equal(stale.status, 1);
      const partial = output(stale);
      assert.equal(partial.ok, false);
      assert.equal(partial.status, 'partial');
      assert.deepEqual(partial.succeeded.map(entry => entry.workId), ['work-alpha']);
      assert.deepEqual(partial.remaining.map(entry => entry.code), ['KNOWLEDGE_REVISION_CONFLICT']);
      assert.deepEqual(partial.retry.workIds, ['work-beta']);
      assert.match(partial.retry.expectedRevisions['work-beta'], /^sha256:[a-f0-9]{64}$/);
      assert.equal(typeof partial.remaining[0].recovery, 'string');

      const retried = run(kind, associateArgs(value, {
        workIds: partial.retry.workIds, expectedRevisions: partial.retry.expectedRevisions,
      }), value);
      assert.equal(retried.status, 0, retried.stderr);
      assert.equal(output(retried).status, 'associated');
      outputs.push([stale.stdout, retried.stdout]);
    }
    assert.deepEqual(outputs[0], outputs[1]);
  });

  it('carries a start-only delivery receipt through the existing capture command and retires the branch PR state hint', async (t) => {
    const captured = [];
    for (const kind of ['bundled', 'npm']) {
      const value = await deliveryFixture(t);
      const receipt = {
        runId: 'run-captured', branch: 'feature',
        startHead: git(value.projectDir, ['rev-parse', 'HEAD~1']),
        terminalHead: value.candidate.head,
        acceptedCommits: [value.candidate.head],
        acceptedPatchIds: [patchIdOf(value.projectDir, value.candidate.head)],
      };
      const inputPath = writeInput(value, `${kind}-work-capture.json`, {
        inputVersion: 1,
        title: 'Captured delivery receipt', summary: 'A work capture that carries its own run receipt.',
        requestedOutcome: 'Carry a receipt through capture.', scope: 'The capture surface only.',
        actualChanges: 'Captured one work record.', reasons: 'Confirm receipt-aware capture.',
        discoveries: 'The receipt survives the CLI boundary.', verification: 'Focused node tests.',
        remainingWork: 'None.', relatedContext: 'CLI parity fixture.', deliveryReceipt: receipt,
        tags: [{ id: 'delivery-cli', description: 'Receipt-aware capture coverage for the public CLI.' }],
      });
      const result = run(kind, ['capture', '--kind', 'work', '--input', inputPath, '--source-run-id', 'run-captured', '--branch', 'feature'], value);
      assert.equal(result.status, 0, result.stderr);
      const loaded = run(kind, ['load', output(result).id, '--inspect-historical'], value);
      assert.equal(loaded.status, 0, loaded.stderr);
      // Terminal evidence derives only from run evidence, so capture input contributes the start alone.
      assert.deepEqual(output(loaded).record.work.deliveryReceipt, {
        runId: receipt.runId, branch: receipt.branch, startHead: receipt.startHead,
      });
      assert.equal(output(loaded).record.provenance.sourceBranch, 'feature');
      captured.push(output(loaded).record.work.deliveryReceipt);

      const retired = run(kind, ['capture', '--kind', 'work', '--input', inputPath, '--source-run-id', 'run-captured', '--branch-pr-state', 'open'], value);
      assert.equal(retired.status, 1);
      assert.equal(output(retired).code, 'CAPTURE_BRANCH_PR_STATE_RETIRED');
    }
    assert.deepEqual(captured[0], captured[1]);
  });
});
