import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createKnowledgeEvaluationSandbox, invokeKnowledgeHost, normalizeKnowledgeHostTranscript } from './knowledge-evaluation-hosts.mjs';

function childFor({ stdout = '', stderr = '', exitCode = 0, signal = null, delay = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    signal = 'SIGTERM';
    exitCode = null;
  };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    setTimeout(() => child.emit('close', exitCode, signal), delay);
  });
  return child;
}

async function fixture(host) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `knowledge-host-${host}-`));
  const value = {
    root,
    projectDir: path.join(root, 'project'),
    storeDir: path.join(root, 'store'),
    pluginDir: path.join(root, 'plugin'),
    freshStore: true,
    codexHome: path.join(root, 'codex'),
    claudeHome: path.join(root, 'claude'),
  };
  await Promise.all(Object.values(value).filter((directory) => typeof directory === 'string').map((directory) => fs.mkdir(directory, { recursive: true })));
  const rawLogDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `knowledge-host-raw-${host}-`));
  return { root, value, rawLogDirectory };
}

test('Claude transcript preserves primary and worker native usage, tools, and final text', async () => {
  const setup = await fixture('claude');
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/fixture/record.json' } },
      { type: 'text', text: 'I read the record.' },
    ] } }),
    JSON.stringify({ type: 'assistant', is_sidechain: true, worker_id: 'worker-a', message: { usage: { input_tokens: 9, output_tokens: 4 }, content: [
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'node probe.mjs' } },
    ] } }),
    JSON.stringify({ type: 'result', duration_ms: 123, result: 'Claude final answer', usage: {
      input_tokens: 101, cache_read_input_tokens: 7, cache_creation_input_tokens: 2, output_tokens: 13,
      aggregated_output: 'loaded record-id',
    } }),
  ].join('\n');
  const result = await invokeKnowledgeHost({
    host: 'claude', model: 'opus', effort: 'medium', prompt: 'use fixture',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
  }, { spawn: () => childFor({ stdout }) });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage.primary, {
    input: 101, cache: 7, cacheWrite: 2, output: 13, reasoning: null,
  });
  assert.equal(result.usage.fullCycle, null);
  assert.deepEqual(result.usage.workers, [{
    id: 'worker-a', input: 9, cache: null, cacheWrite: null, output: 4, reasoning: null,
  }]);
  assert.equal(result.toolOperations.length, 2);
  assert.deepEqual(result.toolOperations.map((operation) => operation.name), ['Read', 'Bash']);
  assert.ok(result.textFinalAnswers.includes('Claude final answer'));
  assert.equal(result.timing.nativeDurationMs, 123);
  assert.equal(result.isolation.freshStore, true);
});

test('Claude model totals are the only full-cycle aggregate and duplicate worker messages do not inflate it', () => {
  const transcript = normalizeKnowledgeHostTranscript('claude', [
    JSON.stringify({ type: 'assistant', is_sidechain: true, worker_id: 'worker-a', message: { id: 'same-step', usage: { input_tokens: 9, output_tokens: 999 } } }),
    JSON.stringify({ type: 'assistant', is_sidechain: true, worker_id: 'worker-a', message: { id: 'same-step', usage: { input_tokens: 9, output_tokens: 999 } } }),
    JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 4 }, modelUsage: {
      'claude-test': { inputTokens: 12, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, outputTokens: 8 },
    } }),
  ].join('\n'));
  assert.deepEqual(transcript.usage.primary, { input: 10, cache: null, cacheWrite: null, output: 4, reasoning: null });
  assert.equal(transcript.usage.workers.length, 1);
  assert.deepEqual(transcript.usage.fullCycle, {
    source: 'result.modelUsage',
    models: [{ model: 'claude-test', input: 12, cache: 3, cacheWrite: 2, output: 8, reasoning: null }],
    total: { input: 12, cache: 3, cacheWrite: 2, output: 8, reasoning: null },
  });
});

test('Claude preserves parent tool linkage without treating a bare agent id as worker proof', () => {
  const transcript = normalizeKnowledgeHostTranscript('claude', [
    JSON.stringify({ type: 'assistant', agent_id: 'root-agent', message: { content: [{ type: 'tool_use', id: 'primary-read', name: 'Read', input: {} }] } }),
    JSON.stringify({ type: 'assistant', agent_id: 'child-agent', parent_tool_use_id: 'task-1', message: { content: [{ type: 'tool_use', id: 'child-read', name: 'Read', input: {} }] } }),
  ].join('\n'));
  assert.deepEqual(transcript.toolOperations.map(({ id, actorRole, actorId, parentToolUseId }) => ({ id, actorRole, actorId, parentToolUseId })), [
    { id: 'primary-read', actorRole: 'primary', actorId: 'root-agent', parentToolUseId: null },
    { id: 'child-read', actorRole: 'worker', actorId: 'child-agent', parentToolUseId: 'task-1' },
  ]);
});

