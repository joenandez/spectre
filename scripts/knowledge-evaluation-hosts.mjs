import { createHash } from 'node:crypto';
import { spawn as nativeSpawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { access, chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 600_000,
  maxOutputBytes: 20 * 1024 * 1024,
  terminationGraceMs: 100,
});
const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const SYSTEM_RUNTIME_PATHS = ['/bin', '/usr/bin', '/usr/sbin', '/sbin', '/private/var/select', '/opt/homebrew/bin', '/private/etc/ssl/openssl.cnf'];
const ISOLATED_ENVIRONMENT_PATHS = new Set([
  'HOME', 'ZDOTDIR', 'BASH_ENV', 'GIT_CONFIG_GLOBAL', 'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'BUN_TMPDIR',
  'SPECTRE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_TMPDIR', 'SPECTRE_KNOWLEDGE_EVALUATION_TRACE',
  'SPECTRE_EVALUATION_GH_LOG', 'SPECTRE_EVALUATION_GH_STATE', 'SSL_CERT_FILE',
]);
const LAUNCH_ENVIRONMENT_NAMES = new Set([
  ...ISOLATED_ENVIRONMENT_PATHS,
  'PATH', 'LANG', 'TERM', 'COLORTERM', 'NO_COLOR', 'GIT_CONFIG_NOSYSTEM',
]);
const REQUEST_EVALUATION_IDENTIFIER_NAMES = new Set([
  'SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID',
  'SPECTRE_KNOWLEDGE_EVALUATION_CONTEXT_ID',
]);

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function optionalDirectory(value, label) {
  return value == null ? null : absoluteDirectory(value, label);
}

function realDirectory(value, label) {
  const directory = absoluteDirectory(value, label);
  try {
    return fs.realpathSync.native(directory);
  } catch {
    throw new Error(`${label} must exist before launching a host`);
  }
}

function resolveExecutable(command, environment) {
  if (typeof command !== 'string' || !command) throw new Error('host command must be a non-empty string');
  const candidates = path.isAbsolute(command)
    ? [command]
    : String(environment.PATH || process.env.PATH || '').split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, command));
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return fs.realpathSync.native(candidate);
    } catch {
      // Continue through PATH candidates.
    }
  }
  throw new Error(`Host executable is unavailable: ${command}`);
}

function sandboxString(value) {
  return JSON.stringify(value);
}

function sandboxRegexForPrefix(value, suffix) {
  const escaped = value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return JSON.stringify(`^${escaped}${suffix}$`);
}

function xcrunCachePrefix() {
  return `${fs.realpathSync.native(os.tmpdir())}/xcrun_db`;
}

function pathAliases(value, label) {
  const lexical = absoluteDirectory(value, label);
  return [...new Set([lexical, realDirectory(lexical, label)])];
}

function requireContained(cellRoot, directories) {
  const rootAliases = pathAliases(cellRoot, 'preparedFixture.root');
  for (const directory of directories.filter(Boolean)) {
    const aliases = pathAliases(directory, 'prepared fixture directory');
    if (!aliases.every((alias) => rootAliases.some((root) => isWithin(root, alias)))) {
      throw new Error(`prepared fixture directory escapes its cell root: ${directory}`);
    }
  }
  return rootAliases;
}

function containedAliases(cellRoot, directories) {
  return [...new Set(directories.filter(Boolean).flatMap((directory) => {
    const aliases = pathAliases(directory, 'prepared fixture directory');
    if (!aliases.every((alias) => cellRoot.some((root) => isWithin(root, alias)))) {
      throw new Error(`prepared fixture directory escapes its cell root: ${directory}`);
    }
    return aliases;
  }))];
}

function developerToolchain() {
  const selected = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const commandLineTools = '/Library/Developer/CommandLineTools';
  const root = fs.existsSync(path.join(commandLineTools, 'usr', 'bin', 'git'))
    ? commandLineTools
    : selected.status === 0 ? selected.stdout.trim() : '';
  if (!root) throw new Error('Knowledge evaluation developer runtime is unavailable: xcode-select -p');
  const developerRoot = realDirectory(root, 'xcode developer root');
  const toolBin = realDirectory(path.join(developerRoot, 'usr', 'bin'), 'xcode developer tools');
  for (const command of ['git', 'python3']) {
    try {
      const stat = fs.statSync(path.join(toolBin, command));
      if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('not executable');
    } catch {
      throw new Error(`Knowledge evaluation developer runtime is missing ${command}`);
    }
  }
  if (developerRoot === commandLineTools) return { developerRoot, toolBin, runtimePaths: [developerRoot] };
  const xcodeContents = realDirectory(path.dirname(developerRoot), 'xcode contents');
  const coreDevice = fs.existsSync('/Library/Developer/PrivateFrameworks/CoreDevice.framework')
    ? realDirectory('/Library/Developer/PrivateFrameworks/CoreDevice.framework', 'xcode CoreDevice framework')
    : null;
  return { developerRoot, toolBin, runtimePaths: [xcodeContents, coreDevice].filter(Boolean) };
}

