#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrateLegacyKnowledge } from './knowledge/migration.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..');
const PLUGIN_ROOT = path.join(REPOSITORY_ROOT, 'plugins', 'spectre');
const require = createRequire(import.meta.url);

function makeTmp(t) {
  const root = fs.mkdtempSync(path.join('/tmp', 'spectre-knowledge-retirement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function addLegacySource(projectDir, nativeRoot, id, { managed = false, body = '# Historical\n' } = {}) {
  const sourceDir = path.join(projectDir, nativeRoot, 'skills', id);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), [
    '---', `name: ${id}`, `description: Use when consulting ${id}`,
    ...(managed ? ['metadata:', '  spectre-migration-origin: legacy-spectre-learning'] : []),
    '---', body, '',
  ].join('\n'));
  const registry = path.join(projectDir, nativeRoot, 'skills', 'spectre-recall', 'references', 'registry.toon');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.appendFileSync(registry, `${id}|feature|legacy retirement|Use when consulting ${id}\n`);
  return sourceDir;
}

function read(relativePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

describe('retired prompt-time knowledge delivery', () => {
  it('ships only the canonical SessionStart knowledge hook and no prompt runtime', () => {
    const hooks = JSON.parse(read('plugins/spectre/hooks/hooks.json'));
    assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart']);
    assert.equal(
      fs.existsSync(path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'user-prompt-submit.mjs')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'knowledge', 'matcher.mjs')),
      false,
    );
    assert.doesNotMatch(JSON.stringify(hooks), /UserPromptSubmit|user-prompt-submit/);
  });

  it('keeps registry budgeting but removes the registration-time prompt-body gate', () => {
    const registration = read('plugins/spectre/hooks/scripts/knowledge/registration.mjs');
    const registry = read('plugins/spectre/hooks/scripts/knowledge/registry.mjs');
    assert.doesNotMatch(registration, /measurePayload|validatePayloadSafe|KNOWLEDGE_PAYLOAD_UNSAFE/);
    assert.match(registry, /estimatePayloadTokens/);
    assert.match(registry, /SESSION_START_TOKEN_LIMIT\s*=\s*300/);
    assert.equal(
      fs.existsSync(path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'knowledge', 'payload.mjs')),
      true,
    );
  });
});

describe('retired active recall surface', () => {
  it('removes the canonical skill and expected-skill entry', () => {
    assert.equal(
      fs.existsSync(path.join(PLUGIN_ROOT, 'skills', 'spectre-recall', 'SKILL.md')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(
        PLUGIN_ROOT,
        'skills',
        'spectre-recall',
        'scripts',
        'search-knowledge.mjs',
      )),
      false,
    );
    const expected = read('.agents/skills/verify-spectre/references/expected-skills.txt')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    assert.equal(expected.includes('spectre-recall'), false);
  });

  it('rewrites retained Codex knowledge commands to the neutral bundled CLI', () => {
    const translators = [
      read('scripts/translators/skills.cjs'),
      read('scripts/translators/hooks.cjs'),
    ].join('\n');
    assert.doesNotMatch(translators, /spectre-recall|skills\/spectre-recall/);
    const skills = require(path.join(REPOSITORY_ROOT, 'scripts', 'translators', 'skills.cjs'));
    const hooks = require(path.join(REPOSITORY_ROOT, 'scripts', 'translators', 'hooks.cjs'));
    for (const command of ['search', 'load', 'register', 'migrate']) {
      const canonical = `spectre knowledge ${command}`;
      assert.match(
        skills.rewriteTextForCodex(canonical),
        new RegExp(`knowledge-cli\\.mjs["']? ${command}`),
      );
      assert.match(
        hooks.rewriteRuntimeScript(canonical),
        new RegExp(`knowledge-cli\\.mjs["']? ${command}`),
      );
    }
  });

  it('updates package and structural verification expectations to the replacement surface', () => {
    const packTest = read('src/pack.test.js');
    const structureGate = read('.agents/skills/verify-spectre/scripts/gate1_structure.mjs');
    assert.match(packTest, /hooks\/scripts\/knowledge-cli\.mjs/);
    assert.doesNotMatch(packTest, /skills\/spectre-recall|user-prompt-submit/);
    assert.match(packTest, /'UserPromptSubmit' in hooksConfig\.hooks, false/);
    assert.match(structureGate, /UserPromptSubmit/);
    assert.match(structureGate, /user-prompt-submit\.mjs/);
    assert.match(structureGate, /spectre-recall/);
  });
});

describe('provenance-gated legacy skill retirement', () => {
  it('preserves an unrelated user-authored legacy skill after import', async (t) => {
    const root = makeTmp(t);
    const projectDir = path.join(root, 'project');
    const storePath = path.join(root, 'store');
    const sourceDir = addLegacySource(projectDir, '.claude', 'user-authored');

    await migrateLegacyKnowledge({ projectDir, storePath });
    assert.equal(fs.existsSync(path.join(sourceDir, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(storePath, 'knowledge', 'user-authored', 'record.json')), true);
  });

  it('retires only a managed copy after its imported package, archive, and receipt verify', async (t) => {
    const root = makeTmp(t);
    const projectDir = path.join(root, 'project');
    const storePath = path.join(root, 'store');
    const managed = addLegacySource(projectDir, '.claude', 'managed-copy', { managed: true });
    const user = addLegacySource(projectDir, '.claude', 'neighbor-skill');

    const result = await migrateLegacyKnowledge({ projectDir, storePath });
    assert.equal(fs.existsSync(managed), false);
    assert.equal(fs.existsSync(user), true);
    assert.deepEqual(result.retirement.map(({ code }) => code), ['RETIRED']);
  });

  it('keeps a managed copy and reports recovery guidance when its import cannot verify', async (t) => {
    const root = makeTmp(t);
    const projectDir = path.join(root, 'project');
    const storePath = path.join(root, 'store');
    const managed = addLegacySource(projectDir, '.agents', 'unverified-copy', { managed: true });
    const { retireManagedLegacyCopies } = await import('./knowledge/migration.mjs');

    const result = await retireManagedLegacyCopies({ projectDir, storePath });
    assert.equal(fs.existsSync(managed), true);
    assert.equal(result[0].code, 'PRESERVED');
    assert.match(result[0].message, /import.*archive.*receipt/i);
  });

  it('retires duplicate managed copies with one imported work record', async (t) => {
    const root = makeTmp(t);
    const projectDir = path.join(root, 'project');
    const storePath = path.join(root, 'store');
    const first = addLegacySource(projectDir, '.claude', 'managed-duplicate', { managed: true });
    const second = addLegacySource(projectDir, '.agents', 'managed-duplicate', { managed: true });

    await migrateLegacyKnowledge({ projectDir, storePath });
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), false);
    assert.deepEqual(fs.readdirSync(path.join(storePath, 'knowledge')), ['managed-duplicate']);
  });
});