test('Codex transcript reports command timing without inventing omitted usage fields', async () => {
  const setup = await fixture('codex');
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution', id: 'exec-1', command: 'cat record.json', status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:00.025Z', duration_ms: 25,
      aggregated_output: 'loaded record-id',
    } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex final answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 22, output_tokens: 6 } }),
  ].join('\n');
  const result = await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'high', prompt: 'use fixture',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
  }, { spawn: () => childFor({ stdout }) });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage.primary, {
    input: 22, cache: null, cacheWrite: null, output: 6, reasoning: null,
  });
  assert.equal(result.usage.workers, null);
  assert.equal(result.usage.fullCycle, null);
  assert.deepEqual(result.toolOperations[0], {
    id: 'exec-1', host: 'codex', name: 'exec', type: 'command_execution',
    input: { command: 'cat record.json' }, status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.025Z', durationMs: 25,
    actorRole: 'primary', actorId: null, parentToolUseId: null, eventOrdinal: 0,
  });
  assert.deepEqual(result.toolResults, [{ host: 'codex', toolUseId: 'exec-1', eventOrdinal: 0, content: 'loaded record-id' }]);
  assert.deepEqual(result.textFinalAnswers, ['Codex final answer']);
});

test('Codex transcript preserves MCP results and web action metadata without inventing web results', () => {
  const transcript = normalizeKnowledgeHostTranscript('codex', [
    JSON.stringify({ type: 'item.completed', item: {
      type: 'mcp_tool_call', id: 'mcp-1', server: 'codex_apps', tool: 'github.search_repositories',
      arguments: { query: 'acquired-deploy', topn: 20 }, status: 'failed',
      result: {
        content: [{ type: 'text', text: 'connector returned a partial result' }],
        structured_content: { repositories: [{ id: 'repo-1' }], error_code: 'PARTIAL' },
        _meta: { source: 'connector' },
      },
      error: { code: 'UPSTREAM_PARTIAL', message: 'partial result' },
    } }),
    JSON.stringify({ type: 'item.completed', item: {
      type: 'web_search', id: 'web-1', query: 'Codex project instructions',
      action: { type: 'search', query: 'Codex project instructions' }, status: 'completed',
    } }),
  ].join('\n'));

  assert.deepEqual(transcript.toolOperations, [
    {
      id: 'mcp-1', host: 'codex', name: 'github.search_repositories', type: 'mcp_tool_call',
      input: { server: 'codex_apps', tool: 'github.search_repositories', arguments: { query: 'acquired-deploy', topn: 20 } },
      status: 'failed', startedAt: null, endedAt: null, durationMs: null,
      actorRole: 'primary', actorId: null, parentToolUseId: null,
      externalTool: { kind: 'mcp', server: 'codex_apps', tool: 'github.search_repositories' }, eventOrdinal: 0,
    },
    {
      id: 'web-1', host: 'codex', name: 'web_search', type: 'web_search',
      input: { query: 'Codex project instructions', action: { type: 'search', query: 'Codex project instructions' } },
      status: 'completed', startedAt: null, endedAt: null, durationMs: null,
      actorRole: 'primary', actorId: null, parentToolUseId: null,
      externalTool: { kind: 'web', query: 'Codex project instructions', action: { type: 'search', query: 'Codex project instructions' } }, eventOrdinal: 1,
    },
  ]);
  assert.deepEqual(transcript.toolResults, [{
    host: 'codex', toolUseId: 'mcp-1', eventOrdinal: 0,
    type: 'mcp_tool_call', server: 'codex_apps', tool: 'github.search_repositories', status: 'failed',
    content: '[{"type":"text","text":"connector returned a partial result"}]',
    structuredContent: { repositories: [{ id: 'repo-1' }], error_code: 'PARTIAL' },
    error: { code: 'UPSTREAM_PARTIAL', message: 'partial result' },
    result: {
      content: [{ type: 'text', text: 'connector returned a partial result' }],
      structured_content: { repositories: [{ id: 'repo-1' }], error_code: 'PARTIAL' },
      _meta: { source: 'connector' },
    },
    isError: true,
  }]);
});