function prependDeveloperTools(environment, toolBin) {
  const entries = String(environment.PATH || '').split(path.delimiter).filter(Boolean);
  environment.PATH = [toolBin, ...entries.filter((entry) => path.resolve(entry) !== toolBin)].join(path.delimiter);
}

function sandboxRuntimePaths(command, environment) {
  const developer = developerToolchain();
  if (environment.DEVELOPER_DIR && path.resolve(environment.DEVELOPER_DIR) !== developer.developerRoot) {
    throw new Error('evaluation environment DEVELOPER_DIR does not match xcode-select -p');
  }
  const executable = resolveExecutable(command, environment);
  const providerExecutables = [
    executable,
    resolveExecutable(environment.CLAUDE_BIN || process.env.CLAUDE_BIN || 'claude', environment),
    resolveExecutable(environment.CODEX_BIN || process.env.CODEX_BIN || 'codex', environment),
  ];
  const paths = new Set([...SYSTEM_RUNTIME_PATHS, ...developer.runtimePaths, ...providerExecutables.map(path.dirname), path.dirname(process.execPath)]);
  const cellaredNode = process.execPath.match(/^(.*\/Cellar\/node\/[^/]+)/);
  if (cellaredNode) paths.add(cellaredNode[1]);
  return { executable, executables: [...new Set(providerExecutables)], paths: [...paths].filter((value) => fs.existsSync(value)), developer };
}

function assertSeparated(rawAliases, allowedPaths) {
  if (rawAliases.some((raw) => allowedPaths.some((allowed) => isWithin(raw, allowed) || isWithin(allowed, raw)))) {
    throw new Error('rawLogDirectory must be outside every filesystem boundary allowlist path');
  }
}

