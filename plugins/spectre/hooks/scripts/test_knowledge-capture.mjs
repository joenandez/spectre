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

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const BUNDLED_CLI = path.join(SCRIPT_DIR, 'knowledge-cli.mjs');
const NPM_CLI = path.join(REPOSITORY_ROOT, 'bin', 'spectre.js');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
  fs.writeFileSync(path.join(storePath, 'tags.json'), JSON.stringify({
    schemaVersion: 1,
    tags: { authentication: { description: 'Authentication behavior.', aliases: ['auth'] } },
    redirects: { credentials: 'authentication' },
  }, null, 2));
  refreshKnowledgeIndex(storePath);
  return { root, projectDir, spectreHome, storePath };
}

function inputPath(value, name, input) {
  const result = path.join(value.root, name);
  fs.writeFileSync(result, `${JSON.stringify(input, null, 2)}\n`);
  return result;
}

function run(kind, args, value) {
  const command = kind === 'npm' ? NPM_CLI : BUNDLED_CLI;
  const prefix = kind === 'npm' ? ['knowledge'] : [];
  return spawnSync(process.execPath, [command, ...prefix, ...args, '--project-dir', value.projectDir, '--json'], {
    cwd: value.projectDir,
    env: { ...process.env, SPECTRE_HOME: value.spectreHome },
    encoding: 'utf8',
  });
}

function output(result) {
  assert.notEqual(result.stdout.trim(), '', result.stderr);
  return JSON.parse(result.stdout);
}

function knowledgeInput(overrides = {}) {
  return {
    inputVersion: 1,
    id: 'capture-auth-guidance',
    title: 'Capture authentication guidance',
    summary: 'A compact semantic capture fixture.',
    category: 'pattern',
    useWhen: 'Capturing authentication guidance.',
    content: 'Reuse the canonical authentication path.',
    evidence: 'Capture acceptance test.',
    tags: [{ id: 'auth' }],
    ...overrides,
  };
}

function workInput(overrides = {}) {
  return {
    inputVersion: 1,
    title: 'Capture work account',
    summary: 'A compact work capture fixture.',
    requestedOutcome: 'Provide one semantic work capture command.',
    scope: 'The command adapts only the existing typed store authorities.',
    actualChanges: 'Added the capture entry point.',
    reasons: 'The full schema is not agent-authored.',
    discoveries: 'Exact associations allocate stable work identity.',
    verification: 'Focused tests cover the public contract.',
    remainingWork: 'No remaining work is known.',
    relatedContext: 'Knowledge capture authoring feature.',
    tags: [{ id: 'credentials' }],
    ...overrides,
  };
}

function filledTemplate(kind, overrides = {}) {
  const template = JSON.parse(fs.readFileSync(path.join(
    PLUGIN_ROOT, 'skills', 'spectre-capture', 'references', `${kind}-capture-input.json`,
  ), 'utf8'));
  return { ...template, ...(kind === 'knowledge' ? knowledgeInput() : workInput()), ...overrides };
}

describe('semantic knowledge capture', () => {
  it('captures canonicalized tag intent and repeats identical knowledge input as a no-op through both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const source = inputPath(value, `${kind}-knowledge.json`, filledTemplate('knowledge'));
      const created = run(kind, ['capture', '--kind', 'knowledge', '--input', source], value);
      assert.equal(created.status, 0, created.stderr);
      assert.deepEqual(output(created).tags, ['authentication']);
      assert.equal(output(created).status, 'created');

      const repeated = run(kind, ['capture', '--kind', 'knowledge', '--input', source], value);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.equal(output(repeated).status, 'noop');
      assert.deepEqual(output(repeated).tags, ['authentication']);

      const found = run(kind, ['search', '--tag', 'credentials'], value);
      assert.equal(found.status, 0, found.stderr);
      assert.deepEqual(output(found).results.map((entry) => entry.id), ['capture-auth-guidance']);

      const registry = run(kind, ['registry'], value);
      assert.equal(registry.status, 0, registry.stderr);
      assert.match(output(registry).payload.hookSpecificOutput.additionalContext, /authentication: Authentication behavior/);

      const index = JSON.parse(fs.readFileSync(path.join(value.storePath, 'index.json'), 'utf8'));
      assert.deepEqual(index.records.find((entry) => entry.id === 'capture-auth-guidance').tags, ['authentication']);
    }
  });

  it('allocates a work id from an exact association and rejects invalid semantic input before allocation', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const invalid = inputPath(value, `${kind}-invalid.json`, filledTemplate('work', { tags: [] }));
      const rejected = run(kind, ['capture', '--kind', 'work', '--input', invalid, '--source-run-id', 'run-capture'], value);
      assert.equal(rejected.status, 1);
      assert.equal(output(rejected).code, 'CAPTURE_INPUT_INVALID');
      assert.equal(fs.existsSync(path.join(value.storePath, 'work-associations.json')), false);

      const source = inputPath(value, `${kind}-work.json`, filledTemplate('work'));
      const created = run(kind, ['capture', '--kind', 'work', '--input', source, '--source-run-id', 'run-capture'], value);
      assert.equal(created.status, 0, created.stderr);
      const captured = output(created);
      assert.match(captured.workId, /^work-/);
      assert.deepEqual(captured.tags, ['authentication']);

      const resolved = run(kind, ['work', 'resolve', '--source-run-id', 'run-capture'], value);
      assert.equal(resolved.status, 0, resolved.stderr);
      assert.equal(output(resolved).workId, captured.workId);
    }
  });

  it('preserves omitted tags on a revision-guarded update and replaces them only when explicitly supplied', async (t) => {
    const value = await fixture(t);
    const initial = inputPath(value, 'initial.json', knowledgeInput());
    const created = run('bundled', ['capture', '--kind', 'knowledge', '--input', initial], value);
    assert.equal(created.status, 0, created.stderr);
    const revision = output(created).revisionToken;

    const omitted = inputPath(value, 'omitted.json', knowledgeInput({ evidence: 'Updated capture acceptance test.', tags: undefined }));
    const updated = run('bundled', ['capture', '--kind', 'knowledge', '--input', omitted, '--expected-revision', revision], value);
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(output(updated).status, 'updated');
    assert.deepEqual(output(updated).tags, ['authentication']);

    const replacement = inputPath(value, 'replacement.json', knowledgeInput({
      evidence: 'Replacement tag capture acceptance test.',
      tags: [{ id: 'capture', description: 'Semantic capture behavior.' }],
    }));
    const replaced = run('bundled', ['capture', '--kind', 'knowledge', '--input', replacement, '--expected-revision', output(updated).revisionToken], value);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.deepEqual(output(replaced).tags, ['capture']);
  });

  it('rejects a record-id flag that conflicts with semantic knowledge identity', async (t) => {
    const value = await fixture(t);
    const source = inputPath(value, 'identity.json', knowledgeInput());
    const result = run('bundled', ['capture', '--kind', 'knowledge', '--input', source, '--record-id', 'other-record'], value);
    assert.equal(result.status, 1);
    assert.equal(output(result).code, 'CAPTURE_INPUT_INVALID');
    assert.equal(fs.existsSync(path.join(value.storePath, 'knowledge', 'capture-auth-guidance')), false);
  });
});
