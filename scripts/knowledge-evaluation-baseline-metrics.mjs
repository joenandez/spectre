import path from 'node:path';

import { estimatePayloadTokens } from '../plugins/spectre/hooks/scripts/knowledge/payload.mjs';

function resultFor(operation, results) {
  return results.find(result => result.toolUseId === operation.id &&
    (result.sessionOrdinal ?? 0) === (operation.sessionOrdinal ?? 0) && result.isError !== true && typeof result.content === 'string') || null;
}

function commandKind(operation) {
  const command = operation?.input?.command;
  if (typeof command !== 'string') return null;
  const match = command.match(/knowledge-cli\.mjs(?:['\"])?\s+(search|load|history|inspect|resource)\b/);
  return match?.[1] || null;
}

function byteMetrics(content) {
  return { tokens: estimatePayloadTokens(content), bytes: Buffer.byteLength(content, 'utf8') };
}

function humanLoad(content) {
  const marker = '\nSPECTRE_KNOWLEDGE_RESOURCE_LOCATIONS=';
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex === -1) return { body: content, resources: null };
  const body = content.slice(0, markerIndex + 1);
  try {
    const locations = JSON.parse(content.slice(markerIndex + marker.length).trim());
    return { body, resources: Array.isArray(locations.resources) ? locations.resources : null, id: null, revisionToken: null };
  } catch {
    return { body, resources: null, id: null, revisionToken: null };
  }
}

function loadedBody(content) {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.content === 'string') return { body: parsed.content, resources: Array.isArray(parsed.resources) ? parsed.resources : null, id: parsed.id, revisionToken: parsed.revisionToken ?? parsed.sourceFingerprint ?? null };
  } catch {
    // Archived human output is expected when the host omitted --json.
  }
  return humanLoad(content);
}

function resourcePaths(resources) {
  return resources.flatMap(resource => typeof resource === 'string' ? [resource] : typeof resource?.path === 'string' ? [resource.path] : []);
}

function directPath(operation) {
  const input = operation?.input;
  if (typeof input?.file_path === 'string') return input.file_path;
  if (typeof input?.path === 'string') return input.path;
  if (typeof input?.command === 'string') return input.command;
  return null;
}

function containsPath(value, candidate) {
  const root = path.resolve(candidate);
  return value.includes(root) || value.includes(`${root}${path.sep}`);
}

function potentialKnowledgeAccess(value, workingDir, knownKnowledgePaths) {
  if (typeof value !== 'string') return false;
  if (workingDir && containsPath(value, workingDir)) return false;
  if (knownKnowledgePaths.some(candidate => containsPath(value, candidate) || containsPath(value, path.dirname(candidate)))) return true;
  return /(?:^|[\s/'"])(?:knowledge|spectre-home)(?:[\s/'"]|$)/.test(value);
}

function metric(entries, complete, noObservedValue = null) {
  if (!complete) return { tokens: null, bytes: null };
  if (entries.length === 0) return { tokens: noObservedValue, bytes: noObservedValue };
  return entries.reduce((total, entry) => ({ tokens: total.tokens + entry.tokens, bytes: total.bytes + entry.bytes }), { tokens: 0, bytes: 0 });
}

/** Derive bounded baseline payload facts solely from ordered normalized native tool evidence. */
export function baselineRuntimeFacts({ toolOperations = [], toolResults = [], sessionStartMeasurement = null, workingDir = null, knownKnowledgePaths = [] } = {}) {
  const operations = [...toolOperations].sort((left, right) => (left.sessionOrdinal ?? 0) - (right.sessionOrdinal ?? 0) || (left.eventOrdinal ?? 0) - (right.eventOrdinal ?? 0));
  const previews = [];
  const bodies = [];
  const bodyEntries = [];
  const resources = [];
  const exposedResources = new Set();
  let previewComplete = true;
  let bodyComplete = true;
  let resourceComplete = true;
  let resourceInventoryKnown = false;
  let recognized = 0;
  let incomplete = 0;
  let unsupported = 0;

  for (const operation of operations) {
    const kind = commandKind(operation);
    if (kind) {
      recognized += 1;
      const result = resultFor(operation, toolResults);
      if (!result || operation.status && operation.status !== 'completed') {
        incomplete += 1;
        if (kind === 'search' || kind === 'history') previewComplete = false;
        else if (kind === 'load' || kind === 'inspect') bodyComplete = false;
        else resourceComplete = false;
        continue;
      }
      if (kind === 'search' || kind === 'history') {
        previews.push(byteMetrics(result.content));
      } else if (kind === 'load' || kind === 'inspect') {
        const loaded = loadedBody(result.content);
        if (typeof loaded.body !== 'string') {
          incomplete += 1;
          bodyComplete = false;
        } else {
          const metrics = byteMetrics(loaded.body);
          bodies.push(metrics);
          bodyEntries.push({ ...metrics, id: loaded.id, revisionToken: loaded.revisionToken, sessionOrdinal: operation.sessionOrdinal ?? 0 });
        }
        if (loaded.resources === null) {
          resourceComplete = false;
        } else {
          resourceInventoryKnown = true;
          resourcePaths(loaded.resources).forEach(value => exposedResources.add(value));
        }
      } else {
        resources.push(byteMetrics(result.content));
      }
      continue;
    }

    const direct = directPath(operation);
    if (!direct || !['Read', 'exec'].includes(operation?.name)) continue;
    const matchedPath = [...exposedResources].find(value => direct.includes(value));
    if (!matchedPath) {
      if (potentialKnowledgeAccess(direct, workingDir, knownKnowledgePaths)) {
        unsupported += 1;
        resourceComplete = false;
      }
      continue;
    }
    recognized += 1;
    const result = resultFor(operation, toolResults);
    if (!result || operation.status && operation.status !== 'completed') {
      incomplete += 1;
      resourceComplete = false;
    } else {
      resources.push(byteMetrics(result.content));
    }
  }

  const preview = metric(previews, previewComplete && previews.length > 0);
  const body = metric(bodies, bodyComplete && bodies.length > 0);
  const resource = metric(resources, resourceComplete && resourceInventoryKnown, 0);
  const injectedTokens = Number.isFinite(sessionStartMeasurement?.injectedTokens) ? sessionStartMeasurement.injectedTokens : null;
  const injectedBytes = Number.isFinite(sessionStartMeasurement?.injectedBytes) ? sessionStartMeasurement.injectedBytes : null;
  const redundancyComplete = bodyEntries.length > 0 && bodyEntries.every(entry => typeof entry.id === 'string' && typeof entry.revisionToken === 'string');
  const redundantTokens = redundancyComplete
    ? bodyEntries.filter((entry, index) => bodyEntries.some((prior, priorIndex) => priorIndex < index && prior.id === entry.id && prior.revisionToken === entry.revisionToken && prior.sessionOrdinal === entry.sessionOrdinal)).reduce((total, entry) => total + entry.tokens, 0)
    : null;
  const totalTokens = [injectedTokens, preview.tokens, body.tokens, resource.tokens].every(Number.isFinite)
    ? injectedTokens + preview.tokens + body.tokens + resource.tokens : null;
  return {
    availability: 'available', injectedTokens, injectedBytes,
    previewTokens: preview.tokens, previewBytes: preview.bytes,
    loadedBodyTokens: body.tokens, loadedBodyBytes: body.bytes,
    resourceTokens: resource.tokens, resourceBytes: resource.bytes,
    redundantTokens, totalTokens,
    diagnostics: { recognized, incomplete, unsupported },
  };
}
