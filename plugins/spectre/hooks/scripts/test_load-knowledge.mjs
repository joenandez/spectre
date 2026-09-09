#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveProjectStore } from './knowledge/store.mjs';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'load-knowledge.mjs');

function typedRecord(id) {
  return {
    schemaVersion: 1, id, kind: 'knowledge', title: 'Private typed title',
    summary: 'Private typed summary.', tags: ['session-routing'], applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' }, relatedRecordIds: [],
    category: 'pattern', useWhen: 'Private typed use condition.', content: 'PRIVATE_TYPED_RECORD_BODY',
    evidence: 'Private typed evidence.', status: 'active',
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-session-tags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
  const id = 'private-typed-record';
  const recordPath = path.join(storePath, 'knowledge', id, 'record.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(typedRecord(id), null, 2)}\n`);
  fs.writeFileSync(path.join(storePath, 'tags.json'), `${JSON.stringify({
    schemaVersion: 1,
    tags: { 'session-routing': { description: 'Route substantive session work to the applicable record.', aliases: ['routing'] } },
    redirects: {},
  }, null, 2)}\n`);
  return { projectDir, spectreHome, storePath, id };
}

function runHook(value, source) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--host', 'codex'], {
    cwd: value.projectDir,
    encoding: 'utf8',
    env: { ...process.env, SPECTRE_HOME: value.spectreHome, CLAUDE_PROJECT_DIR: value.projectDir },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd: value.projectDir }),
  });
}

describe('typed SessionStart tag discovery', () => {
  for (const source of ['startup', 'clear', 'compact']) {
    it(`when_${source}_then_injects_only_bounded_tag_discovery`, async (t) => {
      const value = await fixture(t);
      const result = runHook(value, source);

      assert.equal(result.status, 0, result.stderr);
      const content = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.match(content, /session-routing: Route substantive session work/);
      assert.match(content, /aliases: routing/);
      assert.match(content, /search '<task>' --project-dir \./);
      assert.match(content, /load '<id>'/);
      for (const privateValue of [value.id, 'Private typed title', 'Private typed summary', 'PRIVATE_TYPED_RECORD_BODY']) {
        assert.equal(content.includes(privateValue), false, privateValue);
      }
    });
  }

  it('when_no_store_exists_then_session_start_does_not_create_or_inject_knowledge', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-session-empty-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectDir = path.join(root, 'project');
    const spectreHome = path.join(root, 'spectre-home');
    fs.mkdirSync(projectDir, { recursive: true });
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--host', 'codex'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, SPECTRE_HOME: spectreHome, CLAUDE_PROJECT_DIR: projectDir },
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: projectDir }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(spectreHome), false);
  });

  it('when_tag_catalog_is_invalid_then_session_start_fails_open_without_leaking_catalog_bytes', async (t) => {
    const value = await fixture(t);
    fs.writeFileSync(path.join(value.storePath, 'tags.json'), '{"private-record":"PRIVATE_CATALOG_BODY"}\n');
    const result = runHook(value, 'startup');

    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /SessionStart tag catalog was unavailable/);
    assert.equal(output.includes('private-record'), false);
    assert.equal(output.includes('PRIVATE_CATALOG_BODY'), false);
  });
});
