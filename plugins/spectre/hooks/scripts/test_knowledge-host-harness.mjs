#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CORE_SENTINEL,
  OMITTED_ID,
  RESOURCE_SENTINEL,
  observedRegistryCounts,
  prepareFixture,
} from '../../../../scripts/verify-knowledge-hosts.mjs';
import { readKnowledgeActivity } from './knowledge/activity.mjs';
import { refreshKnowledgeIndex, parseKnowledgeRecord } from './knowledge/records.mjs';
import { readTagCatalog } from './knowledge/tags.mjs';

describe('isolated real-host registry fixture', () => {
  it('reports included and omitted counts from the observed host frame', () => {
    assert.deepEqual(
      observedRegistryCounts(
        { activeRecordCount: 65, preflight: { includedCount: 10, omittedCount: 55 } },
        { observation: { omittedCount: 56 } },
      ),
      { includedCount: 9, omittedCount: 56 },
    );
  });

  it('preflights indexed typed metadata without exposing record bodies before real-host execution', async (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-host-harness-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const manifest = await prepareFixture(fixtureRoot, { date: '2026-07-22' });

    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.expected.omittedId, OMITTED_ID);
    assert.doesNotMatch(manifest.prompt, new RegExp(CORE_SENTINEL));
    assert.doesNotMatch(manifest.prompt, new RegExp(RESOURCE_SENTINEL));
    assert.match(manifest.evidencePath, /host-registry-2026-07-22\.md$/);

    for (const host of ['claude', 'codex']) {
      const value = manifest.hosts[host];
      const { index, errors } = refreshKnowledgeIndex(value.storePath, { persist: false });
      assert.deepEqual(errors, []);
      assert.equal(value.activeRecordCount, 65);
      assert.equal(index.records.length, 65);
      assert.ok(index.records.some(({ id }) => id === OMITTED_ID));
      assert.ok(value.preflight.omittedCount > 0);
      assert.equal(value.preflight.measurement.ok, true);
      assert.equal(value.preflight.observation.validJson, true);
      assert.equal(value.preflight.observation.hookEventMatches, true);
      assert.equal(value.preflight.observation.expectedIdVisible, false);
      assert.equal(value.preflight.observation.coreSentinelVisible, false);
      assert.equal(value.preflight.observation.resourceSentinelVisible, false);
      assert.equal(value.preflight.observation.hasTopLevelSystemMessage, false);
      assert.equal(value.preflight.observation.hasHookSystemMessage, false);
      assert.equal(value.preflight.observation.hasPreview, false);
      assert.equal(value.preflight.observation.hasFallbackFile, false);
      assert.equal(value.preflight.observation.omittedCount, null);
      const omittedPath = path.join(value.storePath, 'knowledge', OMITTED_ID, 'record.json');
      const omitted = parseKnowledgeRecord(omittedPath).record;
      assert.equal(omitted.category, 'gotcha');
      assert.ok(omitted.tags.length > 0);
      const catalog = readTagCatalog(value.storePath);
      for (const tag of omitted.tags) assert.ok(Object.hasOwn(catalog.tags, tag), tag);
      assert.deepEqual(readKnowledgeActivity(value.storePath), {
        schemaVersion: 2,
        records: {},
        search: { matches: 0, misses: 0, recordMatches: {} },
      });
      assert.equal(fs.existsSync(path.join(value.storePath, 'activity.json')), true);
      assert.match(value.command, new RegExp(value.projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      assert.equal(fs.readFileSync(value.resourcePath, 'utf8').trim(), RESOURCE_SENTINEL);
    }
  });
});
