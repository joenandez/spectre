import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const evaluatorPath = join(repositoryRoot, "scripts", "evaluate-task-review.mjs");
const fakeReviewerPath = join(
  testDirectory,
  "fixtures",
  "fake-reviewer.mjs",
);
const fixtureRoot = join(
  testDirectory,
  "..",
  "fixtures",
  "task-review",
  "knowledge-surfacing-before",
);
const priceBasisPath = join(fixtureRoot, "pricing", "basis.json");
const variants = [
  "baseline-opus-max",
  "candidate-opus-medium",
  "candidate-sol-medium",
];
const shaPattern = /^[a-f0-9]{64}$/;

async function implementation() {
  return import(`${new URL(`file://${evaluatorPath}`).href}?t=${Date.now()}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function freezeId(freeze) {
  return `freeze-${
    sha256(canonicalJson({ ...freeze, freeze_id: null })).slice(0, 16)
  }`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes);
  return sha256(bytes);
}

function staticSchedule() {
  const ordering = [
    [
      "candidate-sol-medium",
      "baseline-opus-max",
      "candidate-opus-medium",
    ],
    [
      "baseline-opus-max",
      "candidate-sol-medium",
      "candidate-opus-medium",
    ],
    [
      "candidate-opus-medium",
      "baseline-opus-max",
      "candidate-sol-medium",
    ],
  ];
  return {
    schema_version: "task-review-paired-schedule/v1",
    seed: "paired-gate-seed-v1",
    variants,
    blocks: ordering.map((blockVariants, blockIndex) => ({
      block: blockIndex + 1,
      trials: blockVariants.map((variant, sequence) => ({
        sequence: sequence + 1,
        variant,
        trial_id: `b${String(blockIndex + 1).padStart(2, "0")}-s${String(
          sequence + 1,
        ).padStart(2, "0")}-${variant}-a01`,
      })),
    })),
  };
}

function observed(value, label = null) {
  return {
    value,
    source: "fake-runtime",
    ...(label ? { label } : {}),
    unavailable_reason: null,
  };
}

function makeRun({
  block,
  variant,
  sequence,
  trialId,
  scheduleHash,
  freezeHash,
  freeze,
}) {
  const variantIndex = variants.indexOf(variant);
  const totalMs = [100, 60, 80][variantIndex] + (block - 1) * 10;
  const totalTokens = [1_000, 700, 800][variantIndex] + block * 10;
  const inputTokens = totalTokens - 300;
  const outputTokens = 250;
  const reasoningTokens = 50;
  const actualCost = [1, 0.6, 0.8][variantIndex] + (block - 1) * 0.1;
  const estimatedCost =
    [1.2, 0.7, 0.9][variantIndex] + (block - 1) * 0.1;
  const protectedHashes = {
    "specs/plan.md": "plan-hash",
    "specs/execute.md": "execute-hash",
    "specs/tasks.json": "tasks-hash",
  };
  const claudeRoute = variant !== "candidate-sol-medium";
  const startedAt = new Date(
    Date.UTC(2026, 6, 23, block, sequence * 2),
  ).toISOString();
  const endedAt = new Date(
    Date.UTC(2026, 6, 23, block, sequence * 2, 1),
  ).toISOString();

  return {
    schema_version: "task-review-evaluation-result/v1",
    id: trialId,
    trial: trialId,
    attempt_id: trialId,
    attempt: 1,
    block,
    variant,
    status: "valid",
    freeze_manifest_sha256: freezeHash,
    schedule_sha256: scheduleHash,
    versions: {
      evaluator: freeze.versions.evaluator,
      node: freeze.versions.node,
      reviewer_cli: observed(
        claudeRoute
          ? freeze.versions.reviewer_clis.claude
          : freeze.versions.reviewer_clis.codex,
      ),
    },
    route: claudeRoute
      ? {
        primary_runtime: "codex",
        reviewer_runtime: "claude-code",
        model: "claude-opus-5-5",
        effort: variant === "baseline-opus-max" ? "max" : "medium",
        invocation_route: "Codex -> Claude Code",
      }
      : {
        primary_runtime: "claude-code",
        reviewer_runtime: "codex",
        model: "gpt-6-sol",
        effort: "medium",
        invocation_route: "Claude Code -> Codex",
      },
    hashes: {
      fixture_manifest: freeze.hashes.fixture_manifest,
      fixture_components: freeze.hashes.fixture_components,
      contract:
        variant === "baseline-opus-max"
          ? freeze.hashes.contracts.baseline
          : freeze.hashes.contracts.candidate,
      prompt: "a".repeat(64),
      normalized_prompt: freeze.hashes.normalized_prompts[variant],
      price_basis: freeze.hashes.price_basis,
      environment: "b".repeat(64),
    },
    quiescence: {
      clean: true,
      pre: { clean: true, contaminants: [] },
      continuous: { clean: true, contaminants: [], samples: 2 },
      post: { clean: true, contaminants: [] },
      owned_reviewer_tree_excluded: true,
      sampling: {
        clean: true,
        sample_count: 4,
        interval_ms: 250,
        started_at: "2026-07-23T00:00:00.000Z",
        ended_at: "2026-07-23T00:00:01.000Z",
        elapsed_ms: 1000,
        contaminants: [],
      },
    },
    isolation: {
      execution_isolated: true,
      oracle_present: false,
      contamination: {
        live_repository_accessible_from_workspace_ancestors: false,
        oracle_present: false,
      },
    },
    validity: {
      first_pass: variantIndex !== 1 || block !== 2,
      report: true,
      inputs_unchanged: true,
      allowed_writes: true,
    },
    protected_inputs: {
      before: protectedHashes,
      after: protectedHashes,
    },
    process: {
      command: claudeRoute ? "claude" : "codex",
      args: ["review"],
      exit_code: 0,
      signal: null,
      timed_out: false,
      timeout_ms: 1200000,
      launched: true,
      attempts:
        variantIndex === 1 && (block === 2 || block === 3) ? 2 : 1,
      retries: variantIndex === 1 && block === 2 ? 1 : 0,
      repairs: variantIndex === 1 && block === 3 ? 1 : 0,
      fallback: observed(variantIndex === 2 && block === 3 ? "native" : null),
    },
    authentication: {
      claude: claudeRoute
        ? {
          checked: true,
          logged_in: true,
          auth_method: "claude.ai",
          api_provider: "firstParty",
          source: "default-secure-storage",
          unavailable_reason: null,
        }
        : {
          checked: false,
          logged_in: null,
          auth_method: null,
          api_provider: null,
          source: "not-applicable",
          unavailable_reason: "The selected reviewer runtime is not Claude Code.",
        },
    },
    lock: {
      path: "/private/tmp/task-review-paired-gate.lock",
      exclusive: true,
      attestation: {
        pid: 1234,
        trial: trialId,
        variant,
        started_at: startedAt,
      },
    },
    timing: {
      started_at: startedAt,
      ended_at: endedAt,
      total_ms: totalMs,
      intervals: {
        preflight_ms: 5,
        reviewer_ms: totalMs - 10,
        repair_fallback_ms: variantIndex === 1 && block === 3 ? 5 : 0,
        validation_ms: 5,
      },
    },
    telemetry: {
      tokens: {
        input: observed(inputTokens),
        cached_input: observed(100),
        cache_write_input: observed(0),
        output: observed(outputTokens),
        reasoning_output: observed(reasoningTokens),
        total: observed(totalTokens),
      },
      cost: {
        actual_runtime_usd: observed(actualCost, "actual"),
        estimated_token_usd: observed(estimatedCost, "estimate"),
      },
      tool_calls: observed(10 - variantIndex),
      messages: observed(5 + variantIndex),
      retries: observed(0),
      timing: {
        runtime_duration_ms: observed(totalMs - 10),
      },
    },
    quality: {
      recall_by_severity: {
        Blocker: 1,
        High: variantIndex === 0 ? 1 : 0.8,
        Medium: variantIndex === 2 ? 0.7 : 0.8,
        Low: 0.5,
      },
      weighted_recall: variantIndex === 0 ? 0.95 : 0.9,
      supported_precision: variantIndex === 2 ? 0.85 : 0.9,
      duplicate_count: variantIndex,
      severity_drift: Array.from({ length: variantIndex }),
      false_scope_change_count: variantIndex === 2 ? 1 : 0,
      unmatched_known: Array.from({ length: variantIndex + 1 }, (_, index) => ({
        id: `known-${index + 1}`,
        severity: index === 0 ? "High" : "Medium",
      })),
      unmatched_candidates: Array.from(
        { length: variantIndex },
        (_, index) => ({
          id: `candidate-${index + 1}`,
          status: "supported",
          route_blind: true,
        }),
      ),
    },
  };
}

