#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MANAGED_AGENT_MARKER = 'spectre-managed-codex-agent';
const LEGACY_MANAGED_MARKER = 'spectre-codex-managed';
const RETIRED_SKILLS = [
  'spectre-apply',
  'spectre-recall',
  'spectre-find',
  'spectre-guide',
  'spectre-evaluate',
  'spectre-architecture_review',
];
const LEGACY_RUNTIME_SEGMENT = `${path.sep}spectre${path.sep}hooks${path.sep}scripts${path.sep}`;

function parseArgs(argv) {
  const args = { mode: 'check', json: false };
  for (const value of argv) {
    if (value === '--check') args.mode = 'check';
    else if (value === '--ensure') args.mode = 'ensure';
    else if (value === '--remove') args.mode = 'remove';
    else if (value === '--json') args.json = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node ensure-codex-agents.mjs [--check|--ensure|--remove] [--json]',
    '',
    'Installs or removes only Spectre-managed Codex custom-agent TOMLs.',
  ].join('\n');
}

function pluginRoot() {
  return process.env.PLUGIN_ROOT
    ? path.resolve(process.env.PLUGIN_ROOT)
    : path.resolve(__dirname, '..', '..', '..');
}

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function sourceAgentsDir() {
  return path.join(pluginRoot(), 'agents');
}

function targetAgentsDir(home = codexHome()) {
  return path.join(home, 'agents');
}

function isManagedAgent(content) {
  return content.includes(`# ${MANAGED_AGENT_MARKER}`);
}

function isLegacyManagedConfig(content) {
  return content.includes(`# ${LEGACY_MANAGED_MARKER}`) ||
    /^\[agents\.spectre_[^\]]+\]$/m.test(content);
}

