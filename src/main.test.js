import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refreshKnowledgeIndex } from '../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import { resolveProjectStore } from '../plugins/spectre/hooks/scripts/knowledge/store.mjs';

const CLI_PATH = path.resolve('bin/spectre.js');

function noGit() {
  throw new Error('not a Git project');
}

function writeRecord(storePath, {
  id,
  category = 'feature',
  description,
  triggers,
}) {
  const recordDir = path.join(storePath, 'knowledge', id);
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(
    path.join(recordDir, 'record.json'),
    JSON.stringify(typedKnowledgeRecord({
      id,
      category: category === 'feature' ? 'pattern' : category === 'procedures' ? 'decision' : category,
      description,
      tags: triggers.map((trigger) => trigger.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()),
    }), null, 2),
  );
}

function typedKnowledgeRecord({
  id,
  category = 'pattern',
  description = `Use when applying ${id}`,
  tags = [id],
  content = `Apply the recorded guidance for ${id}.`,
} = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: 'knowledge',
    title: id,
    summary: description,
    tags,
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' },
    relatedRecordIds: [],
    category,
    useWhen: description,
    content,
    evidence: 'Test fixture.',
    status: 'active',
  };
}

function writeProposal(root, {
  id,
  category = 'feature',
  description = `Use when applying ${id}`,
  triggers = [id],
  body = `\n# ${id}\n\nProposal bytes.\n`,
}) {
  const recordDir = path.join(root, id);
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(
    path.join(recordDir, 'record.json'),
    JSON.stringify(typedKnowledgeRecord({
      id,
      category: category === 'feature' ? 'pattern' : category,
      description,
      tags: triggers.map((trigger) => trigger.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()),
      content: body,
    }), null, 2),
  );
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
  assert.equal(stores.length, 1);
  return stores[0];
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd || path.resolve('.'),
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

async function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-main-test-'));
  const projectDir = path.join(root, 'workspace', 'project');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  const store = await resolveProjectStore(projectDir, {
    spectreHome,
    gitRunner: noGit,
  });
  writeRecord(store.storePath, {
    id: 'feature-auth',
    description: 'Authentication and session behavior.',
    triggers: ['account sign in'],
  });
  writeRecord(store.storePath, {
    id: 'procedure-release',
    category: 'procedures',
    description: 'Publish a release.',
    triggers: ['release publish'],
  });
  refreshKnowledgeIndex(store.storePath);
  return { root, projectDir, spectreHome };
}

