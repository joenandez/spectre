#!/usr/bin/env node

/**
 * Repository-local fixture corpus for the bounded delivery-membership spike.
 *
 * Every fixture builds its own Git history with the local `git` binary in a temporary
 * directory: no network call, no downloaded tool, no dependency on this checkout's history.
 * Each fixture exposes the run start HEAD, the terminal HEAD, the accepted commit ids, the
 * accepted patch ids, and the target-to-HEAD candidate tuple the record must be evaluated
 * against, plus the oracle verdict the membership predicate has to produce.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

export const MEMBERSHIP_SCENARIOS = [
  'sequential-runs',
  'rebased-equivalent',
  'overlapping-later-edits',
  'full-revert',
  'missing-objects',
  'unrelated-same-branch',
];

const FIXED_DATE = '2026-01-01T00:00:00+0000';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Spectre Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@spectre.invalid',
  GIT_COMMITTER_NAME: 'Spectre Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@spectre.invalid',
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(repoDir, args, input) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  }).trim();
}

function initRepo(t) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-membership-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  git(repoDir, ['init', '--quiet', '-b', 'main']);
  return repoDir;
}

function commit(repoDir, message, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(repoDir, relativePath);
    if (contents === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  git(repoDir, ['add', '--all']);
  git(repoDir, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

/** The patch identity the receipt persists at capture time, stable across rebase. */
export function patchIdOf(repoDir, sha) {
  const patch = git(repoDir, ['diff-tree', '-p', '--no-color', '--root', '--full-index', '--binary', sha]);
  if (!patch) return null;
  const [id] = git(repoDir, ['patch-id', '--stable'], `${patch}\n`).split(/\s+/);
  return id || null;
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

/** The frozen outgoing candidate Ship evaluates against: target merge-base to branch HEAD. */
function candidateFor(repoDir, targetRef = 'main') {
  const headSha = git(repoDir, ['rev-parse', 'HEAD']);
  return { targetRef, baseSha: git(repoDir, ['merge-base', targetRef, headSha]), headSha };
}

const BUILDERS = {
  /** Two Execute runs on one branch; the first run's work is still inside the candidate. */
  'sequential-runs'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
    commit(repoDir, 'run B: beta', { 'beta.txt': 'b1\n' });
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_sequential_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedA,
        acceptedCommits: [acceptedA],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'selected', reason: 'net-effect-present' },
    };
  },

  /** The run's commits were rebased onto an advanced base; only patch identity survives. */
  'rebased-equivalent'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
    const receipt = receiptFor(repoDir, {
      runId: 'run_rebased_a',
      branch: 'feature',
      startHead: seed,
      terminalHead: acceptedA,
      acceptedCommits: [acceptedA],
    });
    git(repoDir, ['checkout', '--quiet', 'main']);
    commit(repoDir, 'target: docs', { 'docs.md': 'target moved\n' });
    git(repoDir, ['checkout', '--quiet', 'feature']);
    git(repoDir, ['rebase', '--quiet', 'main']);
    return {
      repoDir,
      branch: 'feature',
      receipt,
      candidate: candidateFor(repoDir),
      expected: { verdict: 'selected', reason: 'net-effect-present' },
    };
  },

  /** A later commit rewrote the same lines: neither presence nor absence is provable. */
  'overlapping-later-edits'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'shared.txt': 'v1\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: shared v2', { 'shared.txt': 'v2\n' });
    commit(repoDir, 'later: shared v3', { 'shared.txt': 'v3\n' });
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_overlap_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedA,
        acceptedCommits: [acceptedA],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'ambiguous', reason: 'net-effect-unprovable' },
    };
  },

  /** The run's commit is inside the candidate range but a later revert removed its effect. */
  'full-revert'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: reverted feature', { 'reverted.txt': 'a1\n' });
    git(repoDir, ['revert', '--quiet', '--no-edit', '--no-gpg-sign', acceptedA]);
    commit(repoDir, 'run B: kept work', { 'kept.txt': 'b1\n' });
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_reverted_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedA,
        acceptedCommits: [acceptedA],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'excluded', reason: 'net-effect-absent' },
    };
  },

  /** The receipt names commits this checkout does not hold; nothing can be recomputed. */
  'missing-objects'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    commit(repoDir, 'run B: beta', { 'beta.txt': 'b1\n' });

    const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-membership-foreign-'));
    t.after(() => fs.rmSync(foreignDir, { recursive: true, force: true }));
    git(foreignDir, ['init', '--quiet', '-b', 'main']);
    const foreign = commit(foreignDir, 'run A: pruned work', { 'alpha.txt': 'a1\n' });
    const foreignPatchId = patchIdOf(foreignDir, foreign);

    return {
      repoDir,
      branch: 'feature',
      receipt: {
        runId: 'run_missing_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: foreign,
        acceptedCommits: [foreign],
        acceptedPatchIds: [foreignPatchId],
      },
      candidate: candidateFor(repoDir),
      expected: { verdict: 'ambiguous', reason: 'accepted-objects-missing' },
    };
  },

  /** Same branch, already delivered: the run's commit sits behind the candidate base. */
  'unrelated-same-branch'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: shipped alpha', { 'alpha.txt': 'a1\n' });
    git(repoDir, ['checkout', '--quiet', 'main']);
    git(repoDir, ['merge', '--quiet', '--ff-only', 'feature']);
    git(repoDir, ['checkout', '--quiet', 'feature']);
    commit(repoDir, 'run B: beta', { 'beta.txt': 'b1\n' });
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_unrelated_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedA,
        acceptedCommits: [acceptedA],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'excluded', reason: 'not-in-candidate-range' },
    };
  },
};

