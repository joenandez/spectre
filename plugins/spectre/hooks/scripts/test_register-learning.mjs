#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const REGISTER_BIN = path.resolve('plugins/spectre/bin/spectre-register');
const MIGRATE_BIN = path.resolve('plugins/spectre/bin/spectre-migrate');

function typedKnowledge(id, overrides = {}) {
  return {
    schemaVersion: 1, id, kind: 'knowledge', title: 'Typed registration fixture',
    summary: 'A typed record used by the plugin registration boundary.', tags: ['typed-registration'],
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' }, relatedRecordIds: [],
    category: 'pattern', useWhen: 'Registering a typed test record.', content: 'TYPED_REGISTRATION_SENTINEL',
    evidence: 'Plugin registration test fixture.', status: 'active', ...overrides,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-register-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  return { root, projectDir, spectreHome };
}

function writeProposal(root, record) {
  const directory = path.join(root, record.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return directory;
}

function findOnlyStore(spectreHome) {
  const candidates = [];
  const pending = [path.join(spectreHome, 'projects')];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    if (fs.existsSync(path.join(current, 'project.json'))) candidates.push(current);
    else for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  assert.equal(candidates.length, 1);
  return candidates[0];
}

function run(bin, args, value) {
  return spawnSync(bin, [...args, '--project-root', value.projectDir, '--json'], {
    cwd: value.projectDir,
    encoding: 'utf8',
    env: { ...process.env, SPECTRE_HOME: value.spectreHome },
  });
}

function parsed(result) {
  assert.notEqual(result.stdout.trim(), '', result.stderr);
  return JSON.parse(result.stdout);
}

describe('plugin typed knowledge registration', () => {
  it('when_a_typed_package_is_registered_then_persists_the_typed_record_and_revision_index', (t) => {
    const value = fixture(t);
    const proposal = writeProposal(path.join(value.root, 'proposal'), typedKnowledge('typed-plugin-record'));
    const result = run(REGISTER_BIN, ['--record', proposal], value);

    assert.equal(result.status, 0, result.stderr);
    const output = parsed(result);
    assert.equal(output.status, 'created');
    assert.match(output.revisionToken, /^sha256:[a-f0-9]{64}$/);
    const storePath = findOnlyStore(value.spectreHome);
    const recordPath = path.join(storePath, 'knowledge', 'typed-plugin-record', 'record.json');
    assert.equal(JSON.parse(fs.readFileSync(recordPath, 'utf8')).content, 'TYPED_REGISTRATION_SENTINEL');
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'typed-plugin-record', 'SKILL.md')), false);
    const index = JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'));
    assert.deepEqual(index.records.map(({ id }) => id), ['typed-plugin-record']);
    assert.equal(index.records[0].revisionToken, output.revisionToken);
  });

  it('when_replacing_without_the_current_revision_then_preserves_the_current_typed_package', (t) => {
    const value = fixture(t);
    const initial = writeProposal(path.join(value.root, 'initial'), typedKnowledge('guarded-plugin-record'));
    const created = run(REGISTER_BIN, ['--record', initial], value);
    assert.equal(created.status, 0, created.stderr);
    const replacement = writeProposal(path.join(value.root, 'replacement'), typedKnowledge('guarded-plugin-record', {
      content: 'REPLACEMENT_MUST_NOT_PERSIST',
    }));
    const rejected = run(REGISTER_BIN, ['--record', replacement], value);

    assert.equal(rejected.status, 1);
    assert.equal(parsed(rejected).code, 'KNOWLEDGE_REVISION_REQUIRED');
    const recordPath = path.join(findOnlyStore(value.spectreHome), 'knowledge', 'guarded-plugin-record', 'record.json');
    assert.equal(JSON.parse(fs.readFileSync(recordPath, 'utf8')).content, 'TYPED_REGISTRATION_SENTINEL');
  });

  it('when_a_legacy_skill_is_registered_then_the_plugin_reports_the_retired_write_boundary', (t) => {
    const value = fixture(t);
    const proposal = path.join(value.root, 'legacy-proposal');
    fs.mkdirSync(proposal, { recursive: true });
    const source = '---\nname: legacy-write\n---\n';
    fs.writeFileSync(path.join(proposal, 'SKILL.md'), source);
    const result = run(REGISTER_BIN, ['--record', proposal], value);

    assert.equal(result.status, 1);
    assert.equal(parsed(result).code, 'KNOWLEDGE_LEGACY_WRITE_RETIRED');
    assert.equal(fs.existsSync(value.spectreHome), false);
    assert.equal(fs.readFileSync(path.join(proposal, 'SKILL.md'), 'utf8'), source);
  });
});

describe('plugin migration entry point', () => {
  it('when_a_legacy_registry_entry_exists_then_spectre_migrate_imports_a_typed_work_record_and_receipt', (t) => {
    const value = fixture(t);
    const legacyDir = path.join(value.projectDir, '.claude', 'skills', 'legacy-work');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'SKILL.md'), [
      '---', 'name: legacy-work', 'description: Use when consulting historical work.', '---', '',
      '# Historical work', '', 'LEGACY_WORK_BODY', '',
    ].join('\n'));
    const registry = path.join(value.projectDir, '.claude', 'skills', 'spectre-recall', 'references', 'registry.toon');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, 'legacy-work|feature|legacy import|Use when consulting historical work.\n');

    const result = run(MIGRATE_BIN, [], value);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parsed(result).entries.map(({ code }) => code), ['IMPORTED']);
    const storePath = findOnlyStore(value.spectreHome);
    const recordPath = path.join(storePath, 'knowledge', 'legacy-work', 'record.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.equal(record.kind, 'work');
    assert.equal(record.provenance.origin, 'legacy-import');
    assert.equal(record.importedSource.body, '\n# Historical work\n\nLEGACY_WORK_BODY\n');
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'legacy-work', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'legacy-work', 'imported-source', 'SKILL.md')), true);
    const receipts = JSON.parse(fs.readFileSync(path.join(storePath, 'import-receipts.json'), 'utf8'));
    assert.equal(receipts.receipts[0].recordId, 'legacy-work');
    assert.match(receipts.receipts[0].revisionToken, /^sha256:[a-f0-9]{64}$/);
  });
});
