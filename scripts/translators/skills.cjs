'use strict';

const fs = require('fs');
const path = require('path');
const { toTomlAgentName } = require('./agents.cjs');

function parseFrontmatter(source, filePath) {
  if (!source.startsWith('---\n')) {
    throw new Error(`Missing frontmatter in ${filePath}`);
  }

  const end = source.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error(`Unclosed frontmatter in ${filePath}`);
  }

  const frontmatterText = source.slice(4, end).trim();
  const body = source.slice(end + 4).replace(/^\r?\n/, '');
  const frontmatter = {};

  for (const line of frontmatterText.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`Invalid frontmatter line in ${filePath}: ${line}`);

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

function yamlScalar(value) {
  if (value === 'true' || value === true) return 'true';
  if (value === 'false' || value === false) return 'false';
  return JSON.stringify(String(value));
}

function renderFrontmatter(frontmatter, body) {
  const fields = Object.entries(frontmatter).map(([key, value]) => `${key}: ${yamlScalar(value)}`);
  return `---\n${fields.join('\n')}\n---\n${body}`;
}

function rewriteProjectSkillPaths(source) {
  return source
    .replace(/\.claude\/skills\//g, '.agents/skills/')
    .replace(/\.claude\\skills\\/g, '.agents\\skills\\');
}

function rewriteCodexCommandRefs(source) {
  return source
    .replace(/@skill-spectre:([A-Za-z0-9_-]+)/g, (_match, skillName) => {
      return `Skill(${skillName})`;
    })
    .replace(/\/skill-spectre:([A-Za-z0-9_-]+)/g, (_match, skillName) => {
      return `Skill(${skillName})`;
    })
    .replace(/@@spectre:([A-Za-z0-9_-]+)/g, '@$1')
    .replace(/@spectre:([A-Za-z0-9_-]+)/g, '@$1')
    .replace(/\/spectre:([A-Za-z0-9_-]+)/g, (_match, skillName) => {
      return skillName.startsWith('spectre-') ? skillName : `spectre-${skillName}`;
    });
}

function knownAgentNames(canonicalRoot) {
  const agentsDir = path.join(canonicalRoot, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  return fs.readdirSync(agentsDir)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => path.basename(fileName, '.md'))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteCodexAgentRefs(source, agentNames = []) {
  let rewritten = source;
  for (const agentName of agentNames) {
    const codexName = toTomlAgentName(agentName);
    const escaped = escapeRegExp(agentName);
    const legacyPatterns = [
      new RegExp(`@@spectre:${escaped}\\b`, 'g'),
      new RegExp(`@spectre:${escaped}\\b`, 'g'),
      new RegExp(`@spectre-${escaped}\\b`, 'g'),
      new RegExp(`@sesh:${escaped}\\b`, 'g'),
      new RegExp(`(?<![\\w:-])@${escaped}\\b`, 'g'),
    ];
    for (const pattern of legacyPatterns) {
      rewritten = rewritten.replace(pattern, `@${codexName}`);
    }
  }
  return rewritten;
}

function rewriteTextForCodex(source, agentNames = []) {
  return rewriteCodexAgentRefs(
    rewriteCodexCommandRefs(rewriteProjectSkillPaths(source))
      .replace(
        /\bspectre-workflow\b/g,
        'node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs"',
      )
      .replace(
        /\bspectre knowledge (search|tags|load|register|work|history|inspect|registry|migrate)\b/g,
        (_match, operation) =>
          `node "\${PLUGIN_ROOT}/hooks/scripts/knowledge-cli.mjs" ${operation}`,
      ),
    agentNames,
  );
}

function rewriteSkillForCodex(source, agentNames = []) {
  const { frontmatter, body } = parseFrontmatter(source, 'SKILL.md');
  const rewrittenFrontmatter = Object.fromEntries(
    Object.entries(frontmatter).map(([key, value]) => [
      key,
      rewriteTextForCodex(String(value), agentNames),
    ]),
  );
  const rewrittenBody = rewriteTextForCodex(body, agentNames);
  return renderFrontmatter(rewrittenFrontmatter, rewrittenBody);
}

// Codex has no SKILL.md-frontmatter equivalent of Claude's `disable-model-invocation`.
// Its lever is a per-skill-directory `agents/openai.yaml` policy: when
// `allow_implicit_invocation` is false, Codex won't auto-invoke the skill from a
// prompt, but explicit `$skill` invocation still works. Mirror the Claude flag here.
const CODEX_INVOCATION_POLICY = 'policy:\n  allow_implicit_invocation: false\n';

function isModelInvocationDisabled(frontmatter) {
  const value = frontmatter['disable-model-invocation'];
  return value === true || value === 'true';
}

function writeIfChanged(filePath, content) {
  const existed = fs.existsSync(filePath);
  if (existed) {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === content) return 'unchanged';
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return existed ? 'updated' : 'created';
}

function copyDirectory(sourceDir, targetDir, keep, agentNames) {
  const results = [];

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue;

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...copyDirectory(sourcePath, targetPath, keep, agentNames));
      continue;
    }

    if (!entry.isFile()) continue;

    const content = fs.readFileSync(sourcePath, 'utf8');
    const output = entry.name === 'SKILL.md'
      ? rewriteSkillForCodex(content, agentNames)
      : rewriteTextForCodex(content, agentNames);
    const status = writeIfChanged(targetPath, output);
    keep.add(targetPath);
    results.push({ path: targetPath, sourcePath, status });

    // Emit the Codex invocation-policy sidecar for skills that opt out of model
    // invocation. Skills without the flag get no sidecar; a previously-emitted one
    // falls out of `keep` and is pruned by removeStaleFiles.
    if (entry.name === 'SKILL.md' && isModelInvocationDisabled(parseFrontmatter(content, sourcePath).frontmatter)) {
      const policyPath = path.join(targetDir, 'agents', 'openai.yaml');
      const policyStatus = writeIfChanged(policyPath, CODEX_INVOCATION_POLICY);
      keep.add(policyPath);
      results.push({ path: policyPath, sourcePath, status: policyStatus });
    }
  }

  return results;
}

