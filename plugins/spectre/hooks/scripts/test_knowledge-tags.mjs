#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { registerCanonicalKnowledge } from './knowledge/registration.mjs';
import { measurePayload } from './knowledge/payload.mjs';
import {
  applyTagOperationFile,
  deriveTagUsage,
  ensureTags,
  loadTagCatalog,
  mergeTags,
  normalizeTagId,
  readTagOperationFile,
  resolveTagId,
  searchTags,
  serializeTagError,
  tagCatalogPath,
} from './knowledge/tags.mjs';

function makeWorkspace(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-tags-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = path.join(tmp, 'workspace', 'project');
  const spectreHome = path.join(tmp, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  return { tmp, projectDir, spectreHome };
}

function storeOptions(workspace) {
  return { projectDir: workspace.projectDir, spectreHome: workspace.spectreHome };
}

function knowledgeRecord(id, tags) {
  return {
    schemaVersion: 1,
    id,
    kind: 'knowledge',
    title: 'Refresh expired auth tokens before retrying',
    summary: 'Expired access tokens surface as a 401 on the retried request.',
    tags,
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-07-19T00:00:00.000Z' },
    relatedRecordIds: [],
    category: 'pattern',
    useWhen: 'Changing retry behavior around authenticated requests.',
    content: 'Refresh the token, then retry the request exactly once.',
    evidence: 'Reproduced the 401 twice, then verified the refresh-then-retry fix.',
    status: 'active',
  };
}

async function registerRecord(workspace, id, tags) {
  const proposals = path.join(workspace.tmp, 'proposals');
  const recordDir = path.join(proposals, id);
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(
    path.join(recordDir, 'record.json'),
    `${JSON.stringify(knowledgeRecord(id, tags), null, 2)}\n`,
  );
  return registerCanonicalKnowledge({ ...storeOptions(workspace), recordPath: recordDir });
}

async function ensure(workspace, tags) {
  return ensureTags({ ...storeOptions(workspace), tags });
}

function codeOf(error) {
  return error?.code;
}

describe('canonical tag identity', () => {
  it('normalizes casing, separators, and compatibility forms into one canonical id', () => {
    assert.equal(normalizeTagId('  Auth Tokens '), 'auth-tokens');
    assert.equal(normalizeTagId('AUTH_tokens'), 'auth-tokens');
    assert.equal(normalizeTagId('auth--tokens'), 'auth-tokens');
    assert.equal(normalizeTagId('auth.tokens'), 'auth-tokens');
    assert.equal(normalizeTagId('ＡＵＴＨ tokens'), 'auth-tokens');
    assert.equal(normalizeTagId('   '), null);
    assert.equal(normalizeTagId('---'), null);
    assert.equal(normalizeTagId(`${'a'.repeat(65)}`), null);
  });

  it('gives two concurrent ensures of one normalized id a single canonical identity', async (t) => {
    const workspace = makeWorkspace(t);

    const results = await Promise.all([
      ensure(workspace, [{ id: 'Auth Tokens', description: 'Token refresh and session auth.' }]),
      ensure(workspace, [{ id: 'auth_tokens', description: 'Same area, different wording.' }]),
    ]);

    for (const result of results) {
      assert.equal(result.tags[0].id, 'auth-tokens');
    }
    assert.equal(
      results.filter((result) => result.tags[0].status === 'created').length,
      1,
      'concurrent ensures of the same normalized id must create exactly one canonical identity',
    );

    const { catalog, catalogPath } = await loadTagCatalog(storeOptions(workspace));
    assert.deepEqual(Object.keys(catalog.tags), ['auth-tokens']);
    assert.equal(catalogPath, tagCatalogPath(path.dirname(catalogPath)));
  });

  it('rejects exact id and alias collisions and leaves the catalog revision unchanged', async (t) => {
    const workspace = makeWorkspace(t);
    await ensure(workspace, [
      { id: 'auth-tokens', description: 'Token refresh and session auth.', aliases: ['session auth'] },
    ]);
    const before = await loadTagCatalog(storeOptions(workspace));

    await assert.rejects(
      () => ensure(workspace, [{ id: 'Session Auth', description: 'A second identity.' }]),
      (error) => codeOf(error) === 'TAG_ID_COLLISION' && error.resolvedId === 'auth-tokens',
    );

    await assert.rejects(
      () => ensure(workspace, [{ id: 'billing', description: 'Payments.', aliases: ['auth-tokens'] }]),
      (error) => codeOf(error) === 'TAG_ALIAS_COLLISION' && error.resolvedId === 'auth-tokens',
    );

    await assert.rejects(
      () => ensure(workspace, [{ id: 'billing' }]),
      (error) => codeOf(error) === 'TAG_DESCRIPTION_REQUIRED',
    );

    const after = await loadTagCatalog(storeOptions(workspace));
    assert.equal(after.revision, before.revision);
    assert.deepEqual(Object.keys(after.catalog.tags), ['auth-tokens']);
  });

  it('derives membership counts from records and stores no member list in the catalog', async (t) => {
    const workspace = makeWorkspace(t);
    await ensure(workspace, [{ id: 'auth-tokens', description: 'Token refresh and session auth.' }]);
    const registered = await registerRecord(workspace, 'auth-token-refresh', ['auth-tokens']);

    const { catalog, catalogPath } = await loadTagCatalog(storeOptions(workspace));
    assert.deepEqual(Object.keys(catalog.tags['auth-tokens']).sort(), ['aliases', 'description']);
    const rawCatalog = fs.readFileSync(catalogPath, 'utf8');
    for (const forbidden of ['members', 'records', 'recordIds', 'count']) {
      assert.equal(rawCatalog.includes(forbidden), false, `catalog must not store ${forbidden}`);
    }

    const usage = deriveTagUsage(registered.storePath, catalog);
    assert.equal(usage['auth-tokens'], 1);
  });

  it('rejects a stored catalog whose alias would split an existing canonical identity', async (t) => {
    const workspace = makeWorkspace(t);
    const ensured = await ensure(workspace, [
      { id: 'auth-tokens', description: 'Token refresh and session auth.' },
      { id: 'billing', description: 'Payment retries and invoices.' },
    ]);
    fs.writeFileSync(ensured.catalogPath, JSON.stringify({
      schemaVersion: 1,
      tags: {
        'auth-tokens': { description: 'Token refresh and session auth.', aliases: ['billing'] },
        billing: { description: 'Payment retries and invoices.', aliases: [] },
      },
      redirects: {},
    }));

    await assert.rejects(
      () => loadTagCatalog(storeOptions(workspace)),
      (error) => codeOf(error) === 'TAG_CATALOG_INVALID',
    );
  });
});

describe('tag consolidation', () => {
  async function seedMergeable(workspace) {
    await ensure(workspace, [
      { id: 'auth-tokens', description: 'Token refresh and session auth.' },
      { id: 'authentication', description: 'Login and session identity.', aliases: ['login auth'] },
    ]);
    return registerRecord(workspace, 'auth-token-refresh', ['authentication']);
  }

  it('resolves a record on a retired id through its redirect after a merge', async (t) => {
    const workspace = makeWorkspace(t);
    const registered = await seedMergeable(workspace);
    const before = await loadTagCatalog(storeOptions(workspace));

    const merged = await mergeTags({
      ...storeOptions(workspace),
      from: ['Authentication'],
      into: 'auth-tokens',
      expectedRevision: before.revision,
    });

    assert.equal(merged.ok, true);
    assert.deepEqual(merged.retired, ['authentication']);
    assert.equal(merged.target, 'auth-tokens');
    assert.notEqual(merged.revision, before.revision);

    const { catalog } = await loadTagCatalog(storeOptions(workspace));
    assert.deepEqual(Object.keys(catalog.tags), ['auth-tokens']);
    assert.equal(catalog.redirects.authentication, 'auth-tokens');
    assert.deepEqual(catalog.tags['auth-tokens'].aliases, ['login-auth']);

    assert.deepEqual(
      resolveTagId(catalog, 'authentication'),
      { id: 'auth-tokens', via: 'redirect' },
      'a record referencing the retired id must still resolve to the merge target',
    );
    assert.deepEqual(resolveTagId(catalog, 'Login Auth'), { id: 'auth-tokens', via: 'alias' });
    assert.deepEqual(resolveTagId(catalog, 'auth-tokens'), { id: 'auth-tokens', via: 'canonical' });
    assert.equal(resolveTagId(catalog, 'nothing-here'), null);

    const storedRecord = JSON.parse(fs.readFileSync(registered.recordPath, 'utf8'));
    assert.deepEqual(storedRecord.tags, ['authentication'], 'merging must not rewrite records');
    assert.equal(deriveTagUsage(registered.storePath, catalog)['auth-tokens'], 1);
  });

  it('rejects a merge without or with a stale catalog revision', async (t) => {
    const workspace = makeWorkspace(t);
    await seedMergeable(workspace);
    const before = await loadTagCatalog(storeOptions(workspace));

    await assert.rejects(
      () => mergeTags({ ...storeOptions(workspace), from: ['authentication'], into: 'auth-tokens' }),
      (error) =>
        codeOf(error) === 'TAG_CATALOG_REVISION_REQUIRED'
        && error.currentRevision === before.revision,
    );

    await assert.rejects(
      () => mergeTags({
        ...storeOptions(workspace),
        from: ['authentication'],
        into: 'auth-tokens',
        expectedRevision: `sha256:${'0'.repeat(64)}`,
      }),
      (error) =>
        codeOf(error) === 'TAG_CATALOG_REVISION_CONFLICT'
        && error.currentRevision === before.revision,
    );

    await assert.rejects(
      () => mergeTags({
        ...storeOptions(workspace),
        from: ['authentication'],
        into: 'unknown-area',
        expectedRevision: before.revision,
      }),
      (error) => codeOf(error) === 'TAG_MERGE_TARGET_UNKNOWN',
    );

    await assert.rejects(
      () => mergeTags({
        ...storeOptions(workspace),
        from: ['auth-tokens'],
        into: 'auth-tokens',
        expectedRevision: before.revision,
      }),
      (error) => codeOf(error) === 'TAG_MERGE_TARGET_INVALID',
    );

    const after = await loadTagCatalog(storeOptions(workspace));
    assert.equal(after.revision, before.revision);
    assert.deepEqual(Object.keys(after.catalog.tags), ['auth-tokens', 'authentication']);
  });
});

describe('bounded tag search', () => {
  it('returns bounded names, descriptions, and aliases without loading record bodies', async (t) => {
    const workspace = makeWorkspace(t);
    await ensure(workspace, [
      { id: 'auth-tokens', description: 'Token refresh and session auth.', aliases: ['session auth'] },
      { id: 'billing', description: 'Invoices and payment retries.' },
      { id: 'caching', description: 'Response and index caching.' },
      { id: 'deploys', description: 'Release and rollback steps.' },
      { id: 'editors', description: 'Editor integrations.' },
      { id: 'fixtures', description: 'Test fixture conventions.' },
    ]);
    const registered = await registerRecord(workspace, 'auth-token-refresh', ['auth-tokens']);

    const page = await searchTags({ ...storeOptions(workspace), query: '' });
    assert.equal(page.results.length, 5, 'an empty query returns a bounded page, never the corpus');
    assert.equal(page.total, 6);
    assert.equal(page.truncated, true);
    assert.ok(page.cursor);
    assert.deepEqual(
      Object.keys(page.results[0]).sort(),
      ['aliases', 'description', 'id', 'matchedVia', 'recordCount'],
    );

    const aliasMatch = await searchTags({ ...storeOptions(workspace), query: 'Session Auth' });
    assert.deepEqual(aliasMatch.results.map((result) => result.id), ['auth-tokens']);
    assert.equal(aliasMatch.results[0].matchedVia, 'alias');
    assert.equal(aliasMatch.results[0].recordCount, 1);

    fs.rmSync(path.join(registered.storePath, 'knowledge'), { recursive: true, force: true });
    const withoutBodies = await searchTags({ ...storeOptions(workspace), query: 'session auth' });
    assert.equal(
      withoutBodies.results[0].recordCount,
      1,
      'tag search must read compact index metadata, never record bodies',
    );
  });

  it('pages a catalog cursor to omitted tags and rejects it after a catalog revision change', async (t) => {
    const workspace = makeWorkspace(t);
    await ensure(workspace, Array.from({ length: 7 }, (_, index) => ({
      id: `area-${index}`, description: `Area ${index} procedures.`,
    })));
    const first = await searchTags({ ...storeOptions(workspace), query: '' });
    const second = await searchTags({ ...storeOptions(workspace), query: '', cursor: first.cursor });
    assert.deepEqual([...first.results, ...second.results].map(({ id }) => id), [
      'area-0', 'area-1', 'area-2', 'area-3', 'area-4', 'area-5', 'area-6',
    ]);
    assert.equal(second.cursor, null);
    await ensure(workspace, [{ id: 'area-next', description: 'Changed catalog revision.' }]);
    await assert.rejects(
      () => searchTags({ ...storeOptions(workspace), query: '', cursor: first.cursor }),
      (error) => codeOf(error) === 'TAG_SEARCH_CURSOR_STALE',
    );
  });

  it('suggests similar tags without merging them', async (t) => {
    const workspace = makeWorkspace(t);
    await ensure(workspace, [
      { id: 'auth-tokens', description: 'Token refresh and session auth.' },
      { id: 'auth-sessions', description: 'Session lifetime and auth cookies.' },
    ]);
    const before = await loadTagCatalog(storeOptions(workspace));

    const found = await searchTags({ ...storeOptions(workspace), query: 'auth' });
    assert.deepEqual(found.results.map((result) => result.id), ['auth-sessions', 'auth-tokens']);

    const after = await loadTagCatalog(storeOptions(workspace));
    assert.equal(after.revision, before.revision, 'similarity must never merge tags on its own');
    assert.deepEqual(after.catalog.redirects, {});
  });

  it('returns an empty bounded page when the project has no store yet', async (t) => {
    const workspace = makeWorkspace(t);
    const page = await searchTags({ ...storeOptions(workspace), query: 'auth' });
    assert.deepEqual(page, { results: [], total: 0, truncated: false, revision: null, cursor: null });
  });

  it('enforces the five-entry and 500-token response budgets even when callers request more', async (t) => {
    const workspace = makeWorkspace(t);
    const description = 'A deliberately long description for bounded tag response verification. '.repeat(2).trim();
    await ensure(workspace, Array.from({ length: 8 }, (_, index) => ({
      id: `area-${index}`,
      description,
      aliases: [`area ${index} compatibility alias`],
    })));

    const page = await searchTags({ ...storeOptions(workspace), query: '', limit: 25 });
    assert.ok(page.results.length <= 5);
    assert.ok(page.truncated);
    assert.ok(measurePayload('codex', JSON.stringify(page)).measured <= 500);
  });
});

describe('structured tag operation files', () => {
  it('applies ensure and merge operations from an input file', async (t) => {
    const workspace = makeWorkspace(t);
    const ensurePath = path.join(workspace.tmp, 'ensure.json');
    fs.writeFileSync(ensurePath, JSON.stringify({
      operation: 'ensure',
      tags: [
        { id: 'Auth Tokens', description: 'Token refresh and session auth.' },
        { id: 'authentication', description: 'Login and session identity.' },
      ],
    }));

    const ensured = await applyTagOperationFile({ ...storeOptions(workspace), inputPath: ensurePath });
    assert.deepEqual(ensured.tags.map((tag) => tag.id), ['auth-tokens', 'authentication']);

    const mergePath = path.join(workspace.tmp, 'merge.json');
    fs.writeFileSync(mergePath, JSON.stringify({
      operation: 'merge',
      from: ['authentication'],
      into: 'auth-tokens',
      expectedRevision: ensured.revision,
    }));
    const merged = await applyTagOperationFile({ ...storeOptions(workspace), inputPath: mergePath });
    assert.deepEqual(merged.retired, ['authentication']);

    const { catalog } = await loadTagCatalog(storeOptions(workspace));
    assert.equal(catalog.redirects.authentication, 'auth-tokens');
  });

  it('rejects a malformed operation file with a serializable coded error', async (t) => {
    const workspace = makeWorkspace(t);
    const inputPath = path.join(workspace.tmp, 'broken.json');
    fs.writeFileSync(inputPath, JSON.stringify({ tags: [] }));

    assert.throws(
      () => readTagOperationFile(inputPath),
      (error) => codeOf(error) === 'TAG_INPUT_INVALID',
    );

    let caught;
    try {
      await applyTagOperationFile({ ...storeOptions(workspace), inputPath });
    } catch (error) {
      caught = error;
    }
    assert.equal(codeOf(caught), 'TAG_INPUT_INVALID');
    const serialized = serializeTagError(caught);
    assert.equal(serialized.ok, false);
    assert.equal(serialized.code, 'TAG_INPUT_INVALID');
    assert.equal(typeof serialized.message, 'string');
  });
});
