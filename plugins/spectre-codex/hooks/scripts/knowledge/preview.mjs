import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderKnowledgeRegistry } from './registry.mjs';
import { resolveProjectStore } from './store.mjs';
import { readTagCatalog } from './tags.mjs';

const HOSTS = new Set(['claude', 'codex']);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLED_CLI_PATH = path.resolve(SCRIPT_DIR, '..', 'knowledge-cli.mjs');

function emptyPreview({ host, projectDir, storePath = null, warnings = [] }) {
  return {
    host,
    projectDir,
    storePath,
    injected: false,
    payload: null,
    measurement: null,
    includedCount: 0,
    omittedCount: 0,
    includedRecords: [],
    omittedRecords: [],
    warnings,
  };
}

export async function previewKnowledgeRegistry(options) {
  const host = options?.host ?? 'claude';
  if (!HOSTS.has(host)) throw new RangeError(`Unsupported registry host: ${host}`);
  const projectDir = path.resolve(options.projectDir);
  const resolved = await resolveProjectStore(projectDir, {
    spectreHome: options.spectreHome,
    readOnly: true,
  });
  if (!resolved.storePath) return emptyPreview({ host, projectDir });

  const warnings = [];
  let catalog;
  try {
    catalog = readTagCatalog(resolved.storePath);
  } catch (error) {
    warnings.push({
      code: error.code || 'TAG_CATALOG_UNAVAILABLE',
      message: 'SessionStart tag catalog was unavailable.',
    });
    catalog = { tags: {} };
  }

  const registry = renderKnowledgeRegistry({
    host,
    catalog,
    cliPath: options.cliPath || BUNDLED_CLI_PATH,
  });
  return {
    host,
    projectDir,
    storePath: resolved.storePath,
    injected: true,
    payload: JSON.parse(registry.frame),
    measurement: registry.measurement,
    includedCount: registry.includedEntries.length,
    omittedCount: registry.omittedCount,
    includedRecords: [],
    omittedRecords: [],
    warnings,
  };
}
