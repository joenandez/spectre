#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerCanonicalKnowledge } from './knowledge/registration.mjs';
import { resolveProjectStore } from './knowledge/store.mjs';
import {
  parseKnowledgeRecord,
  revisionDirectoryName,
  revisionTokenFor,
} from './knowledge/records.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REGISTER_SCRIPT = path.join(SCRIPT_DIR, 'register_learning.mjs');

function makeTmp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-revision-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function knowledgeRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'auth-token-refresh',
    kind: 'knowledge',
    title: 'Refresh expired auth tokens before retrying',
    summary: 'Expired access tokens surface as a 401 on the retried request.',
    tags: ['auth'],
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-07-19T00:00:00.000Z' },
    relatedRecordIds: [],
    category: 'pattern',
    useWhen: 'Changing retry behavior around authenticated requests.',
    content: 'Refresh the token, then retry the request exactly once.',
    evidence: 'Reproduced the 401 twice, then verified the refresh-then-retry fix.',
    status: 'active',
    ...overrides,
  };
}

function workRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'receipt-record',
    kind: 'work',
    title: 'Imported receipt record',
    summary: 'A legacy import receipt transaction fixture.',
    tags: [],
    applicability: { scope: 'work', workId: 'receipt-record' },
    provenance: {
      origin: 'legacy-import',
      capturedAt: '2026-07-19T00:00:00.000Z',
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    },
    relatedRecordIds: [],
    work: {
      requestedOutcome: 'unknown — imported record', scope: 'unknown — imported record',
      actualChanges: 'unknown — imported record', reasons: 'unknown — imported record',
      discoveries: 'unknown — imported record', verification: 'unknown — imported record',
      remainingWork: 'unknown — imported record', relatedContext: 'unknown — imported record',
      execution: { state: 'unknown' }, verificationState: { state: 'unknown' },
      pullRequest: { state: 'unknown' },
      associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] },
    },
    importedSource: {
      body: 'Original legacy source body.', useWhen: 'Use when testing import receipts.',
      cues: ['import receipt'], category: 'feature', status: 'active', version: '1',
    },
    ...overrides,
  };
}

