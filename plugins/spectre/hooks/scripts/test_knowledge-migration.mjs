#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadKnowledgeById } from './knowledge/loader.mjs';
import { registerCanonicalKnowledge } from './knowledge/registration.mjs';
import { resolveProjectStore } from './knowledge/store.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'migration.mjs');
const fixedNow = () => Date.parse('2026-09-06T00:00:00.000Z');

function makeTmp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-migration-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function legacySkill(id, description = `Use when applying ${id}`, body = '\n# Legacy source\n') {
  return ['---', `name: ${id}`, `description: ${description}`, '---', body].join('\n');
}

function addLegacySource(projectDir, id, content, resources = {}) {
  const sourceDir = path.join(projectDir, '.claude', 'skills', id);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), content);
  for (const [relativePath, bytes] of Object.entries(resources)) {
    const target = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const registry = path.join(projectDir, '.claude', 'skills', 'spectre-recall', 'references', 'registry.toon');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.appendFileSync(registry, `${id}|feature|legacy import|Use when importing ${id}\n`);
  return sourceDir;
}

function sourceDigest(sourceDir) {
  const entries = [];
  const pending = [sourceDir];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile()) entries.push([path.relative(sourceDir, entryPath), fs.readFileSync(entryPath)]);
    }
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const [relativePath, bytes] of entries) {
    hash.update(relativePath); hash.update('\0'); hash.update(bytes); hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function typedWork(id, title) {
  return {
    schemaVersion: 1,
    id,
    kind: 'work',
    title,
    summary: 'A typed record used to protect a legacy-write boundary.',
    tags: [],
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' },
    relatedRecordIds: [],
    work: {
      requestedOutcome: 'known test record', scope: 'known test record',
      actualChanges: 'known test record', reasons: 'known test record',
      discoveries: 'known test record', verification: 'known test record',
      remainingWork: 'known test record', relatedContext: 'known test record',
      execution: { state: 'unknown' }, verificationState: { state: 'unknown' },
      pullRequest: { state: 'unknown' },
      associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] },
    },
  };
}

async function migrate(options) {
  const { migrateLegacyKnowledge } = await import(`${pathToFileURL(MIGRATION_MODULE).href}?${Date.now()}`);
  return migrateLegacyKnowledge(options);
}

