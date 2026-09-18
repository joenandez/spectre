#!/usr/bin/env node

/**
 * Repository-local fixture corpus for the bounded delivery-membership spike.
 *
 * Every fixture builds its own Git history with the local `git` binary in a temporary
 * directory: no network call, no downloaded tool, no dependency on this checkout's history.
 * Each fixture exposes the run start HEAD, the terminal HEAD, the accepted commit ids, the
 * accepted patch ids, and the target-to-HEAD candidate tuple the record must be evaluated
 * against, plus the oracle verdict the membership predicate has to produce.
 *
 * `CORE_SCENARIOS` are the six shapes the capability gate froze. The scenarios after them
 * cover the multi-commit shape a real Execute run produces, and the failure shapes that
 * must never resolve to a confident `excluded`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

export const CORE_SCENARIOS = [
  'sequential-runs',
  'rebased-equivalent',
  'overlapping-later-edits',
  'full-revert',
  'missing-objects',
  'unrelated-same-branch',
];

export const MEMBERSHIP_SCENARIOS = [
  ...CORE_SCENARIOS,
  'multi-commit-sequence',
  'multi-commit-partial-revert',
  'partial-range-membership',
  'empty-accepted-commit',
  'rebased-no-patch-commit',
  'candidate-objects-missing',
  'rebased-equivalent-pruned',
  'large-rebased-patch',
];

const FIXED_DATE = '2026-01-01T00:00:00+0000';

/** Above the 1 MiB `execFileSync` default, so the patch cannot be read with it. */
const LARGE_PATCH_BYTES = 1_600_000;

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

/** Untrimmed, so patch text stays byte-identical to what the predicate reads. */
function gitRaw(repoDir, args, input) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

