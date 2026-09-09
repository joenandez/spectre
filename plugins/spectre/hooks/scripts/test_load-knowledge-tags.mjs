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

describe('SessionStart tag discovery', () => {
  it('delivers bounded discovery for an import-only store without exposing record metadata', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-session-tags-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const spectreHome = path.join(root, 'spectre-home');
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    await resolveProjectStore(projectDir, { spectreHome });

    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--host', 'codex'], {
      cwd: projectDir,
      env: { ...process.env, SPECTRE_HOME: spectreHome, CLAUDE_PROJECT_DIR: projectDir },
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: projectDir }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(String(result.stderr), '');
    const content = JSON.parse(String(result.stdout)).hookSpecificOutput.additionalContext;
    assert.match(content, /No tagged records yet; imported work remains searchable/);
    assert.match(content, /knowledge-cli\.mjs' search '<task>' --project-dir \./);
    assert.match(content, /load '<id>'/);
    assert.equal(content.includes('recordPath'), false);
    assert.equal(content.includes('PRIVATE_BODY'), false);
  });

  it('fails open on an invalid tag catalog without leaking its metadata', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-session-tags-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const spectreHome = path.join(root, 'spectre-home');
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
    fs.writeFileSync(path.join(storePath, 'tags.json'), '{"private-record-id":"PRIVATE_BODY"}');

    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--host', 'codex'], {
      cwd: projectDir,
      env: { ...process.env, SPECTRE_HOME: spectreHome, CLAUDE_PROJECT_DIR: projectDir },
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: projectDir }),
    });
    assert.equal(result.status, 0, result.stderr);
    const output = `${String(result.stdout)}${String(result.stderr)}`;
    assert.match(output, /SessionStart tag catalog was unavailable/);
    assert.equal(output.includes('private-record-id'), false);
    assert.equal(output.includes('PRIVATE_BODY'), false);
  });
});
