#!/usr/bin/env node

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimatePayloadTokens } from './knowledge/payload.mjs';
import { renderKnowledgeRegistry, SESSION_START_TOKEN_LIMIT } from './knowledge/registry.mjs';

function catalog(count = 0) {
  return {
    tags: Object.fromEntries(Array.from({ length: count }, (_, index) => {
      const id = `topic-${String(index).padStart(2, '0')}`;
      return [id, { description: `Use this focused topic ${index}.`, aliases: [`area-${index}`] }];
    })),
  };
}

describe('bounded SessionStart tag registry', () => {
  it('caps complete tag entries at 300 estimated tokens without a record catalog or body', () => {
    const result = renderKnowledgeRegistry({ catalog: catalog(80) });

    assert.ok(estimatePayloadTokens(result.frame) <= SESSION_START_TOKEN_LIMIT);
    assert.ok(result.omittedCount > 0);
    assert.match(result.content, /Omitted tags: \d+; omitted tags remain searchable/);
    assert.match(result.content, /untagged imported work/i);
    assert.doesNotMatch(result.content, /recordPath|revisionToken|successfulLoads|PRIVATE_BODY|ID: /);
    for (const id of result.includedEntries) {
      assert.match(result.content, new RegExp(`^- ${id}:`, 'm'));
    }
  });

  it('provides discovery instructions for an import-only store with no tags', () => {
    const result = renderKnowledgeRegistry({ catalog: catalog() });

    assert.match(result.content, /No tagged records yet; imported work remains searchable/);
    assert.match(result.content, /For unrelated general conversation, load nothing/);
    assert.match(result.content, /knowledge-cli\.mjs' search '<task>' --project-dir \./);
    assert.match(result.content, /load '<id>'/);
    assert.equal(result.omittedCount, 0);
  });
});
