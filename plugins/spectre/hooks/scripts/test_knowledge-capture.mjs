#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { estimateRenderedRecordTokens, refreshKnowledgeIndex } from './knowledge/records.mjs';
import { registerCanonicalKnowledge } from './knowledge/registration.mjs';
import { captureCanonicalKnowledge } from './knowledge/capture.mjs';
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
  const stdinTemp = path.join(root, 'stdin-temp');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(stdinTemp, { recursive: true });
  const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
  fs.writeFileSync(path.join(storePath, 'tags.json'), JSON.stringify({
    schemaVersion: 1,
    tags: { authentication: { description: 'Authentication behavior.', aliases: ['auth'] } },
    redirects: { credentials: 'authentication' },
  }, null, 2));
  refreshKnowledgeIndex(storePath);
  return { root, projectDir, spectreHome, stdinTemp, storePath };
}

function inputPath(value, name, input) {
  const result = path.join(value.root, name);
  fs.writeFileSync(result, `${JSON.stringify(input, null, 2)}\n`);
  return result;
}

function run(kind, args, value, input) {
  const command = kind === 'npm' ? NPM_CLI : BUNDLED_CLI;
  const prefix = kind === 'npm' ? ['knowledge'] : [];
  return spawnSync(process.execPath, [command, ...prefix, ...args, '--project-dir', value.projectDir, '--json'], {
    cwd: value.projectDir,
    env: { ...process.env, SPECTRE_HOME: value.spectreHome, TMPDIR: value.stdinTemp },
    encoding: 'utf8',
    input,
  });
}

function runHuman(kind, args, value, input) {
  const command = kind === 'npm' ? NPM_CLI : BUNDLED_CLI;
  const prefix = kind === 'npm' ? ['knowledge'] : [];
  return spawnSync(process.execPath, [command, ...prefix, ...args, '--project-dir', value.projectDir], {
    cwd: value.projectDir,
    env: { ...process.env, SPECTRE_HOME: value.spectreHome, TMPDIR: value.stdinTemp },
    encoding: 'utf8',
    input,
  });
}

function runWithUnreadableStdin(kind, args, value) {
  const command = kind === 'npm' ? NPM_CLI : BUNDLED_CLI;
  const prefix = kind === 'npm' ? ['knowledge'] : [];
  return spawnSync('/bin/sh', ['-c', 'exec 0< "$1"; shift; exec "$@"', 'sh', value.stdinTemp, process.execPath, command, ...prefix, ...args, '--project-dir', value.projectDir, '--json'], {
    cwd: value.projectDir,
    env: { ...process.env, SPECTRE_HOME: value.spectreHome, TMPDIR: value.stdinTemp },
    encoding: 'utf8',
  });
}

function runHelp(kind, value) {
  const command = kind === 'npm' ? NPM_CLI : BUNDLED_CLI;
  return spawnSync(process.execPath, [command], {
    cwd: value.projectDir,
    env: { ...process.env, SPECTRE_HOME: value.spectreHome, TMPDIR: value.stdinTemp },
    encoding: 'utf8',
  });
}

function output(result) {
  assert.notEqual(result.stdout.trim(), '', result.stderr);
  return JSON.parse(result.stdout);
}

