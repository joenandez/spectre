#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as work from './knowledge/work.mjs';

import { registerCanonicalKnowledge } from './knowledge/registration.mjs';
import {
  resolveWorkIdentity,
  resolveOrAllocateWorkIdentity,
} from './knowledge/work.mjs';

function makeWorkspace(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-work-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = path.join(tmp, 'workspace', 'project');
  const spectreHome = path.join(tmp, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  return { projectDir, spectreHome };
}

function options(workspace, associations = {}) {
  return { projectDir: workspace.projectDir, spectreHome: workspace.spectreHome, ...associations };
}

function workRecord(id, associations) {
  return {
    schemaVersion: 1,
    id,
    kind: 'work',
    title: `Work record ${id}`,
    summary: 'A typed work fixture that owns exact identity associations.',
    tags: [],
    applicability: { scope: 'work', workId: id },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' },
    relatedRecordIds: [],
    work: {
      requestedOutcome: 'Record one exact work association.',
      scope: 'The identity fixture only.',
      actualChanges: 'Registered the typed fixture.',
      reasons: 'Verify authoritative work resolution.',
      discoveries: 'Associations belong to the verified work record.',
      verification: 'Focused node tests.',
      remainingWork: 'None.',
      relatedContext: 'Test fixture.',
      execution: { state: 'acceptance-pending' },
      verificationState: { state: 'not-run' },
      pullRequest: { state: 'none' },
      associations,
    },
  };
}

function writeProposal(workspace, record) {
  const proposal = path.join(workspace.spectreHome, 'proposals', record.id);
  fs.mkdirSync(proposal, { recursive: true });
  fs.writeFileSync(path.join(proposal, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return proposal;
}

describe('stable work identity', () => {
  it('reuses one branch work id for distinct Execute source runs', async (t) => {
    const workspace = makeWorkspace(t);
    const first = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/delivery-group', sourceRunId: 'run-a',
    }));
    const second = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/delivery-group', sourceRunId: 'run-b',
    }));

    assert.equal(second.workId, first.workId);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { branch: 'feature/delivery-group' })),
      { status: 'resolved', workId: first.workId },
    );
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run-b' })),
      { status: 'resolved', workId: first.workId },
    );
  });

  it('does not let a branch pointer select work from another branch', async (t) => {
    const workspace = makeWorkspace(t);
    const first = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/one', sourceRunId: 'run-one',
    }));
    const second = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/two', sourceRunId: 'run-two',
    }));

    assert.notEqual(second.workId, first.workId);
  });

  it('rotates a branch pointer after its registered PR is terminal', async (t) => {
    const workspace = makeWorkspace(t);
    const initial = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/terminal', sourceRunId: 'run-before-merge',
    }));
    const terminal = workRecord(initial.workId, {
      sourceRunIds: ['run-before-merge'], pullRequestIds: ['github:example/spectre#1'], candidates: [],
    });
    terminal.work.pullRequest = { state: 'merged' };
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, terminal),
    });

    const next = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/terminal', sourceRunId: 'run-after-merge',
    }));
    assert.notEqual(next.workId, initial.workId);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run-before-merge' })),
      { status: 'resolved', workId: initial.workId },
    );
  });

  it('rotates a draft branch record when validated external PR state is terminal', async (t) => {
    const workspace = makeWorkspace(t);
    const initial = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/external-terminal', sourceRunId: 'run-before-external-merge',
    }));
    const draft = workRecord(initial.workId, {
      sourceRunIds: ['run-before-external-merge'], pullRequestIds: ['github:example/spectre#2'], candidates: [],
    });
    draft.work.pullRequest = { state: 'draft-open', identity: 'github:example/spectre#2' };
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, draft),
    });

    const next = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/external-terminal', sourceRunId: 'run-after-external-merge', branchPrState: 'merged',
    }));

    assert.notEqual(next.workId, initial.workId);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { branch: 'feature/external-terminal' })),
      { status: 'resolved', workId: next.workId },
    );
  });

  it('folds a named provisional work id into its canonical branch record with a redirect', async (t) => {
    const workspace = makeWorkspace(t);
    assert.equal(typeof work.foldWorkIdentities, 'function');
    const canonical = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/fold', sourceRunId: 'run-canonical',
    }));
    const provisional = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run-provisional' }));

    const folded = await work.foldWorkIdentities(options(workspace, {
      branch: 'feature/fold', canonicalWorkId: canonical.workId, oldWorkIds: [provisional.workId],
    }));
    assert.equal(folded.workId, canonical.workId);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { workId: provisional.workId })),
      { status: 'resolved', workId: canonical.workId, redirectedFrom: provisional.workId },
    );
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run-provisional' })),
      { status: 'resolved', workId: canonical.workId },
    );
  });

  it('folds source-run provenance into the canonical record without moving the old PR', async (t) => {
    const workspace = makeWorkspace(t);
    const canonical = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/fold-history', sourceRunId: 'run-canonical-history',
    }));
    const provisional = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-provisional-history', pullRequestId: 'github:example/spectre#99',
    }));
    const registeredCanonical = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(canonical.workId, {
        sourceRunIds: ['run-canonical-history'], pullRequestIds: [], candidates: [],
      })),
    });
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(provisional.workId, {
        sourceRunIds: ['run-provisional-history'], pullRequestIds: ['github:example/spectre#99'], candidates: [],
      })),
    });

    await work.foldWorkIdentities(options(workspace, {
      branch: 'feature/fold-history', canonicalWorkId: canonical.workId, oldWorkIds: [provisional.workId],
    }));

    const canonicalRecord = JSON.parse(fs.readFileSync(registeredCanonical.recordPath, 'utf8'));
    assert.deepEqual(canonicalRecord.work.associations.sourceRunIds, [
      'run-canonical-history', 'run-provisional-history',
    ]);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { pullRequestId: 'github:example/spectre#99' })),
      { status: 'resolved', workId: provisional.workId },
    );
  });

  it('resolves concurrent captures for one exact source run to one work id', async (t) => {
    const workspace = makeWorkspace(t);
    const results = await Promise.all([
      resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run_exact-capture' })),
      resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run_exact-capture' })),
    ]);

    assert.equal(results[0].workId, results[1].workId);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run_exact-capture' })),
      { status: 'resolved', workId: results[0].workId },
    );
  });

  it('requires identification for conflicting exact associations instead of guessing', async (t) => {
    const workspace = makeWorkspace(t);
    const first = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run_first' }));
    const second = await resolveOrAllocateWorkIdentity(options(workspace, { pullRequestId: 'github:42' }));

    await assert.rejects(
      () => resolveWorkIdentity(options(workspace, {
        sourceRunId: 'run_first',
        pullRequestId: 'github:42',
      })),
      (error) => error.code === 'WORK_IDENTITY_AMBIGUOUS'
        && new Set(error.workIds).size === 2
        && error.workIds.includes(first.workId)
        && error.workIds.includes(second.workId),
    );
  });

  it('keeps later exact candidate associations on an explicitly carried work id', async (t) => {
    const workspace = makeWorkspace(t);
    const created = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run_initial' }));
    const candidate = {
      repository: 'github.com/example/spectre',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      diff: 'sha256:c'.padEnd(71, 'c'),
    };

    const associated = await resolveOrAllocateWorkIdentity(options(workspace, {
      workId: created.workId,
      candidate,
    }));
    assert.equal(associated.workId, created.workId);
    const repeated = await resolveOrAllocateWorkIdentity(options(workspace, { candidate }));
    assert.equal(repeated.workId, created.workId);
    assert.equal(repeated.status, 'noop', 'an unchanged direct PR candidate must not fork work');
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { candidate })),
      { status: 'resolved', workId: created.workId },
    );
  });

  it('resolves each exact association and an explicit ID from a verified registered work record', async (t) => {
    const workspace = makeWorkspace(t);
    const candidate = {
      repository: 'github.com/example/spectre',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      diff: `sha256:${'c'.repeat(64)}`,
    };
    const record = workRecord('registered-work', {
      sourceRunIds: ['run-registered'],
      pullRequestIds: ['github:example/spectre#42'],
      candidates: [candidate],
    });

    await registerCanonicalKnowledge({ ...options(workspace), recordPath: writeProposal(workspace, record) });

    for (const association of [
      { sourceRunId: 'run-registered' },
      { pullRequestId: 'github:example/spectre#42' },
      { candidate },
      { workId: 'registered-work' },
    ]) {
      assert.deepEqual(
        await resolveWorkIdentity(options(workspace, association)),
        { status: 'resolved', workId: 'registered-work' },
      );
    }
  });

  it('rejects registration that would split an exact association between work records', async (t) => {
    const workspace = makeWorkspace(t);
    const shared = { sourceRunIds: ['run-no-split'], pullRequestIds: [], candidates: [] };
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord('first-work', shared)),
    });

    await assert.rejects(
      registerCanonicalKnowledge({
        ...options(workspace), recordPath: writeProposal(workspace, workRecord('second-work', shared)),
      }),
      (error) => error.code === 'WORK_IDENTITY_CONFLICT',
    );
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run-no-split' })),
      { status: 'resolved', workId: 'first-work' },
    );
  });

  it('refuses tampered work bytes for exact resolution or a replacement association', async (t) => {
    const workspace = makeWorkspace(t);
    const associations = { sourceRunIds: ['run-tampered'], pullRequestIds: [], candidates: [] };
    const registered = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord('tampered-work', associations)),
    });
    const recordPath = path.join(registered.storePath, 'knowledge', 'tampered-work', 'record.json');
    const tampered = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    tampered.summary = 'Changed outside the typed registration path.';
    fs.writeFileSync(recordPath, `${JSON.stringify(tampered, null, 2)}\n`);

    await assert.rejects(
      resolveWorkIdentity(options(workspace, { workId: 'tampered-work' })),
      (error) => error.code === 'WORK_IDENTITY_UNVERIFIED',
    );
    await assert.rejects(
      registerCanonicalKnowledge({
        ...options(workspace), recordPath: writeProposal(workspace, workRecord('replacement-work', associations)),
      }),
      (error) => error.code === 'WORK_IDENTITY_UNVERIFIED',
    );
  });

  it('retains exact associations when a work record adds a later PR association', async (t) => {
    const workspace = makeWorkspace(t);
    const initial = await registerCanonicalKnowledge({
      ...options(workspace),
      recordPath: writeProposal(workspace, workRecord('successive-work', {
        sourceRunIds: ['run-execute'], pullRequestIds: [], candidates: [],
      })),
    });
    const replacement = workRecord('successive-work', {
      sourceRunIds: ['run-execute'], pullRequestIds: ['github:example/spectre#9'], candidates: [],
    });
    replacement.summary = 'The next work revision adds the draft PR association.';
    const updated = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, replacement), expectedRevision: initial.revisionToken,
    });
    for (const association of [
      { sourceRunId: 'run-execute' },
      { pullRequestId: 'github:example/spectre#9' },
    ]) {
      assert.deepEqual(
        await resolveWorkIdentity(options(workspace, association)),
        { status: 'resolved', workId: 'successive-work' },
      );
    }

    const dropped = workRecord('successive-work', {
      sourceRunIds: [], pullRequestIds: ['github:example/spectre#9'], candidates: [],
    });
    dropped.summary = 'This proposal incorrectly drops the Execute association.';
    await assert.rejects(
      registerCanonicalKnowledge({
        ...options(workspace), recordPath: writeProposal(workspace, dropped),
        expectedRevision: updated.revisionToken,
      }),
      (error) => error.code === 'WORK_IDENTITY_ASSOCIATION_REMOVED',
    );
  });
});