function assertIsolatedEnvironment(cellAliases, environment) {
  for (const [key, value] of Object.entries(environment)) {
    if (!ISOLATED_ENVIRONMENT_PATHS.has(key) || typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const lexical = path.resolve(value);
    if (!cellAliases.some((root) => isWithin(root, lexical))) {
      throw new Error(`evaluation environment ${key} escapes its cell root`);
    }
    try {
      const canonical = fs.realpathSync.native(lexical);
      if (!cellAliases.some((root) => isWithin(root, canonical))) {
        throw new Error(`evaluation environment ${key} resolves outside its cell root`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('resolves outside')) throw error;
    }
  }
}

/** Build a default-deny Seatbelt profile for one staged evaluation cell. */
export function createKnowledgeEvaluationSandbox({ preparedFixture, command, environment, sandboxExecutable = SANDBOX_EXECUTABLE }) {
  if (!path.isAbsolute(sandboxExecutable)) throw new Error('sandbox executable must be an absolute path');
  const cellAliases = requireContained(preparedFixture.root, [
    preparedFixture.projectDir, preparedFixture.storeDir, preparedFixture.pluginDir,
    preparedFixture.codexHome, preparedFixture.claudeHome,
  ]);
  const fixtureAliases = containedAliases(cellAliases, [
    preparedFixture.projectDir, preparedFixture.storeDir, preparedFixture.pluginDir,
    preparedFixture.codexHome, preparedFixture.claudeHome,
  ]);
  const { executable, executables, paths: runtimePaths } = sandboxRuntimePaths(command, environment);
  const allowedPaths = [...new Set([...cellAliases, ...runtimePaths])];
  assertIsolatedEnvironment(cellAliases, environment);
  assertSeparated(pathAliases(preparedFixture.rawDirectory, 'rawLogDirectory'), allowedPaths);
  const readPaths = allowedPaths.map((entry) => `(subpath ${sandboxString(entry)})`).join(' ');
  const rootMetadata = [...new Set([...cellAliases, ...fixtureAliases, ...runtimePaths])]
    .map((entry) => `(path-ancestors ${sandboxString(entry)})`).join(' ');
  const xcrunCache = sandboxRegexForPrefix(xcrunCachePrefix(), '(-[A-Za-z0-9]+)?');
  const runtimeExceptions = [{
    kind: 'xcrun-cache',
    pathPattern: `${xcrunCachePrefix()}(-[A-Za-z0-9]+)?`,
    access: 'read-write',
  }];
  const profile = [
    '(version 1)',
    '(import "system.sb")',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow process-info*)',
    '(allow network-outbound (require-all (require-any (remote tcp "*:443") (remote udp "*:443") (literal "/private/var/run/mDNSResponder")) (require-not (remote ip "localhost:*"))))',
    `(allow file-read* file-map-executable ${readPaths})`,
    `(allow file-read-metadata ${rootMetadata})`,
    `(allow file-write* ${cellAliases.map((entry) => `(subpath ${sandboxString(entry)})`).join(' ')})`,
    `(allow file-write* (regex ${xcrunCache}))`,
    `(allow file-read* (regex ${xcrunCache}))`,
  ].join('\n');
  return {
    command: sandboxExecutable,
    args: ['-p', profile, executable],
    profileHash: `sha256:${createHash('sha256').update(profile).digest('hex')}`,
    mode: 'default-deny',
    allowedPaths,
    cellPaths: cellAliases,
    providerExecutables: executables,
    runtimeExceptions,
    networkPolicy: {
      outbound: 'tcp-udp-443-and-mdns', loopback: 'denied', unixSockets: ['mDNSResponder'],
      residual: 'non-loopback private addresses on port 443 are not distinguishable by Seatbelt',
    },
  };
}

function sandboxForInvocation({ preparedFixture, native, environment, sandboxExecutable }) {
  const executable = sandboxExecutable ?? SANDBOX_EXECUTABLE;
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw new Error(`Knowledge evaluation filesystem boundary is unavailable: ${executable}`);
  }
  const sandbox = createKnowledgeEvaluationSandbox({
    preparedFixture,
    command: native.command,
    environment,
    sandboxExecutable: executable,
  });
  return { ...sandbox, args: [...sandbox.args, ...native.args] };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function usage(input = {}) {
  return {
    input: Number.isFinite(input.input) ? input.input : null,
    cache: Number.isFinite(input.cache) ? input.cache : null,
    cacheWrite: Number.isFinite(input.cacheWrite) ? input.cacheWrite : null,
    output: Number.isFinite(input.output) ? input.output : null,
    reasoning: Number.isFinite(input.reasoning) ? input.reasoning : null,
  };
}

function claudeUsage(value) {
  return usage({
    input: value?.input_tokens ?? value?.inputTokens,
    cache: value?.cache_read_input_tokens ?? value?.cacheReadInputTokens,
    cacheWrite: value?.cache_creation_input_tokens ?? value?.cacheCreationInputTokens,
    output: value?.output_tokens ?? value?.outputTokens,
  });
}

function codexUsage(value) {
  return usage({
    input: value?.input_tokens,
    cache: value?.cached_input_tokens,
    cacheWrite: value?.cache_write_input_tokens,
    output: value?.output_tokens,
    reasoning: value?.reasoning_output_tokens,
  });
}

function aggregateUsage(values) {
  const total = {};
  for (const field of ['input', 'cache', 'cacheWrite', 'output', 'reasoning']) {
    total[field] = values.length > 0 && values.every((value) => Number.isFinite(value[field]))
      ? values.reduce((sum, value) => sum + value[field], 0)
      : null;
  }
  return total;
}

function claudeModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const models = Object.entries(modelUsage).flatMap(([model, value]) =>
    value && typeof value === 'object' ? [{ model, ...claudeUsage(value) }] : []
  );
  if (models.length === 0) return null;
  // Claude result.usage excludes subagents; modelUsage is already inclusive. Never add primary again.
  return { source: 'result.modelUsage', models, total: aggregateUsage(models) };
}

function parseJsonLines(raw) {
  const events = [];
  let malformedLineCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedLineCount += 1;
    }
  }
  return { events, malformedLineCount };
}

function workerId(event, fallback) {
  const value = event.worker_id ?? event.workerId ?? event.agent_id ?? event.agentId ?? event.message?.id;
  return typeof value === 'string' && value ? value : fallback;
}

function isWorkerEvent(event) {
  return event.is_sidechain === true || event.is_worker === true ||
    event.worker_id != null || event.workerId != null ||
    event.parent_tool_use_id != null || event.parentToolUseId != null ||
    event.parent_agent_id != null || event.parentAgentId != null;
}

function actorDetails(event) {
  const worker = isWorkerEvent(event);
  const id = event.worker_id ?? event.workerId ?? event.agent_id ?? event.agentId ?? null;
  return {
    actorRole: worker ? 'worker' : 'primary',
    actorId: typeof id === 'string' ? id : null,
    parentToolUseId: event.parent_tool_use_id ?? event.parentToolUseId ?? null,
  };
}

function textBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  );
}

function claudeOperation(block, event) {
  return {
    id: typeof block.id === 'string' ? block.id : null,
    host: 'claude',
    name: typeof block.name === 'string' ? block.name : 'unknown',
    type: 'tool_use',
    input: block.input ?? null,
    status: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    ...actorDetails(event),
  };
}

