#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { refreshKnowledgeIndex } from './knowledge/records.mjs';
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