function removeStaleFiles(dir, keep) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...removeStaleFiles(fullPath, keep));
      if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0) {
        fs.rmdirSync(fullPath);
      }
      continue;
    }

    if (entry.isFile() && !keep.has(fullPath)) {
      fs.unlinkSync(fullPath);
      results.push({ path: fullPath, status: 'removed' });
    }
  }

  return results;
}

function codexUninstallSkill() {
  return `---
name: "spectre-uninstall-codex"
description: "Codex-only Spectre uninstall workflow. Use when the user wants to uninstall the native spectre@spectre Codex plugin; cleans expired workflow data and removes managed Spectre custom agents before native plugin removal while preserving marketplace registration and project knowledge."
user-invocable: true
---

# uninstall-codex

Clean expired local workflow data, remove only Spectre-managed Codex custom agents, then remove the native plugin. Preserve marketplace registration, project knowledge, handoffs, and unrelated Codex config. Unexpired workflow history is retained unless the user explicitly requests its purge.

## Method
1. From the current project, run and retain the JSON result:
   \`\`\`bash
   node "\${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" cleanup --project-dir "$PWD" --json
   \`\`\`
   Report \`remainingBytes\`. If the user explicitly requested removal of local workflow history too, run this before uninstalling:
   \`\`\`bash
   node "\${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" purge --project-dir "$PWD" --yes --json
   \`\`\`
2. Run:
   \`\`\`bash
   node "\${PLUGIN_ROOT}/skills/spectre-scope/scripts/ensure-codex-agents.mjs" --remove --json
   \`\`\`
3. If the helper reports \`collisions\`, stop and report the paths. Do not delete unowned files.
4. Run:
   \`\`\`bash
   codex plugin remove spectre@spectre
   \`\`\`

## DONE
Expired workflow data was cleaned, retained bytes were reported (or explicit purge completed), managed \`spectre_*.toml\` agents were removed or confirmed absent, the native plugin removal command completed, and no project knowledge/session data was deleted.
`;
}

function writeCodexOnlySkills(targetDir, keep) {
  const results = [];
  const skillDir = path.join(targetDir, 'spectre-uninstall-codex');
  const targetPath = path.join(skillDir, 'SKILL.md');
  const status = writeIfChanged(targetPath, codexUninstallSkill());
  keep.add(targetPath);
  results.push({ path: targetPath, status });
  return results;
}

function translate(canonicalRoot, codexRoot) {
  const sourceDir = path.join(canonicalRoot, 'skills');
  const targetDir = path.join(codexRoot, 'skills');
  const results = [];
  const keep = new Set();
  const agentNames = knownAgentNames(canonicalRoot);

  if (!fs.existsSync(sourceDir)) return results;

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const sourceSkillDir = path.join(sourceDir, entry.name);
    const skillPath = path.join(sourceSkillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    const targetSkillDir = path.join(targetDir, entry.name);
    results.push(...copyDirectory(sourceSkillDir, targetSkillDir, keep, agentNames));
  }

  results.push(...writeCodexOnlySkills(targetDir, keep));
  results.push(...removeStaleFiles(targetDir, keep));
  return results;
}

function verify(codexRoot) {
  const targetDir = path.join(codexRoot, 'skills');
  const results = [];

  if (!fs.existsSync(targetDir)) {
    return [{ path: targetDir, ok: false, error: 'Missing generated skills directory' }];
  }

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(targetDir, entry.name, 'SKILL.md');
    try {
      if (!fs.existsSync(skillPath)) throw new Error('Missing SKILL.md');

      const { frontmatter } = parseFrontmatter(fs.readFileSync(skillPath, 'utf8'), skillPath);
      if (!frontmatter.name) throw new Error('Missing required frontmatter field "name"');
      if (!frontmatter.description) throw new Error('Missing required frontmatter field "description"');
      if (frontmatter.name !== entry.name) {
        throw new Error(`Skill name "${frontmatter.name}" does not match directory "${entry.name}"`);
      }

      results.push({ path: skillPath, ok: true });
    } catch (error) {
      results.push({ path: skillPath, ok: false, error: error.message });
    }
  }

  if (results.length === 0) {
    results.push({ path: targetDir, ok: false, error: 'No generated skills found' });
  }

  return results;
}

module.exports = {
  parseFrontmatter,
  renderFrontmatter,
  rewriteCodexAgentRefs,
  rewriteCodexCommandRefs,
  rewriteProjectSkillPaths,
  rewriteSkillForCodex,
  rewriteTextForCodex,
  yamlScalar,
  translate,
  verify,
};