test('nonzero host exits retain normalized evidence and remove staged Codex auth in finally', async () => {
  const setup = await fixture('codex');
  const authSource = path.join(setup.root, 'source-auth.json');
  await fs.writeFile(authSource, JSON.stringify({ token: 'do-not-return-this' }));
  const result = await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'use fixture',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory, authSourcePath: authSource,
  }, { spawn: () => childFor({ stdout: JSON.stringify({ type: 'turn.completed', usage: {} }), stderr: 'exit failure', exitCode: 7 }) });

  assert.equal(result.status, 'failed');
  assert.equal(result.exit.exitCode, 7);
  assert.equal(result.usage.primary.input, null);
  assert.equal(await fs.stat(path.join(setup.value.codexHome, 'auth.json')).then(() => true, () => false), false);
  assert.equal(JSON.stringify(result).includes('do-not-return-this'), false);
});

test('cleanup failure is reported without losing a completed host result', async () => {
  const setup = await fixture('codex');
  const authSource = path.join(setup.root, 'source-auth.json');
  await fs.writeFile(authSource, '{}');
  const result = await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'use fixture',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory, authSourcePath: authSource,
  }, {
    spawn: () => childFor({ stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) }),
    removeFile: async () => { throw new Error('cleanup denied'); },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.cleanup, { stagedAuth: 'cleanup-failed' });
});

test('configured timeout terminates a host and still writes bounded external logs', async () => {
  const setup = await fixture('claude');
  const result = await invokeKnowledgeHost({
    host: 'claude', model: 'opus', effort: 'medium', prompt: 'use fixture',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
    limits: { timeoutMs: 5, terminationGraceMs: 1, maxOutputBytes: 1024 },
  }, { spawn: () => childFor({ stdout: '{"type":"assistant"}', delay: 50 }) });

  assert.equal(result.status, 'timed_out');
  assert.equal(result.exit.timedOut, true);
  assert.equal(await fs.readFile(result.rawLogs.stdoutPath, 'utf8'), '{"type":"assistant"}');
});

test('rejects raw host logs inside the checkout before launching a host', async () => {
  const setup = await fixture('claude');
  let launched = false;
  await assert.rejects(() => invokeKnowledgeHost({
    host: 'claude', model: 'opus', effort: 'medium', prompt: 'use fixture',
    preparedFixture: setup.value, rawLogDirectory: path.join(process.cwd(), 'raw-host-logs'),
    repositoryRoot: process.cwd(),
  }, { spawn: () => { launched = true; return childFor({}); } }), /outside the checkout/);
  assert.equal(launched, false);
});

test('no-knowledge invocation omits plugin and store arguments while retaining the isolated project', async () => {
  const setup = await fixture('codex');
  let launched;
  await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'ordinary task',
    preparedFixture: { root: setup.root, projectDir: setup.value.projectDir, codexHome: setup.value.codexHome, claudeHome: setup.value.claudeHome, freshStore: true, noKnowledge: true },
    rawLogDirectory: setup.rawLogDirectory,
  }, { spawn: (command, args) => { launched = { command, args }; return childFor({ stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) }); } });
  assert.equal(launched.args.includes('--add-dir'), false);
  assert.equal(launched.args.includes(setup.value.storeDir), false);
});

test('wraps every host launch in a fail-closed per-cell filesystem sandbox', async () => {
  const setup = await fixture('codex');
  let launched;
  const result = await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'ordinary task',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
  }, {
    sandboxExecutable: '/usr/bin/true',
    spawn: (command, args) => {
      launched = { command, args };
      return childFor({ stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) });
    },
  });
  assert.equal(launched.command, '/usr/bin/true');
  assert.equal(launched.args[0], '-p');
  assert.match(launched.args[1], /\(import "system\.sb"\)/);
  assert.match(launched.args[1], /\(allow file-write\*/);
  assert.equal(launched.args.some((entry) => path.basename(entry) === 'codex'), true);
  assert.equal(result.isolation.filesystemBoundary.enabled, true);
  assert.match(result.isolation.filesystemBoundary.profileHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(result.isolation.filesystemBoundary.allowedPaths.includes(setup.root));
  assert.deepEqual(result.isolation.filesystemBoundary.runtimeExceptions, [{
    kind: 'xcrun-cache', pathPattern: `${fsSync.realpathSync.native(os.tmpdir())}/xcrun_db(-[A-Za-z0-9]+)?`, access: 'read-write',
  }]);
  assert.deepEqual(result.isolation.filesystemBoundary.networkPolicy, {
    outbound: 'tcp-udp-443-and-mdns', loopback: 'denied', unixSockets: ['mDNSResponder'],
    residual: 'non-loopback private addresses on port 443 are not distinguishable by Seatbelt',
  });
  assert.equal(result.isolation.filesystemBoundary.cellOnlyWrites, false);
});

