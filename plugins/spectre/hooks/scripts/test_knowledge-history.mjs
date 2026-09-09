#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'history.mjs');
const RECORDS_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'records.mjs');
const STORE_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'store.mjs');

function record(id, content) {
  return {
    schemaVersion: 1, id, kind: 'knowledge', title: `Guidance for ${id}`,
    summary: 'Historical guidance.', tags: [], applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-07-19T00:00:00.000Z' },
    relatedRecordIds: [], category: 'decision', useWhen: 'Investigating a prior decision.',
    content, evidence: 'Verified evidence.', status: 'active',
  };
}

describe('knowledge history', () => {
  it('previews no more than five complete historical revisions and never creates activity', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-history-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const projectDir = path.join(tmp, 'project');
    const spectreHome = path.join(tmp, 'spectre-home');
    fs.mkdirSync(projectDir, { recursive: true });
    const [{ listKnowledgeHistory, inspectKnowledgeRevision }, { parseKnowledgeRecord, revisionDirectoryName }, { resolveProjectStore }] = await Promise.all([
      import(pathToFileURL(HISTORY_MODULE).href), import(pathToFileURL(RECORDS_MODULE).href), import(pathToFileURL(STORE_MODULE).href),
    ]);
    const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
    const id = 'archived-guidance';
    const revisions = [];
    for (let index = 0; index < 6; index += 1) {
      const archive = path.join(tmp, `candidate-${index}`, id);
      fs.mkdirSync(archive, { recursive: true });
      const recordPath = path.join(archive, 'record.json');
      fs.writeFileSync(recordPath, JSON.stringify(record(id, `Archived revision ${index}.`)));
      const revisionToken = parseKnowledgeRecord(recordPath).revisionToken;
      const canonicalArchive = path.join(storePath, 'knowledge-history', id, revisionDirectoryName(revisionToken));
      fs.mkdirSync(path.dirname(canonicalArchive), { recursive: true });
      fs.renameSync(archive, canonicalArchive);
      revisions.push(revisionToken);
    }

    const preview = await listKnowledgeHistory({ projectDir, spectreHome, id });
    assert.equal(preview.entries.length, 5);
    assert.ok(preview.cursor);
    assert.ok(preview.entries.every((entry) => entry.historical && entry.revisionToken));
    assert.equal(fs.existsSync(path.join(storePath, 'activity.json')), false);

    const next = await listKnowledgeHistory({ projectDir, spectreHome, id, cursor: preview.cursor });
    assert.equal(next.entries.length, 1);
    assert.equal(next.cursor, null);
    const inspected = await inspectKnowledgeRevision({ projectDir, spectreHome, id, revisionToken: revisions[0] });
    assert.equal(inspected.historical, true);
    assert.equal(inspected.activation, 'historical');
    assert.equal(inspected.revisionToken, revisions[0]);
    assert.equal(inspected.record.content, 'Archived revision 0.');
    fs.rmSync(path.join(storePath, 'knowledge-history', id, revisionDirectoryName(revisions[0])), { recursive: true });
    await assert.rejects(
      () => listKnowledgeHistory({ projectDir, spectreHome, id, cursor: preview.cursor }),
      (error) => error.code === 'KNOWLEDGE_HISTORY_CURSOR_STALE',
    );

    assert.equal(fs.existsSync(path.join(storePath, 'activity.json')), false);
  });
});
