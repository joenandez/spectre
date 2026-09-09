#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateKnowledgeRecordActivity,
  readKnowledgeActivity,
} from '../plugins/spectre/hooks/scripts/knowledge/activity.mjs';
import { refreshKnowledgeIndex } from '../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import { renderKnowledgeRegistry } from '../plugins/spectre/hooks/scripts/knowledge/registry.mjs';
import { resolveProjectStore } from '../plugins/spectre/hooks/scripts/knowledge/store.mjs';
import {
  normalizeTagId,
  readTagCatalog,
} from '../plugins/spectre/hooks/scripts/knowledge/tags.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE_SCRIPT = path.join(SCRIPT_DIR, 'knowledge-host-probe-hook.mjs');
const CLAUDE_SOURCE = path.join(REPO_ROOT, 'plugins', 'spectre');
const CODEX_SOURCE = path.join(REPO_ROOT, 'plugins', 'spectre-codex');
const OMITTED_ID = 'testing-host-omitted-record';
const SEARCH_QUERY = 'omega recovery protocol';
const CORE_SENTINEL = 'SPECTRE_HOST_OMITTED_CORE_SENTINEL_20260722';
const RESOURCE_SENTINEL = 'SPECTRE_HOST_RESOURCE_SENTINEL_20260722';
const FILLER_COUNT = 64;

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

function parseArgs(argv) {
  const fixtureRoot = valueAfter(argv, '--fixture-root');
  const run = valueAfter(argv, '--run');
  if (!fixtureRoot) {
    throw new Error(
      'Usage: verify-knowledge-hosts.mjs --fixture-root <path> ' +
      '[--run <claude|codex|all>] [--json]',
    );
  }
  if (run && !['claude', 'codex', 'all'].includes(run)) {
    throw new Error('--run must be claude, codex, or all');
  }
  return {
    fixtureRoot: path.resolve(fixtureRoot),
    run,
    validate: argv.includes('--validate'),
    json: argv.includes('--json'),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function commandVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return {
    command,
    status: result.status,
    version: (result.stdout || result.stderr || '').trim(),
  };
}

function canonicalTagId(phrase) {
  const id = normalizeTagId(phrase);
  if (id === null) throw new Error(`Fixture tag is not canonicalizable: ${phrase}`);
  return id;
}

function recordContent({ id, description, tags, core }) {
  return JSON.stringify({
    schemaVersion: 1, id, kind: 'knowledge', title: id, summary: description,
    tags, applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-07-22T00:00:00.000Z' },
    relatedRecordIds: [], category: 'gotcha', useWhen: description,
    content: core, evidence: 'Host fixture verification.', status: 'active',
  }, null, 2);
}

function writeRecord(storePath, { id, description, tags, core, resource, mtimeMs }) {
  const recordDirectory = path.join(storePath, 'knowledge', id);
  const skillPath = path.join(recordDirectory, 'record.json');
  fs.mkdirSync(recordDirectory, { recursive: true });
  fs.writeFileSync(skillPath, recordContent({ id, description, tags, core }));
  if (resource !== undefined) {
    const resourcePath = path.join(recordDirectory, 'references', 'proof.txt');
    fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
    fs.writeFileSync(resourcePath, `${resource}\n`);
  }
  const seconds = mtimeMs / 1000;
  fs.utimesSync(skillPath, seconds, seconds);
  return recordDirectory;
}

function zeroActivity() {
  return {
    schemaVersion: 2,
    records: {},
    search: { matches: 0, misses: 0, recordMatches: {} },
  };
}

function writeTagCatalog(storePath, tags) {
  const entries = [...tags]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, description]) => [id, { description, aliases: [] }]);
  atomicWriteJson(path.join(storePath, 'tags.json'), {
    schemaVersion: 1,
    tags: Object.fromEntries(entries),
    redirects: {},
  });
}