async function writeCountedBundle(root, mutate = () => {}) {
  const schedulePath = join(root, "schedule.json");
  const scheduleHash = await writeJson(schedulePath, staticSchedule());
  const freezePath = join(root, "freeze.json");
  const freeze = {
    schema_version: "task-review-evaluation-freeze/v1",
    freeze_id: null,
    versions: {
      evaluator: "evaluate-task-review/v1",
      node: process.version,
      reviewer_clis: {
        claude: "fake-claude 1.0.0",
        codex: "fake-codex 1.0.0",
      },
    },
    repository: {
      commit: "c".repeat(40),
      dirty: true,
      dirty_diff_sha256: "d".repeat(64),
    },
    hashes: {
      evaluator: "1".repeat(64),
      fixture_manifest: "2".repeat(64),
      fixture_components: "3".repeat(64),
      contracts: {
        baseline: "4".repeat(64),
        candidate: "5".repeat(64),
      },
      price_basis: "6".repeat(64),
      skills: {
        canonical: "7".repeat(64),
        generated: "8".repeat(64),
      },
      helpers: {
        canonical: "9".repeat(64),
        generated: "a".repeat(64),
      },
      normalized_prompts: {
        "baseline-opus-max": "b".repeat(64),
        "candidate-opus-medium": "c".repeat(64),
        "candidate-sol-medium": "d".repeat(64),
      },
    },
  };
  freeze.freeze_id = freezeId(freeze);
  const freezeHash = await writeJson(freezePath, freeze);
  const records = [];
  const schedule = staticSchedule();

  for (let block = 1; block <= 3; block += 1) {
    for (const variant of variants) {
      const trialId = schedule.blocks[block - 1].trials.find(
        (trial) => trial.variant === variant,
      ).trial_id;
      const sequence = schedule.blocks[block - 1].trials.find(
        (trial) => trial.variant === variant,
      ).sequence;
      const run = makeRun({
        block,
        variant,
        sequence,
        trialId,
        scheduleHash,
        freezeHash,
        freeze,
      });
      const path = join(root, "runs", run.trial, "result.json");
      const hash = await writeJson(path, run);
      records.push({
        trial_id: run.trial,
        attempt_id: run.attempt_id,
        result: relative(root, path),
        sha256: hash,
      });
    }
  }

  const bundle = {
    root,
    schedulePath,
    scheduleHash,
    freezePath,
    freezeHash,
    freeze,
    manifest: {
      schema_version: "task-review-counted-results/v1",
      freeze_manifest_sha256: freezeHash,
      schedule_sha256: scheduleHash,
      results: records,
    },
  };
  await mutate(bundle);
  const manifestPath = join(root, "counted-results.json");
  await writeJson(manifestPath, bundle.manifest);
  return { ...bundle, manifestPath };
}