test('fails closed without a usable filesystem boundary before launching a host', async () => {
  const setup = await fixture('codex');
  let launched = false;
  const result = await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'ordinary task',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
  }, {
    sandboxExecutable: '/missing-evaluation-sandbox-exec',
    spawn: () => { launched = true; return childFor({}); },
  });
  assert.equal(result.status, 'launch_failed');
  assert.match(result.exit.error, /filesystem boundary is unavailable/);
  assert.equal(result.isolation.filesystemBoundary.enabled, false);
  assert.equal(launched, false);
});

test('records a sandbox denial reported by a native tool result', async () => {
  const setup = await fixture('codex');
  const result = await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'ordinary task',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
  }, {
    sandboxExecutable: '/usr/bin/true',
    spawn: () => childFor({ stdout: JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution', id: 'denied-read', command: 'cat /outside/record.json', status: 'failed',
      aggregated_output: 'cat: /outside/record.json: Operation not permitted',
    } }) }),
  });
  assert.equal(result.isolation.filesystemBoundary.deniedAttemptsObserved, true);
});

test('rejects a cell-visible raw log or environment path before launching a host', async () => {
  const setup = await fixture('claude');
  let launched = false;
  const base = {
    host: 'claude', model: 'opus', effort: 'medium', prompt: 'ordinary task',
    preparedFixture: setup.value,
  };
  const dependencies = { spawn: () => { launched = true; return childFor({}); } };
  const rawInsideCell = await invokeKnowledgeHost({ ...base, rawLogDirectory: path.join(setup.root, 'raw') }, dependencies);
  assert.equal(rawInsideCell.status, 'launch_failed');
  assert.match(rawInsideCell.exit.error, /rawLogDirectory must be outside every filesystem boundary/);
  const externalHome = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-host-external-home-'));
  const escapedEnvironment = await invokeKnowledgeHost({
    ...base, rawLogDirectory: setup.rawLogDirectory, environment: { HOME: externalHome },
  }, dependencies);
  assert.equal(escapedEnvironment.status, 'launch_failed');
  assert.match(escapedEnvironment.exit.error, /environment HOME escapes its cell root/);
  assert.equal(launched, false);
  await fs.rm(externalHome, { recursive: true, force: true });
});