describe('recoverable legacy-to-work import', () => {
  it('imports historical work without fabricating dossier facts', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    const sourceDir = addLegacySource(projectDir, 'feature-dossier', legacySkill(
      'feature-dossier', 'Use when consulting an old feature dossier', '\n# Dossier\n\nHistorical claim.\n',
    ));
    const digest = sourceDigest(sourceDir);

    const report = await migrate({ projectDir, storePath, now: fixedNow });
    assert.deepEqual(report.entries.map(({ code }) => code), ['IMPORTED']);
    const record = JSON.parse(fs.readFileSync(path.join(storePath, 'knowledge', 'feature-dossier', 'record.json')));
    assert.equal(record.kind, 'work');
    assert.equal(record.provenance.origin, 'legacy-import');
    assert.equal(record.provenance.sourceFingerprint, digest);
    assert.equal(record.importedSource.body, '\n# Dossier\n\nHistorical claim.\n');
    assert.deepEqual(record.importedSource.cues, ['legacy import']);
    assert.equal(record.work.verification, 'unknown — imported record');
    assert.deepEqual(record.tags, []);
    assert.equal('sourceBranch' in record.provenance, false);
    assert.equal('sourceCommit' in record.provenance, false);
    assert.equal('verification' in record, false);
    assert.deepEqual(
      fs.readFileSync(path.join(storePath, 'knowledge', 'feature-dossier', 'imported-source', 'SKILL.md')),
      fs.readFileSync(path.join(storePath, 'knowledge-history', 'imported-sources', digest.replace(':', '-'), 'SKILL.md')),
    );
  });

  it('keeps an original record.json below imported-source beside the new manifest', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    const originalManifest = Buffer.from('{"legacy":true}\n');
    addLegacySource(projectDir, 'feature-resource', legacySkill('feature-resource'), {
      'record.json': originalManifest,
      'references/evidence.bin': Buffer.from([0, 255, 3]),
    });

    await migrate({ projectDir, storePath, now: fixedNow });
    assert.equal(JSON.parse(fs.readFileSync(
      path.join(storePath, 'knowledge', 'feature-resource', 'record.json'), 'utf8',
    )).kind, 'work');
    assert.deepEqual(fs.readFileSync(
      path.join(storePath, 'knowledge', 'feature-resource', 'imported-source', 'record.json'),
    ), originalManifest);
  });

  it('uses receipts to make reruns byte-stable no-ops', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    addLegacySource(projectDir, 'feature-repeat', legacySkill('feature-repeat'));
    await migrate({ projectDir, storePath, now: fixedNow });
    const destination = path.join(storePath, 'knowledge', 'feature-repeat', 'record.json');
    const before = fs.readFileSync(destination);
    const second = await migrate({ projectDir, storePath, now: fixedNow });
    assert.deepEqual(second.entries.map(({ code }) => code), ['NOOP']);
    assert.deepEqual(fs.readFileSync(destination), before);
    const receipt = JSON.parse(fs.readFileSync(path.join(storePath, 'import-receipts.json'))).receipts[0];
    assert.equal(receipt.recordId, 'feature-repeat');
    assert.match(receipt.revisionToken, /^sha256:/);
  });

  it('recovers a retired store-resident package through the same archive and receipt path', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const spectreHome = path.join(makeTmp(t), 'spectre-home');
    const id = 'store-resident-legacy';
    fs.mkdirSync(projectDir, { recursive: true });
    const { storePath } = await resolveProjectStore(projectDir, {
      spectreHome,
      gitRunner() { throw new Error('not a Git project'); },
    });
    const sourceDir = path.join(storePath, 'knowledge', id);
    fs.mkdirSync(path.join(sourceDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), legacySkill(
      id,
      'Use when recovering a prior canonical store-resident package.',
      '\n# Prior package\n\nRetain this historical evidence.\n',
    ));
    fs.writeFileSync(path.join(sourceDir, 'references', 'evidence.txt'), 'preserve these bytes\n');
    const digest = sourceDigest(sourceDir);

    const report = await migrate({ projectDir, storePath, now: fixedNow });

    assert.deepEqual(report.entries.map(({ code }) => code), ['IMPORTED']);
    const destination = path.join(storePath, 'knowledge', id);
    const record = JSON.parse(fs.readFileSync(path.join(destination, 'record.json'), 'utf8'));
    assert.equal(record.kind, 'work');
    assert.equal(record.provenance.origin, 'legacy-import');
    assert.equal(record.provenance.sourceFingerprint, digest);
    assert.deepEqual(
      fs.readFileSync(path.join(destination, 'imported-source', 'references', 'evidence.txt')),
      Buffer.from('preserve these bytes\n'),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(storePath, 'knowledge-history', 'imported-sources', digest.replace(':', '-'), 'SKILL.md')),
      fs.readFileSync(path.join(destination, 'imported-source', 'SKILL.md')),
    );
    const receipts = JSON.parse(fs.readFileSync(path.join(storePath, 'import-receipts.json'), 'utf8'));
    assert.deepEqual(receipts.receipts.map(({ sourceDigest, recordId }) => ({ sourceDigest, recordId })), [
      { sourceDigest: digest, recordId: id },
    ]);
    const loaded = await loadKnowledgeById({
      projectDir,
      spectreHome,
      gitRunner() { throw new Error('not a Git project'); },
      id,
      allowanceTokens: 10_000,
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.id, id);
    assert.equal(loaded.kind, 'work');
  });

  it('deduplicates byte-identical legacy copies without creating a second work record', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    const content = legacySkill('feature-duplicate');
    addLegacySource(projectDir, 'feature-duplicate', content, { 'references/source.txt': 'same bytes\n' });
    const agentsDir = path.join(projectDir, '.agents', 'skills', 'feature-duplicate');
    fs.mkdirSync(path.join(agentsDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'SKILL.md'), content);
    fs.writeFileSync(path.join(agentsDir, 'references', 'source.txt'), 'same bytes\n');
    const registry = path.join(projectDir, '.agents', 'skills', 'spectre-recall', 'references', 'registry.toon');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, 'feature-duplicate|feature|legacy import|Use when importing feature-duplicate\n');

    const report = await migrate({ projectDir, storePath, now: fixedNow });
    assert.deepEqual(report.entries.map(({ code }) => code), ['IMPORTED']);
    assert.deepEqual(fs.readdirSync(path.join(storePath, 'knowledge')), ['feature-duplicate']);
    assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'skills', 'feature-duplicate')), true);
    assert.equal(fs.existsSync(agentsDir), true);
  });

  it('keeps divergent duplicate sources recoverable without choosing or deleting either copy', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    const claude = addLegacySource(projectDir, 'feature-ambiguous', legacySkill('feature-ambiguous', 'First source'));
    const agentsDir = path.join(projectDir, '.agents', 'skills', 'feature-ambiguous');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'SKILL.md'), legacySkill('feature-ambiguous', 'Second source'));
    const registry = path.join(projectDir, '.agents', 'skills', 'spectre-recall', 'references', 'registry.toon');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, 'feature-ambiguous|feature|legacy import|Use when importing feature-ambiguous\n');

    const report = await migrate({ projectDir, storePath, now: fixedNow });
    assert.equal(report.entries[0].code, 'RECOVERABLE_FAILURE');
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'feature-ambiguous')), false);
    assert.equal(fs.existsSync(path.join(claude, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(agentsDir, 'SKILL.md')), true);
  });

  it('rejects a symlinked source resource without following or deleting it', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    const external = path.join(makeTmp(t), 'external.txt');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(external, 'must never be imported\n');
    const sourceDir = addLegacySource(projectDir, 'feature-symlink', legacySkill('feature-symlink'));
    fs.symlinkSync(external, path.join(sourceDir, 'references-link'));

    const report = await migrate({ projectDir, storePath, now: fixedNow });
    assert.equal(report.entries[0].code, 'RECOVERABLE_FAILURE');
    assert.equal(fs.readFileSync(external, 'utf8'), 'must never be imported\n');
    assert.equal(fs.lstatSync(path.join(sourceDir, 'references-link')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'feature-symlink')), false);
  });

  it('retains inactive source status as historical metadata instead of current guidance', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    addLegacySource(projectDir, 'feature-inactive', [
      '---', 'name: feature-inactive', 'description: Use when consulting a superseded rule',
      'spectre-status: superseded', 'spectre-version: 4', '---', '# Historical rule', '',
    ].join('\n'));

    await migrate({ projectDir, storePath, now: fixedNow });
    const record = JSON.parse(fs.readFileSync(
      path.join(storePath, 'knowledge', 'feature-inactive', 'record.json'), 'utf8',
    ));
    assert.equal(record.kind, 'work');
    assert.equal(record.importedSource.status, 'superseded');
    assert.equal(record.work.verification, 'unknown — imported record');
  });

  it('reports invalid sources recoverably without dropping their bytes or discoverable registry row', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    const sourceDir = addLegacySource(projectDir, 'feature-invalid', 'not a legacy package\n');
    const before = fs.readFileSync(path.join(sourceDir, 'SKILL.md'));

    const report = await migrate({ projectDir, storePath, now: fixedNow });
    assert.equal(report.entries[0].code, 'RECOVERABLE_FAILURE');
    assert.deepEqual(fs.readFileSync(path.join(sourceDir, 'SKILL.md')), before);
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'feature-invalid')), false);
    assert.match(fs.readFileSync(
      path.join(projectDir, '.claude', 'skills', 'spectre-recall', 'references', 'registry.toon'), 'utf8',
    ), /feature-invalid/);
  });

  it('preserves a registry row when a stale receipt lacks its imported destination and archive', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    const sourceDir = addLegacySource(projectDir, 'feature-stale-receipt', legacySkill('feature-stale-receipt'));
    const digest = sourceDigest(sourceDir);
    fs.mkdirSync(storePath, { recursive: true });
    fs.writeFileSync(path.join(storePath, 'import-receipts.json'), `${JSON.stringify({
      schemaVersion: 1,
      receipts: [{
        sourceDigest: digest, recordId: 'feature-stale-receipt',
        revisionToken: `sha256:${'a'.repeat(64)}`, importedAt: '2026-09-06T00:00:00.000Z',
      }],
    })}\n`);

    const report = await migrate({ projectDir, storePath, now: fixedNow });
    assert.equal(report.entries[0].code, 'RECOVERABLE_FAILURE');
    assert.match(report.entries[0].message, /stale receipt.*archive/i);
    assert.match(fs.readFileSync(
      path.join(projectDir, '.claude', 'skills', 'spectre-recall', 'references', 'registry.toon'), 'utf8',
    ), /feature-stale-receipt/);
  });

  it('preserves a registry row when a receipted archive is tampered', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const storePath = path.join(makeTmp(t), 'store');
    fs.mkdirSync(projectDir, { recursive: true });
    const sourceDir = addLegacySource(projectDir, 'feature-tampered-archive', legacySkill('feature-tampered-archive'));
    const digest = sourceDigest(sourceDir);
    await migrate({ projectDir, storePath, now: fixedNow });
    const registry = path.join(projectDir, '.claude', 'skills', 'spectre-recall', 'references', 'registry.toon');
    fs.appendFileSync(registry, 'feature-tampered-archive|feature|legacy import|Use when importing feature-tampered-archive\n');
    fs.writeFileSync(
      path.join(storePath, 'knowledge-history', 'imported-sources', digest.replace(':', '-'), 'SKILL.md'),
      'tampered archive bytes\n',
    );

    const report = await migrate({ projectDir, storePath, now: fixedNow });
    assert.equal(report.entries[0].code, 'RECOVERABLE_FAILURE');
    assert.match(fs.readFileSync(registry, 'utf8'), /feature-tampered-archive/);
  });

  it('rejects legacy-package registration with migration guidance without replacing a typed record', async (t) => {
    const projectDir = path.join(makeTmp(t), 'project');
    const spectreHome = path.join(makeTmp(t), 'spectre-home');
    const typed = path.join(makeTmp(t), 'typed', 'feature-registration');
    const legacy = path.join(makeTmp(t), 'legacy', 'feature-registration');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(typed, { recursive: true });
    fs.writeFileSync(path.join(typed, 'record.json'), `${JSON.stringify(
      typedWork('feature-registration', 'Typed record'),
    )}\n`);
    const created = await registerCanonicalKnowledge({ projectDir, recordPath: typed, spectreHome });
    const before = fs.readFileSync(created.recordPath);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), legacySkill('feature-registration'));
    await assert.rejects(registerCanonicalKnowledge({ projectDir, recordPath: legacy, spectreHome }),
      (error) => error.code === 'KNOWLEDGE_LEGACY_WRITE_RETIRED' && /migrate/.test(error.message));
    assert.deepEqual(fs.readFileSync(created.recordPath), before);
  });
});