async function rebindBundleFreeze(bundle, mutateFreeze) {
  const freeze = JSON.parse(await readFile(bundle.freezePath, "utf8"));
  await mutateFreeze(freeze);
  freeze.freeze_id = freezeId(freeze);
  const freezeHash = await writeJson(bundle.freezePath, freeze);
  bundle.manifest.freeze_manifest_sha256 = freezeHash;
  for (const entry of bundle.manifest.results) {
    const path = join(bundle.root, entry.result);
    const run = JSON.parse(await readFile(path, "utf8"));
    run.freeze_manifest_sha256 = freezeHash;
    entry.sha256 = await writeJson(path, run);
  }
}

async function summarizeBundle(runCli, bundle, output) {
  return runCli([
    "summarize",
    "--counted-results",
    bundle.manifestPath,
    "--freeze",
    bundle.freezePath,
    "--schedule",
    bundle.schedulePath,
    "--output",
    output,
  ]);
}

test("schedule persists a deterministic seed-derived 3x3 order with unique trial IDs and refuses overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-paired-schedule-"));
  try {
    const { runCli } = await implementation();
    const firstPath = join(root, "schedule.json");
    const secondPath = join(root, "schedule-copy.json");
    const first = await runCli([
      "schedule",
      "--seed",
      "paired-gate-seed-v1",
      "--output",
      firstPath,
    ]);
    const second = await runCli([
      "schedule",
      "--seed",
      "paired-gate-seed-v1",
      "--output",
      secondPath,
    ]);

    assert.deepEqual(first, staticSchedule());
    assert.deepEqual(second, first);
    assert.deepEqual(
      JSON.parse(await readFile(firstPath, "utf8")),
      first,
    );
    const trialIds = first.blocks.flatMap((block) =>
      block.trials.map(({ trial_id: trialId }) => trialId)
    );
    assert.equal(trialIds.length, 9);
    assert.equal(new Set(trialIds).size, 9);
    for (const block of first.blocks) {
      assert.deepEqual(
        [...block.trials].sort((left, right) =>
          left.sequence - right.sequence
        ).map(({ variant }) => variant),
        staticSchedule().blocks[block.block - 1].trials.map(
          ({ variant }) => variant,
        ),
      );
      assert.deepEqual(
        [...block.trials].map(({ variant }) => variant).sort(),
        [...variants].sort(),
      );
    }

    const before = await readFile(firstPath);
    await assert.rejects(
      runCli([
        "schedule",
        "--seed",
        "different-seed",
        "--output",
        firstPath,
      ]),
      /schedule output already exists|refus(?:e|ing).*overwrite/i,
    );
    assert.deepEqual(await readFile(firstPath), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paired run records a visible later attempt without changing its immutable scheduled slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-paired-attempt-"));
  const previousClaudeBinary = process.env.CLAUDE_BIN;
  const previousCodexBinary = process.env.CODEX_BIN;
  process.env.CLAUDE_BIN = fakeReviewerPath;
  process.env.CODEX_BIN = fakeReviewerPath;
  await chmod(fakeReviewerPath, 0o755);
  try {
    const { runCli } = await implementation();
    const freezePath = join(root, "freeze.json");
    const schedulePath = join(root, "schedule.json");
    await runCli([
      "freeze",
      "--fixture",
      fixtureRoot,
      "--price-basis",
      priceBasisPath,
      "--output",
      freezePath,
    ]);
    const schedule = await runCli([
      "schedule",
      "--seed",
      "paired-gate-seed-v1",
      "--output",
      schedulePath,
    ]);
    const scheduled = schedule.blocks
      .flatMap((block) =>
        block.trials.map((trial) => ({ ...trial, block: block.block }))
      )
      .find((trial) => trial.variant === "baseline-opus-max");
    const attemptId = scheduled.trial_id.replace(/-a01$/, "-a02");
    await mkdir(join(root, "runs"));
    const result = await runCli([
      "run",
      "--fixture",
      fixtureRoot,
      "--variant",
      scheduled.variant,
      "--trial",
      scheduled.trial_id,
      "--attempt",
      "2",
      "--block",
      String(scheduled.block),
      "--output-dir",
      join(root, "runs", attemptId),
      "--lock-file",
      join(root, "paired.lock"),
      "--price-basis",
      priceBasisPath,
      "--freeze",
      freezePath,
      "--schedule",
      schedulePath,
      "--reviewer-command",
      fakeReviewerPath,
      "--reviewer-arg",
      "scored-report",
      "--timeout-ms",
      "1000",
    ], {
      processSnapshot() {
        return [{
          pid: process.pid,
          ppid: 1,
          command: "node evaluate-task-review.mjs",
        }];
      },
    });

    assert.equal(result.status, "valid");
    assert.equal(result.trial, scheduled.trial_id);
    assert.equal(result.id, attemptId);
    assert.equal(result.attempt_id, attemptId);
    assert.equal(result.attempt, 2);
    assert.equal(result.lock.attestation.trial, attemptId);
    assert.equal(
      JSON.parse(
        await readFile(join(root, "runs", attemptId, "result.json"), "utf8"),
      ).attempt_id,
      attemptId,
    );
  } finally {
    if (previousClaudeBinary === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaudeBinary;
    if (previousCodexBinary === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBinary;
    await rm(root, { recursive: true, force: true });
  }
});

test("freeze persists every immutable comparison input and refuses overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-paired-freeze-"));
  const previousClaudeBinary = process.env.CLAUDE_BIN;
  const previousCodexBinary = process.env.CODEX_BIN;
  process.env.CLAUDE_BIN = fakeReviewerPath;
  process.env.CODEX_BIN = fakeReviewerPath;
  await chmod(fakeReviewerPath, 0o755);
  try {
    const { runCli } = await implementation();
    const output = join(root, "freeze.json");
    const freeze = await runCli([
      "freeze",
      "--fixture",
      fixtureRoot,
      "--price-basis",
      priceBasisPath,
      "--output",
      output,
    ]);

    assert.equal(freeze.schema_version, "task-review-evaluation-freeze/v1");
    assert.equal(freeze.versions.evaluator, "evaluate-task-review/v1");
    assert.equal(freeze.versions.node, process.version);
    assert.equal(freeze.versions.reviewer_clis.claude, "fake-reviewer 1.0.0");
    assert.equal(freeze.versions.reviewer_clis.codex, "fake-reviewer 1.0.0");
    assert.match(freeze.repository.commit, /^[a-f0-9]{40}$/);
    assert.equal(typeof freeze.repository.dirty, "boolean");
    assert.match(freeze.repository.dirty_diff_sha256, shaPattern);
    assert.equal(
      freeze.repository.comparison_binding,
      "protected-input-hashes",
    );

    for (const path of [
      ["hashes", "evaluator"],
      ["hashes", "fixture_manifest"],
      ["hashes", "fixture_components"],
      ["hashes", "contracts", "baseline"],
      ["hashes", "contracts", "candidate"],
      ["hashes", "price_basis"],
      ["hashes", "skills", "canonical"],
      ["hashes", "skills", "generated"],
      ["hashes", "helpers", "canonical"],
      ["hashes", "helpers", "generated"],
      ["hashes", "normalized_prompts", "baseline-opus-max"],
      ["hashes", "normalized_prompts", "candidate-opus-medium"],
      ["hashes", "normalized_prompts", "candidate-sol-medium"],
    ]) {
      let value = freeze;
      for (const key of path) value = value?.[key];
      assert.match(value, shaPattern, `missing frozen hash ${path.join(".")}`);
    }
    assert.deepEqual(
      JSON.parse(await readFile(output, "utf8")),
      freeze,
    );

    const before = await readFile(output);
    await assert.rejects(
      runCli([
        "freeze",
        "--fixture",
        fixtureRoot,
        "--price-basis",
        priceBasisPath,
        "--output",
        output,
      ]),
      /freeze output already exists|refus(?:e|ing).*overwrite/i,
    );
    assert.deepEqual(await readFile(output), before);

    const schedulePath = join(root, "schedule.json");
    const schedule = await runCli([
      "schedule",
      "--seed",
      "paired-gate-seed-v1",
      "--output",
      schedulePath,
    ]);
    const scheduled = schedule.blocks
      .flatMap((block) =>
        block.trials.map((trial) => ({ ...trial, block: block.block }))
      )
      .find((trial) => trial.variant === "baseline-opus-max");

    const provenanceDriftPath = join(root, "freeze-provenance-drift.json");
    const provenanceDrift = {
      ...freeze,
      repository: {
        ...freeze.repository,
        commit: "0".repeat(40),
        dirty: !freeze.repository.dirty,
        dirty_diff_sha256: "f".repeat(64),
      },
    };
    provenanceDrift.freeze_id = freezeId(provenanceDrift);
    await writeJson(provenanceDriftPath, provenanceDrift);
    const provenanceDriftRun = await runCli([
      "run",
      "--fixture",
      fixtureRoot,
      "--variant",
      scheduled.variant,
      "--trial",
      scheduled.trial_id,
      "--block",
      String(scheduled.block),
      "--output-dir",
      join(root, "provenance-drift-run"),
      "--lock-file",
      join(root, "provenance-drift.lock"),
      "--price-basis",
      priceBasisPath,
      "--freeze",
      provenanceDriftPath,
      "--schedule",
      schedulePath,
      "--reviewer-command",
      fakeReviewerPath,
      "--reviewer-arg",
      "scored-report",
      "--timeout-ms",
      "1000",
    ]);
    assert.equal(
      provenanceDriftRun.freeze_manifest_sha256,
      sha256(await readFile(provenanceDriftPath)),
    );
    assert.equal(provenanceDriftRun.trial, scheduled.trial_id);

    const versionMismatchPath = join(root, "freeze-version-mismatch.json");
    await writeJson(versionMismatchPath, {
      ...freeze,
      versions: {
        ...freeze.versions,
        reviewer_clis: {
          ...freeze.versions.reviewer_clis,
          claude: "different-claude-version",
        },
      },
    });
    await assert.rejects(
      runCli([
        "run",
        "--fixture",
        fixtureRoot,
        "--variant",
        scheduled.variant,
        "--trial",
        scheduled.trial_id,
        "--block",
        String(scheduled.block),
        "--output-dir",
        join(root, "version-mismatch-run"),
        "--lock-file",
        join(root, "version-mismatch.lock"),
        "--price-basis",
        priceBasisPath,
        "--freeze",
        versionMismatchPath,
        "--schedule",
        schedulePath,
        "--reviewer-command",
        fakeReviewerPath,
        "--reviewer-arg",
        "scored-report",
        "--timeout-ms",
        "1000",
      ]),
      /freeze reviewer CLI version mismatch/i,
    );
  } finally {
    if (previousClaudeBinary === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaudeBinary;
    if (previousCodexBinary === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBinary;
    await rm(root, { recursive: true, force: true });
  }
});

test("quiescence uses injected pre/continuous/post snapshots, excludes the owned reviewer tree, and marks external work contaminated", async () => {
  const { assessQuiescence } = await implementation();
  assert.equal(
    typeof assessQuiescence,
    "function",
    "the evaluator must expose process-snapshot quiescence assessment",
  );
  const ownedOnly = assessQuiescence({
    evaluator_pid: 100,
    reviewer_pid: 200,
    snapshots: {
      pre: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
      ],
      continuous: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
        { pid: 200, ppid: 100, command: "claude --output-format stream-json" },
        { pid: 201, ppid: 200, command: "claude helper" },
      ],
      post: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
      ],
    },
  });
  assert.equal(ownedOnly.clean, true);
  assert.equal(ownedOnly.owned_reviewer_tree_excluded, true);
  assert.deepEqual(ownedOnly.pre.contaminants, []);
  assert.deepEqual(ownedOnly.continuous.contaminants, []);
  assert.deepEqual(ownedOnly.post.contaminants, []);

  const contaminated = assessQuiescence({
    evaluator_pid: 100,
    reviewer_pid: 200,
    snapshots: {
      pre: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
      ],
      continuous: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
        { pid: 200, ppid: 100, command: "codex exec" },
        { pid: 201, ppid: 200, command: "codex helper" },
        { pid: 300, ppid: 1, command: "node --test unrelated.test.mjs api_key=private" },
        { pid: 301, ppid: 1, command: "codex exec --prompt refresh_token=private" },
      ],
      post: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
      ],
    },
  });
  assert.equal(contaminated.clean, false);
  assert.deepEqual(
    contaminated.continuous.contaminants.map(({ pid }) => pid),
    [300, 301],
  );
  assert.equal(contaminated.continuous.contaminants[0].command, "node --test");
  assert.equal(contaminated.continuous.contaminants[1].command, "codex exec");
  assert.equal(
    contaminated.continuous.contaminants.some(({ pid }) =>
      [200, 201].includes(pid)
    ),
    false,
  );

  const metadataProbes = assessQuiescence({
    evaluator_pid: 100,
    reviewer_pid: 200,
    snapshots: {
      pre: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
        { pid: 401, ppid: 1, command: "claude --version" },
        { pid: 402, ppid: 1, command: "claude auth status --json" },
        { pid: 403, ppid: 1, command: "codex --version" },
      ],
      continuous: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
        { pid: 404, ppid: 1, command: "/usr/local/bin/claude --version" },
      ],
      post: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
      ],
    },
  });
  assert.equal(
    metadataProbes.clean,
    true,
    "read-only CLI metadata probes must not invalidate a timed model run",
  );

  const missingSamples = assessQuiescence({
    evaluator_pid: 100,
    reviewer_pid: 200,
    snapshots: { pre: [], continuous: [], post: [] },
  });
  assert.equal(
    missingSamples.clean,
    false,
    "missing process samples must fail closed",
  );

  const repositoryHeavyWork = assessQuiescence({
    evaluator_pid: 100,
    reviewer_pid: 200,
    snapshots: {
      pre: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
      ],
      continuous: [
        {
          pid: 301,
          ppid: 1,
          command: "node scripts/sync-codex.cjs --check",
        },
        {
          pid: 302,
          ppid: 1,
          command: "node .agents/skills/verify-spectre/scripts/verify.mjs",
        },
      ],
      post: [
        { pid: 100, ppid: 1, command: "node evaluate-task-review.mjs" },
      ],
    },
  });
  assert.equal(repositoryHeavyWork.clean, false);
  assert.deepEqual(
    repositoryHeavyWork.continuous.contaminants.map(({ pid }) => pid),
    [301, 302],
  );
});