function codexOperation(item, event) {
  const type = item?.type;
  if (type === 'command_execution') {
    return {
      id: typeof item.id === 'string' ? item.id : null,
      host: 'codex', name: 'exec', type,
      input: { command: item.command ?? null }, status: item.status ?? null,
      startedAt: item.started_at ?? item.startedAt ?? null,
      endedAt: item.ended_at ?? item.endedAt ?? null,
      durationMs: Number.isFinite(item.duration_ms) ? item.duration_ms : null,
      ...actorDetails({ ...event, agent_id: event.agent_id ?? event.agentId ?? item.agent_id ?? item.agentId }),
    };
  }
  if (type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : null;
    const tool = typeof item.tool === 'string' ? item.tool : typeof item.tool_name === 'string' ? item.tool_name : null;
    return {
      id: typeof item.id === 'string' ? item.id : null,
      host: 'codex', name: tool ?? 'mcp_tool_call', type,
      input: { server, tool, arguments: safeStructured(item.arguments ?? item.input ?? null) }, status: item.status ?? null,
      startedAt: item.started_at ?? item.startedAt ?? null,
      endedAt: item.ended_at ?? item.endedAt ?? null,
      durationMs: Number.isFinite(item.duration_ms) ? item.duration_ms : null,
      externalTool: { kind: 'mcp', server, tool },
      ...actorDetails({ ...event, agent_id: event.agent_id ?? event.agentId ?? item.agent_id ?? item.agentId }),
    };
  }
  if (type === 'web_search') {
    const query = typeof item.query === 'string' ? item.query : null;
    const action = safeStructured(item.action ?? null);
    return {
      id: typeof item.id === 'string' ? item.id : null,
      host: 'codex', name: 'web_search', type,
      input: { query, action }, status: item.status ?? null,
      startedAt: item.started_at ?? item.startedAt ?? null,
      endedAt: item.ended_at ?? item.endedAt ?? null,
      durationMs: Number.isFinite(item.duration_ms) ? item.duration_ms : null,
      externalTool: { kind: 'web', query, action },
      ...actorDetails({ ...event, agent_id: event.agent_id ?? event.agentId ?? item.agent_id ?? item.agentId }),
    };
  }
  if (['file_change', 'function_call'].includes(type)) {
    return {
      id: typeof item.id === 'string' ? item.id : null,
      host: 'codex', name: item.name ?? item.tool_name ?? type, type,
      input: item.input ?? item.arguments ?? (type === 'file_change' ? { changes: item.changes ?? null } : null), status: item.status ?? null,
      startedAt: item.started_at ?? item.startedAt ?? null,
      endedAt: item.ended_at ?? item.endedAt ?? null,
      durationMs: Number.isFinite(item.duration_ms) ? item.duration_ms : null,
      ...actorDetails({ ...event, agent_id: event.agent_id ?? event.agentId ?? item.agent_id ?? item.agentId }),
    };
  }
  return null;
}

function codexMcpResult(item, eventOrdinal) {
  if (item?.type !== 'mcp_tool_call' || (!Object.hasOwn(item, 'result') && !Object.hasOwn(item, 'error'))) return null;
  const result = safeStructured(item.result ?? null);
  const content = item.result?.content === undefined ? null : safeLog(JSON.stringify(item.result.content));
  return {
    host: 'codex', toolUseId: item.id ?? null, eventOrdinal,
    type: 'mcp_tool_call', server: typeof item.server === 'string' ? item.server : null,
    tool: typeof item.tool === 'string' ? item.tool : typeof item.tool_name === 'string' ? item.tool_name : null,
    status: item.status ?? null, content,
    structuredContent: safeStructured(item.result?.structured_content ?? item.result?.structuredContent ?? null),
    error: safeStructured(item.error ?? item.result?.error ?? null), result,
    isError: item.status === 'failed' || item.error != null || item.result?.is_error === true,
  };
}

function normalizeClaude(events) {
  let workers = null;
  const operations = [];
  const toolResults = [];
  const answers = [];
  let primary = usage();
  let nativeDurationMs = null;
  let workerSequence = 0;
  let fullCycle = null;
  const workerMessageIds = new Set();
  for (const [eventOrdinal, event] of events.entries()) {
    if (event.type === 'assistant') {
      const content = event.message?.content ?? [];
      operations.push(...content.filter((block) => block?.type === 'tool_use').map((block) => ({ ...claudeOperation(block, event), eventOrdinal })));
      if (!isWorkerEvent(event)) answers.push(...textBlocks(content));
      const messageId = event.message?.id;
      if (isWorkerEvent(event) && event.message?.usage &&
        (typeof messageId !== 'string' || !workerMessageIds.has(messageId))) {
        if (typeof messageId === 'string') workerMessageIds.add(messageId);
        if (workers === null) workers = [];
        workerSequence += 1;
        workers.push({ id: workerId(event, `worker-${workerSequence}`), ...claudeUsage(event.message.usage) });
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block?.type === 'tool_result') {
          toolResults.push({
            host: 'claude', toolUseId: block.tool_use_id ?? null, eventOrdinal,
            content: safeLog(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null)),
            isError: block.is_error === true,
          });
        }
      }
    }
    if (event.type === 'result') {
      primary = claudeUsage(event.usage);
      fullCycle = claudeModelUsage(event.modelUsage ?? event.model_usage) ?? fullCycle;
      nativeDurationMs = Number.isFinite(event.duration_ms) ? event.duration_ms : null;
      if (typeof event.result === 'string' && event.result) answers.push(event.result);
    }
  }
  return { usage: { primary, workers, fullCycle }, toolOperations: operations, toolResults, textFinalAnswers: [...new Set(answers)], nativeDurationMs };
}

