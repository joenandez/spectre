#!/usr/bin/env node

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimatePayloadTokens } from './knowledge/payload.mjs';
import { renderKnowledgeRegistry, SESSION_START_TOKEN_LIMIT } from './knowledge/registry.mjs';

const INSTALLED_CODEX_CLI = '/Users/joe/.codex/plugins/cache/spectre/spectre/7.6.0/hooks/scripts/knowledge-cli.mjs';
const STAGED_CODEX_CLI = '/private/tmp/q/spectre-knowledge-evaluation-cell-aBcDeF/codex-home/plugins/cache/evaluation/spectre/7.6.0/hooks/scripts/knowledge-cli.mjs';

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
    assert.ok(result.includedEntries.length > 0);
    assert.ok(result.omittedCount > 0);
    assert.match(result.content, /Omitted tags: \d+; omitted tags remain searchable/);
    assert.match(result.content, /Before broad source\/filename discovery[\s\S]*search '<task>'[\s\S]*assess preview applicability[\s\S]*load '<id>'[\s\S]*read selected paths\/symbols\/lines/i);
    assert.match(result.content, /Broaden only if focused hints prove insufficient\/stale\/unavailable/i);
    assert.match(result.content, /omitted\/untagged/i);
    assert.match(result.content, /Substance insufficient/i);
    assert.match(result.content, /Discovery is per question/i);
    assert.match(result.content, /reuse results\/loads[\s\S]*refine only unresolved\/new subject/i);
    assert.match(result.content, /never repeat equivalent search/i);
    assert.match(result.content, /#tag:[\s\S]*search --tag '<tag>'[\s\S]*previews[\s\S]*exact-load/i);
    assert.match(result.content, /never authorize guesses\/create tags/i);
    assert.match(result.content, /Oversized loads require blocked decision/i);
    assert.doesNotMatch(result.content, /recordPath|revisionToken|successfulLoads|PRIVATE_BODY|ID: /);
    for (const id of result.includedEntries) {
      assert.match(result.content, new RegExp(`^- ${id}:`, 'm'));
    }
  });

  it('provides discovery instructions for an import-only store with no tags', () => {
    const result = renderKnowledgeRegistry({ catalog: catalog() });

    assert.match(result.content, /No tagged records yet; imported work remains searchable/);
    assert.match(result.content, /Unrelated chat: load nothing/);
    assert.match(result.content, /knowledge-cli\.mjs' --project-dir \./);
    assert.match(result.content, /search '<task>'/);
    assert.match(result.content, /load '<id>'/);
    assert.equal(result.omittedCount, 0);
  });

  it('fits installed and staged Codex CLI paths by omitting tags before startup failure', () => {
    for (const cliPath of [INSTALLED_CODEX_CLI, STAGED_CODEX_CLI]) {
      const empty = renderKnowledgeRegistry({ cliPath, catalog: catalog() });
      assert.ok(empty.measurement.measured <= SESSION_START_TOKEN_LIMIT);
      assert.equal(empty.omittedCount, 0);
      assert.match(empty.content, new RegExp(cliPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const nonempty = renderKnowledgeRegistry({ cliPath, catalog: catalog(20) });
      assert.ok(nonempty.measurement.measured <= SESSION_START_TOKEN_LIMIT);
      assert.ok(nonempty.includedEntries.length > 0);
      assert.ok(nonempty.omittedCount > 0);
      assert.equal(nonempty.includedEntries.length + nonempty.omittedCount, 20);
      assert.match(nonempty.content, new RegExp(`Omitted tags: ${nonempty.omittedCount}; omitted tags remain searchable`));
      assert.match(nonempty.content, /Before broad source\/filename discovery[\s\S]*search '<task>'[\s\S]*load '<id>'[\s\S]*read selected paths\/symbols\/lines/i);
      assert.match(nonempty.content, /Broaden only if focused hints prove insufficient\/stale\/unavailable/i);
      for (const id of nonempty.includedEntries) {
        assert.match(nonempty.content, new RegExp(`^- ${id}:`, 'm'));
      }
    }
  });
});