test("paired quiescence spans preflight through validation and prevents spend when the pre-snapshot is contaminated", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-full-quiescence-"));
  const previousClaudeBinary = process.env.CLAUDE_BIN;
  const previousCodexBinary = process.env.CODEX_BIN;
  process.env.CLAUDE_BIN = fakeReviewerPath;
  process.env.CODEX_BIN = fakeReviewerPath;
  await chmod(fakeReviewerPath, 0o755);
  try {
    const { runCli } = await implementation();
    const freezePath = join(root, "freeze.json");
    const schedulePath = join(root, "schedule.json");
    await runCli([
      "freeze",
      "--fixture",
      fixtureRoot,
      "--price-basis",
      priceBasisPath,
      "--output",
      freezePath,
    ]);
    const schedule = await runCli([
      "schedule",
      "--seed",
      "paired-gate-seed-v1",
      "--output",
      schedulePath,
    ]);
    const scheduled = schedule.blocks
      .flatMap((block) =>
        block.trials.map((trial) => ({ ...trial, block: block.block }))
      )
      .find((trial) => trial.variant === "baseline-opus-max");
    const common = [
      "--fixture",
      fixtureRoot,
      "--variant",
      scheduled.variant,
      "--trial",
      scheduled.trial_id,
      "--block",
      String(scheduled.block),
      "--price-basis",
      priceBasisPath,
      "--freeze",
      freezePath,
      "--schedule",
      schedulePath,
      "--reviewer-command",
      fakeReviewerPath,
      "--reviewer-arg",
      "scored-report",
      "--timeout-ms",
      "1000",
    ];

    let phase = "preflight";
    const preflightBlocked = await runCli([
      "run",
      ...common,
      "--output-dir",
      join(root, "preflight-contaminated"),
      "--lock-file",
      join(root, "preflight.lock"),
    ], {
      beforeReviewer() {
        phase = "reviewer";
      },
      processSnapshot() {
        return [
          {
            pid: process.pid,
            ppid: 1,
            command: "node evaluate-task-review.mjs",
          },
          ...(phase === "preflight"
            ? [{
              pid: 9001,
              ppid: 1,
              command: "node --test competing.test.mjs",
            }]
            : []),
        ];
      },
    });
    assert.equal(preflightBlocked.status, "blocked");
    assert.equal(preflightBlocked.quiescence.clean, false);
    assert.equal(
      preflightBlocked.process.launched,
      false,
      "a dirty pre-snapshot must prevent reviewer spend",
    );

    phase = "preflight";
    const validationBlocked = await runCli([
      "run",
      ...common,
      "--output-dir",
      join(root, "validation-contaminated"),
      "--lock-file",
      join(root, "validation.lock"),
    ], {
      beforeReviewer() {
        phase = "reviewer";
      },
      async beforeValidation() {
        phase = "validation";
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      },
      processSnapshot() {
        return [
          {
            pid: process.pid,
            ppid: 1,
            command: "node evaluate-task-review.mjs",
          },
          ...(phase === "validation"
            ? [{
              pid: 9002,
              ppid: 1,
              command: "node scripts/sync-codex.cjs --check",
            }]
            : []),
        ];
      },
    });
    assert.equal(validationBlocked.status, "blocked");
    assert.equal(validationBlocked.quiescence.clean, false);
    assert.ok(
      validationBlocked.quiescence.sampling.contaminants.some(
        ({ pid }) => pid === 9002,
      ),
    );
  } finally {
    if (previousClaudeBinary === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaudeBinary;
    if (previousCodexBinary === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBinary;
    await rm(root, { recursive: true, force: true });
  }
});

test("run persists structured runtime retry events for paired aggregation", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-runtime-retry-"));
  await chmod(fakeReviewerPath, 0o755);
  try {
    const { runCli } = await implementation();
    const result = await runCli([
      "run",
      "--fixture",
      fixtureRoot,
      "--variant",
      "candidate-opus-medium",
      "--trial",
      "runtime-retry",
      "--output-dir",
      join(root, "run"),
      "--lock-file",
      join(root, "evaluation.lock"),
      "--price-basis",
      priceBasisPath,
      "--reviewer-command",
      fakeReviewerPath,
      "--reviewer-arg",
      "retry-success",
      "--timeout-ms",
      "1000",
    ]);

    assert.equal(result.status, "valid");
    assert.equal(result.telemetry.retries.value, 1);
    assert.equal(
      result.process.retries,
      1,
      "structured retry events must not be summarized as zero",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adjudication-packet accepts an otherwise-valid source with unmatched candidates and remains route blind", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-valid-packet-"));
  await chmod(fakeReviewerPath, 0o755);
  try {
    const { runCli } = await implementation();
    const outputDirectory = join(root, "source");
    const source = await runCli([
      "run",
      "--fixture",
      fixtureRoot,
      "--variant",
      "baseline-opus-max",
      "--trial",
      "valid-unmatched",
      "--output-dir",
      outputDirectory,
      "--lock-file",
      join(root, "evaluation.lock"),
      "--price-basis",
      priceBasisPath,
      "--reviewer-command",
      fakeReviewerPath,
      "--reviewer-arg",
      "scored-report",
      "--timeout-ms",
      "1000",
    ]);
    assert.equal(source.status, "valid");

    const reportPath = join(outputDirectory, source.evidence.report);
    const report = await readFile(reportPath, "utf8");
    const unmatchedRow =
      "| 2 | Medium | Executability | tasks.json 9.9.9 | A novel acceptance criterion is not observable. | Replace it with an observable result. |\n\n";
    const updatedReport = report.replace(
      "## Review Metadata",
      `${unmatchedRow}## Review Metadata`,
    );
    await writeFile(reportPath, updatedReport);
    const sourceResultPath = join(outputDirectory, "result.json");
    const updatedSource = {
      ...source,
      evidence: {
        ...source.evidence,
        report_sha256: sha256(updatedReport),
      },
    };
    await writeJson(sourceResultPath, updatedSource);

    const packetPath = join(root, "packet.json");
    const packet = await runCli([
      "adjudication-packet",
      "--source-result",
      sourceResultPath,
      "--fixture",
      fixtureRoot,
      "--output",
      packetPath,
    ]);
    assert.equal(packet.candidates.length, 1);
    assert.equal(packet.candidates[0].candidate_id, "2");
    assert.ok(packet.oracles.length > 0);
    assert.doesNotMatch(
      JSON.stringify(packet),
      /baseline-opus-max|candidate-opus-medium|candidate-sol-medium|Claude Code|Codex ->|-> Codex|gpt-5\.6|"variant"|"route"|"runtime"|"model"|"effort"/i,
    );

    const adjudicationsPath = join(root, "adjudications.json");
    await writeJson(adjudicationsPath, [
      {
        candidate_id: "2",
        route_blind: true,
        disposition: "supported",
      },
    ]);
    const adjudicated = await runCli([
      "adjudicate",
      "--source-result",
      sourceResultPath,
      "--fixture",
      fixtureRoot,
      "--adjudications",
      adjudicationsPath,
      "--output-dir",
      join(root, "adjudicated"),
    ]);
    assert.equal(adjudicated.status, "valid");
    assert.deepEqual(adjudicated.quality.unmatched_candidates, [
      { id: "2", status: "supported", route_blind: true },
    ]);
    assert.equal(adjudicated.validity.first_pass, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarize accepts only a curated immutable 3x3 counted-results manifest and rejects every ineligible run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "task-review-counted-gates-"));
  try {
    const { runCli } = await implementation();

    await t.test("rejects recursive directory discovery", async () => {
      await assert.rejects(
        runCli([
          "summarize",
          "--runs",
          root,
          "--output",
          join(root, "recursive-summary.json"),
        ]),
        /curated.*counted-results|--counted-results.*required/i,
      );
    });

    const cases = [
      {
        name: "incomplete freeze manifest",
        pattern: /freeze.*(?:incomplete|helper|hash)/i,
        mutate: async (bundle) => {
          await rebindBundleFreeze(bundle, (freeze) => {
            delete freeze.hashes.helpers;
          });
        },
      },
      {
        name: "forged evaluator freeze version",
        pattern: /freeze.*evaluator|evaluator.*mismatch/i,
        mutate: async (bundle) => {
          await rebindBundleFreeze(bundle, (freeze) => {
            freeze.versions.evaluator = "forged-evaluator/v9";
          });
        },
      },
      {
        name: "duplicate result entries",
        pattern: /duplicate.*(?:trial|result|path)/i,
        mutate: async ({ manifest }) => {
          manifest.results[1] = { ...manifest.results[0] };
        },
      },
      {
        name: "missing explicit counted attempt",
        pattern: /malformed.*counted attempt|attempt.*missing/i,
        mutate: async ({ manifest }) => {
          delete manifest.results[0].attempt_id;
        },
      },
      {
        name: "attempt from another scheduled slot",
        pattern: /attempt.*belong.*scheduled trial/i,
        mutate: async ({ manifest }) => {
          manifest.results[0].attempt_id = manifest.results[1].attempt_id;
        },
      },
      {
        name: "result attempt identity disagrees with manifest",
        pattern: /does not match scheduled trial/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.attempt = 2;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "wrong 3x3 matrix",
        pattern: /3x3|three.*blocks|exactly.*nine|missing.*variant/i,
        mutate: async ({ manifest }) => {
          manifest.results.pop();
        },
      },
      {
        name: "directory instead of an explicitly counted result",
        pattern: /result.*(?:file|directory)|recursive/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          manifest.results[0].result = relative(caseRoot, join(caseRoot, "runs"));
          manifest.results[0].sha256 = sha256("");
        },
      },
      {
        name: "freeze mismatch",
        pattern: /freeze.*mismatch/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.freeze_manifest_sha256 = "f".repeat(64);
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "frozen fixture hash mismatch",
        pattern: /fixture.*freeze mismatch|freeze.*fixture mismatch/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.hashes.fixture_manifest = "f".repeat(64);
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "frozen route mismatch",
        pattern: /route.*mismatch/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.route.model = "forged-model";
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "frozen reviewer CLI mismatch",
        pattern: /reviewer CLI.*mismatch/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.versions.reviewer_cli.value = "forged-reviewer";
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "missing exclusive timed-run lock attestation",
        pattern: /exclusive.*lock|lock.*attestation/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.lock;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "Claude route without live authentication identity",
        pattern: /Claude.*auth|authentication.*identity/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results.find(({ trial_id: trialId }) =>
            trialId.includes("baseline-opus-max")
          );
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.authentication.claude.logged_in = false;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "runs outside scheduled sequential order",
        pattern: /sequential.*order|schedule.*timing|overlap/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results.find(({ trial_id: trialId }) =>
            trialId.startsWith("b01-s01-")
          );
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.timing.started_at = "2026-07-23T01:59:00.000Z";
          run.timing.ended_at = "2026-07-23T01:59:01.000Z";
          run.lock.attestation.started_at = run.timing.started_at;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "unclean quiescence",
        pattern: /quiescen.*(?:unclean|contamin)/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.quiescence.clean = false;
          run.quiescence.continuous = {
            clean: false,
            contaminants: [{ pid: 300, command: "node --test" }],
          };
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "missing quiescence sampling evidence",
        pattern: /quiescen.*sampl/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.quiescence.sampling;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "non-valid report",
        pattern: /status.*valid|report.*valid/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.status = "blocked";
          run.validity.report = false;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "missing process attempts",
        pattern: /process.*attempts.*missing/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.process.attempts;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "missing process retries",
        pattern: /process.*retries.*missing/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.process.retries;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "missing process repairs",
        pattern: /process.*repairs.*missing/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.process.repairs;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "missing process fallback",
        pattern: /process.*fallback.*missing/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.process.fallback;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "missing process launch evidence",
        pattern: /process.*launched.*missing/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.process.launched;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "nonzero reviewer exit",
        pattern: /exit.*(?:nonzero|0)|process.*invalid/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.process.exit_code = 7;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "reviewer timeout",
        pattern: /timed?.*out|timeout/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.process.timed_out = true;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "mutated protected inputs",
        pattern: /input.*(?:mutat|unchanged|mismatch)/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.validity.inputs_unchanged = false;
          run.protected_inputs.after = {
            ...run.protected_inputs.after,
            "specs/plan.md": "mutated-plan-hash",
          };
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "unclean isolated workspace",
        pattern: /isolation|oracle|contamin/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.isolation.oracle_present = true;
          run.isolation.contamination.oracle_present = true;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "telemetry unavailable without a reason",
        pattern: /telemetry.*unavailable|unavailable.*reason/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.telemetry.tokens.output = {
            value: null,
            unavailable_reason: null,
          };
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "telemetry field omitted",
        pattern: /telemetry.*missing.*tokens\.output/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          delete run.telemetry.tokens.output;
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "unadjudicated unmatched candidate",
        pattern: /unmatched.*adjudicat|route.blind/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.quality.unmatched_candidates = [
            {
              id: "unresolved-new-finding",
              status: "unadjudicated",
              route_blind: false,
            },
          ];
          entry.sha256 = await writeJson(path, run);
        },
      },
      {
        name: "less than 100% known Blocker recall",
        pattern: /Blocker recall.*100%/i,
        mutate: async ({ root: caseRoot, manifest }) => {
          const entry = manifest.results[0];
          const path = join(caseRoot, entry.result);
          const run = JSON.parse(await readFile(path, "utf8"));
          run.quality.recall_by_severity.Blocker = 0;
          entry.sha256 = await writeJson(path, run);
        },
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const caseRoot = join(
          root,
          scenario.name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase(),
        );
        const bundle = await writeCountedBundle(caseRoot, scenario.mutate);
        await assert.rejects(
          summarizeBundle(
            runCli,
            bundle,
            join(caseRoot, "summary.json"),
          ),
          scenario.pattern,
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarize counts one explicit later attempt for a scheduled slot while preserving the earlier artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-counted-attempt-"));
  try {
    const { runCli } = await implementation();
    const bundle = await writeCountedBundle(root, async ({
      root: caseRoot,
      manifest,
    }) => {
      const entry = manifest.results[0];
      const sourcePath = join(caseRoot, entry.result);
      const run = JSON.parse(await readFile(sourcePath, "utf8"));
      const attemptId = run.trial.replace(/-a01$/, "-a02");
      run.id = attemptId;
      run.attempt_id = attemptId;
      run.attempt = 2;
      run.lock.attestation.trial = attemptId;
      const attemptPath = join(caseRoot, "runs", attemptId, "result.json");
      entry.attempt_id = attemptId;
      entry.result = relative(caseRoot, attemptPath);
      entry.sha256 = await writeJson(attemptPath, run);
    });

    const summary = await summarizeBundle(
      runCli,
      bundle,
      join(root, "summary.json"),
    );
    assert.equal(summary.counted_results.count, 9);
    assert.equal(
      bundle.manifest.results[0].attempt_id.endsWith("-a02"),
      true,
    );
    await stat(
      join(
        root,
        "runs",
        bundle.manifest.results[0].trial_id,
        "result.json",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarize aggregates required performance, spend, interaction, route-state, quality, loss, and same-block metrics without relabeling cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-review-paired-summary-"));
  try {
    const { runCli } = await implementation();
    const bundle = await writeCountedBundle(root);
    const output = join(root, "summary.json");
    const summary = await summarizeBundle(runCli, bundle, output);

    assert.equal(summary.schema_version, "task-review-evaluation-summary/v2");
    assert.deepEqual(summary.counted_results, {
      manifest_sha256: sha256(await readFile(bundle.manifestPath)),
      freeze_manifest_sha256: bundle.freezeHash,
      schedule_sha256: bundle.scheduleHash,
      count: 9,
    });
    assert.deepEqual(Object.keys(summary.variants).sort(), [...variants].sort());

    const requiredAggregatePaths = [
      ["latency_ms"],
      ["tokens", "input"],
      ["tokens", "cached_input"],
      ["tokens", "output"],
      ["tokens", "reasoning_output"],
      ["tokens", "total"],
      ["cost", "actual_runtime_usd"],
      ["cost", "estimated_token_usd"],
      ["tool_calls"],
      ["messages"],
      ["validity", "first_pass"],
      ["process", "retries"],
      ["process", "repairs"],
      ["process", "fallbacks"],
      ["quality", "recall_by_severity", "Blocker"],
      ["quality", "recall_by_severity", "High"],
      ["quality", "recall_by_severity", "Medium"],
      ["quality", "recall_by_severity", "Low"],
      ["quality", "weighted_recall"],
      ["quality", "supported_precision"],
      ["quality", "duplicates"],
      ["quality", "severity_drift"],
      ["quality", "false_scope_changes"],
      ["quality", "unmatched_findings"],
      ["quality", "non_blocker_losses"],
    ];
    for (const variant of variants) {
      for (const path of requiredAggregatePaths) {
        let value = summary.variants[variant];
        for (const key of path) value = value?.[key];
        assert.ok(value, `missing ${variant}.${path.join(".")}`);
        assert.equal(value.individual.length, 3);
        assert.equal(typeof value.median, "number");
        assert.equal(value.range.length, 2);
      }
    }
    assert.equal(
      summary.variants["baseline-opus-max"].latency_ms.median,
      110,
    );
    assert.equal(
      summary.variants["candidate-opus-medium"].latency_ms.median,
      70,
    );
    assert.equal(
      summary.variants["candidate-sol-medium"].latency_ms.median,
      90,
    );
    assert.equal(
      summary.variants["baseline-opus-max"].cost.actual_runtime_usd.label,
      "actual",
    );
    assert.equal(
      summary.variants["baseline-opus-max"].cost.estimated_token_usd.label,
      "estimate",
    );
    assert.notEqual(
      summary.variants["baseline-opus-max"].cost.actual_runtime_usd,
      summary.variants["baseline-opus-max"].cost.estimated_token_usd,
    );

    for (const candidate of [
      "candidate-opus-medium",
      "candidate-sol-medium",
    ]) {
      assert.equal(summary.paired_deltas[candidate].length, 3);
      for (const blockDelta of summary.paired_deltas[candidate]) {
        assert.equal(typeof blockDelta.block, "number");
        for (const path of requiredAggregatePaths) {
          let value = blockDelta.deltas;
          for (const key of path) value = value?.[key];
          assert.ok(
            value,
            `missing ${candidate} paired delta ${path.join(".")}`,
          );
          assert.equal(typeof value.candidate, "number");
          assert.equal(typeof value.baseline, "number");
          assert.equal(typeof value.delta, "number");
          assert.equal(typeof value.percent_delta, "number");
        }
      }
    }
    assert.equal(
      summary.paired_deltas["candidate-opus-medium"][0]
        .deltas.latency_ms.percent_delta,
      -40,
    );

    assert.deepEqual(
      JSON.parse(await readFile(output, "utf8")),
      summary,
    );
    const before = await readFile(output);
    await assert.rejects(
      summarizeBundle(runCli, bundle, output),
      /summary output already exists|refus(?:e|ing).*overwrite/i,
    );
    assert.deepEqual(await readFile(output), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