test('default-deny boundary permits one cell, declared toolchain cache, and both host runtimes without a model invocation', async (t) => {
  const setup = await fixture('codex');
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-host-external-'));
  t.after(async () => Promise.all([fs.rm(setup.root, { recursive: true, force: true }), fs.rm(setup.rawLogDirectory, { recursive: true, force: true }), fs.rm(externalRoot, { recursive: true, force: true })]));
  const allowed = path.join(setup.value.projectDir, 'allowed.txt');
  const written = path.join(setup.value.projectDir, 'written.txt');
  const external = path.join(externalRoot, 'oracle.txt');
  const otherTemp = path.join(os.tmpdir(), `knowledge-host-unrelated-${process.pid}.txt`);
  const userGitConfig = path.join(os.homedir(), '.gitconfig');
  const escaped = path.join(setup.value.projectDir, 'outside');
  const probe = path.join(setup.value.projectDir, 'child-probe.mjs');
  await fs.writeFile(allowed, 'allowed');
  await fs.writeFile(external, 'external');
  await fs.writeFile(otherTemp, 'unrelated');
  t.after(() => fs.rm(otherTemp, { force: true }));
  const initialized = spawnSync('git', ['init', setup.value.projectDir], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  await fs.access(userGitConfig);
  await fs.symlink(externalRoot, escaped);
  await fs.writeFile(probe, [
    "import fs from 'node:fs';",
    "const [allowedPath, outputPath, deniedPath] = process.argv.slice(2);",
    "if (fs.readFileSync(allowedPath, 'utf8') !== 'allowed') process.exit(2);",
    "fs.writeFileSync(outputPath, 'child write');",
    "try { fs.readFileSync(deniedPath); process.exit(3); } catch { process.exit(0); }",
  ].join('\n'));
  const environment = {
    PATH: process.env.PATH,
    HOME: setup.value.claudeHome,
    ZDOTDIR: setup.value.claudeHome,
    TMPDIR: setup.value.claudeHome,
    TMP: setup.value.claudeHome,
    TEMP: setup.value.claudeHome,
    XDG_RUNTIME_DIR: setup.value.claudeHome,
    BUN_TMPDIR: setup.value.claudeHome,
    CLAUDE_CODE_TMPDIR: setup.value.claudeHome,
    CLAUDE_TMPDIR: setup.value.claudeHome,
    DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
    CODEX_HOME: setup.value.codexHome,
    CLAUDE_CONFIG_DIR: setup.value.claudeHome,
  };
  const shell = createKnowledgeEvaluationSandbox({
    preparedFixture: { ...setup.value, rawDirectory: setup.rawLogDirectory }, command: '/bin/sh', environment,
  });
  const shellScript = [
    `test "$(cat ${JSON.stringify(allowed)})" = allowed`,
    `printf shell-write > ${JSON.stringify(written)}`,
    `! cat ${JSON.stringify(external)} >/dev/null 2>&1`,
    `! cat ${JSON.stringify(path.join(escaped, 'oracle.txt'))} >/dev/null 2>&1`,
    `! cat ${JSON.stringify(userGitConfig)} >/dev/null 2>&1`,
    `! cat ${JSON.stringify(otherTemp)} >/dev/null 2>&1`,
    'git -C . status --porcelain=v1',
    'python3 --version',
    `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} ${JSON.stringify(allowed)} ${JSON.stringify(path.join(setup.value.projectDir, 'child-write.txt'))} ${JSON.stringify(external)}`,
  ].join('; ');
  const shellResult = spawnSync(shell.command, [...shell.args, '-c', shellScript], {
    cwd: setup.value.projectDir, env: environment, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(shellResult.status, 0, shellResult.stderr);
  assert.equal(shellResult.stderr, '');
  assert.equal(await fs.readFile(written, 'utf8'), 'shell-write');
  assert.equal(await fs.readFile(path.join(setup.value.projectDir, 'child-write.txt'), 'utf8'), 'child write');
  await fs.rm(otherTemp, { force: true });
  for (const provider of ['codex', 'claude']) {
    const boundary = createKnowledgeEvaluationSandbox({
      preparedFixture: { ...setup.value, rawDirectory: setup.rawLogDirectory }, command: provider, environment,
    });
    const version = spawnSync(boundary.command, [...boundary.args, '--version'], {
      cwd: setup.value.projectDir, env: environment, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(version.status, 0, `${provider}: ${version.stderr}`);
  }
  const claudeStatus = createKnowledgeEvaluationSandbox({
    preparedFixture: { ...setup.value, rawDirectory: setup.rawLogDirectory }, command: 'claude', environment,
  });
  const authStatus = spawnSync(claudeStatus.command, [...claudeStatus.args, 'auth', 'status'], {
    cwd: setup.value.projectDir, env: environment, encoding: 'utf8', timeout: 30_000,
  });
  assert.doesNotMatch(authStatus.stderr, /EEXIST: file already exists, mkdir '\/tmp\/claude-/);
});

test('Codex permits git metadata writes only for an attested isolated fixture', async () => {
  const setup = await fixture('codex');
  let launched;
  const result = await invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'complete the local workflow',
    preparedFixture: { ...setup.value, isolatedGitWorkflow: true }, rawLogDirectory: setup.rawLogDirectory,
  }, { spawn: (_command, args) => { launched = args; return childFor({ stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) }); } });
  const sandbox = launched.indexOf('--sandbox');
  assert.equal(launched[sandbox + 1], 'danger-full-access');
  assert.equal(result.isolation.codexSandbox, 'danger-full-access');
});

test('Claude launch rejects implicit MCP sources while retaining its staged plugin', async () => {
  const setup = await fixture('claude');
  let launched;
  await invokeKnowledgeHost({
    host: 'claude', model: 'opus', effort: 'medium', prompt: 'ordinary task',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
  }, {
    spawn: (_command, args) => {
      launched = args;
      return childFor({ stdout: JSON.stringify({ type: 'result', usage: {} }) });
    },
  });
  assert.equal(launched.includes('--strict-mcp-config'), true);
  assert.equal(launched.includes('--plugin-dir'), true);
  assert.equal(launched.includes(setup.value.pluginDir), true);
});

test('default-deny host boundary blocks loopback and external Unix services', async (t) => {
  const setup = await fixture('codex');
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-host-network-'));
  t.after(async () => {
    await fs.rm(externalRoot, { recursive: true, force: true });
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.rawLogDirectory, { recursive: true, force: true });
  });
  const environment = {
    PATH: process.env.PATH,
    HOME: setup.value.claudeHome, ZDOTDIR: setup.value.claudeHome,
    TMPDIR: setup.value.claudeHome, TMP: setup.value.claudeHome, TEMP: setup.value.claudeHome,
    XDG_RUNTIME_DIR: setup.value.claudeHome, BUN_TMPDIR: setup.value.claudeHome,
    CLAUDE_CODE_TMPDIR: setup.value.claudeHome, CLAUDE_TMPDIR: setup.value.claudeHome,
    DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
    CODEX_HOME: setup.value.codexHome, CLAUDE_CONFIG_DIR: setup.value.claudeHome,
  };
  const httpServer = http.createServer((_request, response) => response.end('loopback service'));
  await new Promise((resolve, reject) => httpServer.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => httpServer.close());
  const port = httpServer.address().port;
  const curlSandbox = createKnowledgeEvaluationSandbox({
    preparedFixture: { ...setup.value, rawDirectory: setup.rawLogDirectory }, command: '/usr/bin/curl', environment,
  });
  for (const host of ['127.0.0.1', 'localhost']) {
    const result = spawnSync(curlSandbox.command, [
      ...curlSandbox.args, '--noproxy', '*', '--connect-timeout', '1', '-sS', `http://${host}:${port}`,
    ], { cwd: setup.value.projectDir, env: environment, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${host} unexpectedly reached loopback: ${result.stdout}`);
  }
  const ipv6Server = http.createServer((_request, response) => response.end('loopback service'));
  try {
    await new Promise((resolve, reject) => ipv6Server.once('error', reject).listen(0, '::', resolve));
    t.after(() => ipv6Server.close());
    const ipv6Port = ipv6Server.address().port;
    for (const host of ['[::1]', '[::ffff:127.0.0.1]']) {
      const result = spawnSync(curlSandbox.command, [
        ...curlSandbox.args, '--noproxy', '*', '--connect-timeout', '1', '-sS', `http://${host}:${ipv6Port}`,
      ], { cwd: setup.value.projectDir, env: environment, encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${host} unexpectedly reached loopback: ${result.stdout}`);
    }
  } catch (error) {
    ipv6Server.close();
    assert.match(String(error), /EADDRNOTAVAIL|EAFNOSUPPORT/);
  }
  const unixPath = path.join(externalRoot, 'service.sock');
  const unixServer = net.createServer(socket => socket.end('external service'));
  await new Promise((resolve, reject) => unixServer.once('error', reject).listen(unixPath, resolve));
  t.after(() => unixServer.close());
  const nodeSandbox = createKnowledgeEvaluationSandbox({
    preparedFixture: { ...setup.value, rawDirectory: setup.rawLogDirectory }, command: process.execPath, environment,
  });
  const webSocket = spawnSync(nodeSandbox.command, [
    ...nodeSandbox.args, '-e', `const socket = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}`)}); socket.addEventListener('open', () => process.exit(2)); socket.addEventListener('error', () => process.exit(0)); setTimeout(() => process.exit(3), 1000);`,
  ], { cwd: setup.value.projectDir, env: environment, encoding: 'utf8', timeout: 5_000 });
  assert.equal(webSocket.status, 0, webSocket.stderr);
  const unix = spawnSync(nodeSandbox.command, [
    ...nodeSandbox.args, '-e', `const socket = require('node:net').createConnection(${JSON.stringify(unixPath)}); socket.on('connect', () => process.exit(2)); socket.on('error', () => process.exit(0)); setTimeout(() => process.exit(3), 1000);`,
  ], { cwd: setup.value.projectDir, env: environment, encoding: 'utf8', timeout: 5_000 });
  assert.equal(unix.status, 0, unix.stderr);
  assert.deepEqual(curlSandbox.networkPolicy, {
    outbound: 'tcp-udp-443-and-mdns', loopback: 'denied', unixSockets: ['mDNSResponder'],
    residual: 'non-loopback private addresses on port 443 are not distinguishable by Seatbelt',
  });
});

test('every host invocation receives isolated homes, removes staged Codex auth, and clears Claude OAuth', async () => {
  for (const host of ['claude', 'codex']) {
    const setup = await fixture(host);
    const authSource = path.join(setup.root, 'source-auth.json');
    await fs.writeFile(authSource, '{}');
    let environment;
    const oauthToken = `fixture-claude-oauth-token-${host}`;
    const result = await invokeKnowledgeHost({
      host, model: host === 'claude' ? 'opus' : 'gpt-test', effort: 'medium', prompt: 'workflow task',
      preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory, authSourcePath: authSource,
      environment: {
        GROVE_CDP_PORT: '9222', SUBSPACE_SESSION_TOKEN: 'fixture-subspace-token', BROWSER_WS_ENDPOINT: 'ws://127.0.0.1:9222',
        SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID: `evaluation-actor-${host}`,
        SPECTRE_KNOWLEDGE_EVALUATION_CONTEXT_ID: `evaluation-context-${host}`,
      },
    }, {
      baseEnvironment: {
        ...process.env, MCP_CONFIG_PATH: '/live-user/mcp.json', GROVE_CDP_PORT: '9222', SUBSPACE_SESSION_TOKEN: 'fixture-subspace-token',
        SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID: 'inherited-actor', SPECTRE_KNOWLEDGE_EVALUATION_CONTEXT_ID: 'inherited-context',
      },
      readClaudeOauthToken: () => oauthToken,
      spawn: (_command, _args, options) => { environment = options.env; return childFor({ stdout: JSON.stringify({ type: 'result', usage: {} }) }); },
    });
    assert.equal(environment.CODEX_HOME, setup.value.codexHome);
    assert.equal(environment.CLAUDE_CONFIG_DIR, setup.value.claudeHome);
    assert.equal(environment.CLAUDE_SECURESTORAGE_CONFIG_DIR, '');
    assert.equal(environment.CLAUDE_CODE_TMPDIR, setup.value.claudeHome);
    assert.equal(environment.CLAUDE_TMPDIR, setup.value.claudeHome);
    assert.equal(environment.XDG_RUNTIME_DIR, setup.value.claudeHome);
    assert.equal(environment.BUN_TMPDIR, setup.value.claudeHome);
    assert.equal(environment.DEVELOPER_DIR, '/Library/Developer/CommandLineTools');
    assert.match(environment.PATH, /\/Library\/Developer\/CommandLineTools\/usr\/bin/);
    assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, host === 'claude' ? oauthToken : undefined);
    assert.equal(environment.MCP_CONFIG_PATH, undefined);
    assert.equal(environment.GROVE_CDP_PORT, undefined);
    assert.equal(environment.SUBSPACE_SESSION_TOKEN, undefined);
    assert.equal(environment.BROWSER_WS_ENDPOINT, undefined);
    assert.equal(environment.SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID, `evaluation-actor-${host}`);
    assert.equal(environment.SPECTRE_KNOWLEDGE_EVALUATION_CONTEXT_ID, `evaluation-context-${host}`);
    assert.deepEqual({ claudeHome: result.isolation.claudeHome, codexHome: result.isolation.codexHome }, { claudeHome: setup.value.claudeHome, codexHome: setup.value.codexHome });
    assert.equal(await fs.stat(path.join(setup.value.codexHome, 'auth.json')).then(() => true, () => false), false);
    assert.equal(result.cleanup.claudeOauth, host === 'claude' ? 'cleared' : undefined);
    assert.equal(JSON.stringify(result).includes(oauthToken), false);
  }
});

test('Claude refresh credentials are staged ephemerally instead of a possibly expired access token', async () => {
  const setup = await fixture('claude');
  const refreshToken = 'fixture-claude-oauth-refresh-token';
  let environment;
  const environments = [];
  const calls = [];
  try {
    const result = await invokeKnowledgeHost({
      host: 'claude', model: 'opus', effort: 'medium', prompt: 'workflow task',
      preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
    }, {
      readClaudeOauthCredentials: () => ({
        accessToken: null,
        refreshToken,
        scopes: ['user:inference', 'user:profile'],
      }),
      spawn: (_command, _args, options) => {
        environment = options.env;
        environments.push(options.env);
        calls.push(_args);
        return childFor({ stdout: JSON.stringify({ type: 'result', usage: {} }) });
      },
    });
    assert.equal(environments[0].CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(environments[0].CLAUDE_CODE_OAUTH_REFRESH_TOKEN, refreshToken);
    assert.equal(environments[0].CLAUDE_CODE_OAUTH_SCOPES, 'user:inference user:profile');
    assert.equal(environments[1].CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined);
    assert.equal(environments[1].CLAUDE_CODE_OAUTH_SCOPES, undefined);
    assert.equal(result.cleanup.claudeOauth, 'cleared');
    assert.equal(JSON.stringify(result).includes(refreshToken), false);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('auth'));
    assert.ok(calls[0].includes('login'));
    assert.ok(calls[1].includes('-p'));
  } finally {
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.rawLogDirectory, { recursive: true, force: true });
  }
});