function listSourceAgents() {
  const dir = sourceAgentsDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing bundled Codex agents directory: ${dir}`);
  }
  const agents = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.toml'))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      const content = fs.readFileSync(filePath, 'utf8');
      if (!isManagedAgent(content)) {
        throw new Error(`Bundled agent is missing managed marker: ${filePath}`);
      }
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      const expectedName = path.basename(entry.name, '.toml');
      if (!nameMatch || nameMatch[1] !== expectedName || !expectedName.startsWith('spectre_')) {
        throw new Error(`Bundled agent name/file mismatch: ${filePath}`);
      }
      return {
        name: entry.name,
        sourcePath: filePath,
        targetPath: path.join(targetAgentsDir(), entry.name),
        content,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (agents.length === 0) {
    throw new Error(`No bundled Codex agents found in ${dir}`);
  }
  return agents;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function removeIfManaged(filePath, result, label) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    fs.rmSync(filePath, { recursive: true, force: true });
    result.cleaned.push(label);
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (isManagedAgent(content) || isLegacyManagedConfig(content)) {
    fs.unlinkSync(filePath);
    result.cleaned.push(label);
  }
}

function listBundledSkillNames() {
  const skillsDir = path.join(pluginRoot(), 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name);
}

function cleanupLegacySkills(home, result, ownedLegacyInstall) {
  if (!ownedLegacyInstall) return;
  for (const skill of new Set([...listBundledSkillNames(), ...RETIRED_SKILLS])) {
    const skillDir = path.join(home, 'skills', skill);
    if (!fs.existsSync(skillDir)) continue;
    fs.rmSync(skillDir, { recursive: true, force: true });
    result.cleaned.push(path.relative(home, skillDir));
  }
}

function cleanupLegacyConfig(home, result) {
  const configPath = path.join(home, 'config.toml');
  if (!fs.existsSync(configPath)) return false;
  const current = fs.readFileSync(configPath, 'utf8');
  const ownedLegacyInstall = current.includes(`# ${LEGACY_MANAGED_MARKER}`);
  let next = current.replace(
    /\n*\[\[skills\.config\]\]\n[\s\S]*?(?=^\[\[skills\.config\]\]\n|^\[(?!\[)|(?![\s\S]))/gm,
    (block) => /(?:^|[\\/])(?:\.agents|\.claude)[\\/]skills[\\/]spectre-(?:recall|find)[\\/]SKILL\.md/m.test(block)
      ? '\n'
      : block,
  );
  if (ownedLegacyInstall) {
    next = next
      .replace(/\n*\[agents\.spectre_[^\]]+\]\n[\s\S]*?(?=^\[|(?![\s\S]))/gm, '\n')
      .replace(new RegExp(`^# ${LEGACY_MANAGED_MARKER}\\n?`, 'm'), '');
  }
  next = next
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  if (`${next}\n` === current) return ownedLegacyInstall;
  atomicWrite(configPath, `${next}\n`);
  result.cleaned.push('config.toml:retired-spectre-knowledge');
  return ownedLegacyInstall;
}

function isLegacySpectreHook(hook, home) {
  if (hook?.type !== 'command' || typeof hook.command !== 'string') return false;
  const normalized = hook.command.replaceAll('/', path.sep);
  return normalized.includes('${CODEX_HOME}' + LEGACY_RUNTIME_SEGMENT) ||
    normalized.includes(path.join(home, 'spectre', 'hooks', 'scripts') + path.sep);
}

function cleanupLegacyHooks(home, result) {
  const hooksPath = path.join(home, 'hooks.json');
  if (!fs.existsSync(hooksPath)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  } catch {
    return;
  }
  let changed = false;
  for (const [event, groups] of Object.entries(parsed?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const nextGroups = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        nextGroups.push(group);
        continue;
      }
      const hooks = group.hooks.filter((hook) => {
        const remove = isLegacySpectreHook(hook, home);
        changed ||= remove;
        return !remove;
      });
      if (hooks.length > 0) nextGroups.push({ ...group, hooks });
    }
    if (nextGroups.length > 0) parsed.hooks[event] = nextGroups;
    else delete parsed.hooks[event];
  }
  if (!changed) return;
  atomicWrite(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`);
  result.cleaned.push('hooks.json:spectre-handlers');
}

function legacyHomes() {
  return new Set([codexHome(), path.join(process.cwd(), '.codex')]
    .map((home) => path.resolve(home)));
}

function hasOwnedLegacyInstall(home) {
  if (fs.existsSync(path.join(home, 'spectre'))) return true;
  const configPath = path.join(home, 'config.toml');
  return fs.existsSync(configPath) &&
    fs.readFileSync(configPath, 'utf8').includes(`# ${LEGACY_MANAGED_MARKER}`);
}

function findUnownedRetiredSkillCollisions() {
  const collisions = [];
  for (const home of legacyHomes()) {
    if (!home || !fs.existsSync(home) || hasOwnedLegacyInstall(home)) continue;
    for (const skill of RETIRED_SKILLS) {
      const skillDir = path.join(home, 'skills', skill);
      if (fs.existsSync(skillDir)) collisions.push(skillDir);
    }
  }
  return collisions;
}

function cleanupLegacyCodexHomes(result) {
  for (const home of legacyHomes()) {
    if (!home || !fs.existsSync(home)) continue;

    const legacyRuntimePresent = fs.existsSync(path.join(home, 'spectre'));
    const legacyConfigPresent = cleanupLegacyConfig(home, result);
    const ownedLegacyInstall = legacyRuntimePresent || legacyConfigPresent;
    cleanupLegacySkills(home, result, ownedLegacyInstall);
    cleanupLegacyHooks(home, result);

    for (const skill of RETIRED_SKILLS) {
      removeIfManaged(
        path.join(home, 'skills', skill),
        result,
        path.relative(home, path.join(home, 'skills', skill)),
      );
    }
    removeIfManaged(path.join(home, 'spectre', 'agents'), result, path.join('spectre', 'agents'));
    removeIfManaged(path.join(home, 'spectre', 'hooks'), result, path.join('spectre', 'hooks'));
    removeIfManaged(path.join(home, 'spectre', 'tools'), result, path.join('spectre', 'tools'));
    removeIfManaged(path.join(home, 'spectre'), result, 'spectre');
  }
}

function checkAgents() {
  const result = {
    ok: true,
    mode: 'check',
    codexHome: codexHome(),
    sourceAgentsDir: sourceAgentsDir(),
    targetAgentsDir: targetAgentsDir(),
    missing: [],
    stale: [],
    collisions: [],
    installed: [],
    updated: [],
    removed: [],
    cleaned: [],
  };
  const sources = listSourceAgents();
  for (const source of sources) {
    if (!fs.existsSync(source.targetPath)) {
      result.missing.push(source.name);
      continue;
    }
    const current = fs.readFileSync(source.targetPath, 'utf8');
    if (!isManagedAgent(current)) {
      result.collisions.push(source.targetPath);
      continue;
    }
    if (current !== source.content) {
      result.stale.push(source.name);
    }
  }
  result.ok = result.missing.length === 0 &&
    result.stale.length === 0 &&
    result.collisions.length === 0;
  return result;
}

function ensureAgents() {
  const result = checkAgents();
  result.mode = 'ensure';
  result.collisions.push(...findUnownedRetiredSkillCollisions());
  if (result.collisions.length > 0) {
    result.ok = false;
    return result;
  }
  cleanupLegacyCodexHomes(result);
  for (const source of listSourceAgents()) {
    const existed = fs.existsSync(source.targetPath);
    const current = existed ? fs.readFileSync(source.targetPath, 'utf8') : null;
    if (current === source.content) continue;
    atomicWrite(source.targetPath, source.content);
    if (existed) result.updated.push(source.name);
    else result.installed.push(source.name);
  }
  result.missing = [];
  result.stale = [];
  result.ok = true;
  return result;
}

function removeAgents() {
  const result = {
    ok: true,
    mode: 'remove',
    codexHome: codexHome(),
    sourceAgentsDir: sourceAgentsDir(),
    targetAgentsDir: targetAgentsDir(),
    missing: [],
    stale: [],
    collisions: [],
    installed: [],
    updated: [],
    removed: [],
    cleaned: [],
  };
  for (const source of listSourceAgents()) {
    if (!fs.existsSync(source.targetPath)) continue;
    const current = fs.readFileSync(source.targetPath, 'utf8');
    if (!isManagedAgent(current)) {
      result.collisions.push(source.targetPath);
      result.ok = false;
      continue;
    }
    fs.unlinkSync(source.targetPath);
    result.removed.push(source.name);
  }
  return result;
}

function writeResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const changed = result.installed.length + result.updated.length + result.removed.length;
  process.stdout.write(
    changed === 0
      ? 'Spectre Codex agents are current.\n'
      : `Spectre Codex agents changed: ${changed}\n`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = args.mode === 'ensure'
    ? ensureAgents()
    : args.mode === 'remove'
      ? removeAgents()
      : checkAgents();
  writeResult(result, args.json);
  if (!result.ok) process.exitCode = 1;
}

export {
  MANAGED_AGENT_MARKER,
  checkAgents,
  codexHome,
  ensureAgents,
  listSourceAgents,
  removeAgents,
  targetAgentsDir,
};

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