function normalizeCodex(events) {
  let workers = null;
  const operations = [];
  const toolResults = [];
  const answers = [];
  let primary = usage();
  let workerSequence = 0;
  for (const [eventOrdinal, event] of events.entries()) {
    const item = event.item;
    if (event.type === 'item.completed' && item) {
      const operation = codexOperation(item, event);
      if (operation) operations.push({ ...operation, eventOrdinal });
      if (typeof item.aggregated_output === 'string') {
        toolResults.push({ host: 'codex', toolUseId: item.id ?? null, eventOrdinal, content: safeLog(item.aggregated_output) });
      }
      const mcpResult = codexMcpResult(item, eventOrdinal);
      if (mcpResult) toolResults.push(mcpResult);
      if (item.type === 'agent_message') {
        const text = item.text ?? item.content;
        if (typeof text === 'string' && text) answers.push(text);
      }
    }
    if (isWorkerEvent(event) && event.usage) {
      if (workers === null) workers = [];
      workerSequence += 1;
      workers.push({ id: workerId(event, `worker-${workerSequence}`), ...codexUsage(event.usage) });
    }
    if (event.type === 'turn.completed') primary = codexUsage(event.usage);
  }
  return { usage: { primary, workers, fullCycle: null }, toolOperations: operations, toolResults, textFinalAnswers: [...new Set(answers)], nativeDurationMs: null };
}

/**
 * Normalize structured native host output. Claude's inclusive modelUsage is the sole full-cycle
 * aggregate. Codex input_tokens already includes cached dimensions, so consumers must not add them.
 */
export function normalizeKnowledgeHostTranscript(host, rawStdout) {
  const { events, malformedLineCount } = parseJsonLines(rawStdout);
  const normalized = host === 'claude' ? normalizeClaude(events) : normalizeCodex(events);
  return { ...normalized, transcript: { eventCount: events.length, malformedLineCount } };
}

function isOpaqueEvaluationIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function cleanEnvironment(base = {}, { allowIsolated = false, allowEvaluationIdentifiers = false } = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(base)) {
    if (allowEvaluationIdentifiers && REQUEST_EVALUATION_IDENTIFIER_NAMES.has(key)) {
      if (!isOpaqueEvaluationIdentifier(value)) throw new Error(`${key} must be an opaque evaluation identifier`);
      environment[key] = value;
      continue;
    }
    const allowed = (allowIsolated && ISOLATED_ENVIRONMENT_PATHS.has(key))
      || (LAUNCH_ENVIRONMENT_NAMES.has(key) && !ISOLATED_ENVIRONMENT_PATHS.has(key))
      || /^LC_[A-Z_]+$/.test(key);
    if (allowed) environment[key] = value;
  }
  return environment;
}

function hostCommand({ host, model, effort, prompt, preparedFixture, command, extraArgs = [], allowedTools }) {
  const binary = command ?? (host === 'claude' ? process.env.CLAUDE_BIN || 'claude' : process.env.CODEX_BIN || 'codex');
  if (host === 'claude') {
    return {
      command: binary,
      args: [
        ...(preparedFixture.pluginDir ? ['--plugin-dir', preparedFixture.pluginDir, '--setting-sources', 'project'] : []),
        '--strict-mcp-config',
        '--allowedTools', (allowedTools ?? ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill', 'Task']).join(','),
        '--permission-mode', 'dontAsk', '--no-session-persistence',
        '--output-format', 'stream-json', '--include-hook-events', '--verbose',
        ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
        ...extraArgs, '-p', prompt,
      ],
    };
  }
  return {
    command: binary,
    args: [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check',
      '--dangerously-bypass-hook-trust', '--sandbox', preparedFixture.isolatedGitWorkflow === true ? 'danger-full-access' : 'workspace-write',
      ...(preparedFixture.storeDir ? ['--add-dir', preparedFixture.storeDir] : []), '-c', 'approval_policy="never"',
      '-C', preparedFixture.projectDir,
      ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      ...extraArgs, prompt,
    ],
  };
}

function safeLog(value) {
  return String(value)
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]');
}

function safeStructured(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(safeLog(JSON.stringify(value)));
  } catch {
    return safeLog(value);
  }
}

async function stageCodexAuth(codexHome, authSourcePath) {
  const source = authSourcePath ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  if (!(await exists(source))) return null;
  const destination = path.join(codexHome, 'auth.json');
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  return destination;
}