function storedRecord(value, workId) {
  return JSON.parse(fs.readFileSync(path.join(value.storePath, 'knowledge', workId, 'record.json'), 'utf8'));
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

function renderedWorkRecord(input, id, tags) {
  return {
    schemaVersion: 1, id, kind: 'work', title: input.title, summary: input.summary,
    tags, applicability: { scope: 'work', workId: id },
    provenance: { origin: 'captured', capturedAt: '2026-09-09T00:00:00.000Z' }, relatedRecordIds: [],
    work: {
      requestedOutcome: input.requestedOutcome, scope: input.scope, actualChanges: input.actualChanges,
      reasons: input.reasons, discoveries: input.discoveries, verification: input.verification,
      remainingWork: input.remainingWork, relatedContext: input.relatedContext,
      execution: input.execution || { state: 'unknown' },
      verificationState: input.verificationState || { state: 'unknown' },
      pullRequest: input.pullRequest || { state: 'unknown' },
      associations: { sourceRunIds: ['run-canonical-ceiling'], pullRequestIds: [], candidates: [] },
    },
  };
}

function filledTemplate(kind, overrides = {}) {
  const template = JSON.parse(fs.readFileSync(path.join(
    PLUGIN_ROOT, 'skills', kind === 'work' ? 'spectre-work-record' : 'spectre-capture', 'references', `${kind}-capture-input.json`,
  ), 'utf8'));
  return { ...template, ...(kind === 'knowledge' ? knowledgeInput() : workInput()), ...overrides };
}

function rawKnowledgeRecord(input) {
  return {
    schemaVersion: 1, id: input.id, kind: 'knowledge', title: input.title, summary: input.summary,
    tags: ['authentication'], applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-09T00:00:00.000Z' }, relatedRecordIds: [],
    category: input.category, useWhen: input.useWhen, content: input.content, evidence: input.evidence,
    status: 'active',
  };
}

async function registerResourceRecord(value, input) {
  const directory = path.join(value.root, 'proposal', input.id);
  fs.mkdirSync(path.join(directory, 'references'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'record.json'), `${JSON.stringify(rawKnowledgeRecord(input), null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'references', 'proof.md'), 'Durable proof resource.\n');
  return registerCanonicalKnowledge({ projectDir: value.projectDir, spectreHome: value.spectreHome, recordPath: directory });
}

async function registerResourceWork(value, id, input, { legacyImport = false, expectedRevision } = {}) {
  const directory = path.join(value.root, 'work-proposal', id);
  fs.mkdirSync(path.join(directory, 'references'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'record.json'), `${JSON.stringify({
    schemaVersion: 1, id, kind: 'work', title: input.title, summary: input.summary,
    tags: ['authentication'], applicability: { scope: 'work', workId: id, runIds: ['run-a'] },
    provenance: { origin: legacyImport ? 'legacy-import' : 'captured', capturedAt: '2026-09-09T00:00:00.000Z', sourceRunIds: ['run-a'] }, relatedRecordIds: [],
    work: {
      requestedOutcome: input.requestedOutcome, scope: input.scope, actualChanges: input.actualChanges,
      reasons: input.reasons, discoveries: input.discoveries, verification: input.verification,
      remainingWork: input.remainingWork, relatedContext: input.relatedContext,
      execution: { state: 'unknown' }, verificationState: { state: 'unknown' }, pullRequest: { state: 'unknown' },
      associations: { sourceRunIds: ['run-a'], pullRequestIds: [], candidates: [] },
    },
    ...(legacyImport ? { importedSource: { body: 'Imported historical work account.', useWhen: 'Inspecting legacy history.', cues: ['legacy'], category: 'pattern', status: 'active', version: '1' } } : {}),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'references', 'proof.md'), 'Work proof resource.\n');
  return registerCanonicalKnowledge({
    projectDir: value.projectDir, spectreHome: value.spectreHome, recordPath: directory, expectedRevision,
  });
}

describe('semantic knowledge capture', () => {
  it('gives distinct Execute captures on one branch distinct work ids through both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const firstInput = inputPath(value, `branch-first-${kind}.json`, workInput());
      const first = run(kind, [
        'capture', '--kind', 'work', '--input', firstInput,
        '--source-run-id', `run-branch-a-${kind}`, '--branch', 'feature/branch-work',
      ], value);
      assert.equal(first.status, 0, first.stderr);
      const secondInput = inputPath(value, `branch-second-${kind}.json`, workInput({
        summary: 'The second Execute boundary owns its own work record.',
      }));
      const second = run(kind, [
        'capture', '--kind', 'work', '--input', secondInput,
        '--source-run-id', `run-branch-b-${kind}`, '--branch', 'feature/branch-work',
      ], value);
      assert.equal(second.status, 0, second.stderr);
      assert.notEqual(output(second).workId, output(first).workId);

      for (const result of [first, second]) {
        const record = JSON.parse(fs.readFileSync(
          path.join(value.storePath, 'knowledge', output(result).workId, 'record.json'), 'utf8',
        ));
        assert.equal(record.provenance.sourceBranch, 'feature/branch-work');
      }
      const associations = JSON.parse(fs.readFileSync(path.join(value.storePath, 'work-associations.json'), 'utf8'));
      assert.deepEqual(associations.branches, {}, 'branch is evidence on each record, never a pointer');
    }
  });

  it('keeps a later branch capture independent of a terminal PR record through both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const first = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `terminal-first-${kind}.json`, workInput({
          pullRequest: { state: 'merged', identity: 'github:example/spectre#2' },
        })), '--source-run-id', `run-terminal-a-${kind}`, '--pull-request-id', 'github:example/spectre#2', '--branch', 'feature/external-terminal',
      ], value);
      assert.equal(first.status, 0, first.stderr);

      const next = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `terminal-next-${kind}.json`, workInput()),
        '--source-run-id', `run-terminal-b-${kind}`, '--branch', 'feature/external-terminal',
      ], value);
      assert.equal(next.status, 0, next.stderr);
      assert.notEqual(output(next).workId, output(first).workId);
      assert.equal(output(next).workLifecycle.pullRequest, 'unknown', 'a later run never inherits PR state');
      assert.equal(output(first).workLifecycle.pullRequest, 'merged');
    }
  });

  it('requires explicit tags for a new same-branch capture through both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const first = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `tagged-terminal-${kind}.json`, workInput({
          pullRequest: { state: 'draft-open', identity: 'github:example/spectre#3' },
        })), '--source-run-id', `run-tagged-terminal-${kind}`, '--pull-request-id', 'github:example/spectre#3', '--branch', 'feature/post-terminal-tags',
      ], value);
      assert.equal(first.status, 0, first.stderr);

      const next = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `untagged-terminal-${kind}.json`, workInput({ tags: undefined })),
        '--source-run-id', `run-untagged-terminal-${kind}`, '--branch', 'feature/post-terminal-tags',
      ], value);
      assert.equal(next.status, 1);
      assert.equal(output(next).code, 'CAPTURE_INPUT_INVALID');
      const record = JSON.parse(fs.readFileSync(
        path.join(value.storePath, 'knowledge', output(first).workId, 'record.json'), 'utf8',
      ));
      assert.equal(record.provenance.sourceBranch, 'feature/post-terminal-tags');
    }
  });

  it('captures knowledge revisions and exact-associated work from stdin through both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const id = `stdin-${kind}-knowledge`;
      const created = run(kind, ['capture', '--kind', 'knowledge', '--input', '-'], value, `${JSON.stringify(filledTemplate('knowledge', { id }))}\n`);
      assert.equal(created.status, 0, created.stderr);
      const initial = output(created);
      assert.equal(initial.recoveryInput, undefined);
      assert.equal(fs.existsSync(initial.recordPath), true);
      assert.deepEqual(fs.readdirSync(value.stdinTemp), []);

      const revised = run(kind, ['capture', '--kind', 'knowledge', '--input', '-', '--expected-revision', initial.revisionToken], value, `${JSON.stringify(filledTemplate('knowledge', {
        id, evidence: 'Updated through standard input.', tags: undefined,
      }))}\n`);
      assert.equal(revised.status, 0, revised.stderr);
      assert.equal(output(revised).status, 'updated');
      assert.equal(output(revised).recoveryInput, undefined);
      assert.deepEqual(fs.readdirSync(value.stdinTemp), []);

      const work = run(kind, ['capture', '--kind', 'work', '--input', '-', '--source-run-id', `run-stdin-${kind}`], value, `${JSON.stringify(filledTemplate('work'))}\n`);
      assert.equal(work.status, 0, work.stderr);
      assert.match(output(work).workId, /^work-/);
      assert.equal(fs.existsSync(output(work).recordPath), true);
      assert.deepEqual(fs.readdirSync(value.stdinTemp), []);
    }
  });

  it('retains malformed stdin privately for file-input recovery and advertises direct input on both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const failed = run(kind, ['capture', '--kind', 'knowledge', '--input', '-'], value, '{"inputVersion":');
      assert.equal(failed.status, 1);
      const failure = output(failed);
      assert.equal(failure.code, 'CAPTURE_INPUT_INVALID');
      assert.equal(path.dirname(path.dirname(failure.recoveryInput)), value.stdinTemp);
      assert.equal(fs.statSync(path.dirname(failure.recoveryInput)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(failure.recoveryInput).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(failure.recoveryInput, 'utf8'), '{"inputVersion":');

      fs.writeFileSync(failure.recoveryInput, `${JSON.stringify(filledTemplate('knowledge', { id: `recovered-${kind}` }))}\n`);
      const recovered = run(kind, ['capture', '--kind', 'knowledge', '--input', failure.recoveryInput], value);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(fs.existsSync(output(recovered).recordPath), true);

      const help = runHelp(kind, value);
      assert.equal(help.status, 0, `${help.stdout}\n${help.stderr}`);
      assert.match(help.stdout, /capture --kind knowledge\|work --input <json\|->/);
    }
  });

  it('prints retained recovery input for parsed-but-invalid stdin on both public CLIs', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const failed = runHuman(kind, ['capture', '--kind', 'knowledge', '--input', '-'], value, `${JSON.stringify(filledTemplate('knowledge', { title: '' }))}\n`);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /Capture input requires a non-empty title\./);
      const recoveryInput = failed.stderr.match(/^Recovery input: (.+)$/m)?.[1];
      assert.ok(recoveryInput, failed.stderr);
      assert.equal(path.dirname(path.dirname(recoveryInput)), value.stdinTemp);
      assert.equal(fs.readFileSync(recoveryInput, 'utf8'), `${JSON.stringify(filledTemplate('knowledge', { title: '' }))}\n`);
    }
  });

  it('removes a failed stdin transport directory and returns the capture input contract', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const failed = runWithUnreadableStdin(kind, ['capture', '--kind', 'knowledge', '--input', '-'], value);
      assert.equal(failed.status, 1);
      const failure = output(failed);
      assert.equal(failure.code, 'CAPTURE_INPUT_INVALID');
      assert.deepEqual(fs.readdirSync(value.stdinTemp), []);
    }
  });

  it('advertises standard input from both unresolved work resolution commands', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const resolved = run(kind, ['work', 'resolve', '--source-run-id', `run-unresolved-${kind}`], value);
      assert.equal(resolved.status, 0, resolved.stderr);
      assert.match(output(resolved).nextAction.command, /--input -/);
    }
  });

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

  it('rejects oversized work accounts before allocation and preserves legacy accounts until a compact revision', async (t) => {
    const value = await fixture(t);
    const oversized = workInput({ actualChanges: 'x'.repeat(12_000) });
    const newInput = inputPath(value, 'oversized-new-work.json', oversized);
    const rejectedNew = run('bundled', ['capture', '--kind', 'work', '--input', newInput, '--source-run-id', 'run-oversized-new'], value);
    assert.equal(rejectedNew.status, 1);
    assert.equal(output(rejectedNew).code, 'WORK_RECORD_TOO_LARGE');
    assert.equal(output(rejectedNew).recoveryInput, newInput);
    assert.equal(fs.existsSync(path.join(value.storePath, 'work-associations.json')), false);

    const legacy = await registerResourceWork(value, 'legacy-oversized-work', oversized, { legacyImport: true });
    const legacyPath = path.join(value.storePath, 'knowledge', 'legacy-oversized-work', 'record.json');
    const before = fs.readFileSync(legacyPath, 'utf8');
    const revisedInput = inputPath(value, 'oversized-legacy-update.json', workInput({
      actualChanges: 'y'.repeat(12_000),
      tags: undefined,
    }));
    const rejectedUpdate = run('bundled', [
      'capture', '--kind', 'work', '--input', revisedInput, '--work-id', 'legacy-oversized-work',
      '--expected-revision', legacy.revisionToken,
    ], value);
    assert.equal(rejectedUpdate.status, 1);
    assert.equal(output(rejectedUpdate).code, 'WORK_RECORD_TOO_LARGE');
    assert.equal(output(rejectedUpdate).recoveryInput, revisedInput);
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), before);

    const compactInput = inputPath(value, 'compact-legacy-update.json', workInput({ tags: undefined }));
    const compact = run('bundled', [
      'capture', '--kind', 'work', '--input', compactInput, '--work-id', 'legacy-oversized-work',
      '--expected-revision', legacy.revisionToken,
    ], value);
    assert.equal(compact.status, 0, compact.stderr);
    assert.equal(output(compact).status, 'updated');
  });

  it('rejects a canonical tag and work-id ceiling delta before tags or identity can mutate', async (t) => {
    const value = await fixture(t);
    const workId = 'work-00000000-0000-0000-0000-000000000000';
    const canonicalTags = ['canonical-work-capture-rendering-ceiling-boundary-tag'];
    let boundaryInput;
    for (let length = 1; length < 12_000; length += 1) {
      const candidate = workInput({
        actualChanges: 'x'.repeat(length),
        tags: [{ id: canonicalTags[0], description: 'Tests capture preflight accounting.' }],
      });
      const actual = estimateRenderedRecordTokens(renderedWorkRecord(candidate, workId, canonicalTags));
      const standIn = estimateRenderedRecordTokens(renderedWorkRecord(candidate, 'semantic-capture-validation', ['semantic-capture-validation']));
      if (actual > 2_000 && standIn <= 2_000) {
        boundaryInput = candidate;
        break;
      }
    }
    assert.ok(boundaryInput, 'fixture must straddle the old stand-in accounting boundary');
    const tagsPath = path.join(value.storePath, 'tags.json');
    const tagsBefore = fs.readFileSync(tagsPath, 'utf8');
    const source = inputPath(value, 'canonical-ceiling.json', boundaryInput);
    const rejected = run('bundled', [
      'capture', '--kind', 'work', '--input', source, '--source-run-id', 'run-canonical-ceiling',
    ], value);
    assert.equal(rejected.status, 1);
    assert.equal(output(rejected).code, 'WORK_RECORD_TOO_LARGE');
    assert.equal(fs.readFileSync(tagsPath, 'utf8'), tagsBefore);
    assert.equal(fs.existsSync(path.join(value.storePath, 'work-associations.json')), false);
  });

  it('enforces the work-record ceiling for direct registration while retaining legacy imports', async (t) => {
    const value = await fixture(t);
    const oversized = workInput({ actualChanges: 'x'.repeat(12_000) });
    const proposal = path.join(value.root, 'direct-oversized-work');
    fs.mkdirSync(proposal);
    fs.writeFileSync(path.join(proposal, 'record.json'), `${JSON.stringify({
      schemaVersion: 1, id: 'direct-oversized-work', kind: 'work', title: oversized.title, summary: oversized.summary,
      tags: ['authentication'], applicability: { scope: 'work', workId: 'direct-oversized-work' },
      provenance: { origin: 'captured', capturedAt: '2026-09-09T00:00:00.000Z' }, relatedRecordIds: [],
      work: {
        requestedOutcome: oversized.requestedOutcome, scope: oversized.scope, actualChanges: oversized.actualChanges,
        reasons: oversized.reasons, discoveries: oversized.discoveries, verification: oversized.verification,
        remainingWork: oversized.remainingWork, relatedContext: oversized.relatedContext,
        execution: { state: 'unknown' }, verificationState: { state: 'unknown' }, pullRequest: { state: 'unknown' },
        associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] },
      },
    }, null, 2)}\n`);
    await assert.rejects(
      registerCanonicalKnowledge({ projectDir: value.projectDir, spectreHome: value.spectreHome, recordPath: proposal }),
      (error) => error.code === 'WORK_RECORD_TOO_LARGE',
    );
    assert.equal(fs.existsSync(path.join(value.storePath, 'knowledge', 'direct-oversized-work')), false);

    const legacy = await registerResourceWork(value, 'direct-legacy-oversized-work', oversized, { legacyImport: true });
    const legacyPath = path.join(value.storePath, 'knowledge', 'direct-legacy-oversized-work', 'record.json');
    const before = fs.readFileSync(legacyPath, 'utf8');
    await assert.rejects(
      registerResourceWork(value, 'direct-legacy-oversized-work', workInput({ actualChanges: 'y'.repeat(12_000) }), {
        legacyImport: true, expectedRevision: legacy.revisionToken,
      }),
      (error) => error.code === 'WORK_RECORD_TOO_LARGE',
    );
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), before);
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

  it('rejects invalid nested lifecycle state before ensuring a new tag or allocating work identity', async (t) => {
    const value = await fixture(t);
    const tagsPath = path.join(value.storePath, 'tags.json');
    const beforeTags = fs.readFileSync(tagsPath, 'utf8');
    const source = inputPath(value, 'invalid-lifecycle.json', filledTemplate('work', {
      tags: [{ id: 'new-capture-tag', description: 'New capture tag.' }],
      execution: { state: 'definitely-invalid' },
    }));
    const result = run('bundled', ['capture', '--kind', 'work', '--input', source, '--source-run-id', 'run-invalid-lifecycle'], value);
    assert.equal(result.status, 1);
    assert.equal(output(result).code, 'CAPTURE_INPUT_INVALID');
    assert.equal(fs.readFileSync(tagsPath, 'utf8'), beforeTags);
    assert.equal(fs.existsSync(path.join(value.storePath, 'work-associations.json')), false);
  });

  it('rejects nested lifecycle objects with unknown fields before store mutation', async (t) => {
    const value = await fixture(t);
    const tagsPath = path.join(value.storePath, 'tags.json');
    const beforeTags = fs.readFileSync(tagsPath, 'utf8');
    const source = inputPath(value, 'invalid-lifecycle-shape.json', filledTemplate('work', {
      tags: [{ id: 'another-new-capture-tag', description: 'Another new capture tag.' }],
      verificationState: { state: 'unknown', unexpected: 'field' },
    }));
    const result = run('npm', ['capture', '--kind', 'work', '--input', source, '--source-run-id', 'run-invalid-shape'], value);
    assert.equal(result.status, 1);
    assert.equal(output(result).code, 'CAPTURE_INPUT_INVALID');
    assert.equal(fs.readFileSync(tagsPath, 'utf8'), beforeTags);
    assert.equal(fs.existsSync(path.join(value.storePath, 'work-associations.json')), false);
  });

  it('preserves existing package resources and no-ops on identical semantic capture', async (t) => {
    const value = await fixture(t);
    const input = knowledgeInput();
    const registered = await registerResourceRecord(value, input);
    const source = inputPath(value, 'resource-record.json', input);
    const result = run('bundled', ['capture', '--kind', 'knowledge', '--input', source], value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output(result).status, 'noop');
    assert.equal(fs.readFileSync(path.join(registered.storePath, 'knowledge', input.id, 'references', 'proof.md'), 'utf8'), 'Durable proof resource.\n');
  });

  it('allows placeholder-like prose but rejects whole-value template placeholders', async (t) => {
    const value = await fixture(t);
    const valid = inputPath(value, 'valid-prose.json', knowledgeInput({
      content: "Run knowledge-cli.mjs search '<task>' and note the TODO was stale.",
      evidence: 'Promise<void> resolves before flush.',
    }));
    const created = run('bundled', ['capture', '--kind', 'knowledge', '--input', valid], value);
    assert.equal(created.status, 0, created.stderr);

    const beforeTags = fs.readFileSync(path.join(value.storePath, 'tags.json'), 'utf8');
    const template = inputPath(value, 'raw-template.json', JSON.parse(fs.readFileSync(path.join(
      PLUGIN_ROOT, 'skills', 'spectre-capture', 'references', 'knowledge-capture-input.json',
    ), 'utf8')));
    const rejected = run('bundled', ['capture', '--kind', 'knowledge', '--input', template], value);
    assert.equal(rejected.status, 1);
    assert.equal(output(rejected).code, 'CAPTURE_INPUT_INVALID');
    assert.equal(fs.readFileSync(path.join(value.storePath, 'tags.json'), 'utf8'), beforeTags);
  });

  it('merges later work source runs into associations, applicability, and provenance', async (t) => {
    const value = await fixture(t);
    const source = inputPath(value, 'work-runs.json', workInput());
    const created = run('bundled', ['capture', '--kind', 'work', '--input', source, '--source-run-id', 'run-a'], value);
    assert.equal(created.status, 0, created.stderr);
    const initial = output(created);
    const updated = run('bundled', ['capture', '--kind', 'work', '--input', source, '--work-id', initial.workId, '--source-run-id', 'run-b', '--expected-revision', initial.revisionToken], value);
    assert.equal(updated.status, 0, updated.stderr);
    const stored = JSON.parse(fs.readFileSync(path.join(value.storePath, 'knowledge', initial.workId, 'record.json'), 'utf8'));
    assert.deepEqual(stored.work.associations.sourceRunIds, ['run-a', 'run-b']);
    assert.deepEqual(stored.applicability.runIds, ['run-a', 'run-b']);
    assert.deepEqual(stored.provenance.sourceRunIds, ['run-a', 'run-b']);
  });

  it('applies aliases to existing tags and rejects record-id on work capture', async (t) => {
    const value = await fixture(t);
    const alias = inputPath(value, 'existing-alias.json', knowledgeInput({ tags: [{ id: 'authentication', aliases: ['login'] }] }));
    const created = run('bundled', ['capture', '--kind', 'knowledge', '--input', alias], value);
    assert.equal(created.status, 0, created.stderr);
    const tags = JSON.parse(fs.readFileSync(path.join(value.storePath, 'tags.json'), 'utf8'));
    assert.deepEqual(tags.tags.authentication.aliases, ['auth', 'login']);

    const work = inputPath(value, 'work-record-id.json', workInput());
    const rejected = run('npm', ['capture', '--kind', 'work', '--input', work, '--record-id', 'ignored', '--source-run-id', 'run-work-id'], value);
    assert.equal(rejected.status, 1);
    assert.equal(output(rejected).code, 'CAPTURE_INPUT_INVALID');
  });

  it('rejects missing descriptions and tag collisions without catalog mutation', async (t) => {
    const value = await fixture(t);
    const tagsPath = path.join(value.storePath, 'tags.json');
    const beforeTags = fs.readFileSync(tagsPath, 'utf8');
    for (const tags of [[{ id: 'new-tag' }], [{ id: 'new-collision-tag', description: 'Conflicting tag.', aliases: ['auth'] }]]) {
      const source = inputPath(value, `invalid-tag-${tags[0].id}.json`, knowledgeInput({ tags }));
      const result = run('bundled', ['capture', '--kind', 'knowledge', '--input', source], value);
      assert.equal(result.status, 1);
      assert.match(output(result).code, /TAG_(?:DESCRIPTION_REQUIRED|ALIAS_COLLISION)/);
      assert.equal(fs.readFileSync(tagsPath, 'utf8'), beforeTags);
    }
  });

  it('reports stale revisions as conflicts and preserves resources plus associations on guarded work updates', async (t) => {
    const value = await fixture(t);
    const initial = inputPath(value, 'stale-initial.json', knowledgeInput());
    const created = run('bundled', ['capture', '--kind', 'knowledge', '--input', initial], value);
    const firstRevision = output(created).revisionToken;
    const changed = inputPath(value, 'stale-changed.json', knowledgeInput({ evidence: 'Changed once.' }));
    const updated = run('bundled', ['capture', '--kind', 'knowledge', '--input', changed, '--expected-revision', firstRevision], value);
    assert.equal(updated.status, 0, updated.stderr);
    const staleInput = inputPath(value, 'stale-second-change.json', knowledgeInput({ evidence: 'Changed twice.' }));
    const stale = run('bundled', ['capture', '--kind', 'knowledge', '--input', staleInput, '--expected-revision', firstRevision], value);
    assert.equal(stale.status, 1);
    assert.equal(output(stale).status, 'conflict');

    const rawWork = await registerResourceWork(value, 'resource-work', workInput());
    const work = inputPath(value, 'resource-work.json', workInput({ actualChanges: 'Updated with a second source run.', tags: undefined }));
    const workUpdate = run('bundled', ['capture', '--kind', 'work', '--input', work, '--work-id', 'resource-work', '--source-run-id', 'run-b', '--expected-revision', rawWork.revisionToken], value);
    assert.equal(workUpdate.status, 0, workUpdate.stderr);
    assert.equal(fs.readFileSync(path.join(value.storePath, 'knowledge', 'resource-work', 'references', 'proof.md'), 'utf8'), 'Work proof resource.\n');
    const stored = JSON.parse(fs.readFileSync(path.join(value.storePath, 'knowledge', 'resource-work', 'record.json'), 'utf8'));
    assert.deepEqual(stored.work.associations.sourceRunIds, ['run-a', 'run-b']);
  });

  it('returns recovery input, tag outcomes, and stable work identity after post-ensure registration failure', async (t) => {
    const value = await fixture(t);
    const source = inputPath(value, 'recovery.json', workInput({ tags: [{ id: 'recovery-tag', description: 'Recovery test tag.' }] }));
    await assert.rejects(
      captureCanonicalKnowledge({
        projectDir: value.projectDir, spectreHome: value.spectreHome, kind: 'work', inputPath: source,
        sourceRunId: 'run-recovery', afterIndexRefresh: () => { throw new Error('forced registration failure'); },
      }),
      (error) => {
        assert.equal(error.recoveryInput, source);
        assert.match(error.workId, /^work-/);
        assert.deepEqual(error.tags, ['recovery-tag']);
        assert.equal(error.tagOutcomes[0].id, 'recovery-tag');
        return true;
      },
    );
  });

  it('captures a terminal Execute boundary as finalized and leaves an unstated finality unknown', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const terminal = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `terminal-${kind}.json`, workInput({
          remainingWork: 'None.',
          execution: { state: 'finalized' },
          verificationState: { state: 'passed', evidenceRef: 'proof/proof.json' },
          pullRequest: { state: 'none' },
        })), '--source-run-id', `run-terminal-${kind}`, '--branch', 'feature/terminal-finality',
      ], value);
      assert.equal(terminal.status, 0, terminal.stderr);
      const finalized = storedRecord(value, output(terminal).workId);
      assert.equal(finalized.work.execution.state, 'finalized');
      assert.equal(finalized.work.pullRequest.state, 'none');
      assert.equal(finalized.work.remainingWork, 'None.');

      const unstated = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `unstated-${kind}.json`, workInput({
          verificationState: { state: 'passed', evidenceRef: 'proof/proof.json' },
        })), '--source-run-id', `run-unstated-${kind}`, '--branch', 'feature/terminal-finality',
      ], value);
      assert.equal(unstated.status, 0, unstated.stderr);
      const historical = storedRecord(value, output(unstated).workId);
      assert.equal(historical.work.verificationState.state, 'passed');
      assert.equal(historical.work.execution.state, 'unknown');
      assert.equal(historical.work.pullRequest.state, 'unknown');
    }
  });

  it('refuses delivery lifecycle as remaining work at terminal Execute and Ship refresh captures', async (t) => {
    for (const kind of ['bundled', 'npm']) {
      const value = await fixture(t);
      const terminal = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `lifecycle-terminal-${kind}.json`, workInput({
          remainingWork: 'Awaiting PR review, CI, and merge.',
          execution: { state: 'finalized' },
        })), '--source-run-id', `run-lifecycle-terminal-${kind}`, '--branch', 'feature/lifecycle-remaining-work',
      ], value);
      assert.equal(terminal.status, 1);
      assert.equal(output(terminal).code, 'CAPTURE_INPUT_INVALID');

      const blocked = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `lifecycle-blocked-${kind}.json`, workInput({
          remainingWork: 'Waiting on CI.',
          execution: { state: 'blocked' },
        })), '--source-run-id', `run-lifecycle-blocked-${kind}`, '--branch', 'feature/lifecycle-remaining-work',
      ], value);
      assert.equal(blocked.status, 1);
      assert.equal(output(blocked).code, 'CAPTURE_INPUT_INVALID');

      const shipRefresh = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `lifecycle-ship-${kind}.json`, workInput({
          remainingWork: 'None.',
          execution: { state: 'finalized' },
          verificationState: { state: 'passed', evidenceRef: 'proof/proof.json' },
          pullRequest: { state: 'draft-open', identity: 'github:example/spectre#7' },
        })), '--source-run-id', `run-lifecycle-ship-${kind}`, '--pull-request-id', 'github:example/spectre#7', '--branch', 'feature/lifecycle-remaining-work',
      ], value);
      assert.equal(shipRefresh.status, 0, shipRefresh.stderr);
      const shipped = storedRecord(value, output(shipRefresh).workId);
      assert.equal(shipped.work.execution.state, 'finalized');
      assert.equal(shipped.work.pullRequest.state, 'draft-open');
      assert.equal(shipped.work.remainingWork, 'None.');

      const residual = run(kind, [
        'capture', '--kind', 'work', '--input', inputPath(value, `lifecycle-residual-${kind}.json`, workInput({
          remainingWork: 'The rebase path still needs a regression test for merge conflicts.',
          execution: { state: 'blocked' },
          verificationState: { state: 'failed' },
        })), '--source-run-id', `run-lifecycle-residual-${kind}`, '--branch', 'feature/lifecycle-remaining-work',
      ], value);
      assert.equal(residual.status, 0, residual.stderr);
      const kept = storedRecord(value, output(residual).workId);
      assert.equal(kept.work.execution.state, 'blocked');
      assert.equal(
        kept.work.remainingWork,
        'The rebase path still needs a regression test for merge conflicts.',
      );
    }
  });

  it('gates delivery-lifecycle remaining work at capture input and keeps implementation work', async (t) => {
    const value = await fixture(t);

    for (const [index, remainingWork] of [
      'Waiting on CI to pass.',
      'Awaiting PR review from the platform team.',
      'Blocked on code review.',
      'Still waiting on CI.',
      'The PR needs review before merge.',
      'Waiting for the reviewer to approve.',
      'CI is pending; week-long Codex/Claude fill-rate parity remains a post-ship longitudinal measurement.',
      'Draft PR testing section still needs final ship-suite results before final-update; week-long parity remains a post-ship measurement.',
      'Awaiting PR review.',
      'Waiting for approval.',
      'Pending readiness.',
      'Needs merge.',
      'Needs review.',
      'Pending merge.',
      'Blocked on CI checks.',
      'Requires closure.',
      'Awaiting PR review, CI, and closure.',
    ].entries()) {
      await assert.rejects(
        captureCanonicalKnowledge({
          projectDir: value.projectDir, spectreHome: value.spectreHome, kind: 'work',
          inputPath: inputPath(value, `lifecycle-probe-${index}.json`, workInput({ remainingWork })),
          sourceRunId: `run-lifecycle-probe-${index}`,
        }),
        (error) => {
          assert.equal(error.code, 'CAPTURE_INPUT_INVALID', remainingWork);
          assert.match(error.message, /remainingWork/);
          return true;
        },
        remainingWork,
      );
    }

    for (const [index, remainingWork] of [
      'Needs checks.',
      'Needs close.',
      'Needs a follow-up refactor of the merge helper.',
      'Needs merge conflict handling in the rebase path.',
      'None.',
      'unknown — imported record',
      'The rebase path still needs a regression test for merge conflicts.',
    ].entries()) {
      const captured = await captureCanonicalKnowledge({
        projectDir: value.projectDir, spectreHome: value.spectreHome, kind: 'work',
        inputPath: inputPath(value, `lifecycle-accept-${index}.json`, workInput({ remainingWork })),
        sourceRunId: `run-lifecycle-accept-${index}`,
      });
      assert.equal(captured.ok, true, remainingWork);
      assert.equal(storedRecord(value, captured.workId).work.remainingWork, remainingWork);
    }
  });
});