function git(repoDir, args, input) {
  return gitRaw(repoDir, args, input).trim();
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

/** A second repository, so a fixture can name an object this checkout cannot hold. */
function foreignRepo(t, message = 'run A: pruned work', files = { 'alpha.txt': 'a1\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-membership-foreign-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '--quiet', '-b', 'main']);
  const sha = commit(dir, message, files);
  return { dir, sha, patchId: patchIdOf(dir, sha) };
}

function largeFileContents(seedText) {
  const line = `${seedText} `.repeat(4).padEnd(79, 'x');
  const lines = Math.ceil(LARGE_PATCH_BYTES / (line.length + 1));
  return `${Array.from({ length: lines }, (_, index) => `${index} ${line}`).join('\n')}\n`;
}

/**
 * The patch identity the receipt persists at capture time, stable across rebase. The
 * command and the piped bytes are identical to the predicate's, so a recomputed id is
 * comparable to a persisted one.
 */
export function patchIdOf(repoDir, sha) {
  const patch = commitPatchOf(repoDir, sha);
  if (!patch.trim()) return null;
  const [id] = git(repoDir, ['patch-id', '--stable'], patch).split(/\s+/);
  return id || null;
}

/** The predicate's exact patch command, so a recomputed id is comparable to a persisted one. */
export function commitPatchOf(repoDir, sha) {
  return gitRaw(repoDir, [
    'diff-tree', '-p', '--no-color', '--root', '--full-index', '--binary',
    '--no-ext-diff', '--no-textconv', sha,
  ]);
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

/** Drop every reachability root the rewritten commits still hang from, then collect. */
function pruneUnreachable(repoDir) {
  fs.rmSync(path.join(repoDir, '.git', 'ORIG_HEAD'), { force: true });
  git(repoDir, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
  git(repoDir, ['gc', '--quiet', '--prune=now']);
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
    const foreign = foreignRepo(t);

    return {
      repoDir,
      branch: 'feature',
      receipt: {
        runId: 'run_missing_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: foreign.sha,
        acceptedCommits: [foreign.sha],
        acceptedPatchIds: [foreign.patchId],
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

  /** The common shape: one run accepts several commits that edit the same file in turn. */
  'multi-commit-sequence'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'shared.txt': 'v1\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: shared v2', { 'shared.txt': 'v2\n' });
    const acceptedB = commit(repoDir, 'run A: shared v3', { 'shared.txt': 'v3\n' });
    commit(repoDir, 'later: unrelated note', { 'notes.md': 'note\n' });
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_multi_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedB,
        acceptedCommits: [acceptedA, acceptedB],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'selected', reason: 'net-effect-present' },
    };
  },

  /** Half the run survived: the second accepted commit was reverted, the first was kept. */
  'multi-commit-partial-revert'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
    const acceptedB = commit(repoDir, 'run A: beta', { 'beta.txt': 'b1\n' });
    git(repoDir, ['revert', '--quiet', '--no-edit', '--no-gpg-sign', acceptedB]);
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_partial_revert_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedB,
        acceptedCommits: [acceptedA, acceptedB],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'ambiguous', reason: 'net-effect-unprovable' },
    };
  },

  /** One accepted commit shipped earlier, one is still outgoing: the run straddles the base. */
  'partial-range-membership'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    const shipped = commit(repoDir, 'run A: shipped alpha', { 'alpha.txt': 'a1\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const outgoing = commit(repoDir, 'run A: outgoing beta', { 'beta.txt': 'b1\n' });
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_straddle_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: outgoing,
        acceptedCommits: [shipped, outgoing],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'ambiguous', reason: 'partial-range-membership' },
    };
  },

  /** The accepted commit carries no diff, so no net effect can be proved either way. */
  'empty-accepted-commit'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    git(repoDir, ['commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'run A: no-op']);
    const acceptedA = git(repoDir, ['rev-parse', 'HEAD']);
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_empty_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedA,
        acceptedCommits: [acceptedA],
      }),
      candidate: candidateFor(repoDir),
      expected: { verdict: 'ambiguous', reason: 'no-patch-evidence' },
    };
  },

  /**
   * An accepted commit with no patch of its own — an empty commit here, a merge commit in the
   * field — that a rebase moved out of the candidate range while its own object still
   * resolves. Nothing about it proves the run's work absent, so it must never answer
   * `excluded`.
   */
  'rebased-no-patch-commit'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    git(repoDir, ['commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'run A: no-op']);
    const acceptedA = git(repoDir, ['rev-parse', 'HEAD']);
    const terminalHead = commit(repoDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
    const receipt = receiptFor(repoDir, {
      runId: 'run_no_patch_a',
      branch: 'feature',
      startHead: seed,
      terminalHead,
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
      expected: { verdict: 'ambiguous', reason: 'no-patch-identity' },
    };
  },

  /** The frozen candidate names a base this checkout does not hold. */
  'candidate-objects-missing'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: alpha', { 'alpha.txt': 'a1\n' });
    const foreign = foreignRepo(t, 'foreign base', { 'base.txt': 'base\n' });
    return {
      repoDir,
      branch: 'feature',
      receipt: receiptFor(repoDir, {
        runId: 'run_bad_candidate_a',
        branch: 'feature',
        startHead: seed,
        terminalHead: acceptedA,
        acceptedCommits: [acceptedA],
      }),
      candidate: { ...candidateFor(repoDir), baseSha: foreign.sha },
      expected: { verdict: 'ambiguous', reason: 'candidate-objects-missing' },
    };
  },

  /**
   * The rebase-equivalent case after the pre-rebase object was collected. This is the state
   * of a fresh clone, and the only state in which the persisted patch id earns its place.
   */
  'rebased-equivalent-pruned'(t) {
    const fixture = BUILDERS['rebased-equivalent'](t);
    pruneUnreachable(fixture.repoDir);
    return { ...fixture, receipt: { ...fixture.receipt, runId: 'run_rebased_pruned_a' } };
  },

  /** A generated file puts the rebased commit's patch past the 1 MiB read default. */
  'large-rebased-patch'(t) {
    const repoDir = initRepo(t);
    const seed = commit(repoDir, 'seed', { 'README.md': 'seed\n' });
    git(repoDir, ['checkout', '--quiet', '-b', 'feature']);
    const acceptedA = commit(repoDir, 'run A: generated lockfile', {
      'generated.lock': largeFileContents('spectre-membership-large-patch'),
    });
    const receipt = receiptFor(repoDir, {
      runId: 'run_large_a',
      branch: 'feature',
      startHead: seed,
      terminalHead: acceptedA,
      acceptedCommits: [acceptedA],
    });
    git(repoDir, ['checkout', '--quiet', 'main']);
    commit(repoDir, 'target: docs', { 'docs.md': 'target moved\n' });
    git(repoDir, ['checkout', '--quiet', 'feature']);
    git(repoDir, ['rebase', '--quiet', 'main']);
    const rebased = git(repoDir, ['rev-parse', 'HEAD']);
    return {
      repoDir,
      branch: 'feature',
      receipt,
      candidate: candidateFor(repoDir),
      patchBytes: Buffer.byteLength(commitPatchOf(repoDir, rebased)),
      expected: { verdict: 'selected', reason: 'net-effect-present' },
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
    assert.equal(new Set(MEMBERSHIP_SCENARIOS).size, MEMBERSHIP_SCENARIOS.length);
    assert.equal(CORE_SCENARIOS.length, 6);
    for (const scenario of CORE_SCENARIOS) assert.ok(MEMBERSHIP_SCENARIOS.includes(scenario), scenario);
  });

  for (const scenario of CORE_SCENARIOS) {
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
  });

  it('collects the pre-rebase object in the pruned rebase fixture', (t) => {
    const fixture = buildMembershipFixture('rebased-equivalent-pruned', t);
    assert.throws(
      () => git(fixture.repoDir, ['cat-file', '-e', `${fixture.receipt.acceptedCommits[0]}^{commit}`]),
      'the pre-rebase object is gone, so only the persisted patch id remains',
    );
  });

  it('builds a rebased patch past the 1 MiB default read buffer', (t) => {
    const fixture = buildMembershipFixture('large-rebased-patch', t);
    assert.ok(fixture.patchBytes > 1024 * 1024, `patch is ${fixture.patchBytes} bytes`);
  });

  it('feeds patch-id untrimmed patch bytes, as the predicate does', (t) => {
    const fixture = buildMembershipFixture('sequential-runs', t);
    const patch = commitPatchOf(fixture.repoDir, fixture.receipt.acceptedCommits[0]);
    assert.ok(patch.endsWith('\n'), 'the persisted id is computed from untrimmed patch text');
  });
});
