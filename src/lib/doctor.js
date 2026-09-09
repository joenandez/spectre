import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  KNOWLEDGE_OVERRIDE_START,
  listSpectreAgents,
  listSpectreSkills,
  MIN_CODEX_VERSION,
  SHARED_SKILLS,
  WORKFLOW_PROBE_SKILLS
} from './constants.js';
import {
  codexConfigPath,
  codexHooksConfigPath,
  codexRuntimeRoot,
  codexSkillsDir,
  repoRoot,
  resolveCodexHome
} from './paths.js';
import {
  parseKnowledgeRecord,
  RECORD_FILE_NAME
} from '../../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import {
  resolveProjectStore
} from '../../plugins/spectre/hooks/scripts/knowledge/store.mjs';
import {
  readKnowledgeActivity
} from '../../plugins/spectre/hooks/scripts/knowledge/activity.mjs';

const RESOLVED_MIGRATION_CODES = new Set([
  'MIGRATED',
  'DEDUPLICATED',
  'ALREADY_MIGRATED'
]);

const MANAGED_AGENT_MARKER = 'spectre-managed-codex-agent';

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

export function codexVersion() {
  const output = execFileSync('codex', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
  if (!versionMatch) {
    throw new Error(`Unable to parse Codex version from "${output}"`);
  }
  return versionMatch[1];
}

function isSpectreHook(hook) {
  return hook?.type === 'command'
    && typeof hook.command === 'string'
    && (
      hook.command.includes('spectre/hooks/session-start.mjs')
      || hook.command.includes('spectre/hooks/scripts/')
    );
}

function spectreHooksConfigured() {
  const hooksPath = codexHooksConfigPath();
  if (!fs.existsSync(hooksPath)) {
    return {
      configured: false,
      knowledgeSessionStartConfigured: false,
      retiredPromptHookConfigured: false,
      error: null
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const configured = Object.values(parsed?.hooks ?? {}).some(groups =>
      Array.isArray(groups) && groups.some(group =>
        Array.isArray(group?.hooks) && group.hooks.some(hook =>
          isSpectreHook(hook)
        )
      )
    );
    const knowledgeSessionStartConfigured = (parsed?.hooks?.SessionStart ?? [])
      .some(group =>
        Array.isArray(group?.hooks) && group.hooks.some(hook =>
          isSpectreHook(hook)
          && hook.command.includes('load-knowledge.mjs')
        )
      );
    const retiredPromptHookConfigured = (parsed?.hooks?.UserPromptSubmit ?? [])
      .some(group => Array.isArray(group?.hooks) && group.hooks.some(hook =>
        isSpectreHook(hook) && hook.command.includes('user-prompt-submit.mjs')
      ));

    return { configured, knowledgeSessionStartConfigured, retiredPromptHookConfigured, error: null };
  } catch (error) {
    return {
      configured: false,
      knowledgeSessionStartConfigured: false,
      retiredPromptHookConfigured: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function generatedCodexPluginRoot() {
  return path.join(repoRoot(), 'plugins', 'spectre-codex');
}

function generatedCodexPluginManifestPath() {
  return path.join(generatedCodexPluginRoot(), '.codex-plugin', 'plugin.json');
}

function codexMarketplacePath() {
  return path.join(repoRoot(), '.agents', 'plugins', 'marketplace.json');
}

function listGeneratedAgents() {
  const agentsDir = path.join(generatedCodexPluginRoot(), 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir)
    .filter(fileName => fileName.endsWith('.toml'))
    .sort()
    .map(fileName => {
      const filePath = path.join(agentsDir, fileName);
      return {
        fileName,
        sourcePath: filePath,
        content: fs.readFileSync(filePath, 'utf8')
      };
    });
}

function inspectManagedAgents() {
  const targetDir = path.join(resolveCodexHome(), 'agents');
  const expected = listGeneratedAgents();
  const result = {
    targetDir,
    expected: expected.map(agent => agent.fileName),
    installed: [],
    missing: [],
    stale: [],
    collisions: []
  };

  for (const agent of expected) {
    const targetPath = path.join(targetDir, agent.fileName);
    if (!fs.existsSync(targetPath)) {
      result.missing.push(agent.fileName);
      continue;
    }
    const content = fs.readFileSync(targetPath, 'utf8');
    if (!content.includes(`# ${MANAGED_AGENT_MARKER}`)) {
      result.collisions.push(targetPath);
      continue;
    }
    result.installed.push(agent.fileName);
    if (content !== agent.content) {
      result.stale.push(agent.fileName);
    }
  }
  result.ready = result.missing.length === 0 &&
    result.stale.length === 0 &&
    result.collisions.length === 0;
  return result;
}

function generatedHooksUsePluginRoot() {
  const hooksPath = path.join(generatedCodexPluginRoot(), 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksPath)) return false;
  const content = fs.readFileSync(hooksPath, 'utf8');
  return content.includes('${PLUGIN_ROOT}') && !content.includes('${CODEX_HOME}/spectre');
}

function findSpectrePluginEntry(parsed) {
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.plugins)
      ? parsed.plugins
      : Array.isArray(parsed?.installed)
        ? parsed.installed
        : [];
  return candidates.find(entry => {
    const id = entry?.pluginId || entry?.id || entry?.name || entry?.plugin || entry?.package || '';
    const marketplace = entry?.marketplaceName || entry?.marketplace ||
      (typeof entry?.source === 'string' ? entry.source : '');
    return id === 'spectre@spectre' ||
      (id === 'spectre' && marketplace === 'spectre') ||
      String(id).includes('spectre@spectre');
  }) || null;
}

function nativePluginInstallPath(entry) {
  const explicit = entry?.installPath || entry?.path || entry?.cachePath;
  if (explicit) return explicit;
  const pluginId = entry?.pluginId || '';
  const [pluginName, pluginMarketplace] = pluginId.split('@');
  const name = entry?.name || pluginName;
  const marketplace = entry?.marketplaceName || pluginMarketplace;
  const version = entry?.version;
  if (![name, marketplace, version].every(value =>
    typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value)
  )) {
    return null;
  }
  return path.join(resolveCodexHome(), 'plugins', 'cache', marketplace, name, version);
}

function inspectInstalledNativeHooks(installPath) {
  if (!installPath) return {
    configured: false,
    knowledgeSessionStartConfigured: false,
    handlerPresent: false,
    cliPresent: false,
    retiredPromptHookConfigured: false,
    retiredPromptAdapterPresent: false
  };
  const hooksPath = path.join(installPath, 'hooks', 'hooks.json');
  const scriptsPath = path.join(installPath, 'hooks', 'scripts');
  const handlerPresent = fs.existsSync(path.join(scriptsPath, 'load-knowledge.mjs'));
  const cliPresent = fs.existsSync(path.join(scriptsPath, 'knowledge-cli.mjs'));
  const retiredPromptAdapterPresent = fs.existsSync(path.join(scriptsPath, 'user-prompt-submit.mjs'));
  if (!fs.existsSync(hooksPath)) {
    return {
      configured: false,
      knowledgeSessionStartConfigured: false,
      handlerPresent,
      cliPresent,
      retiredPromptHookConfigured: false,
      retiredPromptAdapterPresent
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const configured = Object.values(parsed?.hooks ?? {}).some(groups =>
      Array.isArray(groups) && groups.some(group =>
        Array.isArray(group?.hooks) && group.hooks.some(hook =>
          hook?.type === 'command' && typeof hook.command === 'string' &&
          hook.command.includes('${PLUGIN_ROOT}')
        )
      )
    );
    const knowledgeSessionStartConfigured = (parsed?.hooks?.SessionStart ?? []).some(group =>
      Array.isArray(group?.hooks) && group.hooks.some(hook =>
        hook?.type === 'command' && typeof hook.command === 'string' &&
        hook.command.includes('${PLUGIN_ROOT}') && hook.command.includes('load-knowledge.mjs')
      )
    );
    const retiredPromptHookConfigured = (parsed?.hooks?.UserPromptSubmit ?? []).some(group =>
      Array.isArray(group?.hooks) && group.hooks.some(hook =>
        hook?.type === 'command' && typeof hook.command === 'string' &&
        hook.command.includes('${PLUGIN_ROOT}') && hook.command.includes('user-prompt-submit.mjs')
      )
    );
    return {
      configured,
      knowledgeSessionStartConfigured,
      handlerPresent,
      cliPresent,
      retiredPromptHookConfigured,
      retiredPromptAdapterPresent
    };
  } catch {
    return {
      configured: false,
      knowledgeSessionStartConfigured: false,
      handlerPresent,
      cliPresent,
      retiredPromptHookConfigured: false,
      retiredPromptAdapterPresent
    };
  }
}

function inspectInstalledNativePlugin(expectedVersion) {
  try {
    const output = execFileSync('codex', ['plugin', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const parsed = JSON.parse(output);
    const entry = findSpectrePluginEntry(parsed);
    const installPath = nativePluginInstallPath(entry);
    const hooks = inspectInstalledNativeHooks(installPath);
    const installed = Boolean(entry) && entry.installed !== false;
    const enabled = installed && entry.enabled !== false;
    const active = installed && enabled;
    return {
      status: !entry
        ? 'absent'
        : !installed
          ? 'not_installed'
          : !enabled
            ? 'disabled'
            : 'installed',
      entry,
      installed,
      enabled,
      active,
      version: entry?.version || null,
      versionMatches: entry ? entry.version === expectedVersion : false,
      installPath,
      cachePresent: installPath ? fs.existsSync(installPath) : false,
      hooks
    };
  } catch (error) {
    return {
      status: 'unknown',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectLegacyResidue(config) {
  const legacySkills = [];
  for (const skillName of [
    ...listSpectreSkills(),
    'spectre-apply',
    'spectre-recall',
    'spectre-find',
    'spectre-guide',
    'spectre-evaluate',
    'spectre-architecture_review'
  ]) {
    if (fs.existsSync(path.join(codexSkillsDir(), skillName))) {
      legacySkills.push(skillName);
    }
  }
  const legacyAgentTables = [...config.matchAll(/^\[agents\.(spectre_[^\]]+)\]$/gm)]
    .map(match => match[1]);
  return {
    runtimeDir: fs.existsSync(codexRuntimeRoot()),
    legacySkills,
    legacyAgentTables,
    present: fs.existsSync(codexRuntimeRoot()) ||
      legacySkills.length > 0 ||
      legacyAgentTables.length > 0
  };
}

function inspectNativePlugin(config) {
  const manifestPath = generatedCodexPluginManifestPath();
  const manifest = fs.existsSync(manifestPath)
    ? readJsonFile(manifestPath)
    : null;
  const marketplacePath = codexMarketplacePath();
  const marketplace = fs.existsSync(marketplacePath)
    ? readJsonFile(marketplacePath)
    : null;
  const expectedVersion = manifest?.version || null;
  return {
    marketplace: {
      path: marketplacePath,
      present: Boolean(marketplace),
      version: marketplace?.version || null,
      targetsGeneratedPlugin: marketplace?.plugins?.some(plugin =>
        plugin?.name === 'spectre' && plugin?.source === './plugins/spectre-codex'
      ) || false
    },
    generated: {
      root: generatedCodexPluginRoot(),
      manifestPath,
      present: Boolean(manifest),
      version: expectedVersion,
      hooksUsePluginRoot: generatedHooksUsePluginRoot(),
      agents: listGeneratedAgents().map(agent => agent.fileName)
    },
    installed: inspectInstalledNativePlugin(expectedVersion),
    agents: inspectManagedAgents(),
    legacyResidue: inspectLegacyResidue(config)
  };
}

function skillPath(skillName) {
  return path.join(codexSkillsDir(), skillName, 'SKILL.md');
}

function tableBody(config, tableHeader) {
  const lines = config.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => line.trim() === tableHeader);
  if (headerIndex === -1) return '';
  const body = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join('\n');
}

function projectTrusted(config, projectDir) {
  const candidates = new Set([path.resolve(projectDir)]);
  try {
    candidates.add(fs.realpathSync.native(projectDir));
  } catch {
    // The resolved project path remains the trust lookup fallback.
  }
  return [...candidates].some(candidate =>
    /^trust_level\s*=\s*"trusted"\s*$/m.test(
      tableBody(config, `[projects.${JSON.stringify(candidate)}]`)
    )
  );
}

function hooksEnabled(config) {
  return /^hooks\s*=\s*true\s*$/m.test(tableBody(config, '[features]'));
}

function readIndexStatus(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return { status: 'absent', recordCount: 0 };
  }
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (
      !index
      || index.schemaVersion !== 2
      || !Array.isArray(index.records)
    ) {
      return {
        status: 'malformed',
        recordCount: 0,
        error: 'Expected schemaVersion 2 with a records array.'
      };
    }
    return { status: 'valid', recordCount: index.records.length };
  } catch (error) {
    return {
      status: 'malformed',
      recordCount: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectRecords(storePath) {
  const knowledgeDir = path.join(storePath, 'knowledge');
  const validRecords = [];
  const invalidRecords = [];
  if (!fs.existsSync(knowledgeDir)) {
    return { validRecords, invalidRecords };
  }

  for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })
    .filter(candidate => candidate.isDirectory() && !candidate.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const recordPath = path.join(knowledgeDir, entry.name, RECORD_FILE_NAME);
    if (!fs.existsSync(recordPath)) continue;
    try {
      const parsed = parseKnowledgeRecord(recordPath);
      validRecords.push({
        id: parsed.record.id,
        status: parsed.record.status,
        revisionToken: parsed.revisionToken,
        path: recordPath
      });
    } catch (error) {
      invalidRecords.push({
        path: recordPath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { validRecords, invalidRecords };
}

function legacyRegistryRows(projectDir) {
  const rows = [];
  for (const nativeRoot of ['.claude', '.agents']) {
    for (const recallName of ['spectre-recall', 'spectre-find']) {
      const registryPath = path.join(
        projectDir,
        nativeRoot,
        'skills',
        recallName,
        'references',
        'registry.toon'
      );
      if (!fs.existsSync(registryPath)) continue;
      rows.push(...fs.readFileSync(registryPath, 'utf8')
        .split(/\r?\n/)
        .filter(line => line.trim() && !line.trimStart().startsWith('#'))
        .map(line => ({
          id: line.split('|')[0]?.trim() || null,
          registryPath
        })));
    }
  }
  return rows;
}

function inspectMigration(projectDir, storePath) {
  const reportPath = storePath
    ? path.join(storePath, 'migration-report.json')
    : null;
  const legacyRows = legacyRegistryRows(projectDir);
  if (!reportPath || !fs.existsSync(reportPath)) {
    return {
      status: legacyRows.length > 0 ? 'debt' : 'complete',
      reportPath,
      unresolvedCount: legacyRows.length,
      issues: legacyRows.length > 0
        ? [{ code: 'UNCLASSIFIED_LEGACY', count: legacyRows.length }]
        : [],
      grandfatheredClaudeExceptions: []
    };
  }

  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (
      !report
      || report.schemaVersion !== 1
      || !Array.isArray(report.entries)
    ) {
      throw new Error('Expected schemaVersion 1 with an entries array.');
    }
    const issues = report.entries.filter(entry =>
      !RESOLVED_MIGRATION_CODES.has(entry?.code)
    );
    const reportedIds = new Set(
      report.entries
        .map(entry => entry?.id)
        .filter(id => typeof id === 'string' && id)
    );
    const unclassifiedLegacyCount = legacyRows.filter(
      row => row.id === null || !reportedIds.has(row.id)
    ).length;
    const grandfatheredClaudeExceptions = issues
      .filter(entry =>
        entry?.code === 'OVERSIZED'
        && entry.grandfatheredClaudeNativeDiscovery === true
        && Array.isArray(entry.sourcePaths)
        && entry.sourcePaths.some(sourcePath =>
          typeof sourcePath === 'string'
          && sourcePath.includes(`${path.sep}.claude${path.sep}`)
        )
      )
      .map(entry => ({
        id: entry.id,
        sourcePaths: entry.sourcePaths,
        nativeDiscoveryEligible: true
      }));
    return {
      status: issues.length > 0 || unclassifiedLegacyCount > 0 ? 'debt' : 'complete',
      reportPath,
      unresolvedCount: issues.length + unclassifiedLegacyCount,
      issues: [
        ...issues.map(entry => ({
          id: entry.id,
          code: entry.code,
          sourcePaths: entry.sourcePaths ?? []
        })),
        ...(unclassifiedLegacyCount > 0
          ? [{ code: 'UNCLASSIFIED_LEGACY', count: unclassifiedLegacyCount }]
          : [])
      ],
      grandfatheredClaudeExceptions
    };
  } catch (error) {
    return {
      status: 'invalid',
      reportPath,
      unresolvedCount: legacyRows.length,
      issues: [],
      grandfatheredClaudeExceptions: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function inspectKnowledge(projectDir, config, hookConfigStatus, nativePlugin) {
  const runtimeScripts = path.join(codexRuntimeRoot(), 'hooks', 'scripts');
  const nativePluginActive = nativePlugin.installed?.active === true;
  const nativeHooks = nativePluginActive
    ? nativePlugin.installed?.hooks ?? {}
    : {};
  const sessionHookConfigured = hookConfigStatus.knowledgeSessionStartConfigured ||
    nativeHooks.knowledgeSessionStartConfigured === true;
  const handlerPresent = fs.existsSync(path.join(runtimeScripts, 'load-knowledge.mjs')) ||
    nativeHooks.handlerPresent === true;
  const cliPresent = fs.existsSync(path.join(runtimeScripts, 'knowledge-cli.mjs')) ||
    nativeHooks.cliPresent === true;
  const retiredPromptHookConfigured = hookConfigStatus.retiredPromptHookConfigured ||
    nativeHooks.retiredPromptHookConfigured === true;
  const retiredPromptAdapterPresent =
    fs.existsSync(path.join(runtimeScripts, 'user-prompt-submit.mjs')) ||
    nativeHooks.retiredPromptAdapterPresent === true;
  const hooksFeatureEnabled = hooksEnabled(config) || nativeHooks.configured === true;
  const trusted = projectTrusted(config, projectDir);
  let registryStatus = 'active';
  if (retiredPromptHookConfigured || retiredPromptAdapterPresent) {
    registryStatus = 'stale_prompt_hook';
  } else if (nativePlugin.installed?.status === 'disabled') {
    registryStatus = 'disabled';
  } else if (!sessionHookConfigured || !handlerPresent || !cliPresent) {
    registryStatus = 'absent';
  } else if (!hooksFeatureEnabled) {
    registryStatus = 'disabled';
  } else if (!trusted) {
    registryStatus = 'untrusted';
  }

  const registry = {
    status: registryStatus,
    sessionHookConfigured,
    handlerPresent,
    cliPresent,
    promptHookAbsent: !retiredPromptHookConfigured && !retiredPromptAdapterPresent,
    hooksFeatureEnabled,
    projectTrusted: trusted,
    nativePluginActive
  };

  const overridePath = path.join(projectDir, 'AGENTS.override.md');
  const overrideBlockPresent = fs.existsSync(overridePath) &&
    fs.readFileSync(overridePath, 'utf8').includes(KNOWLEDGE_OVERRIDE_START);

  function staleStatus(storePath) {
    const promptLedgerPresent = Boolean(storePath) &&
      fs.existsSync(path.join(storePath, 'runtime', 'sessions'));
    return {
      status: retiredPromptHookConfigured || retiredPromptAdapterPresent ||
        overrideBlockPresent || promptLedgerPresent
        ? 'cleanup_required'
        : 'clean',
      promptHookConfigured: retiredPromptHookConfigured,
      promptAdapterPresent: retiredPromptAdapterPresent,
      overrideBlockPresent,
      promptLedgerPresent
    };
  }

  let resolved;
  try {
    resolved = await resolveProjectStore(projectDir, { readOnly: true });
  } catch (error) {
    return {
      registry,
      store: {
        status: 'invalid',
        path: null,
        index: { status: 'unknown', recordCount: 0 },
        activity: { status: 'unknown' },
        validRecords: [],
        invalidRecords: [],
        error: error instanceof Error ? error.message : String(error)
      },
      migration: {
        status: 'unknown',
        reportPath: null,
        unresolvedCount: 0,
        issues: [],
        grandfatheredClaudeExceptions: []
      },
      nativeDiscovery: {
        status: 'complete',
        grandfatheredClaudeExceptions: []
      },
      stale: staleStatus(null)
    };
  }

  if (!resolved.storePath) {
    const migration = inspectMigration(projectDir, null);
    return {
      registry,
      store: {
        status: 'absent',
        path: null,
        index: { status: 'absent', recordCount: 0 },
        activity: { status: 'absent' },
        validRecords: [],
        invalidRecords: []
      },
      migration,
      nativeDiscovery: {
        status: migration.grandfatheredClaudeExceptions.length > 0
          ? 'grandfathered_claude'
          : 'complete',
        grandfatheredClaudeExceptions:
          migration.grandfatheredClaudeExceptions
      },
      stale: staleStatus(null)
    };
  }

  const index = readIndexStatus(path.join(resolved.storePath, 'index.json'));
  const records = inspectRecords(resolved.storePath);
  const migration = inspectMigration(projectDir, resolved.storePath);
  const activityPath = path.join(resolved.storePath, 'activity.json');
  let activity = { status: 'absent' };
  if (fs.existsSync(activityPath)) {
    try {
      const value = readKnowledgeActivity(resolved.storePath);
      activity = {
        status: 'valid',
        recordCount: Object.keys(value.records).length,
        searchMatches: value.search.matches,
        searchMisses: value.search.misses
      };
    } catch (error) {
      activity = {
        status: 'corrupt',
        code: error?.code || 'KNOWLEDGE_ACTIVITY_CORRUPT',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return {
    registry,
    store: {
      status: index.status === 'valid' && records.invalidRecords.length === 0 &&
        activity.status !== 'corrupt'
        ? 'valid'
        : 'invalid',
      path: resolved.storePath,
      index,
      activity,
      ...records
    },
    migration,
    nativeDiscovery: {
      status: migration.grandfatheredClaudeExceptions.length > 0
        ? 'grandfathered_claude'
        : 'complete',
      grandfatheredClaudeExceptions:
        migration.grandfatheredClaudeExceptions
    },
    stale: staleStatus(resolved.storePath)
  };
}

export async function runDoctor({ verifyHooks = false, json = false, projectDir = process.cwd() } = {}) {
  const home = resolveCodexHome();
  const version = codexVersion();
  const hookConfigStatus = spectreHooksConfigured();
  const config = fs.existsSync(codexConfigPath())
    ? fs.readFileSync(codexConfigPath(), 'utf8')
    : '';
  const nativePlugin = inspectNativePlugin(config);
  const nativeHooksConfigured = nativePlugin.installed?.active === true &&
    nativePlugin.installed?.hooks?.configured === true;
  const result = {
    codexHome: home,
    codexVersion: version,
    minVersion: MIN_CODEX_VERSION,
    supported: compareVersions(version, MIN_CODEX_VERSION) >= 0,
    paths: {
      config: codexConfigPath(),
      skills: codexSkillsDir(),
      runtime: codexRuntimeRoot()
    },
    installed: {
      config: fs.existsSync(codexConfigPath()),
      runtimeDir: fs.existsSync(codexRuntimeRoot())
    },
    hooks: {
      verifyRequested: verifyHooks,
      spectreHooksConfigured: false,
      hooksFeatureEnabled: false,
      hiddenContextInjection: 'none',
      hooksConfigPath: codexHooksConfigPath(),
      hooksConfigPresent: fs.existsSync(codexHooksConfigPath())
    },
    capabilities: {
      workflowSkillsInstalled: false,
      exactWorkflowSkillsInstalled: false,
      subagentsInstalled: false,
      multiAgentEnabled: false,
      sharedSkillsInstalled: false
    },
    nativePlugin,
    knowledge: await inspectKnowledge(projectDir, config, hookConfigStatus, nativePlugin)
  };
  result.hooks.hooksFeatureEnabled = nativeHooksConfigured;
  result.hooks.spectreHooksConfigured = nativeHooksConfigured;
  if (nativeHooksConfigured) {
    result.hooks.hiddenContextInjection = 'native_plugin_hooks';
  }
  result.capabilities.subagentsInstalled = nativePlugin.agents.ready;

  if (config) {
    result.hooks.hooksFeatureEnabled = hooksEnabled(config) || nativeHooksConfigured;
    result.hooks.spectreHooksConfigured = hookConfigStatus.configured || nativeHooksConfigured;
    if (nativeHooksConfigured) {
      result.hooks.hiddenContextInjection = 'native_plugin_hooks';
    } else if (hookConfigStatus.configured) {
      result.hooks.hiddenContextInjection = 'session_start_registry';
    }
    if (hookConfigStatus.error) {
      result.hooks.configError = hookConfigStatus.error;
    }
    if (hookConfigStatus.error) {
      result.hooks.hiddenContextInjection = 'malformed_hooks_json';
    }
    result.capabilities.subagentsInstalled = nativePlugin.agents.ready ||
      listSpectreAgents().every(agent => config.includes(`[agents.spectre_${agent.replace(/-/g, '_')}]`));
    result.capabilities.multiAgentEnabled = config.includes('multi_agent = true');
  }

  const expectedSkillNames = listSpectreSkills();
  const expectedSkillFiles = expectedSkillNames.map(name => skillPath(name));
  const nativeSkillsDir = nativePlugin.installed?.active === true && nativePlugin.installed?.installPath
    ? path.join(nativePlugin.installed.installPath, 'skills')
    : null;
  const nativeSkillPath = name => nativeSkillsDir
    ? path.join(nativeSkillsDir, name, 'SKILL.md')
    : null;
  result.capabilities.workflowSkillsInstalled = WORKFLOW_PROBE_SKILLS
    .some(name => fs.existsSync(skillPath(name)) || Boolean(nativeSkillPath(name) && fs.existsSync(nativeSkillPath(name))));
  result.capabilities.exactWorkflowSkillsInstalled = expectedSkillFiles.every((filePath, index) =>
    fs.existsSync(filePath) || Boolean(nativeSkillPath(expectedSkillNames[index]) && fs.existsSync(nativeSkillPath(expectedSkillNames[index])))
  );

  result.capabilities.sharedSkillsInstalled = SHARED_SKILLS
    .every(skill => fs.existsSync(skillPath(skill)) || Boolean(nativeSkillPath(skill) && fs.existsSync(nativeSkillPath(skill))));

  if (verifyHooks) {
    result.hooks.manualVerification = 'SessionStart hooks are configured; the size-bounded metadata registry is refreshed without reading or rewriting canonical knowledge.';
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Codex version: ${result.codexVersion}\n`);
  process.stdout.write(`Codex home: ${result.codexHome}\n`);
  process.stdout.write(`Supported: ${result.supported ? 'yes' : 'no'} (requires >= ${result.minVersion})\n`);
  process.stdout.write(`Config present: ${result.installed.config ? 'yes' : 'no'}\n`);
  process.stdout.write(`Runtime present: ${result.installed.runtimeDir ? 'yes' : 'no'}\n`);
  process.stdout.write(`Spectre hooks configured: ${result.hooks.spectreHooksConfigured ? 'yes' : 'no'}\n`);
  process.stdout.write(`hooks.json present: ${result.hooks.hooksConfigPresent ? 'yes' : 'no'}\n`);
  process.stdout.write(`Hooks feature enabled: ${result.hooks.hooksFeatureEnabled ? 'yes' : 'no'}\n`);
  process.stdout.write(`Hidden context injection: ${result.hooks.hiddenContextInjection}\n`);
  if (result.hooks.configError) {
    process.stdout.write(`Hook config error: ${result.hooks.configError}\n`);
  }
  if (result.hooks.manualVerification) {
    process.stdout.write(`Hook verification: ${result.hooks.manualVerification}\n`);
  }
  process.stdout.write(`Exact Spectre workflow skills installed: ${result.capabilities.exactWorkflowSkillsInstalled ? 'yes' : 'no'}\n`);
  process.stdout.write(`Spectre subagents installed: ${result.capabilities.subagentsInstalled ? 'yes' : 'no'}\n`);
  process.stdout.write(`Multi-agent enabled: ${result.capabilities.multiAgentEnabled ? 'yes' : 'no'}\n`);
  process.stdout.write(`Native plugin generated: ${result.nativePlugin.generated.present ? 'yes' : 'no'} (${result.nativePlugin.generated.version || 'unknown'})\n`);
  process.stdout.write(`Native marketplace target: ${result.nativePlugin.marketplace.targetsGeneratedPlugin ? 'plugins/spectre-codex' : 'missing'}\n`);
  process.stdout.write(`Native hooks use PLUGIN_ROOT: ${result.nativePlugin.generated.hooksUsePluginRoot ? 'yes' : 'no'}\n`);
  process.stdout.write(`Native plugin installed: ${result.nativePlugin.installed.status}\n`);
  process.stdout.write(`Managed Codex agents ready: ${result.nativePlugin.agents.ready ? 'yes' : 'no'}\n`);
  process.stdout.write(`Legacy direct-install residue: ${result.nativePlugin.legacyResidue.present ? 'present' : 'none'}\n`);
  process.stdout.write(`Knowledge registry: ${result.knowledge.registry.status}\n`);
  process.stdout.write(`Knowledge store: ${result.knowledge.store.status}\n`);
  process.stdout.write(`Knowledge index: ${result.knowledge.store.index.status}\n`);
  process.stdout.write(`Knowledge activity: ${result.knowledge.store.activity.status}\n`);
  process.stdout.write(`Stale knowledge transport: ${result.knowledge.stale.status}\n`);
  if (result.knowledge.migration.status === 'debt') {
    process.stdout.write(`Migration debt: ${result.knowledge.migration.unresolvedCount} unresolved\n`);
  } else {
    process.stdout.write(`Migration debt: ${result.knowledge.migration.status}\n`);
  }
  const grandfathered =
    result.knowledge.nativeDiscovery.grandfatheredClaudeExceptions;
  if (result.knowledge.nativeDiscovery.status === 'grandfathered_claude') {
    process.stdout.write(
      `Native discovery retirement: incomplete (${grandfathered.length} grandfathered Claude exception${grandfathered.length === 1 ? '' : 's'})\n`
    );
    for (const exception of grandfathered) {
      process.stdout.write(
        `Grandfathered Claude skill: ${exception.id} (still eligible for Claude native discovery)\n`
      );
    }
  } else {
    process.stdout.write('Native discovery retirement: complete\n');
  }
}