async function seedOverflowStore(projectDir, spectreHome) {
  const resolved = await resolveProjectStore(projectDir, { spectreHome });
  const tags = [];
  const omittedTag = canonicalTagId(SEARCH_QUERY);
  const recordDirectory = writeRecord(resolved.storePath, {
    id: OMITTED_ID,
    description:
      `Use when handling ${SEARCH_QUERY} in the isolated real-host exact-load recovery protocol.`,
    tags: [omittedTag],
    core: [
      CORE_SENTINEL,
      'The only supporting resource is references/proof.txt.',
      'Return the core sentinel and then read the supporting resource path from the load result.',
    ].join('\n'),
    resource: RESOURCE_SENTINEL,
    mtimeMs: Date.parse('2020-01-01T00:00:00.000Z'),
  });
  tags.push([omittedTag, 'Omega recovery protocol.']);

  for (let index = 0; index < FILLER_COUNT; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const fillerPhrase = `host registry filler ${suffix}`;
    const fillerTag = canonicalTagId(fillerPhrase);
    writeRecord(resolved.storePath, {
      id: `testing-host-registry-filler-${suffix}`,
      description:
        `Use when validating deterministic registry filler ${suffix} for complete-entry host-budget measurement. ` +
        'This routing metadata is intentionally verbose but contains no record body or sentinel discovery terms.',
      tags: [fillerTag],
      core: `Filler body ${suffix}; this content must never appear in SessionStart registry metadata.`,
      mtimeMs: Date.parse('2026-01-01T00:00:00.000Z') + index * 1000,
    });
    tags.push([fillerTag, `Host registry filler ${suffix}.`]);
  }
  writeTagCatalog(resolved.storePath, tags);
  atomicWriteJson(path.join(resolved.storePath, 'activity.json'), zeroActivity());
  const { index } = refreshKnowledgeIndex(resolved.storePath);
  return {
    storePath: resolved.storePath,
    recordDirectory,
    resourcePath: path.join(recordDirectory, 'references', 'proof.txt'),
    activeRecordCount: index.records.length,
  };
}

function probeCommand(hostFixture) {
  return [
    'node',
    shellQuote(hostFixture.probeScript ?? PROBE_SCRIPT),
    '--runtime',
    shellQuote(hostFixture.runtimePath),
    '--host',
    hostFixture.host,
    '--evidence',
    shellQuote(hostFixture.observationPath),
    '--expected-id',
    OMITTED_ID,
    '--core-sentinel',
    CORE_SENTINEL,
    '--resource-sentinel',
    RESOURCE_SENTINEL,
  ].join(' ');
}

