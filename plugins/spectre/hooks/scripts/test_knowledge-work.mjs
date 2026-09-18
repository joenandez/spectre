#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import * as work from './knowledge/work.mjs';

import { registerCanonicalKnowledge } from './knowledge/registration.mjs';
import {
  DELIVERY_SELECTION_REASONS,
  evaluateRecordDeliveryMembership,
  listDeliveryMembership,
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

  it('returns every verified work id on one branch in a deterministic order', async (t) => {
    const workspace = makeWorkspace(t);
    const branch = 'feature/plural-branch';
    const workIds = ['work-branch-1', 'work-branch-2', 'work-branch-3'];
    for (const [position, workId] of workIds.entries()) {
      await registerCanonicalKnowledge({
        ...options(workspace), recordPath: writeProposal(workspace, workRecord(workId, {
          sourceRunIds: [`run-branch-${position}`], pullRequestIds: [], candidates: [],
        }, { sourceBranch: branch })),
      });
    }
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord('work-other-branch', {
        sourceRunIds: ['run-other-branch'], pullRequestIds: [], candidates: [],
      }, { sourceBranch: 'feature/unrelated' })),
    });

    const listed = await work.listWorkIdentities(options(workspace, { branch }));
    assert.deepEqual(listed.workIds, workIds);
    assert.deepEqual(listed.legacyWorkIds, []);
    assert.deepEqual(
      (await work.listWorkIdentities(options(workspace, { branch }))).workIds,
      workIds,
      'a repeated branch query must return the same order',
    );
    assert.deepEqual(
      (await work.listWorkIdentities(options(workspace, { branch: 'feature/unrelated' }))).workIds,
      ['work-other-branch'],
    );
  });

  it('reads a legacy scalar branch sidecar without advancing it to a new work id', async (t) => {
    const workspace = makeWorkspace(t);
    const branch = 'feature/legacy-aggregate';
    const legacy = await resolveOrAllocateWorkIdentity(options(workspace, { sourceRunId: 'run-legacy-one' }));
    const registered = await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(legacy.workId, {
        sourceRunIds: ['run-legacy-one', 'run-legacy-two'], pullRequestIds: [], candidates: [],
      })),
    });
    const associationPath = work.workAssociationPath(registered.storePath);
    const sidecar = JSON.parse(fs.readFileSync(associationPath, 'utf8'));
    sidecar.branches = { [branch]: legacy.workId };
    fs.writeFileSync(associationPath, `${JSON.stringify(sidecar, null, 2)}\n`);

    const current = await resolveOrAllocateWorkIdentity(options(workspace, {
      branch, sourceRunId: 'run-after-legacy',
    }));
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(current.workId, {
        sourceRunIds: ['run-after-legacy'], pullRequestIds: [], candidates: [],
      }, { sourceBranch: branch })),
    });

    const listed = await work.listWorkIdentities(options(workspace, { branch }));
    assert.deepEqual(listed.workIds, [current.workId], 'only record-backed branch evidence is selectable');
    assert.deepEqual(listed.legacyWorkIds, [legacy.workId], 'the legacy aggregate stays readable');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(associationPath, 'utf8')).branches,
      { [branch]: legacy.workId },
      'the legacy branch sidecar is never advanced to a new work id',
    );
    for (const sourceRunId of ['run-legacy-one', 'run-legacy-two']) {
      assert.deepEqual(
        await resolveWorkIdentity(options(workspace, { sourceRunId })),
        { status: 'resolved', workId: legacy.workId },
      );
    }
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
    await assert.rejects(
      () => resolveOrAllocateWorkIdentity(options(workspace, { candidate })),
      (error) => error.code === 'WORK_IDENTITY_REQUIRED'
        && error.workIds.includes(created.workId),
      'a delivery-only candidate must neither fork work nor take over the record it matches',
    );
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { candidate })),
      { status: 'resolved', workId: created.workId },
    );
  });

  it('refuses to hand one matched delivery key the identity of another run', async (t) => {
    const workspace = makeWorkspace(t);
    const pullRequestId = 'github:example/spectre#7';
    const first = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-delivery-owner', pullRequestId,
    }));
    await registerCanonicalKnowledge({
      ...options(workspace), recordPath: writeProposal(workspace, workRecord(first.workId, {
        sourceRunIds: ['run-delivery-owner'], pullRequestIds: [pullRequestId], candidates: [],
      })),
    });
    const associationPath = work.workAssociationPath(first.storePath);
    const before = fs.readFileSync(associationPath);

    await assert.rejects(
      () => resolveOrAllocateWorkIdentity(options(workspace, { pullRequestId })),
      (error) => error.code === 'WORK_IDENTITY_REQUIRED' && error.workIds.includes(first.workId),
      'a later run must never inherit the record a shared PR already names',
    );
    assert.deepEqual(fs.readFileSync(associationPath), before, 'the rejected write leaves no association');
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { pullRequestId })),
      { status: 'resolved', workId: first.workId },
      'read-only resolution still reports the single match',
    );

    const laterRun = await resolveOrAllocateWorkIdentity(options(workspace, {
      sourceRunId: 'run-delivery-later', pullRequestId,
    }));
    assert.notEqual(laterRun.workId, first.workId, 'the later run owns its own identity');
  });

  it('still allocates for a delivery key that matches no record', async (t) => {
    const workspace = makeWorkspace(t);
    const allocated = await resolveOrAllocateWorkIdentity(options(workspace, {
      pullRequestId: 'github:example/spectre#404',
    }));
    assert.equal(allocated.status, 'created');
    assert.match(allocated.workId, /^work-/);
    assert.deepEqual(
      await resolveWorkIdentity(options(workspace, { pullRequestId: 'github:example/spectre#404' })),
      { status: 'resolved', workId: allocated.workId },
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

/**
 * Candidate-bounded delivery selection.
 *
 * Every check builds a real Git history with the local `git` binary and registers real work
 * packages against it. Nothing about Git is mocked, because the whole point of the selection
 * layer is that only proved membership in the frozen candidate may reach `selected`.
 */

const FIXTURE_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Spectre Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@spectre.invalid',
  GIT_COMMITTER_NAME: 'Spectre Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@spectre.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function gitRaw(repoDir, args, input) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...FIXTURE_GIT_ENV },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

function git(repoDir, args, input) {
  return gitRaw(repoDir, args, input).trim();
}

/** The predicate's exact patch bytes, so a persisted id is comparable to a recomputed one. */
function patchIdOf(repoDir, sha) {
  const patch = gitRaw(repoDir, [
    'diff-tree', '-p', '--no-color', '--root', '--full-index', '--binary',
    '--no-ext-diff', '--no-textconv', sha,
  ]);
  if (!patch.trim()) return null;
  const [id] = git(repoDir, ['patch-id', '--stable'], patch).split(/\s+/);
  return id || null;
}

function commit(repoDir, message, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(repoDir, relativePath), contents);
  }
  git(repoDir, ['add', '--all']);
  git(repoDir, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function makeGitWorkspace(t) {
  const workspace = makeWorkspace(t);
  git(workspace.projectDir, ['init', '--quiet', '-b', 'main']);
  return workspace;
}

function receiptFor(repoDir, { runId, branch, startHead, terminalHead, acceptedCommits }) {
  return {
    runId,
    branch,
    startHead,
    terminalHead,
    acceptedCommits,
    acceptedPatchIds: acceptedCommits.map((sha) => patchIdOf(repoDir, sha)),
  };
}

function deliveryRecord(id, { sourceRunId, receipt, pullRequestIds = [], sourceBranch, pullRequest }) {
  const record = workRecord(
    id,
    { sourceRunIds: [sourceRunId], pullRequestIds, candidates: [] },
    sourceBranch ? { sourceBranch } : {},
  );
  if (receipt) record.work.deliveryReceipt = receipt;
  if (pullRequest) record.work.pullRequest = pullRequest;
  return record;
}

async function registerDelivery(workspace, record) {
  await registerCanonicalKnowledge({ ...options(workspace), recordPath: writeProposal(workspace, record) });
}

const ABSENT_SHA = '0'.repeat(40);
const ABSENT_PATCH_ID = '1'.repeat(40);

/**
 * One branch carrying present work, reverted work, overwritten work, delivered work, work from
 * another branch, a receipt-less legacy record, a start-only receipt, and work that never
 * entered the candidate range at all.
 */
async function buildSelectionFixture(t) {
  const workspace = makeGitWorkspace(t);
  const repoDir = workspace.projectDir;
  const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
  git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
  const alpha = commit(repoDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
  const beta = commit(repoDir, 'run B: beta', { 'beta.txt': 'b1\n' });
  const gamma = commit(repoDir, 'run C: gamma', { 'gamma.txt': 'c1\n' });
  git(repoDir, ['revert', '--quiet', '--no-edit', '--no-gpg-sign', gamma]);
  const shared = commit(repoDir, 'run D: shared v2', { 'shared.txt': 'v2\n' });
  commit(repoDir, 'later: shared v3', { 'shared.txt': 'v3\n' });

  const candidate = {
    repository: 'github.com/example/spectre',
    base: git(repoDir, ['merge-base', 'main', 'HEAD']),
    head: git(repoDir, ['rev-parse', 'HEAD']),
    diff: `sha256:${'c'.repeat(64)}`,
  };

  // Registration order is deliberately not the expected output order.
  const records = [
    deliveryRecord('work-shared', {
      sourceRunId: 'run-shared',
      receipt: receiptFor(repoDir, {
        runId: 'run-shared', branch: 'feature', startHead: gamma, terminalHead: shared, acceptedCommits: [shared],
      }),
    }),
    deliveryRecord('work-delivered', {
      sourceRunId: 'run-delivered',
      pullRequestIds: ['github:example/spectre#7'],
      pullRequest: { state: 'draft-open', identity: 'github:example/spectre#7', url: 'https://example.invalid/pull/7' },
      receipt: receiptFor(repoDir, {
        runId: 'run-delivered', branch: 'feature', startHead: alpha, terminalHead: beta, acceptedCommits: [beta],
      }),
    }),
    deliveryRecord('work-alpha', {
      sourceRunId: 'run-alpha',
      receipt: receiptFor(repoDir, {
        runId: 'run-alpha', branch: 'feature', startHead: seed, terminalHead: alpha, acceptedCommits: [alpha],
      }),
    }),
    deliveryRecord('work-missing', {
      sourceRunId: 'run-missing',
      receipt: {
        runId: 'run-missing',
        branch: 'feature',
        startHead: seed,
        terminalHead: ABSENT_SHA,
        acceptedCommits: [ABSENT_SHA],
        acceptedPatchIds: [ABSENT_PATCH_ID],
      },
    }),
    deliveryRecord('work-legacy', { sourceRunId: 'run-legacy', sourceBranch: 'feature' }),
    deliveryRecord('work-beta', {
      sourceRunId: 'run-beta',
      receipt: receiptFor(repoDir, {
        runId: 'run-beta', branch: 'feature', startHead: alpha, terminalHead: beta, acceptedCommits: [beta],
      }),
    }),
    deliveryRecord('work-other-branch', {
      sourceRunId: 'run-other-branch',
      sourceBranch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run-other-branch', branch: 'feature/other', startHead: seed, terminalHead: alpha, acceptedCommits: [alpha],
      }),
    }),
    deliveryRecord('work-start-only', {
      sourceRunId: 'run-start-only',
      receipt: { runId: 'run-start-only', branch: 'feature', startHead: seed },
    }),
    deliveryRecord('work-gamma', {
      sourceRunId: 'run-gamma',
      receipt: receiptFor(repoDir, {
        runId: 'run-gamma', branch: 'feature', startHead: beta, terminalHead: gamma, acceptedCommits: [gamma],
      }),
    }),
    deliveryRecord('work-absent', {
      sourceRunId: 'run-absent',
      receipt: receiptFor(repoDir, {
        runId: 'run-absent', branch: 'feature', startHead: seed, terminalHead: seed, acceptedCommits: [seed],
      }),
    }),
  ];
  for (const record of records) await registerDelivery(workspace, record);
  return { workspace, repoDir, candidate, branch: 'feature' };
}

function selectionQuery(fixture) {
  return {
    projectDir: fixture.workspace.projectDir,
    spectreHome: fixture.workspace.spectreHome,
    branch: fixture.branch,
    candidate: fixture.candidate,
  };
}

const EXPECTED_SELECTION = {
  'work-absent': ['excluded', 'not-in-candidate-range'],
  'work-alpha': ['selected', 'net-effect-present'],
  'work-beta': ['selected', 'net-effect-present'],
  'work-delivered': ['excluded', 'pull-request-associated'],
  'work-gamma': ['excluded', 'net-effect-absent'],
  'work-legacy': ['excluded', 'receipt-absent'],
  'work-missing': ['ambiguous', 'accepted-objects-missing'],
  'work-other-branch': ['excluded', 'branch-mismatch'],
  'work-shared': ['ambiguous', 'net-effect-unprovable'],
  'work-start-only': ['ambiguous', 'receipt-start-only'],
};

describe('candidate-bounded delivery selection', () => {
  it('returns one verdict and reason per record for every mapped case', async (t) => {
    const fixture = await buildSelectionFixture(t);
    const result = await listDeliveryMembership(selectionQuery(fixture));

    assert.equal(result.ok, true);
    assert.deepEqual(
      Object.fromEntries(result.evaluations.map((entry) => [entry.workId, [entry.verdict, entry.reason]])),
      EXPECTED_SELECTION,
    );
  });

  it('selects several PR-less current-branch records proven in the frozen candidate', async (t) => {
    const fixture = await buildSelectionFixture(t);
    const result = await listDeliveryMembership(selectionQuery(fixture));

    assert.deepEqual(result.selected, ['work-alpha', 'work-beta']);
  });

  it('keeps rebase-equivalent work selectable from the persisted patch identity', async (t) => {
    const workspace = makeGitWorkspace(t);
    const repoDir = workspace.projectDir;
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const accepted = commit(repoDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
    const receipt = receiptFor(repoDir, {
      runId: 'run-rebased', branch: 'feature', startHead: seed, terminalHead: accepted, acceptedCommits: [accepted],
    });
    git(repoDir, ['checkout', '--quiet', 'main']);
    commit(repoDir, 'target: docs', { 'docs.md': 'target moved\n' });
    git(repoDir, ['checkout', '--quiet', 'feature']);
    git(repoDir, ['rebase', '--quiet', 'main']);
    await registerDelivery(workspace, deliveryRecord('work-rebased', { sourceRunId: 'run-rebased', receipt }));

    const result = await listDeliveryMembership({
      projectDir: repoDir,
      spectreHome: workspace.spectreHome,
      branch: 'feature',
      candidate: {
        repository: 'github.com/example/spectre',
        base: git(repoDir, ['merge-base', 'main', 'HEAD']),
        head: git(repoDir, ['rev-parse', 'HEAD']),
        diff: `sha256:${'d'.repeat(64)}`,
      },
    });

    assert.deepEqual(result.selected, ['work-rebased']);
    assert.deepEqual(result.evaluations[0].evidence.provedByPatchId, [accepted]);
  });

  it('excludes other-branch, delivered, reverted, absent, and legacy records', async (t) => {
    const fixture = await buildSelectionFixture(t);
    const result = await listDeliveryMembership(selectionQuery(fixture));

    assert.deepEqual(result.excluded, [
      'work-absent', 'work-delivered', 'work-gamma', 'work-legacy', 'work-other-branch',
    ]);
  });

  it('never auto-associates missing objects, unprovable overlap, or a start-only receipt', async (t) => {
    const fixture = await buildSelectionFixture(t);
    const result = await listDeliveryMembership(selectionQuery(fixture));

    assert.deepEqual(result.ambiguous, ['work-missing', 'work-shared', 'work-start-only']);
    for (const workId of result.ambiguous) assert.ok(!result.selected.includes(workId), workId);
  });

  it('repeats the same ordered set and the same evidence for the same tuple', async (t) => {
    const fixture = await buildSelectionFixture(t);
    const query = selectionQuery(fixture);
    const first = await listDeliveryMembership(query);
    const second = await listDeliveryMembership(query);

    assert.deepEqual(second, first);
    assert.deepEqual(
      first.evaluations.map((entry) => entry.workId),
      [...first.evaluations.map((entry) => entry.workId)].sort(),
    );
  });

  it('names why membership could not be proven on every excluded and ambiguous record', async (t) => {
    const fixture = await buildSelectionFixture(t);
    const result = await listDeliveryMembership(selectionQuery(fixture));

    for (const entry of result.evaluations) {
      if (entry.verdict === 'selected') {
        assert.equal(entry.recovery, null);
        continue;
      }
      assert.equal(typeof entry.reason, 'string');
      assert.ok(entry.reason.length > 0, entry.workId);
      assert.equal(typeof entry.recovery, 'string');
      assert.ok(entry.recovery.length > 0, `${entry.workId} carries recovery detail`);
    }
  });

  it('answers every hostile input with a closed verdict instead of throwing', async (t) => {
    const workspace = makeGitWorkspace(t);
    const candidate = {
      repository: 'github.com/example/spectre',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      diff: `sha256:${'c'.repeat(64)}`,
    };
    const throwingRecord = { id: 'work-hostile', kind: 'work', get work() { throw new Error('unreadable'); } };
    const hostile = [
      undefined, null, 0, '', [], true, Number.NaN, new Date(), () => {}, Symbol('x'),
      { }, { id: 'work-x' }, { id: 'work-x', kind: 'knowledge' },
      { id: 'work-x', kind: 'work', work: null }, { id: 'work-x', kind: 'work', work: { deliveryReceipt: 7 } },
      throwingRecord,
    ];

    for (const record of hostile) {
      for (const query of [
        { projectDir: workspace.projectDir, record, branch: 'feature', candidate },
        { projectDir: undefined, record, branch: undefined, candidate: undefined },
      ]) {
        const result = evaluateRecordDeliveryMembership(query);
        assert.notEqual(result, undefined, String(record));
        assert.ok(['selected', 'excluded', 'ambiguous'].includes(result.verdict), `${String(record)}: ${result.verdict}`);
        assert.notEqual(result.verdict, 'selected', 'a hostile input is never selected');
        assert.equal(typeof result.reason, 'string');
        assert.ok(result.reason.length > 0);
        assert.ok(result.recovery === null || typeof result.recovery === 'string');
      }
    }
    assert.notEqual(evaluateRecordDeliveryMembership(), undefined);
    assert.notEqual(evaluateRecordDeliveryMembership(null), undefined);
  });

  it('maps every record-level reason to exactly one verdict', () => {
    for (const [reason, verdict] of Object.entries(DELIVERY_SELECTION_REASONS)) {
      assert.ok(['selected', 'excluded', 'ambiguous'].includes(verdict), reason);
    }
  });
});