function writePackage(root, record, { resources = {}, directoryName = record.id, raw } = {}) {
  const recordDir = path.join(root, directoryName);
  fs.rmSync(recordDir, { recursive: true, force: true });
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(
    path.join(recordDir, 'record.json'),
    raw === undefined ? `${JSON.stringify(record, null, 2)}\n` : raw,
  );
  for (const [relativePath, bytes] of Object.entries(resources)) {
    const target = path.join(recordDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return recordDir;
}

function findOnlyStore(spectreHome) {
  const projectsDir = path.join(spectreHome, 'projects');
  const stores = [];
  const pending = [projectsDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    if (fs.existsSync(path.join(current, 'project.json'))) {
      stores.push(current);
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  assert.equal(stores.length, 1, `expected exactly one store, found ${stores.length}`);
  return stores[0];
}

function snapshotTree(root) {
  const tree = {};
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else tree[path.relative(root, entryPath)] = fs.readFileSync(entryPath, 'utf8');
    }
  }
  return tree;
}

function makeWorkspace(t) {
  const tmp = makeTmp(t);
  const projectDir = path.join(tmp, 'workspace', 'project');
  const spectreHome = path.join(tmp, 'spectre-home');
  const proposals = path.join(tmp, 'proposals');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(proposals, { recursive: true });
  return { tmp, projectDir, spectreHome, proposals };
}

function register(workspace, recordDir, options = {}) {
  return registerCanonicalKnowledge({
    projectDir: workspace.projectDir,
    spectreHome: workspace.spectreHome,
    recordPath: recordDir,
    ...options,
  });
}

describe('whole-package revision tokens', () => {
  it('covers record bytes and resource bytes independently of stored key order', async (t) => {
    const tmp = makeTmp(t);
    const record = knowledgeRecord({ id: 'revision-token' });
    const reordered = Object.fromEntries(Object.entries(record).reverse());

    const plain = parseKnowledgeRecord(path.join(
      writePackage(tmp, record, { directoryName: 'revision-token' }),
      'record.json',
    ));
    const reorderedParse = parseKnowledgeRecord(path.join(
      writePackage(tmp, reordered, {
        directoryName: 'revision-token',
        raw: JSON.stringify(reordered),
      }),
      'record.json',
    ));
    assert.match(plain.revisionToken, /^sha256:[a-f0-9]{64}$/);
    assert.equal(reorderedParse.revisionToken, plain.revisionToken);
    assert.equal(plain.revisionToken, revisionTokenFor(record, []));

    const withResource = parseKnowledgeRecord(path.join(
      writePackage(tmp, record, {
        directoryName: 'revision-token',
        resources: { 'references/detail.md': 'first bytes\n' },
      }),
      'record.json',
    ));
    const changedResource = parseKnowledgeRecord(path.join(
      writePackage(tmp, record, {
        directoryName: 'revision-token',
        resources: { 'references/detail.md': 'second bytes\n' },
      }),
      'record.json',
    ));
    assert.notEqual(withResource.revisionToken, plain.revisionToken);
    assert.notEqual(
      changedResource.revisionToken,
      withResource.revisionToken,
      'a resource-only change must produce a different revision token',
    );
    assert.equal(
      revisionDirectoryName(plain.revisionToken),
      plain.revisionToken.replace(':', '-'),
    );
  });
});

describe('registration preconditions', () => {
  it('rejects a record file whose parent is not its exact package ID before traversal', async (t) => {
    const workspace = makeWorkspace(t);
    const sessionRoot = path.join(workspace.tmp, 'session-root');
    fs.mkdirSync(path.join(sessionRoot, 'unrelated-session-output'), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, 'record.json'), `${JSON.stringify(knowledgeRecord({ id: 'exact-package-id' }), null, 2)}\n`);
    fs.writeFileSync(path.join(sessionRoot, 'unrelated-session-output', 'marker.txt'), 'must not be registered\n');

    await assert.rejects(
      register(workspace, path.join(sessionRoot, 'record.json')),
      (error) => error.code === 'KNOWLEDGE_RECORD_INVALID' && /exact-package-id\/record\.json/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(workspace.spectreHome, 'projects')), false);
  });

  it('rejects a package root that contains its resolved store before creating a stage', async (t) => {
    const workspace = makeWorkspace(t);
    const sourceRoot = path.join(workspace.tmp, 'contained-store');
    const embeddedHome = path.join(sourceRoot, 'spectre-home');
    writePackage(path.dirname(sourceRoot), knowledgeRecord({ id: 'contained-store' }));
    const { storePath } = await resolveProjectStore(workspace.projectDir, { spectreHome: embeddedHome });
    fs.writeFileSync(path.join(sourceRoot, 'unrelated-session-note.txt'), 'do not traverse me\n');

    await assert.rejects(
      registerCanonicalKnowledge({ projectDir: workspace.projectDir, spectreHome: embeddedHome, recordPath: sourceRoot }),
      (error) => error.code === 'KNOWLEDGE_RECORD_INVALID' && /contains the knowledge store/i.test(error.message),
    );
    assert.equal(fs.readdirSync(storePath).some(entry => entry.startsWith('.registration-stage-')), false);
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'contained-store')), false);
  });

  it('rejects a store-containing package through a symlinked ancestor alias before staging', async (t) => {
    const workspace = makeWorkspace(t);
    const physicalRoot = path.join(workspace.tmp, 'physical-root');
    const sourceRoot = path.join(physicalRoot, 'aliased-store');
    const aliasRoot = path.join(workspace.tmp, 'alias-root');
    const embeddedHome = path.join(sourceRoot, 'spectre-home');
    writePackage(physicalRoot, knowledgeRecord({ id: 'aliased-store' }));
    fs.symlinkSync(physicalRoot, aliasRoot);
    const { storePath } = await resolveProjectStore(workspace.projectDir, { spectreHome: embeddedHome });

    await assert.rejects(
      registerCanonicalKnowledge({ projectDir: workspace.projectDir, spectreHome: embeddedHome, recordPath: path.join(aliasRoot, 'aliased-store') }),
      (error) => error.code === 'KNOWLEDGE_RECORD_INVALID' && /contains the knowledge store/i.test(error.message),
    );
    assert.equal(fs.readdirSync(storePath).some(entry => entry.startsWith('.registration-stage-')), false);
  });

  it('rejects canonical-store proposals and a current package that no longer matches its index', async (t) => {
    const workspace = makeWorkspace(t);
    const proposal = writePackage(workspace.proposals, knowledgeRecord({ id: 'stored-proposal' }));
    const created = await register(workspace, proposal);
    const storePath = findOnlyStore(workspace.spectreHome);
    const canonicalRecordPath = path.join(storePath, 'knowledge', 'stored-proposal', 'record.json');
    const indexPath = path.join(storePath, 'index.json');
    const originalRecord = fs.readFileSync(canonicalRecordPath, 'utf8');
    const originalIndex = fs.readFileSync(indexPath, 'utf8');

    for (const source of [
      canonicalRecordPath,
      (() => {
        const alias = path.join(workspace.tmp, 'store-alias');
        fs.symlinkSync(storePath, alias);
        return path.join(alias, 'knowledge', 'stored-proposal', 'record.json');
      })(),
    ]) {
      await assert.rejects(
        register(workspace, source),
        (error) => error.code === 'KNOWLEDGE_RECORD_INVALID' && /inside the knowledge store/i.test(error.message),
      );
      assert.equal(fs.readFileSync(canonicalRecordPath, 'utf8'), originalRecord);
      assert.equal(fs.readFileSync(indexPath, 'utf8'), originalIndex);
    }

    const tampered = knowledgeRecord({ id: 'stored-proposal', content: 'Tampered canonical bytes.' });
    fs.writeFileSync(canonicalRecordPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const externalProposal = writePackage(path.join(workspace.proposals, 'external'), tampered);
    await assert.rejects(
      register(workspace, externalProposal, { expectedRevision: created.revisionToken }),
      (error) => error.code === 'KNOWLEDGE_CURRENT_RECORD_MISMATCH' && error.currentRevision !== created.revisionToken,
    );
    assert.equal(fs.readFileSync(canonicalRecordPath, 'utf8'), `${JSON.stringify(tampered, null, 2)}\n`);
    assert.equal(fs.readFileSync(indexPath, 'utf8'), originalIndex);
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge-history', 'stored-proposal')), false);
  });

  it('creates only when absent and reports the identical re-registration as a no-op', async (t) => {
    const workspace = makeWorkspace(t);
    const proposal = writePackage(workspace.proposals, knowledgeRecord({ id: 'precondition-create' }));

    const created = await register(workspace, proposal);
    assert.equal(created.status, 'created');
    assert.match(created.revisionToken, /^sha256:[a-f0-9]{64}$/);
    assert.equal(created.previousRevisionToken, null);
    const storePath = findOnlyStore(workspace.spectreHome);
    const indexPath = path.join(storePath, 'index.json');
    assert.equal(
      created.recordPath,
      path.join(storePath, 'knowledge', 'precondition-create', 'record.json'),
    );

    const indexBytes = fs.readFileSync(indexPath, 'utf8');
    const recordBytes = fs.readFileSync(created.recordPath, 'utf8');
    const noop = await register(workspace, proposal);
    assert.equal(noop.status, 'noop');
    assert.equal(noop.revisionToken, created.revisionToken);
    assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBytes);
    assert.equal(fs.readFileSync(created.recordPath, 'utf8'), recordBytes);
    assert.equal(
      fs.existsSync(path.join(storePath, 'knowledge-history', 'precondition-create')),
      false,
      'a no-op must not archive a revision',
    );

    await assert.rejects(
      register(workspace, writePackage(
        workspace.proposals,
        knowledgeRecord({ id: 'precondition-absent' }),
      ), { expectedRevision: created.revisionToken }),
      (error) =>
        error.code === 'KNOWLEDGE_REVISION_CONFLICT'
        && error.currentRevision === null
        && /no record exists/i.test(error.message),
    );
  });

  it('refuses a replacement without the expected token and a stale expected token', async (t) => {
    const workspace = makeWorkspace(t);
    const proposal = writePackage(workspace.proposals, knowledgeRecord({ id: 'precondition-update' }));
    const created = await register(workspace, proposal);
    const storePath = findOnlyStore(workspace.spectreHome);
    const recordDir = path.join(storePath, 'knowledge', 'precondition-update');
    const priorTree = snapshotTree(recordDir);

    const update = writePackage(path.join(workspace.proposals, 'update'), knowledgeRecord({
      id: 'precondition-update',
      content: 'Refresh the token, then retry the request at most twice.',
    }));

    await assert.rejects(
      register(workspace, update),
      (error) =>
        error.code === 'KNOWLEDGE_REVISION_REQUIRED'
        && error.currentRevision === created.revisionToken
        && /expected-revision/i.test(error.message),
    );
    assert.deepEqual(snapshotTree(recordDir), priorTree);

    await assert.rejects(
      register(workspace, update, { expectedRevision: `sha256:${'0'.repeat(64)}` }),
      (error) =>
        error.code === 'KNOWLEDGE_REVISION_CONFLICT'
        && error.currentRevision === created.revisionToken,
    );
    assert.deepEqual(snapshotTree(recordDir), priorTree);

    const updated = await register(workspace, update, { expectedRevision: created.revisionToken });
    assert.equal(updated.status, 'updated');
    assert.equal(updated.previousRevisionToken, created.revisionToken);
    assert.notEqual(updated.revisionToken, created.revisionToken);
  });

  it('rejects the losing writer of two updates that hold the same expected token', async (t) => {
    const workspace = makeWorkspace(t);
    const created = await register(workspace, writePackage(
      workspace.proposals,
      knowledgeRecord({ id: 'concurrent-update' }),
    ));
    const storePath = findOnlyStore(workspace.spectreHome);
    const first = writePackage(path.join(workspace.proposals, 'first'), knowledgeRecord({
      id: 'concurrent-update',
      content: 'First concurrent writer content.',
    }));
    const second = writePackage(path.join(workspace.proposals, 'second'), knowledgeRecord({
      id: 'concurrent-update',
      content: 'Second concurrent writer content.',
    }));

    const results = await Promise.allSettled([
      register(workspace, first, { expectedRevision: created.revisionToken }),
      register(workspace, second, { expectedRevision: created.revisionToken }),
    ]);
    const winners = results.filter(({ status }) => status === 'fulfilled');
    const losers = results.filter(({ status }) => status === 'rejected');
    assert.equal(winners.length, 1, JSON.stringify(results.map(({ status }) => status)));
    assert.equal(losers.length, 1);

    const winner = winners[0].value;
    const loser = losers[0].reason;
    assert.equal(loser.code, 'KNOWLEDGE_REVISION_CONFLICT');
    assert.equal(loser.expectedRevision, created.revisionToken);
    assert.equal(
      loser.currentRevision,
      winner.revisionToken,
      'the rejected writer must learn the current revision token',
    );

    const currentPath = path.join(storePath, 'knowledge', 'concurrent-update', 'record.json');
    assert.equal(parseKnowledgeRecord(currentPath).revisionToken, winner.revisionToken);
    for (const source of [first, second]) {
      assert.equal(
        fs.existsSync(path.join(source, 'record.json')),
        true,
        'a rejected version must survive for a reconciled retry',
      );
    }
  });
});

