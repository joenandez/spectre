import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerCanonicalKnowledge } from '../plugins/spectre/hooks/scripts/knowledge/registration.mjs';
import { parseKnowledgeRecord, refreshKnowledgeIndex, revisionTokenFromDirectoryName } from '../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import { readKnowledgeActivity } from '../plugins/spectre/hooks/scripts/knowledge/activity.mjs';
import { resolveProjectStore } from '../plugins/spectre/hooks/scripts/knowledge/store.mjs';
import { ensureTags } from '../plugins/spectre/hooks/scripts/knowledge/tags.mjs';
import { rewriteHooks } from './verify-knowledge-hosts.mjs';

export const BASELINE_REF = '1cd1f035a253e9d7ef5086693ab9f1d0b11d360b';

const PROBE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge-host-probe-hook.mjs');
const CURRENT_PAYLOAD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugins/spectre/hooks/scripts/knowledge/payload.mjs');

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    result: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })(),
  };
}

function requireDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !fs.statSync(value).isDirectory()) {
    throw new Error(`${label} must be an absolute existing directory`);
  }
  return value;
}

function hostPluginSource(repositoryRoot, host, options) {
  const configured = options.candidatePluginRoots?.[host] ?? options.candidatePluginRoot;
  return requireDirectory(configured ?? path.join(repositoryRoot, host === 'codex' ? 'plugins/spectre-codex' : 'plugins/spectre'), 'candidate plugin root');
}

