import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

import { refreshKnowledgeIndex } from '../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import { resolveProjectStore } from '../plugins/spectre/hooks/scripts/knowledge/store.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function collectFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(root);
  return files.sort();
}

test('packed npm artifact contains portable Claude and Codex knowledge runtimes with no retired surface', { concurrency: false }, async () => {
  const repoRoot = path.resolve('.');
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ).version;
  const packDir = makeTempDir('spectre-pack-');
  const projectDir = makeTempDir('spectre-pack-install-');
  const homeDir = makeTempDir('spectre-pack-home-');

  try {
    const packOutput = exec('npm', ['pack', '--pack-destination', packDir], { cwd: repoRoot }).trim();
    const tarball = path.join(packDir, packOutput.split('\n').at(-1));

    exec('npm', ['init', '-y'], { cwd: projectDir });
    exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: projectDir });

    const installedPackage = path.join(
      projectDir,
      'node_modules',
      '@codename_inc',
      'spectre',
    );
    const claudePluginRoot = path.join(installedPackage, 'plugins', 'spectre');
    const pluginRoot = path.join(installedPackage, 'plugins', 'spectre-codex');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'spectre');
    assert.equal(manifest.version, packageVersion);
    assert.equal('skills' in manifest, false);
    assert.equal('agents' in manifest, false);

    const marketplace = JSON.parse(
      fs.readFileSync(path.join(installedPackage, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
    );
    assert.equal(marketplace.plugins[0].source, './plugins/spectre-codex');
    assert.equal(marketplace.plugins[0].version, packageVersion);

    for (const relativePath of [
      'skills/spectre-scope/SKILL.md',
      'skills/spectre-scope/scripts/ensure-codex-agents.mjs',
      'skills/spectre-learn/scripts/register-knowledge.mjs',
      'skills/spectre-uninstall-codex/SKILL.md',
      'hooks/hooks.json',
      'hooks/scripts/bootstrap.mjs',
      'hooks/scripts/load-knowledge.mjs',
      'hooks/scripts/knowledge-cli.mjs',
      'hooks/scripts/workflow-cli.mjs',
      'hooks/scripts/workflow/store.mjs',
      'hooks/scripts/workflow/retention.mjs',
      'hooks/scripts/knowledge/activity.mjs',
      'hooks/scripts/knowledge/loader.mjs',
      'hooks/scripts/knowledge/preview.mjs',
      'hooks/scripts/knowledge/registry.mjs',
      'hooks/scripts/knowledge/search.mjs',
      'agents/spectre_dev.toml',
      'agents/spectre_web_research.toml',
    ]) {
      assert.ok(
        fs.existsSync(path.join(pluginRoot, relativePath)),
        `packed plugin is missing ${relativePath}`,
      );
    }
    assert.ok(fs.existsSync(path.join(claudePluginRoot, 'bin', 'spectre-workflow')));

    for (const root of [claudePluginRoot, pluginRoot]) {
      for (const relativePath of [
        'hooks/hooks.json',
        'hooks/scripts/load-knowledge.mjs',
        'hooks/scripts/knowledge-cli.mjs',
        'hooks/scripts/workflow-cli.mjs',
        'hooks/scripts/workflow/store.mjs',
        'hooks/scripts/workflow/retention.mjs',
        'hooks/scripts/knowledge/activity.mjs',
        'hooks/scripts/knowledge/loader.mjs',
        'hooks/scripts/knowledge/preview.mjs',
        'hooks/scripts/knowledge/registry.mjs',
        'hooks/scripts/knowledge/search.mjs',
      ]) {
        assert.ok(fs.existsSync(path.join(root, relativePath)), `packed host is missing ${relativePath}`);
      }
      const retiredPromptAdapter = ['hooks', 'scripts', `${['user', 'prompt', 'submit'].join('-')}.mjs`].join('/');
      const retiredRecallSkill = ['skills', `spectre-${'recall'}`].join('/');
      for (const relativePath of [
        retiredPromptAdapter,
        'hooks/scripts/knowledge/matcher.mjs',
        'hooks/scripts/runtime/sessions',
        retiredRecallSkill,
      ]) {
        assert.equal(fs.existsSync(path.join(root, relativePath)), false, `packed host retained ${relativePath}`);
      }
      const hostHooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
      assert.equal('UserPromptSubmit' in hostHooks.hooks, false);
    }

    const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(
      hooksConfig.hooks.SessionStart.flatMap(group => group.hooks)
        .map(hook => hook.command),
      [
        'node ${PLUGIN_ROOT}/hooks/scripts/bootstrap.mjs',
        'node ${PLUGIN_ROOT}/hooks/scripts/handoff-resume.mjs',
        'node ${PLUGIN_ROOT}/hooks/scripts/load-knowledge.mjs --host codex',
      ],
    );
    assert.equal('UserPromptSubmit' in hooksConfig.hooks, false);

    const agent = fs.readFileSync(path.join(pluginRoot, 'agents', 'spectre_dev.toml'), 'utf8');
    assert.match(agent, /^# spectre-managed-codex-agent/m);
    assert.match(agent, /^name = "spectre_dev"$/m);

    const pluginFiles = collectFiles(pluginRoot).map((filePath) => path.relative(pluginRoot, filePath));
    assert.equal(
      pluginFiles.some((relativePath) => /(?:^|\/)spectre-apply(?:\/|$)/.test(relativePath)),
      false,
    );
    assert.equal(
      pluginFiles.some((relativePath) => /(?:^|\/)spectre-guide(?:\/|$)/.test(relativePath)),
      false,
    );
    for (const filePath of collectFiles(pluginRoot)) {
      const content = fs.readFileSync(filePath, 'utf8');
      assert.doesNotMatch(content, /file:\/\//, `${filePath} should not contain package-cache file:// imports`);
      assert.doesNotMatch(
        content,
        new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${filePath} should not reference the repo checkout`,
      );
    }


    const spectreHome = path.join(homeDir, '.spectre-proof');
    const retrievalProject = path.join(homeDir, 'retrieval-project');
    fs.mkdirSync(retrievalProject, { recursive: true });
    const { storePath } = await resolveProjectStore(retrievalProject, { spectreHome });
    const recordId = 'feature-packed-neutral-cli';
    const recordDirectory = path.join(storePath, 'knowledge', recordId);
    fs.mkdirSync(path.join(recordDirectory, 'references'), { recursive: true });
    fs.writeFileSync(path.join(recordDirectory, 'record.json'), JSON.stringify({
      schemaVersion: 1,
      id: recordId,
      kind: 'knowledge',
      title: 'Packed neutral retrieval',
      summary: 'Use when proving packed neutral knowledge retrieval.',
      tags: ['packed-retrieval'],
      applicability: { scope: 'project' },
      provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' },
      relatedRecordIds: [],
      category: 'pattern',
      useWhen: 'Proving packed neutral knowledge retrieval.',
      content: 'SPECTRE_PACKED_CORE_SENTINEL',
      evidence: 'Packed artifact fixture.',
      status: 'active',
    }, null, 2));
    fs.writeFileSync(
      path.join(recordDirectory, 'references', 'proof.md'),
      'SPECTRE_PACKED_RESOURCE_SENTINEL\n',
    );
    fs.writeFileSync(path.join(storePath, 'tags.json'), JSON.stringify({
      schemaVersion: 1,
      tags: { 'packed-retrieval': { description: 'Packed retrieval checks.', aliases: [] } },
      redirects: {},
    }, null, 2));
    refreshKnowledgeIndex(storePath);

    const isolatedPath = path.join(homeDir, 'isolated-path');
    fs.mkdirSync(isolatedPath);
    fs.symlinkSync(process.execPath, path.join(isolatedPath, 'node'));
    assert.equal(
      fs.existsSync(path.join(retrievalProject, '.agents', 'skills', `spectre-${'recall'}`)),
      false,
    );
    let expectedLoads = 0;
    for (const root of [claudePluginRoot, pluginRoot]) {
      const bundledCli = path.join(root, 'hooks', 'scripts', 'knowledge-cli.mjs');
      const runBundled = (args) => spawnSync(process.execPath, [bundledCli, ...args], {
        cwd: retrievalProject,
        env: { ...process.env, SPECTRE_HOME: spectreHome, PATH: isolatedPath },
        encoding: 'utf8',
      });
      const host = root === claudePluginRoot ? 'claude' : 'codex';
      const activityPath = path.join(storePath, 'activity.json');
      const activityBeforePreview = fs.existsSync(activityPath)
        ? fs.readFileSync(activityPath)
        : null;
      const preview = runBundled([
        'registry',
        '--host',
        host,
        '--project-dir',
        retrievalProject,
        '--json',
      ]);
      assert.equal(preview.status, 0, preview.stderr);
      assert.match(preview.stdout, /\S/, `${host} registry returned no JSON: ${preview.stderr}`);
      const previewed = JSON.parse(preview.stdout);
      assert.equal(previewed.host, host);
      assert.equal(previewed.injected, true);
      assert.equal(previewed.measurement.ok, true);
      assert.deepEqual(previewed.includedRecords, []);
      assert.equal(previewed.includedCount, 1);
      assert.match(
        previewed.payload.hookSpecificOutput.additionalContext,
        /## Project knowledge[\s\S]*packed-retrieval/,
      );
      assert.doesNotMatch(
        previewed.payload.hookSpecificOutput.additionalContext,
        /SPECTRE_PACKED_CORE_SENTINEL/,
      );
      const activityAfterPreview = fs.existsSync(activityPath)
        ? fs.readFileSync(activityPath)
        : null;
      assert.deepEqual(activityAfterPreview, activityBeforePreview);
      const search = runBundled([
        'search',
        'packed neutral retrieval',
        '--project-dir',
        retrievalProject,
        '--json',
      ]);
      assert.equal(search.status, 0, search.stderr);
      assert.ok(JSON.parse(search.stdout).results.some(({ id }) => id === recordId));

      const load = runBundled([
        'load',
        recordId,
        '--project-dir',
        retrievalProject,
        '--json',
      ]);
      assert.equal(load.status, 0, load.stderr);
      const loaded = JSON.parse(load.stdout);
      expectedLoads += 1;
      assert.match(loaded.rendered, /SPECTRE_PACKED_CORE_SENTINEL/);
      assert.equal(loaded.recordDirectory, recordDirectory);
      assert.deepEqual(loaded.resources, [{
        relativePath: 'references/proof.md',
        absolutePath: path.join(recordDirectory, 'references', 'proof.md'),
      }]);
      assert.equal(loaded.activity.successfulLoads, expectedLoads);
    }

    const workflowHome = path.join(homeDir, '.spectre-workflow');
    const workflowSource = path.join(
      projectDir,
      '.spectre',
      'features',
      'packed-runtime',
      'specs',
      'tasks.json',
    );
    fs.mkdirSync(path.dirname(workflowSource), { recursive: true });
    fs.writeFileSync(workflowSource, JSON.stringify({
      meta: { schema_version: 1, feature_root: '.spectre/features/packed-runtime' },
      phases: [{
        id: '1',
        parents: [{ id: '1.1', status: 'pending', subtasks: [{ id: '1.1.1', status: 'pending' }] }],
      }],
    }));
    const workflowEnv = { ...process.env, SPECTRE_HOME: workflowHome };
    const workflowStart = spawnSync(process.execPath, [
      path.join(installedPackage, 'bin', 'spectre.js'),
      'workflow',
      'run',
      'start',
      '--source',
      workflowSource,
      '--project-dir',
      projectDir,
      '--json',
    ], { cwd: projectDir, env: workflowEnv, encoding: 'utf8' });
    assert.equal(workflowStart.status, 0, workflowStart.stderr);
    const workflowRun = JSON.parse(workflowStart.stdout);
    const packedMarker = spawnSync(process.execPath, [
      path.join(pluginRoot, 'hooks', 'scripts', 'workflow-cli.mjs'),
      'stage',
      'start',
      '--run-id',
      workflowRun.runId,
      '--actor-id',
      workflowRun.primaryActorId,
      '--project-dir',
      projectDir,
      '--json',
    ], { cwd: projectDir, env: workflowEnv, encoding: 'utf8' });
    assert.equal(packedMarker.status, 0, packedMarker.stderr);
    const packedStage = JSON.parse(packedMarker.stdout);
    assert.equal(packedStage.ok, true);
    assert.match(packedStage.eventId, /^evt_/);

    const codexHome = path.join(homeDir, '.codex');
    const result = spawnSync('npx', [
      '@codename_inc/spectre',
      'install',
      'codex',
      '--scope',
      'project',
      '--project-dir',
      projectDir,
      '--json',
    ], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: homeDir,
        CODEX_HOME: codexHome,
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).code, 'CODEX_PLUGIN_REQUIRED');
    assert.equal(fs.existsSync(codexHome), false);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
