import {
  formatKnowledgeLoadHuman,
  loadKnowledgeById,
  serializeKnowledgeLoadError
} from '../../plugins/spectre/hooks/scripts/knowledge/loader.mjs';
import {
  migrateLegacyKnowledge
} from '../../plugins/spectre/hooks/scripts/knowledge/migration.mjs';
import {
  refreshKnowledgeIndex
} from '../../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import {
  registerCanonicalKnowledge as registerKnowledge,
  serializeKnowledgeError
} from '../../plugins/spectre/hooks/scripts/knowledge/registration.mjs';
import {
  formatKnowledgeSearchHuman,
  formatKnowledgeSearchWarningsHuman,
  searchKnowledge
} from '../../plugins/spectre/hooks/scripts/knowledge/search.mjs';
import {
  resolveProjectStore
} from '../../plugins/spectre/hooks/scripts/knowledge/store.mjs';
import {
  previewKnowledgeRegistry
} from '../../plugins/spectre/hooks/scripts/knowledge/preview.mjs';
import {
  inspectKnowledgeRevision,
  listKnowledgeHistory
} from '../../plugins/spectre/hooks/scripts/knowledge/history.mjs';
import {
  applyTagOperationFile,
  ensureTags,
  mergeTags,
  readTagOperationFile,
  searchTags
} from '../../plugins/spectre/hooks/scripts/knowledge/tags.mjs';
import {
  resolveWorkIdentity
} from '../../plugins/spectre/hooks/scripts/knowledge/work.mjs';

export async function searchCanonicalKnowledge(options) {
  return searchKnowledge(options);
}

export function formatCanonicalKnowledgeSearch(result, query) {
  return formatKnowledgeSearchHuman(result, query);
}

export function formatCanonicalKnowledgeSearchWarnings(warnings) {
  return formatKnowledgeSearchWarningsHuman(warnings);
}

export async function loadCanonicalKnowledge(options) {
  return loadKnowledgeById(options);
}

export async function previewCanonicalKnowledgeRegistry(options) {
  return previewKnowledgeRegistry(options);
}

export async function listCanonicalKnowledgeHistory(options) {
  return listKnowledgeHistory(options);
}

export async function inspectCanonicalKnowledgeRevision(options) {
  return inspectKnowledgeRevision(options);
}

export async function searchCanonicalKnowledgeTags(options) {
  return searchTags(options);
}

export async function applyCanonicalKnowledgeTagOperation(options) {
  return applyTagOperationFile(options);
}

async function runCanonicalKnowledgeTagOperation(operation, options) {
  const { operation: inputOperation, ...request } = readTagOperationFile(options.inputPath);
  if (inputOperation !== operation) {
    const error = new Error(`Input operation ${inputOperation} cannot run as tags ${operation}.`);
    error.code = 'TAG_INPUT_INVALID';
    throw error;
  }
  return operation === 'ensure'
    ? ensureTags({ ...options, ...request })
    : mergeTags({ ...options, ...request });
}

export async function ensureCanonicalKnowledgeTags(options) {
  return runCanonicalKnowledgeTagOperation('ensure', options);
}

export async function mergeCanonicalKnowledgeTags(options) {
  return runCanonicalKnowledgeTagOperation('merge', options);
}

export async function resolveCanonicalKnowledgeWork(options) {
  return resolveWorkIdentity(options);
}

export function formatCanonicalKnowledgeLoad(result) {
  return formatKnowledgeLoadHuman(result);
}

export function serializeCanonicalKnowledgeLoadError(error) {
  return serializeKnowledgeLoadError(error);
}

export async function registerCanonicalKnowledge(options) {
  return registerKnowledge(options);
}

export function serializeCanonicalKnowledgeError(error) {
  return serializeKnowledgeError(error);
}

export async function migrateCanonicalKnowledge(options) {
  return migrateLegacyKnowledge(options);
}

export async function initializeProjectKnowledge(options) {
  const migrationReport = await migrateCanonicalKnowledge(options);
  const resolved = await resolveProjectStore(options.projectDir, {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
  });
  const index = refreshKnowledgeIndex(resolved.storePath);

  return {
    migrationReport,
    storePath: resolved.storePath,
    index,
  };
}