test('a staged Claude cell refreshes once and reuses its cell-local credential', async () => {
  const setup = await fixture('claude');
  const calls = [];
  let credentialReads = 0;
  try {
    const dependencies = {
      readClaudeOauthCredentials: () => {
        credentialReads += 1;
        return { refreshToken: 'fixture-claude-oauth-refresh-token', scopes: ['user:inference'] };
      },
      spawn: (_command, args, options) => {
        calls.push({ args, environment: options.env });
        return childFor({ stdout: JSON.stringify({ type: 'result', usage: {} }) });
      },
    };
    const request = {
      host: 'claude', model: 'opus', effort: 'medium', prompt: 'workflow task',
      preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
    };
    await invokeKnowledgeHost(request, dependencies);
    await invokeKnowledgeHost(request, dependencies);
    assert.equal(credentialReads, 1);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].args.includes('auth') && calls[0].args.includes('login'));
    assert.equal(calls[0].environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, 'fixture-claude-oauth-refresh-token');
    assert.equal(calls[0].environment.CLAUDE_CODE_OAUTH_SCOPES, 'user:inference');
    assert.ok(calls[1].args.includes('-p'));
    assert.equal(calls[1].environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined);
    assert.ok(calls[2].args.includes('-p'));
    assert.equal(calls[2].args.includes('auth'), false);
    assert.equal(calls[2].environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined);
    assert.equal(calls[2].environment.CLAUDE_CODE_OAUTH_SCOPES, undefined);
  } finally {
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.rawLogDirectory, { recursive: true, force: true });
  }
});