test('knowledge search is target-independent with project-dir, human, JSON, and empty-query output', async () => {
  const fixture = await makeFixture();
  try {
    const human = runCli([
      'knowledge',
      'search',
      'account sign in',
      '--project-dir',
      fixture.projectDir,
    ], {
      env: { SPECTRE_HOME: fixture.spectreHome },
    });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /feature-auth/);
    assert.match(human.stdout, /Authentication and session behavior/);
    assert.doesNotMatch(human.stderr, /Codex target/);

    const json = runCli([
      'knowledge',
      'search',
      'release',
      '--project-dir',
      fixture.projectDir,
      '--json',
    ], {
      env: { SPECTRE_HOME: fixture.spectreHome },
    });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.results.map(({ id }) => id), ['procedure-release']);

    const empty = runCli([
      'knowledge',
      'search',
      '',
      '--project-dir',
      fixture.projectDir,
    ], {
      env: { SPECTRE_HOME: fixture.spectreHome },
    });
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /feature-auth/);
    assert.match(empty.stdout, /procedure-release/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('knowledge CLI returns stable JSON failures, recognizes future mutators, and preserves Codex grammar', () => {
  const unknown = runCli(['knowledge', 'unknown', '--json']);
  assert.notEqual(unknown.status, 0);
  assert.deepEqual(JSON.parse(unknown.stdout), {
    ok: false,
    code: 'UNKNOWN_KNOWLEDGE_COMMAND',
    message: 'Unknown knowledge command "unknown".',
  });
  assert.equal(unknown.stderr, '');

  const missingRecord = runCli(['knowledge', 'register', '--json']);
  assert.notEqual(missingRecord.status, 0);
  assert.equal(JSON.parse(missingRecord.stdout).code, 'MISSING_RECORD');

  const installGrammar = runCli(['install', 'unsupported', '--scope', 'project']);
  assert.notEqual(installGrammar.status, 0);
  assert.match(installGrammar.stderr, /Only the Codex target is currently implemented/);
});

test('knowledge register writes canonical store/index and reports validation errors as JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-main-register-'));
  try {
    const projectDir = path.join(root, 'workspace', 'project');
    const spectreHome = path.join(root, 'spectre-home');
    const proposals = path.join(root, 'proposals');
    fs.mkdirSync(projectDir, { recursive: true });
    const proposal = writeProposal(proposals, {
      id: 'feature-cli-register',
      triggers: ['cli register'],
    });

    const registered = runCli([
      'knowledge',
      'register',
      '--record',
      proposal,
      '--project-dir',
      projectDir,
      '--json',
    ], {
      env: { SPECTRE_HOME: spectreHome },
    });
    assert.equal(registered.status, 0, registered.stderr);
    const parsed = JSON.parse(registered.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.id, 'feature-cli-register');
    const storePath = findOnlyStore(spectreHome);
    assert.equal(
      fs.existsSync(path.join(storePath, 'knowledge', 'feature-cli-register', 'record.json')),
      true,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8')).records.map(({ id }) => id),
      ['feature-cli-register'],
    );

    const invalid = writeProposal(path.join(proposals, 'invalid'), {
      id: 'feature-cli-register',
    });
    const invalidRecordPath = path.join(invalid, 'record.json');
    const invalidRecord = JSON.parse(fs.readFileSync(invalidRecordPath, 'utf8'));
    invalidRecord.status = 'retired';
    fs.writeFileSync(invalidRecordPath, JSON.stringify(invalidRecord, null, 2));
    const failed = runCli([
      'knowledge',
      'register',
      '--record',
      invalid,
      '--project-dir',
      projectDir,
      '--json',
    ], {
      env: { SPECTRE_HOME: spectreHome },
    });
    assert.notEqual(failed.status, 0);
    assert.equal(JSON.parse(failed.stdout).code, 'KNOWLEDGE_RECORD_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge migrate runs target-independent migration and lock timeouts serialize as JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-main-migrate-'));
  try {
    const projectDir = path.join(root, 'workspace', 'project');
    const spectreHome = path.join(root, 'spectre-home');
    fs.mkdirSync(path.join(projectDir, '.agents', 'skills', 'feature-legacy'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.agents', 'skills', 'feature-legacy', 'SKILL.md'),
      '---\nname: feature-legacy\ndescription: Use when applying legacy\nuser-invocable: true\n---\n\n# Legacy\n',
    );
    fs.mkdirSync(
      path.join(projectDir, '.agents', 'skills', 'spectre-recall', 'references'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(projectDir, '.agents', 'skills', 'spectre-recall', 'references', 'registry.toon'),
      'feature-legacy|feature|legacy|Use when applying legacy\n',
    );

    const migrated = runCli([
      'knowledge',
      'migrate',
      '--project-dir',
      projectDir,
      '--json',
    ], {
      env: { SPECTRE_HOME: spectreHome },
    });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.deepEqual(JSON.parse(migrated.stdout).entries.map(({ code }) => code), ['IMPORTED']);
    const storePath = findOnlyStore(spectreHome);

    fs.writeFileSync(
      path.join(storePath, '.spectre.lock'),
      JSON.stringify({
        pid: process.pid,
        timestamp: new Date().toISOString(),
        operation: 'held-by-test',
      }),
    );
    const proposal = writeProposal(path.join(root, 'proposals'), {
      id: 'feature-timeout',
      triggers: ['timeout'],
    });
    const timeout = runCli([
      'knowledge',
      'register',
      '--record',
      proposal,
      '--project-dir',
      projectDir,
      '--json',
      '--lock-timeout-ms',
      '20',
    ], {
      env: { SPECTRE_HOME: spectreHome },
    });
    assert.notEqual(timeout.status, 0);
    assert.equal(JSON.parse(timeout.stdout).code, 'LOCK_TIMEOUT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge search treats no matches and a missing store as successful empty results', async () => {
  const fixture = await makeFixture();
  try {
    const noMatches = runCli([
      'knowledge',
      'search',
      'does-not-exist',
      '--project-dir',
      fixture.projectDir,
      '--json',
    ], {
      env: { SPECTRE_HOME: fixture.spectreHome },
    });
    assert.equal(noMatches.status, 0, noMatches.stderr);
    assert.deepEqual(JSON.parse(noMatches.stdout).results, []);

    const missingProject = path.join(fixture.root, 'workspace', 'missing');
    fs.mkdirSync(missingProject, { recursive: true });
    const noStore = runCli([
      'knowledge',
      'search',
      '',
      '--project-dir',
      missingProject,
      '--json',
    ], {
      env: { SPECTRE_HOME: fixture.spectreHome },
    });
    assert.equal(noStore.status, 0, noStore.stderr);
    assert.deepEqual(JSON.parse(noStore.stdout).results, []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('knowledge search serializes unexpected runtime failures when JSON is requested', async () => {
  const fixture = await makeFixture();
  try {
    const projectsRoot = path.join(fixture.spectreHome, 'projects');
    const projectMetadata = [];
    const pending = [projectsRoot];
    while (pending.length > 0) {
      const current = pending.pop();
      if (fs.existsSync(path.join(current, 'project.json'))) {
        projectMetadata.push(current);
        continue;
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    }
    assert.equal(projectMetadata.length, 1);
    fs.rmSync(path.join(projectMetadata[0], 'index.json'), { force: true });
    fs.mkdirSync(path.join(projectMetadata[0], 'index.json'));

    const failed = runCli([
      'knowledge',
      'search',
      'account',
      '--project-dir',
      fixture.projectDir,
      '--json',
    ], {
      env: { SPECTRE_HOME: fixture.spectreHome },
    });

    assert.notEqual(failed.status, 0);
    const parsed = JSON.parse(failed.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ['code', 'message', 'ok']);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'KNOWLEDGE_SEARCH_FAILED');
    assert.equal(typeof parsed.message, 'string');
    assert.notEqual(parsed.message, '');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
