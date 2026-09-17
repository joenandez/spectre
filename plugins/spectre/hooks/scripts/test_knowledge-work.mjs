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

function workRecord(id, associations, provenance = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: 'work',
    title: `Work record ${id}`,
    summary: 'A typed work fixture that owns exact identity associations.',
    tags: [],
    applicability: { scope: 'work', workId: id },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z', ...provenance },
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

/**
 * Writes a package the association index never saw. That restored-store shape is the only way
 * one exact source run ends up owned by two verified records, so it is the fixture for the
 * duplicate-identity recovery that fold still serves.
 */
function writeStoreRecord(storePath, record) {
  const directory = path.join(storePath, 'knowledge', record.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return directory;
}

describe('stable work identity', () => {
  it('allocates a distinct work id for each exact Execute source run on one branch', async (t) => {
    const workspace = makeWorkspace(t);
    const first = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/delivery-group', sourceRunId: 'run-a',
    }));
    const second = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/delivery-group', sourceRunId: 'run-b',
    }));

    assert.notEqual(second.workId, first.workId);
    for (const [sourceRunId, identity] of [['run-a', first], ['run-b', second]]) {
      assert.deepEqual(
        await resolveWorkIdentity(options(workspace, { sourceRunId })),
        { status: 'resolved', workId: identity.workId },
      );
      const resumed = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId }));
      assert.equal(resumed.workId, identity.workId, 'resuming one exact run must stay idempotent');
      assert.equal(resumed.status, 'noop');
    }
  });

  it('never resolves a work identity from a branch and writes no branch pointer', async (t) => {
    const workspace = makeWorkspace(t);
    const allocated = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/no-pointer', sourceRunId: 'run-no-pointer',
    }));
    const associations = JSON.parse(fs.readFileSync(work.workAssociationPath(allocated.storePath), 'utf8'));

    assert.deepEqual(associations.branches, {});
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { branch: 'feature/no-pointer' })),
      { status: 'unresolved', workId: null },
    );
  });

  it('allocates a new record for a later run instead of rolling over a terminal PR record', async (t) => {
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
    assert.equal(next.status, 'created');
    assert.equal(next.rolledOver, undefined);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run-before-merge' })),
      { status: 'resolved', workId: initial.workId },
    );
  });

  it('folds a duplicate record of one exact source run into its canonical id with a redirect', async (t) => {
    const workspace = makeWorkspace(t);
    assert.equal(typeof work.foldWorkIdentities, 'function');
    const canonical = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/fold', sourceRunId: 'run-duplicated',
    }));
    const registeredCanonical = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(canonical.workId, {
        sourceRunIds: ['run-duplicated'], pullRequestIds: [], candidates: [],
      })),
    });
    const duplicate = workRecord('work-restored-duplicate', {
      sourceRunIds: ['run-duplicated'], pullRequestIds: [], candidates: [],
    });
    writeStoreRecord(registeredCanonical.storePath, duplicate);
    await assert.rejects(
      () => resolveWorkIdentity(options(workspace, { sourceRunId: 'run-duplicated' })),
      (error) => error.code === 'WORK_IDENTITY_AMBIGUOUS',
    );

    const folded = await work.foldWorkIdentities(options(workspace, {
      canonicalWorkId: canonical.workId, oldWorkIds: [duplicate.id],
    }));
    assert.equal(folded.workId, canonical.workId);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { workId: duplicate.id })),
      { status: 'resolved', workId: canonical.workId, redirectedFrom: duplicate.id },
    );
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run-duplicated' })),
      { status: 'resolved', workId: canonical.workId },
    );
    const canonicalBytes = fs.readFileSync(registeredCanonical.recordPath);
    const associationPath = work.workAssociationPath(registeredCanonical.storePath);
    const associationBytes = fs.readFileSync(associationPath);
    assert.deepEqual(
      await work.foldWorkIdentities(options(workspace, {
        canonicalWorkId: canonical.workId, oldWorkIds: [duplicate.id],
      })),
      { ok: true, status: 'noop', workId: canonical.workId, foldedWorkIds: [duplicate.id] },
    );
    assert.deepEqual(fs.readFileSync(registeredCanonical.recordPath), canonicalBytes);
    assert.deepEqual(fs.readFileSync(associationPath), associationBytes);
  });

  it('rejects a PR-bound duplicate record without mutating the canonical fold', async (t) => {
    const workspace = makeWorkspace(t);
    const canonical = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/fold-history', sourceRunId: 'run-duplicated-history',
    }));
    const registeredCanonical = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(canonical.workId, {
        sourceRunIds: ['run-duplicated-history'], pullRequestIds: [], candidates: [],
      })),
    });
    const duplicate = workRecord('work-restored-pr-duplicate', {
      sourceRunIds: ['run-duplicated-history'], pullRequestIds: ['github:example/spectre#99'], candidates: [],
    });
    writeStoreRecord(registeredCanonical.storePath, duplicate);

    const canonicalBytes = fs.readFileSync(registeredCanonical.recordPath);
    const associationPath = work.workAssociationPath(registeredCanonical.storePath);
    const associationBytes = fs.readFileSync(associationPath);
    await assert.rejects(
      () => work.foldWorkIdentities(options(workspace, {
        canonicalWorkId: canonical.workId, oldWorkIds: [duplicate.id],
      })),
      (error) => error.code === 'WORK_FOLD_PERMANENT_BOUNDARY',
    );
    assert.deepEqual(fs.readFileSync(registeredCanonical.recordPath), canonicalBytes);
    assert.deepEqual(fs.readFileSync(associationPath), associationBytes);
  });

  it('rejects missing, candidate-bearing, or terminal provisional work before changing identities', async (t) => {
    const workspace = makeWorkspace(t);
    const canonical = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/fold-rejects', sourceRunId: 'run-canonical-rejects',
    }));
    const candidate = {
      repository: 'github.com/example/spectre', base: 'a'.repeat(40), head: 'b'.repeat(40), diff: `sha256:${'c'.repeat(64)}`,
    };
    const candidateWork = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-candidate-rejects', candidate,
    }));
    const terminalWork = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-terminal-rejects',
    }));
    const tamperedWork = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-tampered-rejects',
    }));
    const distinctWork = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-distinct-rejects',
    }));
    const registeredCanonical = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(canonical.workId, {
        sourceRunIds: ['run-canonical-rejects'], pullRequestIds: [], candidates: [],
      })),
    });
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(candidateWork.workId, {
        sourceRunIds: ['run-candidate-rejects'], pullRequestIds: [], candidates: [candidate],
      })),
    });
    const terminal = workRecord(terminalWork.workId, {
      sourceRunIds: ['run-terminal-rejects'], pullRequestIds: [], candidates: [],
    });
    terminal.work.pullRequest = { state: 'merged' };
    await registerCanonicalKnowledge({ ...options(workspace), recordPath: writeProposal(workspace, terminal) });
    const tampered = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(tamperedWork.workId, {
        sourceRunIds: ['run-tampered-rejects'], pullRequestIds: [], candidates: [],
      })),
    });
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(distinctWork.workId, {
        sourceRunIds: ['run-distinct-rejects'], pullRequestIds: [], candidates: [],
      })),
    });
    const tamperedRecord = JSON.parse(fs.readFileSync(tampered.recordPath, 'utf8'));
    tamperedRecord.summary = 'These bytes no longer match the recorded revision.';
    fs.writeFileSync(tampered.recordPath, `${JSON.stringify(tamperedRecord, null, 2)}\n`);

    const associationPath = work.workAssociationPath(registeredCanonical.storePath);
    const canonicalBytes = fs.readFileSync(registeredCanonical.recordPath);
    const associationBytes = fs.readFileSync(associationPath);
    for (const [oldWorkId, code] of [
      ['work-missing-fold', 'WORK_FOLD_RECORD_MISSING'],
      [candidateWork.workId, 'WORK_FOLD_CANDIDATE_BOUNDARY'],
      [terminalWork.workId, 'WORK_FOLD_PERMANENT_BOUNDARY'],
      [tamperedWork.workId, 'WORK_IDENTITY_UNVERIFIED'],
      [distinctWork.workId, 'WORK_FOLD_DISTINCT_RUNS'],
    ]) {
      await assert.rejects(
        () => work.foldWorkIdentities(options(workspace, {
          canonicalWorkId: canonical.workId, oldWorkIds: [oldWorkId],
        })),
        (error) => error.code === code,
      );
      assert.deepEqual(fs.readFileSync(registeredCanonical.recordPath), canonicalBytes);
      assert.deepEqual(fs.readFileSync(associationPath), associationBytes);
    }
  });

  it('keeps chained redirects one hop and rejects a redirected canonical target without mutation', async (t) => {
    const workspace = makeWorkspace(t);
    const third = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run-fold-chain' }));
    const registered = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(third.workId, {
        sourceRunIds: ['run-fold-chain'], pullRequestIds: [], candidates: [],
      })),
    });
    const first = { workId: 'work-chain-duplicate-one' };
    const second = { workId: 'work-chain-duplicate-two' };
    for (const identity of [first, second]) {
      writeStoreRecord(registered.storePath, workRecord(identity.workId, {
        sourceRunIds: ['run-fold-chain'], pullRequestIds: [], candidates: [],
      }));
    }

    await work.foldWorkIdentities(options(workspace, {
      canonicalWorkId: second.workId, oldWorkIds: [first.workId],
    }));
    await work.foldWorkIdentities(options(workspace, {
      canonicalWorkId: third.workId, oldWorkIds: [second.workId],
    }));

    const associationPath = work.workAssociationPath(registered.storePath);
    const associations = JSON.parse(fs.readFileSync(associationPath, 'utf8'));
    assert.deepEqual(associations.redirects, {
      [first.workId]: third.workId,
      [second.workId]: third.workId,
    });
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { workId: first.workId })),
      { status: 'resolved', workId: third.workId, redirectedFrom: first.workId },
    );

    const before = fs.readFileSync(associationPath);
    await assert.rejects(
      () => work.foldWorkIdentities(options(workspace, {
        canonicalWorkId: first.workId, oldWorkIds: [third.workId],
      })),
      (error) => error.code === 'WORK_FOLD_CONFLICT',
    );
    assert.deepEqual(fs.readFileSync(associationPath), before);
  });

  it('rejects a fold of distinct runs that share only a branch without mutation', async (t) => {
    const workspace = makeWorkspace(t);
    const canonical = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/fold-shared-branch', sourceRunId: 'run-fold-owner',
    }));
    const other = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/fold-shared-branch', sourceRunId: 'run-fold-other',
    }));
    for (const [identity, sourceRunId] of [[canonical, 'run-fold-owner'], [other, 'run-fold-other']]) {
      await registerCanonicalKnowledge({
        ...options(workspace), recordPath: writeProposal(workspace, workRecord(identity.workId, {
          sourceRunIds: [sourceRunId], pullRequestIds: [], candidates: [],
        })),
      });
    }

    const associationPath = work.workAssociationPath((await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-fold-owner',
    }))).storePath);
    const before = fs.readFileSync(associationPath);
    await assert.rejects(
      () => work.foldWorkIdentities(options(workspace, {
        branch: 'feature/fold-shared-branch', canonicalWorkId: canonical.workId, oldWorkIds: [other.workId],
      })),
      (error) => error.code === 'WORK_FOLD_DISTINCT_RUNS',
    );
    assert.deepEqual(fs.readFileSync(associationPath), before);
  });

  it('keeps an explicitly named terminal work id and never rolls it over for a later run', async (t) => {
    const workspace = makeWorkspace(t);
    const initial = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/explicit-terminal', sourceRunId: 'run-explicit-terminal',
    }));
    const terminal = workRecord(initial.workId, {
      sourceRunIds: ['run-explicit-terminal'], pullRequestIds: [], candidates: [],
    });
    terminal.work.pullRequest = { state: 'merged' };
    const registered = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, terminal),
    });
    const associationPath = work.workAssociationPath(registered.storePath);
    const before = fs.readFileSync(associationPath);

    assert.deepEqual(
      await resolveOrAllocateWorkIdentity(options(workspace, {
        branch: 'feature/explicit-terminal', workId: initial.workId,
      })),
      {
        ok: true,
        status: 'noop',
        workId: initial.workId,
        storePath: registered.storePath,
        associationPath,
      },
    );
    assert.deepEqual(fs.readFileSync(associationPath), before);

    const later = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch: 'feature/explicit-terminal', sourceRunId: 'run-after-explicit-terminal',
    }));
    assert.notEqual(later.workId, initial.workId);
    assert.equal(later.rolledOver, undefined);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { workId: initial.workId })),
      { status: 'resolved', workId: initial.workId },
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

  it('keeps the exact source run as identity when a shared PR already names another record', async (t) => {
    const workspace = makeWorkspace(t);
    const first = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run_first' }));
    const second = await resolveOrAllocateWorkIdentity(options(workspace, { pullRequestId: 'github:42' }));

    assert.notEqual(second.workId, first.workId);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run_first', pullRequestId: 'github:42' })),
      { status: 'resolved', workId: first.workId },
    );
    const associated = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run_first', pullRequestId: 'github:42',
    }));
    assert.equal(associated.workId, first.workId);
  });

  it('accepts one PR id and one exact candidate tuple across five verified records', async (t) => {
    const workspace = makeWorkspace(t);
    const candidate = {
      repository: 'github.com/example/spectre',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      diff: `sha256:${'c'.repeat(64)}`,
    };
    const pullRequestId = 'github:example/spectre#7';
    const workIds = ['work-plural-1', 'work-plural-2', 'work-plural-3', 'work-plural-4', 'work-plural-5'];
    for (const [position, workId] of workIds.entries()) {
      await registerCanonicalKnowledge({
        ...options(workspace), recordPath: writeProposal(workspace, workRecord(workId, {
          sourceRunIds: [`run-plural-${position}`], pullRequestIds: [pullRequestId], candidates: [candidate],
        })),
      });
    }

    for (const association of [{ pullRequestId }, { candidate }, { pullRequestId, candidate }]) {
      assert.deepEqual(
        await resolveWorkIdentity(options(workspace, association)),
        { status: 'plural', workId: null, workIds },
      );
      assert.deepEqual(
        (await work.listWorkIdentities(options(workspace, association))).workIds,
        workIds,
      );
    }
    for (const [position, workId] of workIds.entries()) {
      assert.deepEqual(
        await resolveWorkIdentity(options(workspace, { sourceRunId: `run-plural-${position}` })),
        { status: 'resolved', workId },
      );
    }
  });

  it('still rejects two verified records that claim one exact source run under a shared PR', async (t) => {
    const workspace = makeWorkspace(t);
    const pullRequestId = 'github:example/spectre#8';
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord('work-run-owner', {
        sourceRunIds: ['run-owned-once'], pullRequestIds: [pullRequestId], candidates: [],
      })),
    });

    await assert.rejects(
      registerCanonicalKnowledge({
        ...options(workspace), recordPath: writeProposal(workspace, workRecord('work-run-claimant', {
          sourceRunIds: ['run-owned-once'], pullRequestIds: [pullRequestId], candidates: [],
        })),
      }),
      (error) => error.code === 'WORK_IDENTITY_CONFLICT' && error.conflictingWorkIds.includes('work-run-owner'),
    );
    await assert.rejects(
      resolveOrAllocateWorkIdentity(options(workspace, {
        workId: 'work-run-claimant', sourceRunId: 'run-owned-once',
      })),
      (error) => error.code === 'WORK_IDENTITY_CONFLICT',
    );
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { sourceRunId: 'run-owned-once' })),
      { status: 'resolved', workId: 'work-run-owner' },
    );
  });

  it('associates a second record with an already shared PR id and candidate under an exact work id', async (t) => {
    const workspace = makeWorkspace(t);
    const candidate = {
      repository: 'github.com/example/spectre',
      base: 'd'.repeat(40),
      head: 'e'.repeat(40),
      diff: `sha256:${'f'.repeat(64)}`,
    };
    const pullRequestId = 'github:example/spectre#11';
    const first = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-shared-first', pullRequestId, candidate,
    }));
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(first.workId, {
        sourceRunIds: ['run-shared-first'], pullRequestIds: [pullRequestId], candidates: [candidate],
      })),
    });

    const second = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run-shared-second' }));
    assert.notEqual(second.workId, first.workId);
    const associated = await resolveOrAllocateWorkIdentity(options(workspace, {
      workId: second.workId, pullRequestId, candidate,
    }));
    assert.equal(associated.workId, second.workId);
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(second.workId, {
        sourceRunIds: ['run-shared-second'], pullRequestIds: [pullRequestId], candidates: [candidate],
      })),
    });
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { workId: second.workId, pullRequestId, candidate })),
      { status: 'resolved', workId: second.workId },
    );
    assert.deepEqual(
      (await work.listWorkIdentities(options(workspace, { pullRequestId }))).workIds,
      [first.workId, second.workId].sort(),
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