function readClaudeOauthCredentials() {
  const result = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  try {
    const credentials = JSON.parse(result.stdout);
    const oauth = credentials?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') return null;
    const scopes = Array.isArray(oauth.scopes) && oauth.scopes.every((scope) => typeof scope === 'string' && scope)
      ? oauth.scopes
      : null;
    return {
      accessToken: typeof oauth.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : null,
      refreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken ? oauth.refreshToken : null,
      scopes,
    };
  } catch {
    return null;
  }
}

function readClaudeOauthToken() {
  return readClaudeOauthCredentials()?.accessToken ?? null;
}

function runChild(command, args, options, spawn) {
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let settled = false;
    let timeout;
    let force;
    const complete = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(force);
      resolveRun({ ...result, stdout, stderr, timedOut, outputLimited });
    };
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      complete({ exitCode: null, signal: null, error: error.message });
      return;
    }
    const append = (stream) => (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const remaining = options.maxOutputBytes - bytes;
      if (remaining > 0) {
        const bounded = Buffer.from(text).subarray(0, remaining).toString('utf8');
        if (stream === 'stdout') stdout += bounded;
        else stderr += bounded;
      }
      bytes += Buffer.byteLength(text);
      if (bytes > options.maxOutputBytes && !outputLimited) {
        outputLimited = true;
        child.kill?.('SIGTERM');
      }
    };
    child.stdout?.on('data', append('stdout'));
    child.stderr?.on('data', append('stderr'));
    child.on?.('error', (error) => complete({ exitCode: null, signal: null, error: error.message }));
    child.on?.('close', (exitCode, signal) => complete({ exitCode, signal, error: null }));
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill?.('SIGTERM');
      force = setTimeout(() => {
        child.kill?.('SIGKILL');
        complete({ exitCode: null, signal: 'SIGKILL', error: null });
      }, options.terminationGraceMs);
    }, options.timeoutMs);
  });
}

function validateInputs({ host, model, effort, prompt, preparedFixture, rawLogDirectory, repositoryRoot }) {
  if (!['claude', 'codex'].includes(host)) throw new Error('host must be claude or codex');
  if (typeof model !== 'string' || !model) throw new Error('model is required');
  if (typeof effort !== 'string' || !effort) throw new Error('effort is required');
  if (typeof prompt !== 'string' || !prompt) throw new Error('prompt is required');
  const projectDir = absoluteDirectory(preparedFixture?.projectDir, 'preparedFixture.projectDir');
  const noKnowledge = preparedFixture?.noKnowledge === true;
  const storeDir = noKnowledge ? optionalDirectory(preparedFixture?.storeDir ?? preparedFixture?.spectreHome, 'preparedFixture.storeDir') : absoluteDirectory(preparedFixture?.storeDir ?? preparedFixture?.spectreHome, 'preparedFixture.storeDir');
  const pluginDir = noKnowledge ? optionalDirectory(preparedFixture?.pluginDir, 'preparedFixture.pluginDir') : absoluteDirectory(preparedFixture?.pluginDir, 'preparedFixture.pluginDir');
  const rawDirectory = absoluteDirectory(rawLogDirectory, 'rawLogDirectory');
  const cellRoot = absoluteDirectory(preparedFixture?.root, 'preparedFixture.root');
  const root = path.resolve(repositoryRoot ?? process.cwd());
  if (isWithin(root, rawDirectory)) throw new Error('rawLogDirectory must be outside the checkout');
  if ([projectDir, storeDir, pluginDir].filter(Boolean).some((directory) => isWithin(root, directory))) {
    throw new Error('prepared fixture directories must be isolated outside the checkout');
  }
  const directories = [projectDir, storeDir, pluginDir].filter(Boolean);
  if (new Set(directories).size !== directories.length) throw new Error('prepared fixture directories must be distinct');
  if (isWithin(root, cellRoot)) throw new Error('preparedFixture.root must be isolated outside the checkout');
  return { projectDir, storeDir, pluginDir, noKnowledge, rawDirectory, cellRoot, repositoryRoot: root };
}

/**
 * Launch one real native Claude or Codex invocation in a caller-supplied isolated fixture.
 * Raw streams are redacted and retained only in `rawLogDirectory`; return data contains no raw streams.
 */
