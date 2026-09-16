'use strict';

const fs = require('fs');
const path = require('path');
const {
  codexDefaultsForClaudeModel,
  defaultsForAgent,
} = require('./model-map.cjs');
const { rewriteUserCommandRefsForCodex } = require('./commands.cjs');

const REQUIRED_FIELDS = [
  'name',
  'description',
  'model',
  'model_reasoning_effort',
  'sandbox_mode',
  'developer_instructions',
];

const MANAGED_AGENT_MARKER = 'spectre-managed-codex-agent';

function parseMarkdownWithFrontmatter(source, filePath) {
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
    if (colon === -1) {
      throw new Error(`Invalid frontmatter line in ${filePath}: ${line}`);
    }

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

function toAgentFileName(name) {
  return `${toTomlAgentName(name)}.toml`;
}

function toTomlAgentName(name) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return normalized.startsWith('spectre_') ? normalized : `spectre_${normalized}`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlMultilineString(value) {
  return `"""${String(value).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`;
}

function renderToml(fields) {
  return [
    `# ${MANAGED_AGENT_MARKER}`,
    `name = ${tomlString(fields.name)}`,
    `description = ${tomlString(fields.description)}`,
    `model = ${tomlString(fields.model)}`,
    `model_reasoning_effort = ${tomlString(fields.model_reasoning_effort)}`,
    `sandbox_mode = ${tomlString(fields.sandbox_mode)}`,
    `developer_instructions = ${tomlMultilineString(fields.developer_instructions)}`,
    '',
  ].join('\n');
}

function parseToml(source) {
  const fields = {};
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) {
      throw new Error(`Invalid TOML line: ${line}`);
    }

    const key = match[1];
    let raw = match[2];

    if (raw.startsWith('"""')) {
      raw = raw.slice(3);
      const chunks = [];
      while (!raw.includes('"""')) {
        chunks.push(raw);
        index++;
        if (index >= lines.length) {
          throw new Error(`Unclosed multiline TOML string for ${key}`);
        }
        raw = lines[index];
      }
      const closeIndex = raw.indexOf('"""');
      chunks.push(raw.slice(0, closeIndex));
      fields[key] = chunks.join('\n');
    } else {
      fields[key] = JSON.parse(raw);
    }
  }

  return fields;
}

function buildAgentToml(source, filePath) {
  const { frontmatter, body } = parseMarkdownWithFrontmatter(source, filePath);
  const sourceName = frontmatter.name;

  if (!sourceName) {
    throw new Error(`Missing required agent frontmatter field "name" in ${filePath}`);
  }
  if (!frontmatter.description) {
    throw new Error(`Missing required agent frontmatter field "description" in ${filePath}`);
  }
  if (!frontmatter.model) {
    throw new Error(`Missing required agent frontmatter field "model" in ${filePath}`);
  }

  const defaults = defaultsForAgent(sourceName);
  const codexDefaults = codexDefaultsForClaudeModel(frontmatter.model);
  return renderToml({
    name: toTomlAgentName(sourceName),
    description: rewriteUserCommandRefsForCodex(frontmatter.description),
    ...codexDefaults,
    sandbox_mode: frontmatter.codex_sandbox_mode || defaults.sandbox_mode,
    developer_instructions: rewriteUserCommandRefsForCodex(body.trim()),
  });
}

function writeIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === content) return 'unchanged';
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return fs.existsSync(filePath) ? 'updated' : 'created';
}

function removeStaleFiles(dir, keep) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...removeStaleFiles(fullPath, keep));
      const remaining = fs.readdirSync(fullPath);
      if (remaining.length === 0) fs.rmdirSync(fullPath);
      continue;
    }

    if (entry.isFile() && !keep.has(fullPath)) {
      fs.unlinkSync(fullPath);
      results.push({ path: fullPath, status: 'removed' });
    }
  }

  return results;
}

function translate(canonicalRoot, codexRoot) {
  const sourceDir = path.join(canonicalRoot, 'agents');
  const targetDir = path.join(codexRoot, 'agents');
  const results = [];
  const keep = new Set();

  if (!fs.existsSync(sourceDir)) return results;

  for (const fileName of fs.readdirSync(sourceDir).sort()) {
    if (!fileName.endsWith('.md')) continue;

    const sourcePath = path.join(sourceDir, fileName);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const { frontmatter } = parseMarkdownWithFrontmatter(source, sourcePath);
    const targetPath = path.join(targetDir, toAgentFileName(frontmatter.name || path.basename(fileName, '.md')));
    const toml = buildAgentToml(source, sourcePath);

    const existed = fs.existsSync(targetPath);
    const status = writeIfChanged(targetPath, toml);
    keep.add(targetPath);
    results.push({ path: targetPath, sourcePath, status: status === 'updated' && !existed ? 'created' : status });
  }

  results.push(...removeStaleFiles(targetDir, keep));
  return results;
}

function verify(codexRoot) {
  const targetDir = path.join(codexRoot, 'agents');
  const results = [];

  if (!fs.existsSync(targetDir)) {
    return [{ path: targetDir, ok: false, error: 'Missing generated agents directory' }];
  }

  for (const fileName of fs.readdirSync(targetDir).sort()) {
    if (!fileName.endsWith('.toml')) continue;

    const filePath = path.join(targetDir, fileName);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const fields = parseToml(content);
      if (!content.includes(`# ${MANAGED_AGENT_MARKER}`)) {
        throw new Error(`Missing managed marker "${MANAGED_AGENT_MARKER}"`);
      }
      for (const field of REQUIRED_FIELDS) {
        if (!fields[field]) throw new Error(`Missing required field "${field}"`);
      }
      results.push({ path: filePath, ok: true });
    } catch (error) {
      results.push({ path: filePath, ok: false, error: error.message });
    }
  }

  if (results.length === 0) {
    results.push({ path: targetDir, ok: false, error: 'No generated agent TOML files found' });
  }

  return results;
}

module.exports = {
  buildAgentToml,
  MANAGED_AGENT_MARKER,
  parseMarkdownWithFrontmatter,
  parseToml,
  renderToml,
  toAgentFileName,
  toTomlAgentName,
  translate,
  verify,
};
