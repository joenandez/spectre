'use strict';

const fs = require('fs');
const path = require('path');

function packageMetadata(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
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

function buildPluginManifest(repoRoot) {
  const metadata = packageMetadata(repoRoot);
  return {
    name: 'spectre',
    version: metadata.version,
    description: metadata.description,
    author: {
      name: 'Joe Fernandez',
      email: 'joe@bycodename.com',
    },
    homepage: metadata.homepage || 'https://github.com/joenandez/spectre#readme',
    repository: metadata.repository?.url || 'https://github.com/joenandez/spectre',
    license: metadata.license || 'MIT',
    keywords: metadata.keywords || [],
    interface: {
      displayName: 'Spectre',
      shortDescription: 'Contract-driven workflow prompts for coding agents',
      longDescription:
        'Spectre provides compact workflow skills, plugin-root hooks, a size-bounded SessionStart knowledge registry with neutral exact-ID search/load, and managed Codex custom-agent setup.',
      developerName: 'Joe Fernandez',
      category: 'Developer Tools',
      capabilities: ['Interactive', 'Write'],
      websiteURL: metadata.homepage || 'https://github.com/joenandez/spectre',
      defaultPrompt: [
        'Use $spectre:spectre-scope to define a new feature, then continue through the Spectre workflow.',
      ],
      brandColor: '#2F5D50',
    },
  };
}

function translate(canonicalRoot, codexRoot) {
  const repoRoot = path.resolve(canonicalRoot, '..', '..');
  const targetPath = path.join(codexRoot, '.codex-plugin', 'plugin.json');
  const manifest = buildPluginManifest(repoRoot);
  const status = writeIfChanged(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return [{ path: targetPath, status }];
}

function verify(codexRoot) {
  const manifestPath = path.join(codexRoot, '.codex-plugin', 'plugin.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== 'spectre') throw new Error('Manifest name must be "spectre"');
    if (!manifest.version) throw new Error('Manifest version is required');
    if ('skills' in manifest) throw new Error('Manifest must not declare a skills field');
    if ('agents' in manifest) throw new Error('Manifest must not declare an agents field');
    return [{ path: manifestPath, ok: true }];
  } catch (error) {
    return [{ path: manifestPath, ok: false, error: error.message }];
  }
}

module.exports = {
  buildPluginManifest,
  translate,
  verify,
};
