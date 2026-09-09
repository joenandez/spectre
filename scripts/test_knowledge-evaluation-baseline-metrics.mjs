import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimatePayloadTokens } from '../plugins/spectre/hooks/scripts/knowledge/payload.mjs';
import { baselineRuntimeFacts } from './knowledge-evaluation-baseline-metrics.mjs';

const operation = (id, command, eventOrdinal) => ({ id, eventOrdinal, sessionOrdinal: 0, name: 'exec', type: 'command_execution', status: 'completed', input: { command } });
const result = (toolUseId, content, eventOrdinal) => ({ toolUseId, eventOrdinal, sessionOrdinal: 0, content, isError: false });

test('measures ordered JSON search, exact load body, and exposed direct resources separately', () => {
  const search = JSON.stringify({ ok: true, results: [{ id: 'dual-ledger' }] });
  const body = 'Keep both settlement ledgers until reconciliation passes.\n';
  const resource = 'Rollback contact: payments-oncall.\n';
  const load = JSON.stringify({ id: 'dual-ledger', sourceFingerprint: 'sha256:baseline-rev', content: body, recordDirectory: '/fixture/dual-ledger', resources: [{ path: '/fixture/dual-ledger/references/rollback.txt' }] });
  const facts = baselineRuntimeFacts({
    toolOperations: [
      operation('search-1', 'node knowledge-cli.mjs search dual-ledger --json', 1),
      operation('load-1', 'node knowledge-cli.mjs load dual-ledger --json', 3),
      { id: 'read-1', eventOrdinal: 5, sessionOrdinal: 0, name: 'Read', type: 'tool_use', status: 'completed', input: { file_path: '/fixture/dual-ledger/references/rollback.txt' } },
    ],
    toolResults: [result('search-1', search, 2), result('load-1', load, 4), result('read-1', resource, 6)],
    sessionStartMeasurement: { injectedTokens: 7, injectedBytes: 70 },
  });

  assert.deepEqual(facts, {
    availability: 'available', injectedTokens: 7, injectedBytes: 70,
    previewTokens: estimatePayloadTokens(search), previewBytes: Buffer.byteLength(search),
    loadedBodyTokens: estimatePayloadTokens(body), loadedBodyBytes: Buffer.byteLength(body),
    resourceTokens: estimatePayloadTokens(resource), resourceBytes: Buffer.byteLength(resource),
    redundantTokens: 0, totalTokens: 7 + estimatePayloadTokens(search) + estimatePayloadTokens(body) + estimatePayloadTokens(resource),
    diagnostics: { recognized: 3, incomplete: 0, unsupported: 0 },
  });
});

test('uses the archived human load boundary and history previews without counting frame metadata as body', () => {
  const search = 'dual-ledger [patterns]\n  Keep ledgers.\n';
  const body = '---\nname: dual-ledger\n---\nKeep ledgers.\n';
  const trailer = 'SPECTRE_KNOWLEDGE_RESOURCE_LOCATIONS={"recordDirectory":"/fixture/dual-ledger","resources":[]}\n';
  const history = 'Revision history for dual-ledger\n';
  const facts = baselineRuntimeFacts({
    toolOperations: [
      operation('search-1', 'node knowledge-cli.mjs search dual-ledger', 1),
      operation('history-1', 'node knowledge-cli.mjs history dual-ledger --json', 3),
      operation('load-1', 'node knowledge-cli.mjs load dual-ledger', 5),
    ],
    toolResults: [result('search-1', search, 2), result('history-1', history, 4), result('load-1', `${body}\n${trailer}`, 6)],
  });

  assert.equal(facts.previewTokens, estimatePayloadTokens(search) + estimatePayloadTokens(history));
  assert.equal(facts.loadedBodyTokens, estimatePayloadTokens(`${body}\n`));
  assert.equal(facts.resourceTokens, 0);
  assert.equal(facts.redundantTokens, null);
  assert.equal(facts.totalTokens, null);
  assert.equal(facts.diagnostics.unsupported, 0);
});