function rewriteHooks(hostFixture) {
  const hooksPath = path.join(hostFixture.pluginRoot, 'hooks', 'hooks.json');
  const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  for (const groups of Object.values(parsed.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook?.type !== 'command' || typeof hook.command !== 'string') continue;
        if (hook.command.includes('load-knowledge.mjs')) {
          hook.command = probeCommand(hostFixture);
        } else if (hostFixture.host === 'codex') {
          hook.command = hook.command.replaceAll('${PLUGIN_ROOT}', hostFixture.pluginRoot);
        }
      }
    }
  }
  fs.writeFileSync(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

function hostPrompt() {
  return [
    'Run the isolated Spectre knowledge overflow proof in this fixture.',
    `The relevant record is omitted from the SessionStart registry. Search exactly once for: ${SEARCH_QUERY}`,
    'Choose the matching record ID from the search results and exact-load it exactly once using the bundled command.',
    'Do not inspect the Spectre store directly and do not run any other knowledge search or load command.',
    'From the load result, capture the core sentinel, recordDirectory, and only resource path.',
    'Read that resource path exactly once and capture its sentinel.',
    'Reply with one compact JSON object containing exactly these keys: recordId, coreSentinel, resourceSentinel, recordDirectory, resourcePath.',
  ].join(' ');
}

function sessionInput(projectDir, host) {
  return JSON.stringify({
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd: projectDir,
    session_id: `spectre-host-proof-${host}`,
  });
}

function runProbePreflight(hostFixture) {
  const args = [
    PROBE_SCRIPT,
    '--runtime', hostFixture.runtimePath,
    '--host', hostFixture.host,
    '--evidence', hostFixture.observationPath,
    '--expected-id', OMITTED_ID,
    '--core-sentinel', CORE_SENTINEL,
    '--resource-sentinel', RESOURCE_SENTINEL,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: hostFixture.projectDir,
    env: {
      ...process.env,
      SPECTRE_HOME: hostFixture.spectreHome,
      CLAUDE_PROJECT_DIR: hostFixture.projectDir,
      CLAUDE_PLUGIN_ROOT: hostFixture.pluginRoot,
      PLUGIN_ROOT: hostFixture.pluginRoot,
      CODEX_HOME: hostFixture.codexHome ?? '',
    },
    input: sessionInput(hostFixture.projectDir, hostFixture.host),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${hostFixture.host} probe preflight failed: ${result.stderr || result.stdout}`);
  }
  const observation = JSON.parse(fs.readFileSync(hostFixture.observationPath, 'utf8'));
  if (
    !observation.validJson
    || !observation.hookEventMatches
    || !observation.measurement?.ok
    || observation.expectedIdVisible
    || observation.coreSentinelVisible
    || observation.resourceSentinelVisible
    || observation.hasTopLevelSystemMessage
    || observation.hasHookSystemMessage
    || observation.hasPreview
    || observation.hasFallbackFile
  ) {
    throw new Error(`${hostFixture.host} preflight registry contract failed`);
  }
  return observation;
}

function writeCodexConfig(hostFixture, hooks) {
  fs.mkdirSync(hostFixture.codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(hostFixture.codexHome, 'config.toml'),
    [
      '[features]',
      'hooks = true',
      '',
      `[projects.${JSON.stringify(hostFixture.projectDir)}]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(hostFixture.codexHome, 'hooks.json'),
    `${JSON.stringify(hooks, null, 2)}\n`,
  );
}

function commandDisplay(cwd, environment, command, args) {
  const envPrefix = Object.entries(environment)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  return `cd ${shellQuote(cwd)} && ${envPrefix} ${shellQuote(command)} ${args.map(shellQuote).join(' ')}`.trim();
}

async function prepareHostFixture(fixtureRoot, host) {
  const hostRoot = path.join(fixtureRoot, host);
  const projectDir = path.join(hostRoot, 'project');
  const spectreHome = path.join(hostRoot, 'spectre-home');
  const pluginRoot = path.join(hostRoot, 'plugin');
  const observationPath = path.join(hostRoot, 'registry-observation.json');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.cpSync(host === 'claude' ? CLAUDE_SOURCE : CODEX_SOURCE, pluginRoot, { recursive: true });
  const store = await seedOverflowStore(projectDir, spectreHome);
  const hostFixture = {
    host,
    hostRoot,
    projectDir,
    spectreHome,
    pluginRoot,
    runtimePath: path.join(pluginRoot, 'hooks', 'scripts', 'load-knowledge.mjs'),
    cliPath: path.join(pluginRoot, 'hooks', 'scripts', 'knowledge-cli.mjs'),
    observationPath,
    rawStdoutPath: path.join(hostRoot, `${host}.stdout.jsonl`),
    rawStderrPath: path.join(hostRoot, `${host}.stderr.txt`),
    ...(host === 'codex' ? { codexHome: path.join(hostRoot, 'codex-home') } : {}),
    ...store,
  };
  const hooks = rewriteHooks(hostFixture);
  if (host === 'codex') writeCodexConfig(hostFixture, hooks);
  const observation = runProbePreflight(hostFixture);
  refreshKnowledgeIndex(store.storePath, { persist: false });
  const registry = renderKnowledgeRegistry({
    host,
    catalog: readTagCatalog(store.storePath),
    projectDir,
    cliPath: hostFixture.cliPath,
  });
  return {
    ...hostFixture,
    preflight: {
      includedCount: registry.includedEntries.length,
      omittedCount: registry.omittedCount,
      measurement: observation.measurement,
      frameCharacters: observation.frameCharacters,
      predicted: {
        includedCount: registry.includedEntries.length,
        omittedCount: registry.omittedCount,
        measurement: registry.measurement,
        frameCharacters: registry.frame.length,
      },
      observation,
      initialSuccessfulLoads: 0,
    },
  };
}

async function prepareFixture(fixtureRoot, options = {}) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const manifestPath = path.join(fixtureRoot, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    throw new Error(`Fixture already prepared: ${manifestPath}`);
  }
  const date = options.date || new Date().toISOString().slice(0, 10);
  const claudeBinary = process.env.CLAUDE_BIN || 'claude';
  const codexBinary = process.env.CODEX_BIN || 'codex';
  const prompt = hostPrompt();
  const claude = await prepareHostFixture(fixtureRoot, 'claude');
  const codex = await prepareHostFixture(fixtureRoot, 'codex');
  const claudeArgs = [
    '--plugin-dir', claude.pluginRoot,
    '--setting-sources', 'project',
    '--allowedTools', 'Bash', 'Read',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--include-hook-events',
    '--verbose',
    '--max-budget-usd', '2.00',
    '-p',
    prompt,
  ];
  const codexArgs = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--dangerously-bypass-hook-trust',
    '--sandbox', 'workspace-write',
    '--add-dir', codex.spectreHome,
    '-c', 'approval_policy="never"',
    '-C', codex.projectDir,
    prompt,
  ];
  const evidenceDirectory = path.join(
    REPO_ROOT,
    'docs',
    'tasks',
    'main',
    'usage-ranked-knowledge',
    'verification',
  );
  const manifest = {
    schemaVersion: 2,
    preparedAt: new Date().toISOString(),
    date,
    fixtureRoot,
    manifestPath,
    prompt,
    expected: {
      omittedId: OMITTED_ID,
      searchQuery: SEARCH_QUERY,
      coreSentinel: CORE_SENTINEL,
      resourceSentinel: RESOURCE_SENTINEL,
    },
    evidencePath: path.join(evidenceDirectory, `host-registry-${date}.md`),
    versions: {
      claude: commandVersion(claudeBinary),
      codex: commandVersion(codexBinary),
    },
    hosts: {
      claude: {
        ...claude,
        binary: claudeBinary,
        args: claudeArgs,
        command: commandDisplay(
          claude.projectDir,
          { SPECTRE_HOME: claude.spectreHome },
          claudeBinary,
          claudeArgs,
        ),
      },
      codex: {
        ...codex,
        binary: codexBinary,
        args: codexArgs,
        command: commandDisplay(
          codex.projectDir,
          { SPECTRE_HOME: codex.spectreHome, CODEX_HOME: codex.codexHome },
          codexBinary,
          codexArgs,
        ),
      },
    },
  };
  atomicWriteJson(manifestPath, manifest);
  return manifest;
}