function archiveBaselinePlugin(repositoryRoot, host, destination, baselineRef) {
  const archivePath = host === 'codex' ? 'plugins/spectre-codex' : 'plugins/spectre';
  const archive = spawnSync('git', ['archive', '--format=tar', baselineRef, archivePath], {
    cwd: repositoryRoot, encoding: null,
  });
  if (archive.status !== 0) throw new Error(`Could not archive baseline ${baselineRef}: ${archive.stderr?.toString('utf8') || ''}`);
  const extractionRoot = path.join(path.dirname(destination), 'baseline-archive');
  fs.mkdirSync(extractionRoot, { recursive: true });
  const extracted = spawnSync('tar', ['-x', '-C', extractionRoot], { input: archive.stdout, encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error(`Could not extract baseline ${baselineRef}: ${extracted.stderr || ''}`);
  const source = path.join(extractionRoot, archivePath);
  fs.cpSync(source, destination, { recursive: true });
  return { baselineRef, sourceHash: hash(archive.stdout) };
}

function initializeRepository(projectDir, fixtureCase) {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'TASK.md'), `${fixtureCase.task}\n`);
  const neutralFacts = (fixtureCase.initialFacts || []).map(fact => `- ${fact.content}`).join('\n') || '- No prior project fact is supplied.';
  fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'EVIDENCE.md'), `# Neutral project evidence\n\n${neutralFacts}\n`);
  fs.writeFileSync(path.join(projectDir, 'docs', 'task-context.md'), `# Task context\n\n${fixtureCase.task}\n\n## Observed facts\n${neutralFacts}\n`);
  fs.writeFileSync(path.join(projectDir, 'test', 'evaluation-facts.txt'), `${neutralFacts}\n`);
  fs.writeFileSync(path.join(projectDir, 'IMPLEMENTATION.md'), [
    '# Evaluation delivery note', '', `Task: ${fixtureCase.task}`,
    'Evidence: pending.', 'Delivery note: pending.', '',
  ].join('\n'));
  const featureRoot = path.join(projectDir, '.spectre', 'features', 'evaluation-cell', 'specs');
  fs.mkdirSync(featureRoot, { recursive: true });
  fs.writeFileSync(path.join(featureRoot, 'execute.md'), [
    '# Evaluation cell execution', '', 'Tasks JSON: `tasks.json`', '',
    '## One bounded task', '',
    'Source evidence: `TASK.md` and `EVIDENCE.md`.',
    'Target: `IMPLEMENTATION.md` only.',
    'Replace `Evidence: pending.` and `Delivery note: pending.` with factual statements for the task.',
    'Use only source evidence or currently supplied accepted or verified evidence. Do not invent facts or edit source evidence.', '',
    '## Verification', '',
    `- ` + '`IMPLEMENTATION.md` retains `Task: ' + fixtureCase.task + '` exactly.',
    '- It contains no `pending.` placeholder.',
    '- Its Evidence and Delivery note lines are non-empty factual statements.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(featureRoot, 'tasks.json'), `${JSON.stringify({
    schemaVersion: 1,
    phases: [{ id: '1', title: 'Evaluation fixture', parents: [{
      id: '1.1', title: 'Write the factual delivery note',
      description: `Edit only IMPLEMENTATION.md. Use TASK.md and EVIDENCE.md, or currently supplied accepted or verified evidence, to replace its pending Evidence and Delivery note lines. Verify the exact Task line remains and no pending placeholder remains.`,
      subtasks: [],
    }] }],
  }, null, 2)}\n`);
  const initialize = run('git', ['init', '--initial-branch=main'], { cwd: projectDir });
  if (initialize.status !== 0) throw new Error(`Could not initialize isolated fixture repository: ${initialize.stderr}`);
  const commands = [
    ['config', 'user.email', 'evaluation@example.invalid'], ['config', 'user.name', 'Knowledge Evaluation'],
    ['add', 'TASK.md', 'EVIDENCE.md', 'IMPLEMENTATION.md', 'docs', 'test', '.spectre'], ['commit', '-m', 'evaluation base fixture'],
  ];
  for (const args of commands) {
    const result = run('git', args, { cwd: projectDir });
    if (result.status !== 0) throw new Error(`Could not initialize isolated fixture repository: ${result.stderr}`);
  }
  const originDir = path.join(path.dirname(projectDir), 'origin.git');
  const origin = run('git', ['init', '--bare', originDir], { cwd: projectDir });
  if (origin.status !== 0) throw new Error(`Could not initialize isolated fixture origin: ${origin.stderr}`);
  for (const args of [['remote', 'add', 'origin', originDir], ['push', '-u', 'origin', 'main'], ['checkout', '-b', 'evaluation/knowledge-cell']]) {
    const result = run('git', args, { cwd: projectDir });
    if (result.status !== 0) throw new Error(`Could not prepare isolated fixture branch: ${result.stderr}`);
  }
  return { branch: 'evaluation/knowledge-cell', baseRef: 'origin/main', originDir, featureRoot: path.dirname(featureRoot) };
}

function fixtureFacts(fixtureCase, requestedScale) {
  const facts = [...(fixtureCase.initialFacts || [])];
  const configuredScale = requestedScale ?? fixtureCase.scaleDistractors ?? 0;
  const levels = Array.isArray(configuredScale) ? configuredScale : [configuredScale];
  if (!levels.every(level => Number.isSafeInteger(level) && level >= 0 && level <= 10_000)) throw new Error('scaleDistractors must be a safe integer from 0 through 10000');
  const count = Math.max(...levels);
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index + 1).padStart(5, '0');
    facts.push({
      id: `telemetry-checkpoint-${suffix}`,
      content: `The telemetry collector for zone ${suffix} retains one local checkpoint after rotation.`,
      tags: ['observability'], scaleDistractor: true,
    });
  }
  return facts;
}

function workTemplate() {
  const unknown = 'unknown — imported record';
  return {
    requestedOutcome: unknown, scope: unknown, actualChanges: unknown, reasons: unknown,
    discoveries: unknown, verification: unknown, remainingWork: unknown, relatedContext: unknown,
    execution: { state: 'unknown' }, verificationState: { state: 'unknown' }, pullRequest: { state: 'unknown' },
    associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] },
  };
}

function candidateRecord(fact) {
  if (fact.record) return fact.record;
  const tags = fact.tags || ['evaluation'];
  if (fact.kind === 'work' || fact.imported === true) {
    return {
      schemaVersion: 1, id: fact.id, kind: 'work', title: fact.id, summary: fact.content, tags,
      applicability: fact.applicability || { scope: 'work', workId: fact.workId || fact.id },
      provenance: { origin: 'legacy-import', capturedAt: '2026-09-06T00:00:00.000Z', sourceFingerprint: `sha256:${'0'.repeat(64)}` },
      relatedRecordIds: [], work: workTemplate(),
      importedSource: { body: fact.content, useWhen: fact.useWhen || fact.content, cues: fact.cues || [fact.id], category: fact.category || 'pattern', status: fact.sourceStatus || 'active', version: String(fact.version || 1) },
    };
  }
  return {
    schemaVersion: 1, id: fact.id, kind: 'knowledge', title: fact.id,
    summary: fact.content, tags, applicability: fact.applicability || { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' }, relatedRecordIds: [],
    category: fact.category || 'pattern', useWhen: `${fact.id}: ${fact.content}`,
    content: fact.content, evidence: 'Frozen evaluation fixture.', status: fact.status || 'active',
  };
}

function baselineSkill(fact) {
  const description = String(fact.content).replaceAll('"', '\\"');
  const triggers = JSON.stringify([fact.id]).replaceAll('"', '\\"');
  return [
    '---', `name: ${fact.id}`, `description: "${description}"`, 'metadata:',
    '  spectre-category: patterns', `  spectre-triggers: "${triggers}"`,
    `  spectre-status: ${fact.status || 'active'}`, '  spectre-version: "1"', '---', '', fact.content, '',
  ].join('\n');
}

async function seedCandidate(projectDir, storeDir, facts) {
  const resolved = await resolveProjectStore(projectDir, { spectreHome: storeDir });
  const tags = new Map();
  for (const fact of facts) {
    for (const id of fact.tags || ['evaluation']) {
      tags.set(id, { id, description: `Frozen evaluation tag ${id}.`, aliases: id === 'evaluation' ? ['eval'] : [] });
    }
    for (const alias of fact.aliases || []) {
      const target = fact.tags?.[0] || 'evaluation';
      const entry = tags.get(target) || { id: target, description: `Frozen evaluation tag ${target}.`, aliases: [] };
      entry.aliases.push(alias); tags.set(target, entry);
    }
  }
  if (tags.size > 0) await ensureTags({ projectDir, spectreHome: storeDir, tags: [...tags.values()] });
  const knownPaths = [];
  for (const fact of facts) {
    const record = candidateRecord(fact);
    const recordPath = path.join(resolved.storePath, 'knowledge', record.id, 'record.json');
    if (fact.scaleDistractor === true) {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      parseKnowledgeRecord(recordPath);
    } else {
      const proposal = path.join(path.dirname(storeDir), 'proposals', record.id);
      fs.mkdirSync(proposal, { recursive: true });
      fs.writeFileSync(path.join(proposal, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
      const result = await registerCanonicalKnowledge({ projectDir, spectreHome: storeDir, recordPath: proposal });
      if (result.status !== 'created' && result.status !== 'noop') throw new Error(`Could not seed candidate record ${record.id}`);
    }
    knownPaths.push(recordPath);
  }
  refreshKnowledgeIndex(resolved.storePath);
  return { storePath: resolved.storePath, knownPaths };
}

async function seedBaseline(projectDir, storeDir, facts) {
  const resolved = await resolveProjectStore(projectDir, { spectreHome: storeDir });
  const knownPaths = [];
  for (const fact of facts) {
    const directory = path.join(resolved.storePath, 'knowledge', fact.id);
    fs.mkdirSync(directory, { recursive: true });
    const skillPath = path.join(directory, 'SKILL.md');
    fs.writeFileSync(skillPath, baselineSkill(fact));
    knownPaths.push(skillPath);
  }
  return { storePath: resolved.storePath, knownPaths };
}

function configureCodexExternalTools(codexHome, options = {}) {
  const configPath = path.join(codexHome, 'config.toml');
  const binary = options.codexCommand || process.env.CODEX_BIN || 'codex';
  const environment = { ...process.env, ...options.environment, CODEX_HOME: codexHome };
  const setFeature = (source, key) => {
    const header = /^\[features\]\s*$/m.exec(source);
    if (!header) return `${source.trimEnd()}\n\n[features]\n${key} = false\n`;
    const start = header.index + header[0].length;
    const nextSection = source.slice(start).search(/^\[/m);
    const end = nextSection < 0 ? source.length : start + nextSection;
    const body = source.slice(start, end);
    const setting = new RegExp(`^${key}\\s*=.*$`, 'm');
    const nextBody = setting.test(body)
      ? body.replace(setting, `${key} = false`)
      : `${body.endsWith('\n') ? body : `${body}\n`}${key} = false\n`;
    return `${source.slice(0, start)}${nextBody}${source.slice(end)}`;
  };
  const setTopLevel = (source, key, value) => {
    const setting = new RegExp(`^${key}\\s*=.*$`, 'm');
    if (setting.test(source)) return source.replace(setting, `${key} = ${value}`);
    const section = source.search(/^\[/m);
    const prefix = section < 0 ? source : source.slice(0, section);
    const suffix = section < 0 ? '' : source.slice(section);
    return `${prefix.trimEnd()}\n${key} = ${value}\n${suffix ? `\n${suffix}` : ''}`;
  };
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  fs.writeFileSync(configPath, setFeature(setFeature(setFeature(setTopLevel(config, 'web_search', '"disabled"'), 'apps'), 'enable_mcp_apps'), 'web_search_request'));
  const checked = run(binary, ['--strict-config', '--version'], { env: environment });
  if (checked.status !== 0) throw new Error(`Isolated Codex external-tool configuration is invalid: ${checked.stderr}`);
  const mcp = run(binary, ['mcp', 'list'], { env: environment });
  if (mcp.status !== 0 || !/No MCP servers configured/.test(mcp.stdout)) {
    throw new Error(`Isolated Codex MCP configuration is not empty: ${mcp.stderr || mcp.stdout}`);
  }
  return configPath;
}

function installCodexPlugin(codexHome, pluginDir, options = {}) {
  const marketplaceRoot = path.join(path.dirname(pluginDir), 'codex-marketplace');
  const marketplacePlugin = path.join(marketplaceRoot, 'plugins', 'spectre-codex');
  fs.mkdirSync(path.join(marketplaceRoot, '.agents', 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(marketplaceRoot, 'plugins'), { recursive: true });
  fs.cpSync(pluginDir, marketplacePlugin, { recursive: true });
  fs.writeFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
    name: 'evaluation', version: '7.3.0', owner: { name: 'Spectre evaluation' },
    plugins: [{ name: 'spectre', source: './plugins/spectre-codex', version: '7.3.0' }],
  }, null, 2)}\n`);
  fs.mkdirSync(codexHome, { recursive: true });
  const environment = { ...process.env, ...options.environment, CODEX_HOME: codexHome };
  const binary = options.codexCommand || process.env.CODEX_BIN || 'codex';
  const marketplace = run(binary, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], { env: environment });
  if (marketplace.status !== 0) throw new Error(`Could not add isolated Codex marketplace: ${marketplace.stderr}`);
  const installed = run(binary, ['plugin', 'add', 'spectre@evaluation', '--json'], { env: environment });
  if (installed.status !== 0 || typeof installed.result?.installedPath !== 'string') throw new Error(`Could not install isolated Codex plugin: ${installed.stderr}`);
  const listed = run(binary, ['plugin', 'list', '--json'], { env: environment });
  const plugin = listed.result?.installed?.find(entry => entry.pluginId === 'spectre@evaluation' && entry.enabled === true);
  if (listed.status !== 0 || !plugin || plugin.source?.source !== 'local') throw new Error(`Isolated Codex plugin install was not discoverable: ${listed.stderr}`);
  const installedPath = path.resolve(installed.result.installedPath);
  if (!fs.existsSync(path.join(installedPath, 'skills', 'spectre-execute', 'SKILL.md')) || !fs.existsSync(path.join(installedPath, 'hooks', 'hooks.json'))) {
    throw new Error('Isolated Codex plugin cache is missing required workflow skills or hooks');
  }
  const configPath = path.join(codexHome, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  if (!config.includes('[plugins."spectre@evaluation"]') || fs.existsSync(path.join(codexHome, 'hooks.json'))) {
    throw new Error('Isolated Codex plugin configuration is incomplete or manually hooked');
  }
  return { marketplaceRoot, marketplacePlugin, installedPath, listing: listed.result, configPath: configureCodexExternalTools(codexHome, options) };
}