test('keeps incomplete or unsupported baseline evidence unknown instead of manufacturing zeroes', () => {
  const facts = baselineRuntimeFacts({
    toolOperations: [
      operation('search-1', 'node knowledge-cli.mjs search dual-ledger --json', 1),
      { id: 'other-1', eventOrdinal: 2, name: 'Read', type: 'tool_use', status: 'completed', input: { file_path: '/unknown/proof.txt' } },
    ],
    toolResults: [],
  });

  assert.equal(facts.previewTokens, null);
  assert.equal(facts.loadedBodyTokens, null);
  assert.equal(facts.resourceTokens, null);
  assert.equal(facts.redundantTokens, null);
  assert.equal(facts.totalTokens, null);
  assert.deepEqual(facts.diagnostics, { recognized: 1, incomplete: 1, unsupported: 0 });
});

test('counts only same-session exact baseline revisions as redundant body loads', () => {
  const body = 'Dual ledger body.\n';
  const load = JSON.stringify({ id: 'dual-ledger', sourceFingerprint: 'sha256:rev-a', content: body, resources: [] });
  const facts = baselineRuntimeFacts({
    toolOperations: [
      operation('load-1', 'node knowledge-cli.mjs load dual-ledger --json', 1),
      operation('load-2', 'node knowledge-cli.mjs load dual-ledger --json', 3),
    ],
    toolResults: [result('load-1', load, 2), result('load-2', load, 4)],
  });

  assert.equal(facts.loadedBodyTokens, estimatePayloadTokens(body) * 2);
  assert.equal(facts.redundantTokens, estimatePayloadTokens(body));
});

test('recognizes quoted CLI paths and ignores ordinary repository reads while preserving ambiguous knowledge reads', () => {
  const search = JSON.stringify({ ok: true, results: [] });
  const facts = baselineRuntimeFacts({
    workingDir: '/fixture/project',
    knownKnowledgePaths: ['/fixture/store/knowledge/dual-ledger/record.json'],
    toolOperations: [
      operation('search-1', "node '/fixture/plugin/hooks/scripts/knowledge-cli.mjs' search dual-ledger --json", 1),
      { id: 'ordinary-read', eventOrdinal: 2, sessionOrdinal: 0, name: 'Read', type: 'tool_use', status: 'completed', input: { file_path: '/fixture/project/docs/rollout.md' } },
      { id: 'ambiguous-read', eventOrdinal: 3, sessionOrdinal: 0, name: 'Read', type: 'tool_use', status: 'completed', input: { file_path: '/fixture/store/knowledge/dual-ledger/references/proof.txt' } },
    ],
    toolResults: [result('search-1', search, 1), result('ordinary-read', 'ordinary evidence', 2), result('ambiguous-read', 'unverified resource', 3)],
  });

  assert.equal(facts.previewTokens, estimatePayloadTokens(search));
  assert.equal(facts.diagnostics.recognized, 1);
  assert.equal(facts.diagnostics.unsupported, 1);
  assert.equal(facts.resourceTokens, null);
});

test('orders same host evidence by session before event ordinal', () => {
  const earlySession = JSON.stringify({ ok: true, results: [] });
  const laterSession = JSON.stringify({ ok: true, results: [{ id: 'later' }] });
  const facts = baselineRuntimeFacts({
    toolOperations: [
      { ...operation('later', 'node knowledge-cli.mjs search later --json', 1), sessionOrdinal: 1 },
      { ...operation('early', 'node knowledge-cli.mjs search early --json', 9), sessionOrdinal: 0 },
    ],
    toolResults: [
      { ...result('later', laterSession, 2), sessionOrdinal: 1 },
      { ...result('early', earlySession, 10), sessionOrdinal: 0 },
    ],
  });

  assert.equal(facts.previewTokens, estimatePayloadTokens(earlySession) + estimatePayloadTokens(laterSession));
});