export async function invokeKnowledgeHost(request, dependencies = {}) {
  const { host, model, effort, prompt, preparedFixture, rawLogDirectory } = request ?? {};
  const paths = validateInputs({ ...request, host, model, effort, prompt, preparedFixture, rawLogDirectory });
  const limits = { ...DEFAULT_LIMITS, ...(request.limits ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`limits.${name} must be a positive number`);
  }
  const fixture = { ...preparedFixture, ...paths };
  fixture.codexHome = absoluteDirectory(preparedFixture.codexHome, 'preparedFixture.codexHome');
  fixture.claudeHome = absoluteDirectory(preparedFixture.claudeHome, 'preparedFixture.claudeHome');
  await mkdir(paths.rawDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([mkdir(paths.projectDir, { recursive: true }), ...[paths.storeDir, paths.pluginDir].filter(Boolean).map((directory) => mkdir(directory, { recursive: true }))]);
  await Promise.all([mkdir(fixture.codexHome, { recursive: true, mode: 0o700 }), mkdir(fixture.claudeHome, { recursive: true, mode: 0o700 })]);

  const environment = {
    ...cleanEnvironment(dependencies.baseEnvironment ?? process.env),
    ...cleanEnvironment(request.environment, { allowIsolated: true, allowEvaluationIdentifiers: true }),
    ...(paths.storeDir ? { SPECTRE_HOME: paths.storeDir } : {}),
    ...(paths.pluginDir ? { CLAUDE_PROJECT_DIR: paths.projectDir, CLAUDE_PLUGIN_ROOT: paths.pluginDir, PLUGIN_ROOT: paths.pluginDir } : {}),
  };
  environment.CLAUDE_CONFIG_DIR = fixture.claudeHome;
  environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = '';
  environment.CODEX_HOME = fixture.codexHome;
  environment.HOME ??= fixture.claudeHome;
  environment.ZDOTDIR ??= fixture.claudeHome;
  environment.TMPDIR ??= fixture.claudeHome;
  environment.TMP ??= fixture.claudeHome;
  environment.TEMP ??= fixture.claudeHome;
  environment.XDG_RUNTIME_DIR ??= environment.TMPDIR;
  environment.BUN_TMPDIR ??= environment.TMPDIR;
  environment.CLAUDE_CODE_TMPDIR ??= environment.TMPDIR;
  environment.CLAUDE_TMPDIR ??= environment.TMPDIR;
  const developer = developerToolchain();
  environment.DEVELOPER_DIR = developer.developerRoot;
  prependDeveloperTools(environment, developer.toolBin);
  const native = hostCommand({ host, model, effort, prompt, preparedFixture: fixture, command: request.command, extraArgs: request.extraArgs, allowedTools: request.allowedTools });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let stagedAuth = null;
  let claudeOauthStaged = false;
  let claudeRefreshStaged = false;
  let claudeAuthentication = null;
  let processResult;
  let cleanup = { stagedAuth: 'not-staged' };
  try {
    stagedAuth = await stageCodexAuth(fixture.codexHome, request.authSourcePath);
    if (host === 'claude' && preparedFixture.claudeRefreshBootstrapped !== true) {
      const readOauthCredentials = dependencies.readClaudeOauthCredentials ?? (dependencies.spawn ? null : readClaudeOauthCredentials);
      const oauthCredentials = readOauthCredentials?.();
      if (typeof oauthCredentials?.accessToken === 'string' && oauthCredentials.accessToken) {
        environment.CLAUDE_CODE_OAUTH_TOKEN = oauthCredentials.accessToken;
        claudeOauthStaged = true;
      } else if (oauthCredentials?.refreshToken && oauthCredentials.scopes?.length) {
        environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = oauthCredentials.refreshToken;
        environment.CLAUDE_CODE_OAUTH_SCOPES = oauthCredentials.scopes.join(' ');
        claudeOauthStaged = true;
        claudeRefreshStaged = true;
      } else {
        const readOauthToken = dependencies.readClaudeOauthToken ?? (dependencies.spawn ? null : readClaudeOauthToken);
        const oauthToken = readOauthToken?.();
        if (typeof oauthToken === 'string' && oauthToken) {
          environment.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
          claudeOauthStaged = true;
        }
      }
    }
    let sandbox = sandboxForInvocation({
      preparedFixture: fixture,
      native,
      environment,
      sandboxExecutable: dependencies.sandboxExecutable,
    });
    fixture.filesystemBoundary = sandbox;
    if (claudeRefreshStaged) {
      const authenticationNative = { command: native.command, args: ['auth', 'login'] };
      const authenticationSandbox = sandboxForInvocation({
        preparedFixture: fixture,
        native: authenticationNative,
        environment,
        sandboxExecutable: dependencies.sandboxExecutable,
      });
      const authenticationResult = await runChild(authenticationSandbox.command, authenticationSandbox.args, {
        cwd: paths.projectDir, env: { ...environment }, timeoutMs: limits.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes, terminationGraceMs: limits.terminationGraceMs,
      }, dependencies.spawn ?? nativeSpawn);
      claudeAuthentication = {
        strategy: 'refresh-token',
        status: authenticationResult.timedOut ? 'timed_out'
          : authenticationResult.outputLimited ? 'output_limited'
            : authenticationResult.error ? 'launch_failed'
              : authenticationResult.exitCode === 0 ? 'completed' : 'failed',
      };
      if (claudeAuthentication.status !== 'completed') {
        processResult = authenticationResult;
      } else {
        preparedFixture.claudeRefreshBootstrapped = true;
        delete environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
        delete environment.CLAUDE_CODE_OAUTH_SCOPES;
        sandbox = sandboxForInvocation({
          preparedFixture: fixture,
          native,
          environment,
          sandboxExecutable: dependencies.sandboxExecutable,
        });
        fixture.filesystemBoundary = sandbox;
      }
    }
    if (!processResult) processResult = await runChild(sandbox.command, sandbox.args, {
      cwd: paths.projectDir, env: { ...environment }, timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes, terminationGraceMs: limits.terminationGraceMs,
    }, dependencies.spawn ?? nativeSpawn);
  } catch (error) {
    processResult = {
      exitCode: null, signal: null, timedOut: false, outputLimited: false,
      error: error instanceof Error ? error.message : String(error), stdout: '', stderr: '',
    };
  } finally {
    if (claudeOauthStaged) {
      delete environment.CLAUDE_CODE_OAUTH_TOKEN;
      delete environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
      delete environment.CLAUDE_CODE_OAUTH_SCOPES;
      cleanup = { ...cleanup, claudeOauth: 'cleared' };
    }
    if (stagedAuth) {
      try {
        await (dependencies.removeFile ?? rm)(stagedAuth, { force: true });
        cleanup = { ...cleanup, stagedAuth: 'removed' };
      } catch {
        cleanup = { ...cleanup, stagedAuth: 'cleanup-failed' };
      }
    }
  }
  const stdoutPath = path.join(paths.rawDirectory, `${host}.stdout.jsonl`);
  const stderrPath = path.join(paths.rawDirectory, `${host}.stderr.log`);
  await Promise.all([
    writeFile(stdoutPath, safeLog(processResult?.stdout ?? ''), { mode: 0o600 }),
    writeFile(stderrPath, safeLog(processResult?.stderr ?? ''), { mode: 0o600 }),
  ]);
  const normalized = normalizeKnowledgeHostTranscript(host, processResult?.stdout ?? '');
  const boundaryDiagnostic = [
    processResult?.stderr ?? '',
    ...normalized.toolResults.map((result) => result.content ?? ''),
  ].join('\n');
  const status = processResult.timedOut ? 'timed_out'
    : processResult.outputLimited ? 'output_limited'
      : processResult.error ? 'launch_failed'
        : processResult.exitCode === 0 ? 'completed' : 'failed';
  return {
    status,
    exit: {
      exitCode: processResult.exitCode, signal: processResult.signal,
      timedOut: processResult.timedOut, outputLimited: processResult.outputLimited,
      error: processResult.error,
    },
    usage: normalized.usage,
    toolOperations: normalized.toolOperations,
    toolResults: normalized.toolResults,
    textFinalAnswers: normalized.textFinalAnswers,
    transcript: normalized.transcript,
    traceUnavailable: /SPECTRE_EVALUATION_TRACE_UNAVAILABLE\b/.test(processResult?.stderr ?? ''),
    timing: { startedAt, endedAt: new Date().toISOString(), wallDurationMs: performance.now() - started, nativeDurationMs: normalized.nativeDurationMs },
    rawLogs: { stdoutPath, stderrPath },
    authentication: claudeAuthentication,
    cleanup,
    isolation: {
      projectDir: paths.projectDir, storeDir: paths.storeDir, pluginDir: paths.pluginDir,
      claudeHome: fixture.claudeHome, codexHome: fixture.codexHome,
      freshStore: preparedFixture.freshStore ?? null, isolated: true,
      codexSandbox: host === 'codex' ? (preparedFixture.isolatedGitWorkflow === true ? 'danger-full-access' : 'workspace-write') : null,
      rawLogsOutsideCheckout: !isWithin(paths.repositoryRoot, paths.rawDirectory),
      filesystemBoundary: fixture.filesystemBoundary
        ? {
          enabled: true,
          mode: fixture.filesystemBoundary.mode,
          profileHash: fixture.filesystemBoundary.profileHash,
          allowedPaths: fixture.filesystemBoundary.allowedPaths,
          cellPaths: fixture.filesystemBoundary.cellPaths,
          providerExecutables: fixture.filesystemBoundary.providerExecutables,
          runtimeExceptions: fixture.filesystemBoundary.runtimeExceptions,
          networkPolicy: fixture.filesystemBoundary.networkPolicy,
          cellOnlyWrites: fixture.filesystemBoundary.runtimeExceptions.length === 0,
          deniedAttemptsObserved: /Operation not permitted|Sandbox: deny/i.test(boundaryDiagnostic),
        }
        : { enabled: false, reason: 'sandbox-unavailable' },
    },
  };
}

export { hostCommand };