function writeGhMock(root) {
  const bin = path.join(root, 'bin');
  const ghLogPath = path.join(root, 'gh.log');
  const ghStatePath = path.join(root, 'gh-state.json');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'gh');
  fs.writeFileSync(ghStatePath, `${JSON.stringify({ nextNumber: 1, pullRequests: [] })}\n`);
  fs.writeFileSync(executable, `#!/usr/bin/env node
const childProcess = require('node:child_process');
const fs = require('node:fs');

const args = process.argv.slice(2);
const statePath = process.env.SPECTRE_EVALUATION_GH_STATE;
const logPath = process.env.SPECTRE_EVALUATION_GH_LOG;
if (!statePath || !logPath) {
  process.stderr.write('local gh fixture is not configured\\n');
  process.exit(2);
}
fs.appendFileSync(logPath, args.join(' ') + '\\n');

if (args.includes('--help') || args.includes('-h')) {
  const command = args.filter(value => !value.startsWith('-')).join(' ') || 'gh';
  process.stdout.write('Usage: gh ' + command + ' [flags]\\n');
  process.exit(0);
}

function fail(message) {
  process.stderr.write(message + '\\n');
  process.exit(1);
}
function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!Number.isSafeInteger(state.nextNumber) || !Array.isArray(state.pullRequests)) throw new Error('invalid');
    return state;
  } catch {
    fail('local gh fixture state is unavailable');
  }
}
function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state) + '\\n');
}
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
function jsonFields() {
  const inline = args.find(value => value.startsWith('--json='));
  const value = inline ? inline.slice('--json='.length) : flag('--json');
  return value ? value.split(',').filter(Boolean) : null;
}
function select(value) {
  const fields = jsonFields();
  if (!fields) return value;
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
}
function currentBranch() {
  const result = childProcess.spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
function headName() {
  const head = flag('--head') || currentBranch();
  return head ? head.split(':').at(-1) : null;
}
function pullPayload(pull) {
  return {
    number: pull.number,
    url: pull.url,
    state: pull.state,
    isDraft: pull.isDraft,
    headRefName: pull.headRefName,
    baseRefName: pull.baseRefName,
    title: pull.title,
    body: pull.body,
  };
}
function print(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
function emit(value) {
  const query = flag('--jq');
  if (query !== undefined) {
    const match = /^\.([A-Za-z][A-Za-z0-9_]*)$/.exec(query);
    if (!match || !Object.hasOwn(value, match[1]) || typeof value[match[1]] === 'object') fail('unsupported local gh fixture jq query: ' + query);
    process.stdout.write(String(value[match[1]]) + '\\n');
    return;
  }
  print(select(value));
}
if (args.includes('-q')) fail('unsupported local gh fixture query option: -q');

if (args[0] === '--version' || args[0] === 'version') {
  process.stdout.write('gh version 0.0.0-evaluation fixture\\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('github.com: logged in as evaluation-fixture (local evaluation token)\\n');
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') {
  const repository = { owner: { login: 'evaluation-fixture' }, name: 'knowledge-evaluation', nameWithOwner: 'evaluation-fixture/knowledge-evaluation', defaultBranchRef: { name: 'main' } };
  if (jsonFields()) emit(repository);
  else process.stdout.write('evaluation-fixture/knowledge-evaluation\\n');
  process.exit(0);
}
if (args[0] !== 'pr') fail('unsupported local gh fixture command: ' + args.join(' '));

const state = readState();
const openPull = (head) => state.pullRequests.find(pull => pull.state === 'OPEN' && (!head || pull.headRefName === head));
function pullSelector(value) {
  if (typeof value !== 'string') return null;
  const match = new RegExp('(?:^|/pull/)([0-9]+)$').exec(value);
  return match ? Number(match[1]) : null;
}
function selectedPull(value) {
  const number = pullSelector(value);
  return number === null ? null : state.pullRequests.find(pull => pull.number === number);
}
if (args[1] === 'view') {
  const explicit = args[2] && !args[2].startsWith('--') ? args[2] : null;
  const pull = explicit ? selectedPull(explicit) : openPull(headName());
  if (!pull) fail(explicit ? 'pull request not found: ' + explicit : 'no open pull request for the current branch');
  const payload = pullPayload(pull);
  if (jsonFields()) emit(payload);
  else process.stdout.write(pull.url + '\\n');
  process.exit(0);
}
if (args[1] === 'list') {
  const head = flag('--head');
  const pulls = state.pullRequests.filter(pull => pull.state === 'OPEN' && (!head || pull.headRefName === head.split(':').at(-1)));
  if (flag('--jq') !== undefined) fail('unsupported local gh fixture jq query: ' + flag('--jq'));
  if (jsonFields()) print(pulls.map(pull => select(pullPayload(pull))));
  else process.stdout.write(pulls.map(pull => pull.url).join('\\n') + (pulls.length ? '\\n' : ''));
  process.exit(0);
}
if (args[1] === 'close') {
  const pull = selectedPull(args[2]);
  if (!pull) fail('pull request not found: ' + (args[2] || ''));
  if (pull.state !== 'OPEN') fail('pull request is not open: ' + pull.number);
  pull.state = 'CLOSED';
  writeState(state);
  process.stdout.write(pull.url + '\\n');
  process.exit(0);
}
if (args[1] === 'create') {
  const head = headName();
  const base = flag('--base') || 'main';
  if (!head) fail('cannot determine pull request head branch');
  if (openPull(head)) fail('branch ' + head + ' already has an open pull request');
  const number = state.nextNumber++;
  let body = flag('--body') || '';
  if (flag('--body-file') !== undefined) {
    try { body = fs.readFileSync(flag('--body-file'), 'utf8'); } catch { fail('could not read pull request body file'); }
  }
  const pull = {
    number, url: 'https://github.com/evaluation-fixture/knowledge-evaluation/pull/' + number,
    state: 'OPEN', isDraft: args.includes('--draft'), headRefName: head, baseRefName: base,
    title: flag('--title') || '', body,
  };
  state.pullRequests.push(pull);
  writeState(state);
  process.stdout.write(pull.url + '\\n');
  process.exit(0);
}
if (args[1] === 'edit') {
  const pull = openPull(headName());
  if (!pull) fail('no open pull request for the current branch');
  if (flag('--title') !== undefined) pull.title = flag('--title');
  if (flag('--body') !== undefined) pull.body = flag('--body');
  if (flag('--body-file') !== undefined) {
    try { pull.body = fs.readFileSync(flag('--body-file'), 'utf8'); } catch { fail('could not read pull request body file'); }
  }
  writeState(state);
  process.stdout.write(pull.url + '\\n');
  process.exit(0);
}
fail('unsupported local gh fixture command: ' + args.join(' '));
`);
  fs.chmodSync(executable, 0o755);
  return {
    bin,
    ghLogPath,
    ghStatePath,
    environment: {
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      SPECTRE_EVALUATION_GH_LOG: ghLogPath,
      SPECTRE_EVALUATION_GH_STATE: ghStatePath,
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function stageTrustBundle(root) {
  const source = '/etc/ssl/cert.pem';
  if (!fs.statSync(source).isFile()) throw new Error('System CA bundle is unavailable');
  const directory = path.join(root, 'trust');
  const destination = path.join(directory, 'cert.pem');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

function writeIsolatedEnvironment(root, gh) {
  const home = path.join(root, 'home');
  const shellHome = path.join(root, 'shell-home');
  const gitConfig = path.join(root, 'gitconfig');
  const ghConfig = path.join(root, 'gh-config');
  const xdgConfig = path.join(root, 'xdg-config');
  const xdgData = path.join(root, 'xdg-data');
  const xdgCache = path.join(root, 'xdg-cache');
  const temporaryDirectory = path.join(root, 'tmp');
  const trustBundle = stageTrustBundle(root);
  const pathValue = `${gh.bin}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`;
  for (const directory of [home, shellHome, ghConfig, xdgConfig, xdgData, xdgCache, temporaryDirectory]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.symlinkSync('/usr/bin/git', path.join(gh.bin, 'git'));
  fs.writeFileSync(gitConfig, '# isolated evaluation Git config\n', { mode: 0o600 });
  const environment = {
    ...gh.environment,
    HOME: home,
    PATH: pathValue,
    ZDOTDIR: shellHome,
    BASH_ENV: path.join(shellHome, '.bash_env'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: ghConfig,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    SSL_CERT_FILE: trustBundle,
  };
  const exports = Object.entries(environment)
    .filter(([key]) => ['HOME', 'PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'TMP', 'TEMP', 'SSL_CERT_FILE'].includes(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  fs.writeFileSync(path.join(shellHome, '.zshenv'), `${exports}\n`);
  fs.writeFileSync(path.join(shellHome, '.zprofile'), `${exports}\n`);
  fs.writeFileSync(path.join(shellHome, '.bash_env'), `${exports}\n`);
  fs.writeFileSync(path.join(home, '.bash_profile'), `${exports}\n`);
  fs.writeFileSync(path.join(home, '.profile'), `${exports}\n`);
  return environment;
}

function probeCli(cliPath, projectDir, storeDir, fact) {
  const environment = { ...process.env, SPECTRE_HOME: storeDir };
  const search = run(process.execPath, [cliPath, 'search', fact.id, '--project-dir', projectDir, '--json'], { cwd: projectDir, env: environment });
  const historical = fact.kind === 'work' || fact.imported === true || fact.status && fact.status !== 'active' || fact.applicability?.scope !== undefined && fact.applicability.scope !== 'project';
  const load = run(process.execPath, [cliPath, 'load', fact.id, '--project-dir', projectDir, ...(historical ? ['--inspect-historical'] : []), '--json'], { cwd: projectDir, env: environment });
  return { search, load, historical };
}

function stageSessionStartProbe(root) {
  const scriptDirectory = path.join(root, 'scripts');
  const stagedProbe = path.join(scriptDirectory, 'knowledge-host-probe-hook.mjs');
  const observerPayload = path.join(root, 'plugins', 'spectre', 'hooks', 'scripts', 'knowledge', 'payload.mjs');
  fs.mkdirSync(scriptDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(observerPayload), { recursive: true, mode: 0o700 });
  fs.copyFileSync(PROBE_SCRIPT, stagedProbe);
  fs.copyFileSync(CURRENT_PAYLOAD_SCRIPT, observerPayload);
  return stagedProbe;
}

function installSessionStartObservation({ host, pluginDir, runtimePath, root }) {
  const observationPath = path.join(root, 'session-start-observation.json');
  const probeScript = stageSessionStartProbe(root);
  rewriteHooks({ host, pluginRoot: pluginDir, runtimePath, observationPath, probeScript });
  return observationPath;
}

/** Read the latest actual native SessionStart hook frame without retaining its content. */
export function readSessionStartMeasurement(staged, { consume = true } = {}) {
  if (staged?.noKnowledge === true) return { availability: 'none', injectedTokens: 0, injectedBytes: 0 };
  const observationPath = staged?.sessionStartObservationPath;
  if (!observationPath || !fs.existsSync(observationPath)) return { availability: 'unavailable', injectedTokens: null, injectedBytes: null };
  try {
    const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8'));
    if (!observation.validJson || !observation.hookEventMatches || !observation.measurement?.ok || !Number.isFinite(observation.additionalContextBytes) || !Number.isFinite(observation.additionalContextTokens)) {
      return { availability: 'unavailable', injectedTokens: null, injectedBytes: null };
    }
    return { availability: 'available', injectedTokens: observation.additionalContextTokens, injectedBytes: observation.additionalContextBytes };
  } catch {
    return { availability: 'unavailable', injectedTokens: null, injectedBytes: null };
  } finally {
    if (consume) fs.rmSync(observationPath, { force: true });
  }
}

/** Stage one condition in a fresh isolated repository without invoking a native model host. */
export async function stageKnowledgeCell(cell, fixtureCase, options = {}) {
  if (!['candidate', 'baseline', 'no-knowledge'].includes(cell?.condition)) throw new Error('condition must be candidate, baseline, or no-knowledge');
  if (!['claude', 'codex'].includes(cell?.host)) throw new Error('host must be claude or codex');
  const repositoryRoot = requireDirectory(options.repositoryRoot || process.cwd(), 'repository root');
  const root = fs.mkdtempSync(path.join(options.temporaryRoot || os.tmpdir(), 'spectre-knowledge-evaluation-cell-'));
  const projectDir = path.join(root, 'project');
  const facts = fixtureFacts(fixtureCase, cell.scaleDistractors);
  const repository = initializeRepository(projectDir, fixtureCase);
  const gh = writeGhMock(root);
  const environment = writeIsolatedEnvironment(root, gh);
  const claudeHome = path.join(root, 'claude-home');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const codexConfigPath = configureCodexExternalTools(codexHome, { ...options, environment });

  if (cell.condition === 'no-knowledge') {
    return {
      root, projectDir, storeDir: null, storePath: null, pluginDir: null, runtimePath: null, cliPath: null, noKnowledge: true,
      freshStore: true, isolatedGitWorkflow: true, knownPaths: [], tracePath: null, sessionStartMeasurement: { availability: 'none', injectedTokens: 0, injectedBytes: 0 }, ghLogPath: gh.ghLogPath, ghStatePath: gh.ghStatePath, environment,
      claudeHome, codexHome, codexConfigPath, claudePluginDir: null, codexPlugin: null,
      provenance: { condition: 'no-knowledge' }, repository, probe: null,
    };
  }

  const storeDir = path.join(root, 'spectre-home');
  const sourcePluginDir = path.join(root, 'plugin');
  const claudePluginDir = cell.host === 'claude' ? sourcePluginDir : path.join(root, 'claude-plugin');
  const codexSourcePluginDir = cell.host === 'codex' ? sourcePluginDir : path.join(root, 'codex-plugin');
  const stagePluginMirror = (host, destination) => {
    if (destination === sourcePluginDir) return;
    if (cell.condition === 'baseline') archiveBaselinePlugin(repositoryRoot, host, destination, options.baselineRef || BASELINE_REF);
    else fs.cpSync(hostPluginSource(repositoryRoot, host, options), destination, { recursive: true });
  };
  let provenance;
  if (cell.condition === 'baseline') {
    provenance = archiveBaselinePlugin(repositoryRoot, cell.host, sourcePluginDir, options.baselineRef || BASELINE_REF);
  } else {
    const source = hostPluginSource(repositoryRoot, cell.host, options);
    fs.cpSync(source, sourcePluginDir, { recursive: true });
    provenance = { candidateSource: source, sourceHash: hash(fs.readFileSync(path.join(sourcePluginDir, 'hooks', 'scripts', 'knowledge-cli.mjs'))) };
  }
  stagePluginMirror('claude', claudePluginDir);
  stagePluginMirror('codex', codexSourcePluginDir);
  const codexPlugin = installCodexPlugin(codexHome, codexSourcePluginDir, { ...options, environment });
  const pluginDir = cell.host === 'codex' ? codexPlugin.installedPath : claudePluginDir;
  const seededFacts = facts.filter(fact => fact.seedKnowledge !== false);
  const seeded = cell.condition === 'baseline'
    ? await seedBaseline(projectDir, storeDir, seededFacts)
    : await seedCandidate(projectDir, storeDir, seededFacts);
  const cliPath = path.join(pluginDir, 'hooks', 'scripts', 'knowledge-cli.mjs');
  const activityPath = path.join(seeded.storePath, 'activity.json');
  const activityBeforeProbe = fs.existsSync(activityPath) ? fs.readFileSync(activityPath) : null;
  const probe = seededFacts.length > 0 ? probeCli(cliPath, projectDir, storeDir, seededFacts[0]) : null;
  if (activityBeforeProbe === null) fs.rmSync(activityPath, { force: true });
  else fs.writeFileSync(activityPath, activityBeforeProbe);
  const baselineHistoricalProbe = cell.condition === 'baseline' && probe?.historical === true;
  if (probe && !baselineHistoricalProbe && (probe.search.status !== 0 || probe.load.status !== 0)) throw new Error(`Staged ${cell.condition} CLI probe failed: ${probe.search.stderr || probe.load.stderr || probe.search.stdout || probe.load.stdout}`);
  const sessionStartObservationPath = installSessionStartObservation({ host: cell.host, pluginDir, runtimePath: path.join(pluginDir, 'hooks', 'scripts', 'load-knowledge.mjs'), root });
  return {
    root, projectDir, storeDir, storePath: seeded.storePath, pluginDir, sourcePluginDir, runtimePath: path.join(pluginDir, 'hooks', 'scripts', 'load-knowledge.mjs'), cliPath,
    freshStore: true, isolatedGitWorkflow: true, knownPaths: seeded.knownPaths, tracePath: cell.condition === 'candidate' ? path.join(root, 'trace.jsonl') : null, sessionStartObservationPath,
    ghLogPath: gh.ghLogPath, ghStatePath: gh.ghStatePath, environment: { ...environment, ...(cell.condition === 'candidate' ? { SPECTRE_KNOWLEDGE_EVALUATION_TRACE: path.join(root, 'trace.jsonl') } : {}) },
    claudeHome, codexHome, codexConfigPath, claudePluginDir, codexPlugin,
    provenance: { condition: cell.condition, ...provenance }, repository, probe,
  };
}

/** Make only record registration fail while existing search/load activity remains available. */
export function blockKnowledgeRegistration(staged) {
  const knowledgePath = path.join(staged?.storePath || '', 'knowledge');
  if (!staged?.storePath || !fs.statSync(knowledgePath).isDirectory()) {
    throw new Error('staged cell must have a canonical knowledge directory');
  }
  const originalMode = fs.statSync(knowledgePath).mode & 0o777;
  fs.chmodSync(knowledgePath, originalMode & 0o555);
  let restored = false;
  return {
    knowledgePath,
    restore() {
      if (!restored) fs.chmodSync(knowledgePath, originalMode);
      restored = true;
    },
  };
}

/** Snapshot bounded record, revision, lifecycle, and operational facts before cleanup. */
export function snapshotKnowledgeCell(staged) {
  if (!staged?.storePath || !fs.existsSync(staged.storePath)) return { records: [], history: [], activity: null };
  const recordRoot = path.join(staged.storePath, 'knowledge');
  const records = [];
  for (const entry of fs.existsSync(recordRoot) ? fs.readdirSync(recordRoot, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(recordRoot, entry.name);
    const recordPath = path.join(directory, 'record.json');
    if (fs.existsSync(recordPath)) {
      const recordBytes = fs.readFileSync(recordPath, 'utf8');
      const parsed = parseKnowledgeRecord(recordPath);
      const record = parsed.record;
      records.push({
        id: record.id, kind: record.kind, revisionToken: parsed.revisionToken, status: record.status ?? record.importedSource?.status ?? 'historical', applicability: record.applicability,
        record,
        recordHash: hash(recordBytes),
        ...(record.work ? { lifecycle: { execution: record.work.execution.state, verification: record.work.verificationState.state, pullRequest: record.work.pullRequest.state, associations: record.work.associations } } : {}),
      });
      continue;
    }
    const skillPath = path.join(directory, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const source = fs.readFileSync(skillPath, 'utf8');
      records.push({ id: entry.name, kind: 'knowledge', source, sourceFingerprint: hash(source), status: source.match(/spectre-status:\s*(\S+)/)?.[1] || 'unknown', applicability: { scope: 'project' } });
    }
  }
  const history = [];
  const historyRoot = path.join(staged.storePath, 'knowledge-history');
  if (fs.existsSync(historyRoot)) {
    for (const id of fs.readdirSync(historyRoot)) {
      const directory = path.join(historyRoot, id);
      if (!fs.statSync(directory).isDirectory()) continue;
      for (const revisionDirectory of fs.readdirSync(directory)) {
        const revisionToken = revisionTokenFromDirectoryName(revisionDirectory);
        if (revisionToken) history.push({ id, revisionToken });
      }
    }
  }
  const sortedRecords = records.sort((left, right) => left.id.localeCompare(right.id));
  return {
    records: sortedRecords,
    history: history.sort((left, right) => left.id.localeCompare(right.id) || left.revisionToken.localeCompare(right.revisionToken)),
    activity: readKnowledgeActivity(staged.storePath),
    workRecords: sortedRecords.filter(record => record.kind === 'work').map(record => ({
      id: record.id, revisionToken: record.revisionToken, execution: record.lifecycle.execution,
      verification: record.lifecycle.verification, pullRequest: record.lifecycle.pullRequest,
    })),
  };
}