test('a usable Claude access credential avoids refresh login and preserves the source refresh', async () => {
  const setup = await fixture('claude');
  const calls = [];
  try {
    const result = await invokeKnowledgeHost({ host: 'claude', model: 'opus', effort: 'medium', prompt: 'workflow task', preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory }, {
      readClaudeOauthCredentials: () => ({ accessToken: 'fixture-current-access-token', refreshToken: 'fixture-refresh-token', scopes: ['user:inference'] }),
      spawn: (_command, args, options) => { calls.push({ args, environment: options.env }); return childFor({ stdout: JSON.stringify({ type: 'result', usage: {} }) }); },
    });
    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('-p'));
    assert.equal(calls[0].args.includes('auth'), false);
    assert.equal(calls[0].environment.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-current-access-token');
    assert.equal(calls[0].environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined);
  } finally { await fs.rm(setup.root, { recursive: true, force: true }); await fs.rm(setup.rawLogDirectory, { recursive: true, force: true }); }
});

test('Codex never receives Claude OAuth refresh credentials or a Claude auth preflight', async () => {
  const setup = await fixture('codex');
  const calls = [];
  try {
    await invokeKnowledgeHost({
      host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'workflow task',
      preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
    }, {
      readClaudeOauthCredentials: () => ({ refreshToken: 'fixture-claude-oauth-refresh-token', scopes: ['user:inference'] }),
      spawn: (_command, args, options) => {
        calls.push({ args, environment: options.env });
        return childFor({ stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined);
    assert.equal(calls[0].environment.CLAUDE_CODE_OAUTH_SCOPES, undefined);
    assert.ok(calls[0].args.includes('exec'));
    assert.equal(calls[0].args.includes('auth'), false);
  } finally {
    await fs.rm(setup.root, { recursive: true, force: true });
    await fs.rm(setup.rawLogDirectory, { recursive: true, force: true });
  }
});

test('rejects non-opaque request trace identifiers before host launch', async () => {
  const setup = await fixture('codex');
  let launched = false;
  await assert.rejects(() => invokeKnowledgeHost({
    host: 'codex', model: 'gpt-test', effort: 'medium', prompt: 'ordinary task',
    preparedFixture: setup.value, rawLogDirectory: setup.rawLogDirectory,
    environment: { SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID: 'not an opaque id' },
  }, {
    spawn: () => { launched = true; return childFor({}); },
  }), /SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID must be an opaque evaluation identifier/);
  assert.equal(launched, false);
});