describe('immutable history and the extended transaction', () => {
  it('archives the complete prior package including resources', async (t) => {
    const workspace = makeWorkspace(t);
    const proposal = writePackage(workspace.proposals, knowledgeRecord({ id: 'history-archive' }), {
      resources: { 'references/prior.md': 'prior resource\n' },
    });
    const created = await register(workspace, proposal);
    const storePath = findOnlyStore(workspace.spectreHome);
    const recordDir = path.join(storePath, 'knowledge', 'history-archive');
    const priorTree = snapshotTree(recordDir);

    const update = writePackage(
      path.join(workspace.proposals, 'update'),
      knowledgeRecord({ id: 'history-archive', content: 'Replacement guidance.' }),
      { resources: { 'references/next.md': 'next resource\n' } },
    );
    const updated = await register(workspace, update, { expectedRevision: created.revisionToken });

    const historyDir = path.join(
      storePath,
      'knowledge-history',
      'history-archive',
      revisionDirectoryName(created.revisionToken),
    );
    assert.equal(updated.historyPath, historyDir);
    assert.deepEqual(snapshotTree(historyDir), priorTree);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'))
        .records.map(({ id }) => id),
      ['history-archive'],
      'history must never be indexed as current guidance',
    );
  });

  it('recovers one complete committed version when the process dies mid-transaction', async (t) => {
    for (const hook of ['afterHistoryArchive', 'afterRecordSwap']) {
      const workspace = makeWorkspace(t);
      const proposal = writePackage(
        workspace.proposals,
        knowledgeRecord({ id: 'crash-transaction' }),
        { resources: { 'references/prior.md': 'prior resource\n' } },
      );
      const created = await register(workspace, proposal);
      const storePath = findOnlyStore(workspace.spectreHome);
      const recordDir = path.join(storePath, 'knowledge', 'crash-transaction');
      const priorTree = snapshotTree(recordDir);
      const update = writePackage(
        path.join(workspace.proposals, 'update'),
        knowledgeRecord({ id: 'crash-transaction', content: 'Replacement guidance.' }),
      );

      const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { registerCanonicalKnowledge } from ${JSON.stringify(
          path.join(SCRIPT_DIR, 'knowledge', 'registration.mjs'),
        )};
        await registerCanonicalKnowledge({
          projectDir: ${JSON.stringify(workspace.projectDir)},
          spectreHome: ${JSON.stringify(workspace.spectreHome)},
          recordPath: ${JSON.stringify(update)},
          expectedRevision: ${JSON.stringify(created.revisionToken)},
          ${hook}() { process.kill(process.pid, 'SIGKILL'); },
        });
      `], { encoding: 'utf8' });
      assert.equal(killed.signal, 'SIGKILL', `${hook}: ${killed.stderr}`);

      // Registering an unrelated record drives the recovery pass without touching the crash.
      await register(workspace, writePackage(
        path.join(workspace.proposals, 'neighbor'),
        knowledgeRecord({ id: 'crash-neighbor' }),
      ));
      assert.deepEqual(
        fs.readdirSync(path.join(storePath, 'knowledge')).sort(),
        ['crash-neighbor', 'crash-transaction'],
        `${hook} must leave no partial package`,
      );
      assert.equal(
        fs.readdirSync(storePath).some((name) => name.startsWith('.registration-stage-')),
        false,
        `${hook} must leave no staging directory`,
      );
      const committed = parseKnowledgeRecord(path.join(recordDir, 'record.json'));
      assert.equal(
        [created.revisionToken, parseKnowledgeRecord(path.join(update, 'record.json')).revisionToken]
          .includes(committed.revisionToken),
        true,
        `${hook} must commit exactly one complete version`,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'))
          .records.find(({ id }) => id === 'crash-transaction').revisionToken,
        committed.revisionToken,
        `${hook} must leave the index describing the committed version`,
      );
      assert.deepEqual(
        snapshotTree(path.join(
          storePath,
          'knowledge-history',
          'crash-transaction',
          revisionDirectoryName(created.revisionToken),
        )),
        priorTree,
        `${hook} must leave the archived prior package reconstructible`,
      );
    }
  });

  it('commits an import receipt with the record and rolls it back with the index', async (t) => {
    const workspace = makeWorkspace(t);
    const proposal = writePackage(workspace.proposals, workRecord());
    const sourceDigest = `sha256:${'a'.repeat(64)}`;

    const created = await register(workspace, proposal, {
      importReceipt: { sourceDigest, sourcePath: '/legacy/receipt-record/SKILL.md' },
    });
    const storePath = findOnlyStore(workspace.spectreHome);
    const { findImportReceipt, readImportReceipts } = await import('./knowledge/receipts.mjs');
    const receipts = readImportReceipts(storePath);
    assert.equal(receipts.schemaVersion, 1);
    assert.deepEqual(findImportReceipt(storePath, sourceDigest), {
      sourceDigest,
      sourcePath: '/legacy/receipt-record/SKILL.md',
      recordId: 'receipt-record',
      revisionToken: created.revisionToken,
      importedAt: receipts.receipts[0].importedAt,
    });

    const receiptBytes = fs.readFileSync(path.join(storePath, 'import-receipts.json'), 'utf8');
    const indexBytes = fs.readFileSync(path.join(storePath, 'index.json'), 'utf8');
    const update = writePackage(path.join(workspace.proposals, 'update'), workRecord({
      summary: 'A second import of the same legacy source.',
    }));
    await assert.rejects(register(workspace, update, {
      expectedRevision: created.revisionToken,
      importReceipt: { sourceDigest: `sha256:${'b'.repeat(64)}` },
      afterIndexRefresh() {
        throw new Error('injected-post-receipt-failure');
      },
    }));
    assert.equal(
      fs.readFileSync(path.join(storePath, 'import-receipts.json'), 'utf8'),
      receiptBytes,
      'a failed transaction must restore the prior receipts',
    );
    assert.equal(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'), indexBytes);
  });

  it('keeps invalid-neighbor diagnostics and index rollback unchanged', async (t) => {
    const workspace = makeWorkspace(t);
    const created = await register(workspace, writePackage(
      workspace.proposals,
      knowledgeRecord({ id: 'valid-neighbor' }),
    ));
    const storePath = findOnlyStore(workspace.spectreHome);
    writePackage(path.join(storePath, 'knowledge'), null, {
      directoryName: 'invalid-neighbor',
      raw: '---\nname: invalid-neighbor\n---\nretired skill\n',
    });

    const update = writePackage(path.join(workspace.proposals, 'update'), knowledgeRecord({
      id: 'valid-neighbor',
      content: 'Replacement guidance beside a malformed neighbor.',
    }));
    const updated = await register(workspace, update, { expectedRevision: created.revisionToken });
    const index = JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'));
    assert.deepEqual(index.records.map(({ id }) => id), ['valid-neighbor']);
    assert.equal(index.records[0].revisionToken, updated.revisionToken);

    const recordDir = path.join(storePath, 'knowledge', 'valid-neighbor');
    const priorTree = snapshotTree(recordDir);
    const indexBytes = fs.readFileSync(path.join(storePath, 'index.json'), 'utf8');
    const third = writePackage(path.join(workspace.proposals, 'third'), knowledgeRecord({
      id: 'valid-neighbor',
      content: 'Guidance that must not survive a failed transaction.',
    }));
    await assert.rejects(register(workspace, third, {
      expectedRevision: updated.revisionToken,
      afterRecordSwap() {
        throw new Error('injected-post-swap-failure');
      },
    }), /injected-post-swap-failure/);
    assert.deepEqual(snapshotTree(recordDir), priorTree);
    assert.equal(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'), indexBytes);
    assert.equal(
      fs.existsSync(path.join(
        storePath,
        'knowledge-history',
        'valid-neighbor',
        revisionDirectoryName(updated.revisionToken),
      )),
      false,
      'a rolled-back transaction must not leave the current revision archived',
    );
  });
});

describe('register CLI revision preconditions', () => {
  it('creates, no-ops, and refuses an unguarded replacement', async (t) => {
    const workspace = makeWorkspace(t);
    const proposal = writePackage(workspace.proposals, knowledgeRecord({ id: 'cli-precondition' }));
    const run = (recordDir) => spawnSync(process.execPath, [
      REGISTER_SCRIPT,
      '--project-root', workspace.projectDir,
      '--record', recordDir,
      '--json',
    ], { encoding: 'utf8', env: { ...process.env, SPECTRE_HOME: workspace.spectreHome } });

    const created = run(proposal);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).status, 'created');

    const noop = run(proposal);
    assert.equal(noop.status, 0, noop.stderr);
    assert.equal(JSON.parse(noop.stdout).status, 'noop');

    const blocked = run(writePackage(path.join(workspace.proposals, 'cli-update'), knowledgeRecord({
      id: 'cli-precondition',
      content: 'CLI replacement guidance.',
    })));
    assert.notEqual(blocked.status, 0);
    const failure = JSON.parse(blocked.stdout);
    assert.equal(failure.code, 'KNOWLEDGE_REVISION_REQUIRED');
    assert.equal(failure.currentRevision, JSON.parse(created.stdout).revisionToken);
  });
});
