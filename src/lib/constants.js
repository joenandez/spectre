import fs from 'fs';
import path from 'path';
import { repoRoot, spectrePluginRoot } from './paths.js';

export const MANIFEST_VERSION = 1;
export const MIN_CODEX_VERSION = '0.110.0';
export const MANAGED_CONFIG_MARKER = 'spectre-codex-managed';
export const AGENTS_BRIDGE_START = '<!-- spectre-codex:start -->';
export const AGENTS_BRIDGE_END = '<!-- spectre-codex:end -->';
export const SESSION_OVERRIDE_START = '<!-- spectre-session:start -->';
export const SESSION_OVERRIDE_END = '<!-- spectre-session:end -->';
export const KNOWLEDGE_OVERRIDE_START = '<!-- spectre-knowledge:start -->';
export const KNOWLEDGE_OVERRIDE_END = '<!-- spectre-knowledge:end -->';

export function listSpectreSkills() {
  const skillsDir = path.join(spectrePluginRoot(), 'skills');
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
}

export function listSpectreAgents() {
  const agentsDir = path.join(spectrePluginRoot(), 'agents');
  return fs.readdirSync(agentsDir)
    .filter(name => name.endsWith('.md'))
    .map(name => path.basename(name, '.md'))
    .sort();
}

export const SHARED_SKILLS = [
  'spectre-learn'
];

export const RETIRED_SKILLS = [
  'spectre-architecture_review',
  'spectre-apply',
  'spectre-evaluate',
  'spectre-guide',
  'spectre-delegate',
  'spectre-kickoff',
  'spectre-goal',
  'spectre-clean',
  'spectre-create_test_guide',
  'spectre-create_plan',
  'spectre-plan_review',
  'spectre-create_tasks',
  'spectre-task_review',
  'spectre-tdd',
  'spectre-prove',
  'spectre-prune',
  'spectre-test',
  'spectre-sweep',
  'spectre-rebase'
];

export const WORKFLOW_PROBE_SKILLS = [
  'spectre-scope',
  'spectre-plan',
  'spectre-execute',
  'spectre-ship'
];

export function repoMetadata() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')
  );
  return {
    name: packageJson.name,
    version: packageJson.version
  };
}