function stageCodexAuth(codexHome) {
  const sourceHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  const source = path.join(sourceHome, 'auth.json');
  if (!fs.existsSync(source)) return null;
  const destination = path.join(codexHome, 'auth.json');
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

function runHost(manifest, host) {
  const fixture = manifest.hosts[host];
  const environment = {
    ...process.env,
    SPECTRE_HOME: fixture.spectreHome,
    CLAUDE_PROJECT_DIR: fixture.projectDir,
    CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
    PLUGIN_ROOT: fixture.pluginRoot,
    ...(host === 'codex' ? { CODEX_HOME: fixture.codexHome } : {}),
  };
  const stagedAuth = host === 'codex' ? stageCodexAuth(fixture.codexHome) : null;
  let result;
  try {
    result = spawnSync(fixture.binary, fixture.args, {
      cwd: fixture.projectDir,
      env: environment,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } finally {
    if (stagedAuth) fs.rmSync(stagedAuth, { force: true });
  }
  fs.writeFileSync(fixture.rawStdoutPath, result.stdout || '');
  fs.writeFileSync(fixture.rawStderrPath, result.stderr || '');
  return result;
}

function validateHostRun(manifest, host, result) {
  const fixture = manifest.hosts[host];
  const observation = JSON.parse(fs.readFileSync(fixture.observationPath, 'utf8'));
  const activity = readKnowledgeActivity(fixture.storePath);
  const aggregate = aggregateKnowledgeRecordActivity(activity, OMITTED_ID);
  const recordMatch = activity.search.recordMatches?.[OMITTED_ID];
  const recordMatchCount = typeof recordMatch === 'number'
    ? recordMatch
    : recordMatch?.count ?? 0;
  const stdout = result.stdout || '';
  const checks = {
    exitZero: result.status === 0,
    registryValid: observation.validJson && observation.hookEventMatches,
    registryWithinBudget: observation.measurement?.ok === true,
    registryMetadataOnly:
      !observation.expectedIdVisible &&
      !observation.coreSentinelVisible &&
      !observation.resourceSentinelVisible,
    noVisibleKnowledgeMessage:
      !observation.hasTopLevelSystemMessage &&
      !observation.hasHookSystemMessage &&
      !observation.hasPreview &&
      !observation.hasFallbackFile,
    overflowPresent: observation.omittedCount > 0,
    searchExactlyOnce:
      activity.search.matches === 1 &&
      activity.search.misses === 0 &&
      recordMatchCount === 1,
    loadExactlyOnce: aggregate.successfulLoads === 1,
    recordRecovered: stdout.includes(OMITTED_ID) && stdout.includes(CORE_SENTINEL),
    resourceRecovered:
      stdout.includes(RESOURCE_SENTINEL) &&
      stdout.includes(fixture.recordDirectory) &&
      stdout.includes(fixture.resourcePath),
  };
  return {
    host,
    ok: Object.values(checks).every(Boolean),
    checks,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    observation,
    activity: {
      successfulLoads: aggregate.successfulLoads,
      lastLoadedAt: aggregate.lastLoadedAt ?? null,
      searchMatches: activity.search.matches,
      searchMisses: activity.search.misses,
      recordMatches: recordMatchCount,
    },
    stdoutPath: fixture.rawStdoutPath,
    stderrPath: fixture.rawStderrPath,
  };
}

function markdownEscape(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function sanitizeHostInteraction(host, rawOutput) {
  const sanitized = [];
  for (const line of rawOutput.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (host === 'codex') {
      const itemType = event.item?.type;
      if (itemType === 'command_execution' || itemType === 'agent_message' || event.type === 'turn.completed') {
        sanitized.push(event);
      }
      continue;
    }
    if (event.type === 'assistant') {
      const content = event.message?.content?.filter(({ type }) => type !== 'thinking') ?? [];
      if (content.length > 0) {
        sanitized.push({
          type: event.type,
          message: {
            role: event.message.role,
            content,
          },
        });
      }
    } else if (event.type === 'user') {
      sanitized.push({ type: event.type, message: event.message });
    } else if (event.type === 'result') {
      sanitized.push({
        type: event.type,
        subtype: event.subtype,
        is_error: event.is_error,
        num_turns: event.num_turns,
        result: event.result,
      });
    }
  }
  return `${sanitized.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function observedRegistryCounts(fixture, result) {
  const omittedCount = result.observation.omittedCount;
  return {
    includedCount: fixture.activeRecordCount - omittedCount,
    omittedCount,
  };
}

function writeEvidence(manifest, results) {
  const evidenceAssetDirectory = manifest.evidencePath.replace(/\.md$/, '');
  fs.mkdirSync(evidenceAssetDirectory, { recursive: true });
  fs.copyFileSync(manifest.manifestPath, path.join(evidenceAssetDirectory, 'manifest.json'));
  const persistentPaths = {};
  for (const result of results) {
    const fixture = manifest.hosts[result.host];
    const paths = {
      observation: path.join(evidenceAssetDirectory, `${result.host}-registry-observation.json`),
      stdout: path.join(evidenceAssetDirectory, `${result.host}.stdout.jsonl`),
      stderr: path.join(evidenceAssetDirectory, `${result.host}.stderr.txt`),
      activity: path.join(evidenceAssetDirectory, `${result.host}-activity.json`),
    };
    fs.copyFileSync(fixture.observationPath, paths.observation);
    fs.writeFileSync(
      paths.stdout,
      sanitizeHostInteraction(result.host, fs.readFileSync(result.stdoutPath, 'utf8')),
    );
    fs.copyFileSync(result.stderrPath, paths.stderr);
    fs.copyFileSync(path.join(fixture.storePath, 'activity.json'), paths.activity);
    persistentPaths[result.host] = paths;
  }
  const lines = [
    `# Usage-ranked knowledge real-host evidence — ${manifest.date}`,
    '',
    'This controlled fixture proves the metadata-only SessionStart registry and omitted-record search → exact-load recovery protocol in real Claude Code and Codex hosts.',
    '',
    '## Result',
    '',
    '| Host | Version | Registry frame | Budget measurement | Included / omitted | Search | Load | Core + resource | Result |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const result of results) {
    const fixture = manifest.hosts[result.host];
    const paths = persistentPaths[result.host];
    const counts = observedRegistryCounts(fixture, result);
    lines.push(
      `| ${result.host} | ${markdownEscape(manifest.versions[result.host].version)} | ` +
      `${result.observation.frameCharacters} chars | ` +
      `${result.observation.measurement.measured} / ${result.observation.measurement.limit} | ` +
      `${counts.includedCount} / ${counts.omittedCount} | ` +
      `${result.activity.searchMatches} match | ${result.activity.successfulLoads} | ` +
      `${result.checks.recordRecovered && result.checks.resourceRecovered ? 'observed' : 'missing'} | ` +
      `${result.ok ? 'PASS' : 'FAIL'} |`,
    );
  }
  lines.push(
    '',
    '## Exact prompt',
    '',
    '```text',
    manifest.prompt,
    '```',
    '',
    '## Exact commands',
    '',
  );
  for (const result of results) {
    lines.push(`### ${result.host}`, '', '```sh', manifest.hosts[result.host].command, '```', '');
  }
  lines.push('## Observations', '');
  for (const result of results) {
    const fixture = manifest.hosts[result.host];
    const paths = persistentPaths[result.host];
    lines.push(
      `### ${result.host}`,
      '',
      `- Metadata-only registry: ${result.checks.registryMetadataOnly ? 'PASS' : 'FAIL'}`,
      `- No visible knowledge system message/preview/fallback file: ${result.checks.noVisibleKnowledgeMessage ? 'PASS' : 'FAIL'}`,
      `- Host budget: ${result.observation.measurement.measured} <= ${result.observation.measurement.limit} (${result.checks.registryWithinBudget ? 'PASS' : 'FAIL'})`,
      `- Omitted sentinel search: ${result.activity.searchMatches} match, ${result.activity.recordMatches} record match`,
      `- Successful-load increment: 0 -> ${result.activity.successfulLoads}`,
      `- Core sentinel observed: ${result.checks.recordRecovered ? 'yes' : 'no'}`,
      `- Record directory: \`${fixture.recordDirectory}\``,
      `- Supporting resource: \`${fixture.resourcePath}\``,
      `- Resource sentinel observed: ${result.checks.resourceRecovered ? 'yes' : 'no'}`,
      `- Registry observation: \`${paths.observation}\``,
      `- Activity snapshot: \`${paths.activity}\``,
      `- Filtered host interaction: \`${paths.stdout}\``,
      `- Host stderr: \`${paths.stderr}\``,
      '',
    );
  }
  lines.push(
    '## Acceptance',
    '',
    `Overall: **${results.every(({ ok }) => ok) ? 'PASS' : 'FAIL'}**. ` +
      'Each isolated host began at zero successful loads, received one metadata-only registry frame, searched once for an omitted record, exact-loaded it once, and exposed its safe supporting-resource path.',
    '',
  );
  fs.mkdirSync(path.dirname(manifest.evidencePath), { recursive: true });
  fs.writeFileSync(manifest.evidencePath, lines.join('\n'));
}

function runFixture(manifest, selection) {
  const hosts = selection === 'all' ? ['claude', 'codex'] : [selection];
  const results = [];
  for (const host of hosts) {
    const result = runHost(manifest, host);
    results.push(validateHostRun(manifest, host, result));
  }
  if (hosts.length === 2) writeEvidence(manifest, results);
  return results;
}

function validateExistingFixture(manifest) {
  const results = ['claude', 'codex'].map((host) => {
    const fixture = manifest.hosts[host];
    const stdout = fs.readFileSync(fixture.rawStdoutPath, 'utf8');
    const stderr = fs.readFileSync(fixture.rawStderrPath, 'utf8');
    const completed = host === 'claude'
      ? stdout.includes('"subtype":"success"')
      : stdout.includes('"type":"turn.completed"');
    return validateHostRun(manifest, host, {
      status: completed ? 0 : 1,
      signal: null,
      stdout,
      stderr,
    });
  });
  writeEvidence(manifest, results);
  return results;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const existingManifestPath = path.join(args.fixtureRoot, 'manifest.json');
  const manifest = (args.run || args.validate) && fs.existsSync(existingManifestPath)
    ? JSON.parse(fs.readFileSync(existingManifestPath, 'utf8'))
    : await prepareFixture(args.fixtureRoot);
  const results = args.validate
    ? validateExistingFixture(manifest)
    : args.run
      ? runFixture(manifest, args.run)
      : [];
  const output = { manifest, results };
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    process.stdout.write(`Fixture: ${manifest.manifestPath}\n`);
    for (const host of Object.keys(manifest.hosts)) {
      process.stdout.write(`${host}: ${manifest.hosts[host].command}\n`);
    }
    if (results.length > 0) {
      for (const result of results) process.stdout.write(`${result.host}: ${result.ok ? 'PASS' : 'FAIL'}\n`);
      if (results.length === 2) process.stdout.write(`Evidence: ${manifest.evidencePath}\n`);
    }
  }
  if (results.some(({ ok }) => !ok)) process.exitCode = 1;
  return output;
}

const isDirect = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  CORE_SENTINEL,
  OMITTED_ID,
  RESOURCE_SENTINEL,
  SEARCH_QUERY,
  observedRegistryCounts,
  rewriteHooks,
  prepareFixture,
  runFixture,
  validateHostRun,
};