export function buildMembershipFixture(scenario, t) {
  const builder = BUILDERS[scenario];
  if (!builder) throw new Error(`Unknown membership fixture scenario ${scenario}`);
  return { scenario, ...builder(t) };
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

describe('delivery membership fixture corpus', () => {
  it('covers every required scenario exactly once', () => {
    assert.deepEqual([...MEMBERSHIP_SCENARIOS].sort(), Object.keys(BUILDERS).sort());
    assert.equal(new Set(MEMBERSHIP_SCENARIOS).size, 6);
  });

  for (const scenario of MEMBERSHIP_SCENARIOS) {
    it(`${scenario} exposes run heads, accepted commits, and the candidate tuple`, (t) => {
      const fixture = buildMembershipFixture(scenario, t);
      const { receipt, candidate } = fixture;
      assert.equal(receipt.branch, fixture.branch);
      assert.match(receipt.startHead, SHA_PATTERN);
      assert.match(receipt.terminalHead, SHA_PATTERN);
      assert.ok(receipt.acceptedCommits.length > 0, 'accepted commit ids are exposed');
      for (const sha of receipt.acceptedCommits) assert.match(sha, SHA_PATTERN);
      assert.equal(receipt.acceptedPatchIds.length, receipt.acceptedCommits.length);
      for (const id of receipt.acceptedPatchIds) assert.match(id, SHA_PATTERN);
      assert.match(candidate.baseSha, SHA_PATTERN);
      assert.match(candidate.headSha, SHA_PATTERN);
      assert.notEqual(candidate.baseSha, candidate.headSha);
      assert.ok(['selected', 'excluded', 'ambiguous'].includes(fixture.expected.verdict));
    });
  }

  it('builds history with the local git binary and no remote', (t) => {
    const fixture = buildMembershipFixture('sequential-runs', t);
    assert.equal(git(fixture.repoDir, ['remote']), '');
    assert.ok(fs.existsSync(path.join(fixture.repoDir, '.git')));
  });

  it('keeps patch identity stable across rebase', (t) => {
    const fixture = buildMembershipFixture('rebased-equivalent', t);
    const rangePatchIds = git(fixture.repoDir, ['rev-list', `${fixture.candidate.baseSha}..${fixture.candidate.headSha}`])
      .split('\n')
      .filter(Boolean)
      .map((sha) => patchIdOf(fixture.repoDir, sha));
    assert.ok(
      rangePatchIds.includes(fixture.receipt.acceptedPatchIds[0]),
      'the rebased commit keeps the accepted patch identity',
    );
    assert.equal(
      git(fixture.repoDir, ['cat-file', '-t', fixture.receipt.acceptedCommits[0]]),
      'commit',
      'the pre-rebase object still resolves while its sha left the branch',
    );
  });
});
