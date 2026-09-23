#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "task-review-evaluation-result/v1";
const AGGREGATE_SCHEMA_VERSION = "task-review-evaluation-summary/v1";
const PAIRED_AGGREGATE_SCHEMA_VERSION =
  "task-review-evaluation-summary/v2";
const SCHEDULE_SCHEMA_VERSION = "task-review-paired-schedule/v1";
const FREEZE_SCHEMA_VERSION = "task-review-evaluation-freeze/v1";
const COUNTED_RESULTS_SCHEMA_VERSION = "task-review-counted-results/v1";
const ADJUDICATION_PACKET_SCHEMA_VERSION =
  "task-review-adjudication-packet/v1";
const SEVERITIES = ["Blocker", "High", "Medium", "Low"];
const SEVERITY_WEIGHTS = {
  Blocker: 8,
  High: 4,
  Medium: 2,
  Low: 1,
};
const VARIANTS = {
  "baseline-opus-max": {
    contract: "baseline/contract.json",
    runtime: "claude-code",
    runtimeLabel: "Claude Code",
    model: "claude-opus-5-5",
    effort: "max",
    primaryRuntime: "codex",
    route: "Codex -> Claude Code",
  },
  "candidate-opus-medium": {
    contract: "candidate/contract.json",
    runtime: "claude-code",
    runtimeLabel: "Claude Code",
    model: "claude-opus-5-5",
    effort: "medium",
    primaryRuntime: "codex",
    route: "Codex -> Claude Code",
  },
  "candidate-sol-medium": {
    contract: "candidate/contract.json",
    runtime: "codex",
    runtimeLabel: "Codex",
    model: "gpt-6-sol",
    effort: "medium",
    primaryRuntime: "claude-code",
    route: "Claude Code -> Codex",
  },
};
const PROTECTED_INPUTS = [
  "specs/plan.md",
  "specs/execute.md",
  "specs/tasks.json",
];
const EVALUATOR_REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EVALUATOR_VERSION = "evaluate-task-review/v1";

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

function isWithin(root, target) {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

async function writeNewJson(path, value, label) {
  if (await exists(path)) {
    throw new Error(`${label} output already exists; refusing overwrite: ${path}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, value);
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

async function hashProtectedInputs(taskRoot) {
  const hashes = {};
  for (const input of PROTECTED_INPUTS) {
    hashes[input] = await hashFile(join(taskRoot, input));
  }
  return hashes;
}

async function filesBelow(root) {
  const files = [];
  if (!(await exists(root))) return files;

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        files.push(relative(root, path));
      }
    }
  }

  await visit(root);
  return files.sort();
}

async function hashFilesBelow(root) {
  const hashes = {};
  for (const path of await filesBelow(root)) {
    hashes[path] = await hashFile(join(root, path));
  }
  return hashes;
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const options = { reviewerArg: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    index += 1;
    if (key === "reviewerArg") {
      options.reviewerArg.push(value);
    } else {
      options[key] = value;
    }
  }
  return { command, options };
}

function requireOptions(options, names) {
  for (const name of names) {
    if (options[name] === undefined) {
      throw new Error(`--${name.replace(/[A-Z]/g, (letter) =>
        `-${letter.toLowerCase()}`,
      )} is required`);
    }
  }
}

function scheduleTrialId(block, sequence, variant) {
  return `b${String(block).padStart(2, "0")}-s${String(sequence).padStart(
    2,
    "0",
  )}-${variant}-a01`;
}

function pairedAttemptId(trialId, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("--attempt must be a positive integer");
  }
  if (!/-a01$/.test(trialId)) {
    throw new Error(`scheduled trial has no canonical attempt suffix: ${trialId}`);
  }
  return trialId.replace(/-a01$/, `-a${String(attempt).padStart(2, "0")}`);
}

function pairedAttemptNumber(trialId, attemptId) {
  if (typeof trialId !== "string" || typeof attemptId !== "string") {
    return null;
  }
  const prefix = trialId.match(/^(.*)-a01$/)?.[1];
  const attempt = attemptId.match(/^(.*)-a([0-9]{2,})$/);
  if (!prefix || !attempt || attempt[1] !== prefix) return null;
  const number = Number(attempt[2]);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function buildSchedule(seed) {
  const variants = Object.keys(VARIANTS);
  return {
    schema_version: SCHEDULE_SCHEMA_VERSION,
    seed,
    variants,
    blocks: [1, 2, 3].map((block) => {
      const ordered = [...variants].sort((left, right) =>
        sha256(`${seed}\0${block}\0${left}`).localeCompare(
          sha256(`${seed}\0${block}\0${right}`),
        )
      );
      return {
        block,
        trials: ordered.map((variant, index) => ({
          sequence: index + 1,
          variant,
          trial_id: scheduleTrialId(block, index + 1, variant),
        })),
      };
    }),
  };
}

function expectedFreezeId(freeze) {
  return `freeze-${
    safeHashObject({ ...freeze, freeze_id: null }).slice(0, 16)
  }`;
}

async function createSchedule(options) {
  requireOptions(options, ["seed", "output"]);
  const output = resolve(options.output);
  const schedule = buildSchedule(options.seed);
  await writeNewJson(output, schedule, "schedule");
  return schedule;
}

function cleanEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(SUBSPACE|GROVE|CLAUDE|SPECTRE|CODEX|ANTHROPIC)/.test(key)) {
      continue;
    }
    environment[key] = value;
  }
  return environment;
}

function claudeAuthenticationEnvironment(claudeHome, baseEnvironment) {
  return {
    ...baseEnvironment,
    CLAUDE_CONFIG_DIR: claudeHome,
    // Keep config/session output isolated while using Claude's existing secure
    // storage namespace. The credential itself remains in Keychain or the
    // runtime-managed default credential store and is never copied here.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
  };
}

export function probeClaudeAuthentication(
  command,
  claudeHome,
  baseEnvironment = cleanEnvironment(),
) {
  const result = spawnSync(command, ["auth", "status", "--json"], {
    encoding: "utf8",
    env: claudeAuthenticationEnvironment(claudeHome, baseEnvironment),
    timeout: 5_000,
  });
  let status = {};
  try {
    status = JSON.parse(result.stdout || "{}");
  } catch {
    return {
      checked: true,
      logged_in: false,
      auth_method: null,
      api_provider: null,
      source: "default-secure-storage",
      unavailable_reason: "Claude auth status returned invalid JSON.",
    };
  }
  const loggedIn = result.status === 0 && status.loggedIn === true;
  return {
    checked: true,
    logged_in: loggedIn,
    auth_method:
      typeof status.authMethod === "string" ? status.authMethod : null,
    api_provider:
      typeof status.apiProvider === "string" ? status.apiProvider : null,
    source: "default-secure-storage",
    unavailable_reason: loggedIn
      ? null
      : `Claude auth status exited ${result.status ?? "without a status"}.`,
  };
}

async function stageCodexAuthentication(codexHome) {
  const sourceHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(process.env.HOME ?? "", ".codex");
  const source = join(sourceHome, "auth.json");
  if (!(await exists(source))) return null;
  const destination = join(codexHome, "auth.json");
  await cp(source, destination);
  return destination;
}

async function prepareReviewerRuntime(
  runRoot,
  configuration,
  reportPath,
  taskRoot,
) {
  const runtimeRoot = join(runRoot, "runtime");
  const paths = {
    claudeHome: join(runtimeRoot, "claude"),
    codexHome: join(runtimeRoot, "codex"),
    spectreHome: join(runtimeRoot, "spectre"),
    temporaryHome: join(runRoot, "home"),
    temporaryDirectory: join(runRoot, "tmp"),
    xdgConfigHome: join(runRoot, "xdg", "config"),
    xdgCacheHome: join(runRoot, "xdg", "cache"),
    xdgDataHome: join(runRoot, "xdg", "data"),
    xdgStateHome: join(runRoot, "xdg", "state"),
    xdgRuntimeDirectory: join(runRoot, "xdg", "runtime"),
  };
  await Promise.all([
    mkdir(paths.claudeHome, { recursive: true }),
    mkdir(paths.codexHome, { recursive: true }),
    mkdir(paths.spectreHome, { recursive: true }),
    mkdir(paths.temporaryHome, { recursive: true }),
    mkdir(paths.temporaryDirectory, { recursive: true }),
    mkdir(paths.xdgConfigHome, { recursive: true }),
    mkdir(paths.xdgCacheHome, { recursive: true }),
    mkdir(paths.xdgDataHome, { recursive: true }),
    mkdir(paths.xdgStateHome, { recursive: true }),
    mkdir(paths.xdgRuntimeDirectory, { recursive: true, mode: 0o700 }),
  ]);

  const baseEnvironment = cleanEnvironment();
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (key === "PATH") {
      baseEnvironment.PATH = value
        .split(delimiter)
        .filter((entry) => !isWithin(EVALUATOR_REPOSITORY_ROOT, entry))
        .join(delimiter);
    } else if (value.includes(EVALUATOR_REPOSITORY_ROOT)) {
      delete baseEnvironment[key];
    }
  }
  const hostHome =
    typeof process.env.HOME === "string" && isAbsolute(process.env.HOME)
      ? process.env.HOME
      : null;
  const reviewerUsesHostHome =
    configuration.runtime === "claude-code" && hostHome !== null;
  baseEnvironment.HOME = reviewerUsesHostHome
    ? hostHome
    : paths.temporaryHome;
  baseEnvironment.TMPDIR = paths.temporaryDirectory;
  baseEnvironment.TMP = paths.temporaryDirectory;
  baseEnvironment.TEMP = paths.temporaryDirectory;
  baseEnvironment.XDG_CONFIG_HOME = paths.xdgConfigHome;
  baseEnvironment.XDG_CACHE_HOME = paths.xdgCacheHome;
  baseEnvironment.XDG_DATA_HOME = paths.xdgDataHome;
  baseEnvironment.XDG_STATE_HOME = paths.xdgStateHome;
  baseEnvironment.XDG_RUNTIME_DIR = paths.xdgRuntimeDirectory;
  const environment = {
    ...claudeAuthenticationEnvironment(paths.claudeHome, baseEnvironment),
    CODEX_HOME: paths.codexHome,
    SPECTRE_HOME: paths.spectreHome,
    TASK_REVIEW_REPORT: reportPath,
    TASK_REVIEW_WORKSPACE: taskRoot,
    TASK_REVIEW_RUNTIME: configuration.runtimeLabel,
    TASK_REVIEW_MODEL: configuration.model,
    TASK_REVIEW_EFFORT: configuration.effort,
    TASK_REVIEW_ROUTE: configuration.route,
  };
  return {
    ...paths,
    baseEnvironment,
    environment,
    hostHome,
    reviewerUsesHostHome,
    stagedAuth: await stageCodexAuthentication(paths.codexHome),
  };
}

function reviewerAuthentication(
  configuration,
  customCommand,
  command,
  claudeHome,
  environment,
) {
  if (configuration.runtime !== "claude-code") {
    return {
      checked: false,
      logged_in: null,
      auth_method: null,
      api_provider: null,
      source: "not-applicable",
      unavailable_reason: "The selected reviewer runtime is not Claude Code.",
    };
  }
  if (customCommand) {
    return {
      checked: false,
      logged_in: null,
      auth_method: null,
      api_provider: null,
      source: "default-secure-storage",
      unavailable_reason:
        "Custom reviewer command bypassed the real Claude auth preflight.",
    };
  }
  return probeClaudeAuthentication(command, claudeHome, environment);
}

async function verifyFixture(fixtureRoot) {
  const manifestPath = join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema_version !== "task-review-fixture-manifest/v1") {
    throw new Error("unsupported fixture manifest");
  }
  for (const [componentPath, expected] of Object.entries(
    manifest.components ?? {},
  )) {
    const target = join(fixtureRoot, componentPath);
    const bytes = await readFile(target);
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`fixture component mismatch: ${componentPath}`);
    }
  }
  return {
    manifest,
    manifestHash: await hashFile(manifestPath),
  };
}

function buildCandidatePrompt(taskRoot, reportPath) {
  return `Perform an adversarial generated-task review.

TASK_DIR: ${taskRoot}
EXECUTE_INDEX: ${join(taskRoot, "specs", "execute.md")}
TASKS_JSON: ${join(taskRoot, "specs", "tasks.json")}
PLAN: ${join(taskRoot, "specs", "plan.md")}
REVIEW_REPORT: ${reportPath}
MODE: adversarial

Write permission is limited to REVIEW_REPORT. Do not edit the plan, execute
index, task graph, or any other file. Review semantic coverage,
executability, integration, and reference relevance in one non-sharded pass.
Do not infer correctness from structural token or path presence alone.

Write a Findings table with columns # | Severity | Lens | Location | Finding |
Suggested Edit, or an explicit "No findings." form. Include Review Metadata
with an ISO8601 UTC Timestamp, Mode, Reviewer Runtime, Reviewer Model,
Reviewer Effort, and Invocation Route.`;
}

function buildRepairPrompt(taskRoot, reportPath, configuration, timestamp) {
  return `Perform a report-only repair of an adversarial generated-task review.

TASK_DIR: ${taskRoot}
EXECUTE_INDEX: ${join(taskRoot, "specs", "execute.md")}
TASKS_JSON: ${join(taskRoot, "specs", "tasks.json")}
PLAN: ${join(taskRoot, "specs", "plan.md")}
REVIEW_REPORT: ${reportPath}

Write only REVIEW_REPORT. Do not write, edit, rename, or delete any other
file. Read the staged plan, execute index, and task graph, then replace or
create REVIEW_REPORT with a complete one-pass review. Use a Findings table
with columns # | Severity | Lens | Location | Finding | Suggested Edit, or
the explicit "No findings." form.

Use these exact Review Metadata values:
Timestamp: ${timestamp}
Mode: adversarial
Reviewer Runtime: ${configuration.runtimeLabel}
Reviewer Model: ${configuration.model}
Reviewer Effort: ${configuration.effort}
Invocation Route: ${configuration.route}`;
}

async function loadPrompt(fixtureRoot, variant, taskRoot, reportPath) {
  if (variant !== "baseline-opus-max") {
    return buildCandidatePrompt(taskRoot, reportPath);
  }
  const contract = JSON.parse(
    await readFile(join(fixtureRoot, "baseline", "contract.json"), "utf8"),
  );
  return contract.historical_prompt.text
    .replaceAll(
      "docs/tasks/main/knowledge-surfacing",
      relative(dirname(taskRoot), taskRoot) === basename(taskRoot)
        ? taskRoot
        : taskRoot,
    )
    .replace(
      /Reviewer Model: fable/g,
      "Reviewer Model: opus",
    )
    .replace(
      /Reviewer Effort: high/g,
      "Reviewer Effort: max",
    );
}

async function normalizedPromptHash(fixtureRoot, variant) {
  const taskRoot = "/TASK_ROOT";
  const reportPath = "/TASK_ROOT/reviews/task_review.md";
  const prompt = await loadPrompt(
    fixtureRoot,
    variant,
    taskRoot,
    reportPath,
  );
  return sha256(prompt.replaceAll("\\", "/"));
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: EVALUATOR_REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ||
        result.stderr?.trim() ||
        `git ${args.join(" ")} exited ${result.status}`,
    );
  }
  return result.stdout;
}

function repositoryState() {
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const dirtyDiff = [
    gitOutput(["diff", "--binary", "HEAD", "--"]),
    status,
  ].join("\0");
  return {
    commit: gitOutput(["rev-parse", "HEAD"]).trim(),
    dirty: status.length > 0,
    dirty_diff_sha256: sha256(dirtyDiff),
  };
}

async function createFreeze(options) {
  requireOptions(options, ["fixture", "priceBasis", "output"]);
  const fixtureRoot = resolve(options.fixture);
  const priceBasisPath = resolve(options.priceBasis);
  const output = resolve(options.output);
  if (await exists(output)) {
    throw new Error(`freeze output already exists; refusing overwrite: ${output}`);
  }
  const { manifest, manifestHash } = await verifyFixture(fixtureRoot);
  const paths = {
    canonicalSkill: join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre",
      "skills",
      "spectre-task_review",
      "SKILL.md",
    ),
    generatedSkill: join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre-codex",
      "skills",
      "spectre-task_review",
      "SKILL.md",
    ),
    canonicalHelper: join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre",
      "skills",
      "spectre-task_review",
      "scripts",
      "task-review-safety.mjs",
    ),
    generatedHelper: join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre-codex",
      "skills",
      "spectre-task_review",
      "scripts",
      "task-review-safety.mjs",
    ),
  };
  const environment = cleanEnvironment();
  const claudeVersion = commandVersion(
    process.env.CLAUDE_BIN || "claude",
    environment,
  );
  const codexVersion = commandVersion(
    process.env.CODEX_BIN || "codex",
    environment,
  );
  const repository = repositoryState();
  repository.comparison_binding = "protected-input-hashes";
  const promptHashes = {};
  for (const variant of Object.keys(VARIANTS)) {
    promptHashes[variant] = await normalizedPromptHash(fixtureRoot, variant);
  }
  const freeze = {
    schema_version: FREEZE_SCHEMA_VERSION,
    freeze_id: null,
    versions: {
      evaluator: EVALUATOR_VERSION,
      node: process.version,
      reviewer_clis: {
        claude: claudeVersion.value,
        codex: codexVersion.value,
      },
    },
    repository,
    hashes: {
      evaluator: await hashFile(fileURLToPath(import.meta.url)),
      fixture_manifest: manifestHash,
      fixture_components: safeHashObject(manifest.components),
      contracts: {
        baseline: await hashFile(join(fixtureRoot, "baseline", "contract.json")),
        candidate: await hashFile(join(fixtureRoot, "candidate", "contract.json")),
      },
      price_basis: await hashFile(priceBasisPath),
      skills: {
        canonical: await hashFile(paths.canonicalSkill),
        generated: await hashFile(paths.generatedSkill),
      },
      helpers: {
        canonical: await hashFile(paths.canonicalHelper),
        generated: await hashFile(paths.generatedHelper),
      },
      normalized_prompts: promptHashes,
    },
  };
  freeze.freeze_id = expectedFreezeId(freeze);
  await writeNewJson(output, freeze, "freeze");
  return freeze;
}

export function reviewerCommand(configuration, prompt, workspace, custom) {
  if (custom.command) {
    return {
      command: custom.command,
      args: custom.args,
    };
  }
  if (configuration.runtime === "claude-code") {
    return {
      command: process.env.CLAUDE_BIN || "claude",
      args: [
        "-p",
        "--safe-mode",
        "--model",
        configuration.model,
        "--effort",
        configuration.effort,
        "--permission-mode",
        "dontAsk",
        "--tools",
        "Read,Glob,Grep,Write",
        "--allowedTools",
        "Read,Glob,Grep,Write",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        prompt,
      ],
    };
  }
  return {
    command: process.env.CODEX_BIN || "codex",
    args: [
      "exec",
      "-C",
      workspace,
      "-m",
      configuration.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(configuration.effort)}`,
      "-s",
      "workspace-write",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--disable",
      "hooks",
      prompt,
    ],
  };
}

function commandVersion(command, environment) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    return {
      value: null,
      unavailable_reason:
        result.error?.message ||
        result.stderr?.trim() ||
        `version command exited ${result.status}`,
    };
  }
  return {
    value: result.stdout.trim() || result.stderr.trim(),
    unavailable_reason: null,
  };
}

function processSnapshot() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `process snapshot failed: ${
        result.error?.message ||
        result.stderr?.trim() ||
        `ps exited ${result.status}`
      }`,
    );
  }
  const snapshot = result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match
      ? [{
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      }]
      : [];
  });
  if (snapshot.length === 0) {
    throw new Error("process snapshot failed: ps returned no process records");
  }
  return snapshot;
}

function heavyProcess(processRecord) {
  const command = processRecord.command ?? "";
  const claudeMetadataProbe =
    /(?:^|\/)claude\s+(?:--version|auth\s+status(?:\s+--json)?)\s*$/i
      .test(command);
  return (
    (!claudeMetadataProbe && /(?:^|\/)claude(?:\s|$)/i.test(command)) ||
    /(?:^|\/)codex\s+exec(?:\s|$)/i.test(command) ||
    /\bnode(?:\S*)?\s+--test(?:\s|$)/i.test(command) ||
    /\bnode(?:\S*)?\s+.*(?:scripts\/sync-codex\.cjs|verify-spectre\/scripts\/verify\.mjs)(?:\s|$)/i
      .test(command) ||
    /\bevaluate-task-review\.mjs\s+(?:run|repair-model)(?:\s|$)/i.test(command)
  );
}

function heavyProcessLabel(command) {
  if (/(?:^|\/)codex\s+exec(?:\s|$)/i.test(command)) return "codex exec";
  if (/(?:^|\/)claude(?:\s|$)/i.test(command)) return "claude";
  if (/\bnode(?:\S*)?\s+--test(?:\s|$)/i.test(command)) return "node --test";
  if (/scripts\/sync-codex\.cjs/i.test(command)) return "sync-codex";
  if (/verify-spectre\/scripts\/verify\.mjs/i.test(command)) return "verify-spectre";
  return "task-review evaluator";
}

function stageSnapshots(value) {
  if (!Array.isArray(value)) return [];
  if (value.length === 0) return [];
  return Array.isArray(value[0]) ? value : [value];
}

export function assessQuiescence({
  evaluator_pid: evaluatorPid,
  reviewer_pid: reviewerPid,
  snapshots,
  sampling = {},
}) {
  const ownedRoots = new Set(
    [evaluatorPid, reviewerPid].filter((pid) => Number.isInteger(pid)),
  );
  const assessStage = (rawSnapshots) => {
    const samples = stageSnapshots(rawSnapshots);
    const contaminants = new Map();
    for (const snapshot of samples) {
      const owned = new Set(ownedRoots);
      let changed = true;
      while (changed) {
        changed = false;
        for (const processRecord of snapshot) {
          if (owned.has(processRecord.ppid) && !owned.has(processRecord.pid)) {
            owned.add(processRecord.pid);
            changed = true;
          }
        }
      }
      for (const processRecord of snapshot) {
        if (!owned.has(processRecord.pid) && heavyProcess(processRecord)) {
          contaminants.set(
            processRecord.pid,
            {
              pid: processRecord.pid,
              ppid: processRecord.ppid,
              command: heavyProcessLabel(processRecord.command ?? ""),
            },
          );
        }
      }
    }
    const values = [...contaminants.values()].sort(
      (left, right) => left.pid - right.pid,
    );
    return {
      clean: samples.length > 0 && values.length === 0,
      contaminants: values,
      samples: samples.length,
    };
  };
  const pre = assessStage(snapshots?.pre);
  const continuous = assessStage(snapshots?.continuous);
  const post = assessStage(snapshots?.post);
  const contaminants = new Map();
  for (const stage of [pre, continuous, post]) {
    for (const contaminant of stage.contaminants) {
      contaminants.set(contaminant.pid, contaminant);
    }
  }
  const clean = pre.clean && continuous.clean && post.clean;
  return {
    clean,
    pre,
    continuous,
    post,
    owned_reviewer_tree_excluded: true,
    sampling: {
      clean,
      sample_count: pre.samples + continuous.samples + post.samples,
      interval_ms: sampling.interval_ms ?? null,
      started_at: sampling.started_at ?? null,
      ended_at: sampling.ended_at ?? null,
      elapsed_ms: sampling.elapsed_ms ?? null,
      contaminants: [...contaminants.values()].sort(
        (left, right) => left.pid - right.pid,
      ),
    },
  };
}

function runReviewer(command, args, options) {
  return new Promise((resolveRun) => {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (options.onSpawn) options.onSpawn(child.pid);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 50);
    }, options.timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      resolveRun({
        ...result,
        stdout,
        stderr,
        timedOut,
        durationMs: performance.now() - startedAt,
      });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, error: error.message });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, error: null });
    });
  });
}

async function runReviewerWithQuiescence(command, args, options, hooks = {}) {
  const takeSnapshot = hooks.processSnapshot ?? processSnapshot;
  const samplingStarted = performance.now();
  const samplingStartedAt = new Date().toISOString();
  const intervalMs = 250;
  const snapshots = {
    pre: takeSnapshot("pre"),
    continuous: [],
    post: [],
  };
  let reviewerPid = null;
  let interval = null;
  let samplingError = null;
  const processResult = await runReviewer(command, args, {
    ...options,
    onSpawn(pid) {
      reviewerPid = pid;
      snapshots.continuous.push(takeSnapshot("continuous"));
      interval = setInterval(() => {
        try {
          snapshots.continuous.push(takeSnapshot("continuous"));
        } catch (error) {
          samplingError = error;
          clearInterval(interval);
        }
      }, intervalMs);
      interval.unref?.();
    },
  });
  if (interval) clearInterval(interval);
  if (samplingError) throw samplingError;
  snapshots.post = takeSnapshot("post");
  const samplingEnded = performance.now();
  return {
    processResult,
    quiescence: assessQuiescence({
      evaluator_pid: process.pid,
      reviewer_pid: reviewerPid,
      snapshots,
      sampling: {
        interval_ms: intervalMs,
        started_at: samplingStartedAt,
        ended_at: new Date().toISOString(),
        elapsed_ms: samplingEnded - samplingStarted,
      },
    }),
  };
}

function assessQuiescenceWithoutReviewer(takeSnapshot = processSnapshot) {
  const samplingStarted = performance.now();
  const samplingStartedAt = new Date().toISOString();
  const snapshots = {
    pre: takeSnapshot("pre"),
    continuous: [],
    post: takeSnapshot("post"),
  };
  const samplingEnded = performance.now();
  return assessQuiescence({
    evaluator_pid: process.pid,
    reviewer_pid: null,
    snapshots,
    sampling: {
      interval_ms: null,
      started_at: samplingStartedAt,
      ended_at: new Date().toISOString(),
      elapsed_ms: samplingEnded - samplingStarted,
    },
  });
}

function startQuiescenceMonitor(hooks = {}) {
  const takeSnapshot = hooks.processSnapshot ?? processSnapshot;
  const samplingStarted = performance.now();
  const samplingStartedAt = new Date().toISOString();
  const intervalMs = 250;
  const snapshots = {
    pre: takeSnapshot("pre"),
    continuous: [],
    post: [],
  };
  let reviewerPid = null;
  let samplingError = null;
  snapshots.continuous.push(takeSnapshot("continuous"));
  const interval = setInterval(() => {
    try {
      snapshots.continuous.push(takeSnapshot("continuous"));
    } catch (error) {
      samplingError = error;
      clearInterval(interval);
    }
  }, intervalMs);
  interval.unref?.();
  let assessment = null;
  let finishError = null;
  let finished = false;
  const preAssessment = assessQuiescence({
    evaluator_pid: process.pid,
    reviewer_pid: null,
    snapshots: {
      pre: snapshots.pre,
      continuous: snapshots.pre,
      post: snapshots.pre,
    },
  });
  return {
    preClean: preAssessment.pre.clean,
    setReviewerPid(pid) {
      reviewerPid = pid;
    },
    finish() {
      if (finished) {
        if (finishError) throw finishError;
        return assessment;
      }
      finished = true;
      clearInterval(interval);
      try {
        if (samplingError) throw samplingError;
        snapshots.post = takeSnapshot("post");
        const samplingEnded = performance.now();
        assessment = assessQuiescence({
          evaluator_pid: process.pid,
          reviewer_pid: reviewerPid,
          snapshots,
          sampling: {
            interval_ms: intervalMs,
            started_at: samplingStartedAt,
            ended_at: new Date().toISOString(),
            elapsed_ms: samplingEnded - samplingStarted,
          },
        });
        return assessment;
      } catch (error) {
        finishError = error;
        throw error;
      }
    },
  };
}

function parseJsonLines(raw) {
  const events = [];
  const rawEvents = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
      rawEvents.push(line);
    } catch {
      // stdout remains authoritative raw evidence; non-JSON lines are retained there.
    }
  }
  return {
    events,
    rawEvents: rawEvents.length > 0 ? `${rawEvents.join("\n")}\n` : "",
  };
}

function observed(value, source, extra = {}) {
  if (value === null || value === undefined) {
    return {
      value: null,
      unavailable_reason: "The runtime did not expose this field.",
      ...extra,
    };
  }
  return { value, source, unavailable_reason: null, ...extra };
}

function unavailable(reason, extra = {}) {
  return { value: null, unavailable_reason: reason, ...extra };
}

function estimatedCost(runtime, selector, tokens, priceBasis) {
  const rate = priceBasis?.public_price_estimate?.rates?.find(
    (entry) => entry.runtime === runtime && entry.selector === selector,
  );
  if (!rate) {
    return unavailable("No dated public price rate matches this runtime/model.", {
      label: "estimate",
      basis_version: priceBasis?.basis_version ?? null,
    });
  }
  if (tokens.input.value === null || tokens.output.value === null) {
    return unavailable("Required native token fields were not exposed.", {
      label: "estimate",
      basis_version: priceBasis.basis_version,
    });
  }
  const input = tokens.input.value * rate.input;
  const cached =
    (tokens.cached_input.value ?? 0) * (rate.cached_input ?? rate.input);
  const cacheWrite =
    (tokens.cache_write_input.value ?? 0) *
    (rate.cache_write_5m ?? rate.input);
  const output = tokens.output.value * rate.output;
  return observed((input + cached + cacheWrite + output) / 1_000_000, [
    "native token fields",
    `price basis ${priceBasis.basis_version}`,
  ].join(" + "), {
    label: "estimate",
    basis_version: priceBasis.basis_version,
  });
}

export function normalizeTelemetry(runtime, events, priceBasis, selector) {
  let tokens;
  let actualCost;
  let toolCalls;
  let messages;
  let nativeTiming;
  let retries;

  if (runtime === "claude-code") {
    const result = [...events].reverse().find((event) => event.type === "result");
    const usage = result?.usage;
    tokens = {
      input: usage
        ? observed(usage.input_tokens ?? null, "result.usage.input_tokens")
        : unavailable("The runtime did not expose input tokens."),
      cached_input: usage
        ? observed(
          usage.cache_read_input_tokens ?? null,
          "result.usage.cache_read_input_tokens",
        )
        : unavailable("The runtime did not expose cached-input tokens."),
      cache_write_input: usage
        ? observed(
          usage.cache_creation_input_tokens ?? null,
          "result.usage.cache_creation_input_tokens",
        )
        : unavailable("The runtime did not expose cache-write input tokens."),
      output: usage
        ? observed(usage.output_tokens ?? null, "result.usage.output_tokens")
        : unavailable("The runtime did not expose output tokens."),
      reasoning_output: unavailable(
        "Reasoning-output tokens were not exposed by the Claude runtime.",
      ),
      total: unavailable(
        "The Claude runtime did not expose a native total-token field.",
      ),
    };
    actualCost = result
      ? observed(result.total_cost_usd ?? null, "result.total_cost_usd", {
        label: "actual",
      })
      : unavailable("Actual runtime cost was not exposed.", {
        label: "actual",
      });
    toolCalls = events.length > 0
      ? observed(
        events.reduce(
          (count, event) =>
            count +
            (event.type === "assistant"
              ? (event.message?.content ?? []).filter(
                (block) => block.type === "tool_use",
              ).length
              : 0),
          0,
        ),
        "complete structured stream assistant tool_use count",
      )
      : unavailable("Structured tool-call events were not exposed.");
    messages = result?.num_turns !== undefined
      ? observed(result.num_turns, "result.num_turns", { unit: "turns" })
      : unavailable("The runtime did not expose message/turn count.", {
        unit: "turns",
      });
    nativeTiming = result?.duration_ms !== undefined
      ? observed(result.duration_ms, "result.duration_ms")
      : unavailable("The runtime did not expose native duration.");
  } else {
    const completed = [...events]
      .reverse()
      .find((event) => event.type === "turn.completed");
    const usage = completed?.usage;
    tokens = {
      input: usage
        ? observed(usage.input_tokens ?? null, "turn.completed.usage.input_tokens")
        : unavailable("The runtime did not expose input tokens."),
      cached_input: usage
        ? observed(
          usage.cached_input_tokens ?? null,
          "turn.completed.usage.cached_input_tokens",
        )
        : unavailable("The runtime did not expose cached-input tokens."),
      cache_write_input: usage
        ? observed(
          usage.cache_write_input_tokens ?? null,
          "turn.completed.usage.cache_write_input_tokens",
        )
        : unavailable("The runtime did not expose cache-write input tokens."),
      output: usage
        ? observed(
          usage.output_tokens ?? null,
          "turn.completed.usage.output_tokens",
        )
        : unavailable("The runtime did not expose output tokens."),
      reasoning_output: usage
        ? observed(
          usage.reasoning_output_tokens ?? null,
          "turn.completed.usage.reasoning_output_tokens",
        )
        : unavailable("The runtime did not expose reasoning-output tokens."),
      total: unavailable(
        "The Codex runtime did not expose a native total-token field.",
      ),
    };
    actualCost = unavailable(
      "Actual runtime cost was not exposed by the Codex runtime.",
      { label: "actual" },
    );
    const toolTypes = new Set([
      "command_execution",
      "mcp_tool_call",
      "web_search",
      "file_change",
    ]);
    toolCalls = events.length > 0
      ? observed(
        events.filter(
          (event) =>
            event.type === "item.completed" && toolTypes.has(event.item?.type),
        ).length,
        "complete structured stream item.completed tool count",
      )
      : unavailable("Structured tool-call events were not exposed.");
    messages = events.length > 0
      ? observed(
        events.filter(
          (event) =>
            event.type === "item.completed" &&
            event.item?.type === "agent_message",
        ).length,
        "complete structured stream item.completed agent_message count",
        { unit: "messages" },
      )
      : unavailable("Structured message events were not exposed.", {
        unit: "messages",
      });
    nativeTiming = unavailable(
      "The Codex runtime did not expose native duration.",
    );
  }

  const retryEvents = events.filter(
    (event) =>
      event.type === "retry" ||
      event.subtype === "retry" ||
      event.type === "api_retry",
  );
  retries = retryEvents.length > 0
    ? observed(retryEvents.length, "structured retry event count")
    : unavailable("The runtime did not expose a retry counter or retry event.");

  return {
    tokens,
    cost: {
      actual_runtime_usd: actualCost,
      estimated_token_usd: estimatedCost(
        runtime,
        selector,
        tokens,
        priceBasis,
      ),
    },
    tool_calls: toolCalls,
    messages,
    retries,
    timing: {
      runtime_duration_ms: nativeTiming,
    },
  };
}

function reportSection(report, title) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(
    `^##\\s+(?:\\d+\\.\\s+)?${escapedTitle}\\s*$`,
    "im",
  );
  const match = heading.exec(report);
  if (!match) return null;
  const remainder = report.slice(match.index + match[0].length);
  const nextHeading = remainder.search(/^##\s+/m);
  return nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
}

function reportMetadataValue(report, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = report.match(
    new RegExp(
      `^\\s*(?:[-+*]\\s+)?(?:\\*\\*)?${escapedLabel}\\s*:(?:\\*\\*)?\\s*(.+?)\\s*$`,
      "im",
    ),
  )?.[1]?.trim();
  return /^`[^`\r\n]+`$/.test(value ?? "")
    ? value.slice(1, -1).trim()
    : value;
}

function parseReportFindings(report) {
  const findingsSection = reportSection(report, "Findings") ?? "";
  if (/^\s*No findings\.\s*$/im.test(findingsSection)) return [];
  const rows = findingsSection
    .split("\n")
    .filter((line) => /^\s*\|/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells) =>
        cells.length >= 6 &&
        !/^#$/i.test(cells[0]) &&
        !/^[-:]+$/.test(cells[0]),
    );
  return rows.map((cells) => {
    const fingerprint = cells.join(" ").match(/\b[a-f0-9]{64}\b/i)?.[0];
    return {
      id: cells[0],
      severity: cells[1],
      lens: cells[2],
      location: cells[3],
      finding: cells[4],
      suggested_edit: cells.slice(5).join(" | "),
      fingerprint: fingerprint?.toLowerCase(),
      scope_change: cells[1] === "Scope Change Required",
    };
  });
}

function validateReport(report, configuration) {
  const failures = [];
  const findingsSection = reportSection(report, "Findings");
  if (findingsSection === null) {
    failures.push("report is missing a Findings section");
  } else if (
    !/\bNo findings\./i.test(findingsSection) &&
    parseReportFindings(report).length === 0
  ) {
    failures.push("report Findings table is invalid");
  }
  const metadata = {
    timestamp: reportMetadataValue(report, "Timestamp"),
    mode: reportMetadataValue(report, "Mode"),
    runtime: reportMetadataValue(report, "Reviewer Runtime"),
    model: reportMetadataValue(report, "Reviewer Model"),
    effort: reportMetadataValue(report, "Reviewer Effort"),
    route: reportMetadataValue(report, "Invocation Route"),
  };
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      metadata.timestamp ?? "",
    ) ||
    Number.isNaN(Date.parse(metadata.timestamp))
  ) {
    failures.push(
      `report metadata timestamp expected an ISO8601 UTC value, found ${JSON.stringify(metadata.timestamp ?? null)}`,
    );
  }
  const expected = {
    mode: "adversarial",
    runtime: configuration.runtimeLabel,
    model: configuration.model,
    effort: configuration.effort,
    route: configuration.route,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (metadata[field] !== value) {
      failures.push(
        `report metadata ${field} expected ${JSON.stringify(value)}, found ${JSON.stringify(metadata[field] ?? null)}`,
      );
    }
  }
  return { valid: failures.length === 0, failures, metadata };
}

const MATCH_STOP_WORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "and",
  "are",
  "before",
  "but",
  "does",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "not",
  "only",
  "that",
  "the",
  "their",
  "then",
  "this",
  "through",
  "with",
]);

function matchTokens(value) {
  return new Set(
    String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g)
      ?.filter(
        (token) =>
          token.length >= 3 &&
          !MATCH_STOP_WORDS.has(token) &&
          !/^\d+$/.test(token),
      ) ?? [],
  );
}

function findingReferences(value) {
  const references = new Set();
  const text = String(value ?? "").toLowerCase();
  for (const match of text.matchAll(/\b\d+(?:\.\d+){1,2}\b/g)) {
    references.add(match[0]);
  }
  for (const match of text.matchAll(
    /\b[a-z0-9_.-]+\.(?:json|md|mjs|cjs|js)\b/g,
  )) {
    references.add(match[0]);
  }
  for (const match of text.matchAll(/§\s*\d+(?:\.\d+)*/g)) {
    references.add(match[0].replace(/\s+/g, ""));
  }
  return references;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function semanticMatchScore(oracle, candidate) {
  if (!oracle.match?.defect_class || !oracle.source_evidence?.finding) {
    return null;
  }
  const candidateText = [
    candidate.lens,
    candidate.location,
    candidate.finding,
    candidate.suggested_edit,
  ].join(" ");
  const candidateTokens = matchTokens(candidateText);
  const candidateReferences = findingReferences(candidateText);
  const oracleLensTokens = matchTokens((oracle.match.lens ?? []).join(" "));
  const candidateLensTokens = matchTokens(candidate.lens);
  if (intersectionSize(oracleLensTokens, candidateLensTokens) === 0) {
    return null;
  }

  const defectTokens = matchTokens(oracle.match.defect_class);
  const defectCoverage =
    defectTokens.size === 0
      ? 0
      : intersectionSize(defectTokens, candidateTokens) / defectTokens.size;
  const oracleReferenceText = [
    ...(oracle.match.locations ?? []),
    oracle.source_evidence.finding,
    oracle.source_evidence.suggested_edit,
  ].join(" ");
  const oracleReferences = findingReferences(oracleReferenceText);
  const referenceHits = intersectionSize(
    oracleReferences,
    candidateReferences,
  );
  const evidenceTokens = matchTokens([
    oracle.source_evidence.finding,
    oracle.source_evidence.suggested_edit,
  ].join(" "));
  const evidenceHits = intersectionSize(evidenceTokens, candidateTokens);
  if (
    defectCoverage < 0.5 ||
    referenceHits < Math.min(2, oracleReferences.size) ||
    evidenceHits < 3
  ) {
    return null;
  }
  return (
    defectCoverage * 0.5 +
    (Math.min(referenceHits, 5) / 5) * 0.3 +
    (Math.min(evidenceHits, 8) / 8) * 0.2
  );
}

function routeBlindSemanticMatch(oracleFindings, candidate) {
  const scored = oracleFindings
    .flatMap((oracle) => {
      const score = semanticMatchScore(oracle, candidate);
      return score === null ? [] : [{ oracle, score }];
    })
    .sort((left, right) =>
      right.score - left.score || left.oracle.id.localeCompare(right.oracle.id),
    );
  if (scored.length === 0) return null;
  if (
    scored.length > 1 &&
    Math.abs(scored[0].score - scored[1].score) < 0.05
  ) {
    return null;
  }
  return scored[0].oracle;
}

export function scoreFindings({
  oracleFindings,
  candidateFindings,
  adjudications = [],
}) {
  const adjudicationByCandidate = new Map(
    adjudications.map((record) => [record.candidate_id, record]),
  );
  const oracleByFingerprint = new Map(
    oracleFindings
      .filter((finding) => finding.fingerprint)
      .map((finding) => [finding.fingerprint, finding]),
  );
  const oracleById = new Map(
    oracleFindings.map((finding) => [finding.id, finding]),
  );
  const matchedOracle = new Map();
  const matchedCandidates = new Set();
  const duplicateCandidates = new Set();
  const severityDrift = [];
  const matches = [];

  for (const candidate of candidateFindings) {
    const adjudication = adjudicationByCandidate.get(candidate.id);
    const adjudicatedOracle =
      adjudication?.route_blind === true &&
      adjudication.disposition === "supported"
        ? oracleById.get(adjudication.oracle_id)
        : null;
    const exactOracle = candidate.fingerprint
      ? oracleByFingerprint.get(candidate.fingerprint)
      : null;
    const oracle =
      exactOracle ??
      adjudicatedOracle ??
      routeBlindSemanticMatch(oracleFindings, candidate);
    if (!oracle) continue;
    if (matchedOracle.has(oracle.id)) {
      duplicateCandidates.add(candidate.id);
      continue;
    }
    matchedOracle.set(oracle.id, candidate);
    matchedCandidates.add(candidate.id);
    matches.push({
      candidate_id: candidate.id,
      oracle_id: oracle.id,
      method: exactOracle
        ? "fingerprint"
        : adjudicatedOracle
          ? "route-blind-adjudication"
          : "route-blind-semantic",
    });
    if (candidate.severity !== oracle.severity) {
      severityDrift.push({
        candidate_id: candidate.id,
        oracle_id: oracle.id,
        expected: oracle.severity,
        observed: candidate.severity,
      });
    }
  }

  const recallBySeverity = {};
  for (const severity of SEVERITIES) {
    const expected = oracleFindings.filter(
      (finding) => finding.severity === severity,
    );
    const matched = expected.filter((finding) =>
      matchedOracle.has(finding.id),
    );
    recallBySeverity[severity] =
      expected.length === 0 ? null : matched.length / expected.length;
  }
  const totalWeight = oracleFindings.reduce(
    (total, finding) => total + (SEVERITY_WEIGHTS[finding.severity] ?? 0),
    0,
  );
  const matchedWeight = oracleFindings
    .filter((finding) => matchedOracle.has(finding.id))
    .reduce(
      (total, finding) => total + (SEVERITY_WEIGHTS[finding.severity] ?? 0),
      0,
    );

  const unmatchedCandidates = candidateFindings
    .filter(
      (candidate) =>
        !matchedCandidates.has(candidate.id) &&
        !duplicateCandidates.has(candidate.id),
    )
    .map((candidate) => {
      const adjudication = adjudicationByCandidate.get(candidate.id);
      const routeBlind = adjudication?.route_blind === true;
      const acceptedDisposition = new Set(["supported", "unsupported"]);
      return {
        id: candidate.id,
        status:
          routeBlind && acceptedDisposition.has(adjudication.disposition)
            ? adjudication.disposition
            : "unadjudicated",
        route_blind:
          routeBlind && acceptedDisposition.has(adjudication?.disposition),
      };
    });
  const adjudicated = unmatchedCandidates.filter(
    ({ status }) => status !== "unadjudicated",
  );
  const supportedCount =
    matchedOracle.size +
    adjudicated.filter(({ status }) => status === "supported").length;
  const precisionDenominator = matchedOracle.size + adjudicated.length;

  return {
    matches,
    recall_by_severity: recallBySeverity,
    weighted_recall: totalWeight === 0 ? null : matchedWeight / totalWeight,
    duplicate_count: duplicateCandidates.size,
    duplicate_candidate_ids: [...duplicateCandidates],
    severity_drift: severityDrift,
    false_scope_change_count: candidateFindings.filter((candidate) => {
      const adjudication = adjudicationByCandidate.get(candidate.id);
      return (
        candidate.scope_change === true &&
        adjudication?.route_blind === true &&
        adjudication.disposition === "unsupported"
      );
    }).length,
    unmatched_known: oracleFindings.filter(
      (finding) => !matchedOracle.has(finding.id),
    ),
    unmatched_candidates: unmatchedCandidates,
    supported_precision:
      precisionDenominator === 0 ? null : supportedCount / precisionDenominator,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function aggregateRuns(runs) {
  const valid = runs.filter((run) => run.status === "valid");
  const excluded = runs
    .filter((run) => run.status !== "valid")
    .map((run) => ({ id: run.id, status: run.status }));
  const variants = {};
  for (const run of valid) {
    variants[run.variant] ??= {
      individual_runs: [],
      duration_ms: { individual: [], median: null, range: [] },
    };
    variants[run.variant].individual_runs.push(run);
    variants[run.variant].duration_ms.individual.push(run.timing.total_ms);
  }
  for (const summary of Object.values(variants)) {
    const values = summary.duration_ms.individual;
    summary.duration_ms.median = median(values);
    summary.duration_ms.range =
      values.length === 0 ? [] : [Math.min(...values), Math.max(...values)];
  }

  const baselineByBlock = new Map(
    valid
      .filter((run) => run.variant === "baseline-opus-max")
      .map((run) => [String(run.block), run]),
  );
  const pairedDeltas = {};
  for (const variant of Object.keys(variants).filter(
    (name) => name !== "baseline-opus-max",
  )) {
    pairedDeltas[variant] = valid
      .filter((run) => run.variant === variant)
      .flatMap((candidate) => {
        const baseline = baselineByBlock.get(String(candidate.block));
        if (!baseline) return [];
        const baselineMs = baseline.timing.total_ms;
        const candidateMs = candidate.timing.total_ms;
        return [{
          block: candidate.block,
          baseline_ms: baselineMs,
          candidate_ms: candidateMs,
          improvement_percent:
            ((baselineMs - candidateMs) / baselineMs) * 100,
        }];
      });
  }
  return {
    schema_version: AGGREGATE_SCHEMA_VERSION,
    variants,
    excluded,
    paired_deltas: pairedDeltas,
  };
}

async function acquireLock(lockFile, attestation) {
  await mkdir(dirname(lockFile), { recursive: true });
  try {
    const handle = await open(lockFile, "wx");
    await handle.writeFile(`${JSON.stringify(attestation)}\n`);
    await handle.close();
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`evaluation lock is held: ${lockFile}`);
    }
    throw error;
  }
}

function safeHashObject(value) {
  return sha256(canonicalJson(value));
}

async function loadPairedContext(options, fixtureRoot, priceBasisPath) {
  const hasFreeze = options.freeze !== undefined;
  const hasSchedule = options.schedule !== undefined;
  if (!hasFreeze && !hasSchedule) return null;
  if (!hasFreeze || !hasSchedule) {
    throw new Error("paired run requires both --freeze and --schedule");
  }
  const freezePath = resolve(options.freeze);
  const schedulePath = resolve(options.schedule);
  const [freezeBytes, scheduleBytes] = await Promise.all([
    readFile(freezePath),
    readFile(schedulePath),
  ]);
  const freeze = JSON.parse(freezeBytes);
  const schedule = JSON.parse(scheduleBytes);
  if (freeze.schema_version !== FREEZE_SCHEMA_VERSION) {
    throw new Error("unsupported freeze manifest");
  }
  if (
    freeze.versions?.evaluator !== EVALUATOR_VERSION ||
    freeze.versions?.node !== process.version
  ) {
    throw new Error("freeze evaluator or Node version mismatch");
  }
  if (schedule.schema_version !== SCHEDULE_SCHEMA_VERSION) {
    throw new Error("unsupported paired schedule");
  }
  if (canonicalJson(schedule) !== canonicalJson(buildSchedule(schedule.seed))) {
    throw new Error("paired schedule is not the canonical seed-derived 3x3 schedule");
  }
  const scheduledTrials = schedule.blocks.flatMap((block) =>
    block.trials.map((trial) => ({ ...trial, block: block.block }))
  );
  const scheduled = scheduledTrials.find(
    (trial) => trial.trial_id === options.trial,
  );
  if (!scheduled) {
    throw new Error(`trial is not present in paired schedule: ${options.trial}`);
  }
  if (scheduled.variant !== options.variant) {
    throw new Error("paired schedule trial variant mismatch");
  }
  if (
    options.block !== undefined &&
    Number(options.block) !== scheduled.block
  ) {
    throw new Error("paired schedule trial block mismatch");
  }
  const attempt = options.attempt === undefined
    ? 1
    : Number(options.attempt);
  const attemptId = pairedAttemptId(scheduled.trial_id, attempt);

  const { manifest, manifestHash } = await verifyFixture(fixtureRoot);
  const currentHashes = {
    evaluator: await hashFile(fileURLToPath(import.meta.url)),
    fixture_manifest: manifestHash,
    fixture_components: safeHashObject(manifest.components),
    baseline_contract: await hashFile(
      join(fixtureRoot, "baseline", "contract.json"),
    ),
    candidate_contract: await hashFile(
      join(fixtureRoot, "candidate", "contract.json"),
    ),
    price_basis: await hashFile(priceBasisPath),
    canonical_skill: await hashFile(join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre",
      "skills",
      "spectre-task_review",
      "SKILL.md",
    )),
    generated_skill: await hashFile(join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre-codex",
      "skills",
      "spectre-task_review",
      "SKILL.md",
    )),
    canonical_helper: await hashFile(join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre",
      "skills",
      "spectre-task_review",
      "scripts",
      "task-review-safety.mjs",
    )),
    generated_helper: await hashFile(join(
      EVALUATOR_REPOSITORY_ROOT,
      "plugins",
      "spectre-codex",
      "skills",
      "spectre-task_review",
      "scripts",
      "task-review-safety.mjs",
    )),
    normalized_prompt: await normalizedPromptHash(
      fixtureRoot,
      options.variant,
    ),
  };
  const frozenHashes = {
    evaluator: freeze.hashes?.evaluator,
    fixture_manifest: freeze.hashes?.fixture_manifest,
    fixture_components: freeze.hashes?.fixture_components,
    baseline_contract: freeze.hashes?.contracts?.baseline,
    candidate_contract: freeze.hashes?.contracts?.candidate,
    price_basis: freeze.hashes?.price_basis,
    canonical_skill: freeze.hashes?.skills?.canonical,
    generated_skill: freeze.hashes?.skills?.generated,
    canonical_helper: freeze.hashes?.helpers?.canonical,
    generated_helper: freeze.hashes?.helpers?.generated,
    normalized_prompt:
      freeze.hashes?.normalized_prompts?.[options.variant],
  };
  for (const [name, current] of Object.entries(currentHashes)) {
    if (frozenHashes[name] !== current) {
      throw new Error(`freeze ${name.replaceAll("_", " ")} mismatch`);
    }
  }
  if (
    !/^[a-f0-9]{40}$/.test(freeze.repository?.commit ?? "") ||
    typeof freeze.repository?.dirty !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(
      freeze.repository?.dirty_diff_sha256 ?? "",
    ) ||
    freeze.repository?.comparison_binding !== "protected-input-hashes"
  ) {
    throw new Error("freeze repository provenance is invalid");
  }
  const configuration = VARIANTS[options.variant];
  const reviewerBinary = options.reviewerCommand ||
    (configuration.runtime === "claude-code"
      ? process.env.CLAUDE_BIN || "claude"
      : process.env.CODEX_BIN || "codex");
  const reviewerVersion = commandVersion(
    reviewerBinary,
    cleanEnvironment(),
  ).value;
  const frozenReviewerVersion =
    freeze.versions?.reviewer_clis?.[
      configuration.runtime === "claude-code" ? "claude" : "codex"
    ];
  if (reviewerVersion !== frozenReviewerVersion) {
    throw new Error("freeze reviewer CLI version mismatch");
  }
  if (freeze.freeze_id !== expectedFreezeId(freeze)) {
    throw new Error("freeze manifest identity mismatch");
  }
  return {
    block: scheduled.block,
    trialId: scheduled.trial_id,
    attempt,
    attemptId,
    freezeHash: sha256(freezeBytes),
    scheduleHash: sha256(scheduleBytes),
    normalizedPromptHash: currentHashes.normalized_prompt,
  };
}

async function runEvaluation(options, hooks = {}) {
  requireOptions(options, [
    "fixture",
    "variant",
    "trial",
    "outputDir",
    "priceBasis",
  ]);
  const configuration = VARIANTS[options.variant];
  if (!configuration) {
    throw new Error(`unknown variant: ${options.variant}`);
  }
  const fixtureRoot = resolve(options.fixture);
  const outputDirectory = resolve(options.outputDir);
  const priceBasisPath = resolve(options.priceBasis);
  const pairedContext = await loadPairedContext(
    options,
    fixtureRoot,
    priceBasisPath,
  );
  if (!pairedContext && options.attempt !== undefined) {
    throw new Error("--attempt is supported only for paired runs");
  }
  const scheduledTrialId = pairedContext?.trialId ?? options.trial;
  const attemptId = pairedContext?.attemptId ?? options.trial;
  const timeoutMs = Number(options.timeoutMs ?? 1_200_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (await exists(outputDirectory)) {
    throw new Error(`output directory already exists: ${outputDirectory}`);
  }
  const totalStarted = performance.now();
  const wallStarted = new Date().toISOString();
  const lockFile = resolve(
    options.lockFile ?? join(tmpdir(), "spectre-task-review-evaluation.lock"),
  );
  if (hooks.beforeLock) await hooks.beforeLock({ lockFile });
  const lockAttestation = {
    pid: process.pid,
    trial: attemptId,
    variant: options.variant,
    started_at: wallStarted,
  };
  await acquireLock(lockFile, lockAttestation);

  let outputCreated = false;
  let stagedAuth = null;
  let runRoot = null;
  let pairedQuiescence = null;
  try {
    await mkdir(outputDirectory, { recursive: false });
    outputCreated = true;
    pairedQuiescence = pairedContext
      ? startQuiescenceMonitor(hooks)
      : null;
    runRoot = await mkdtemp(join(tmpdir(), "spectre-task-review-run-"));
    if (
      isWithin(EVALUATOR_REPOSITORY_ROOT, runRoot) ||
      isWithin(outputDirectory, runRoot) ||
      isWithin(runRoot, outputDirectory)
    ) {
      throw new Error(
        "OS temporary execution root must be outside the repository and evidence output",
      );
    }
    const workspace = join(runRoot, "workspace");
    const taskRoot = join(
      workspace,
      "docs",
      "tasks",
      "main",
      "knowledge-surfacing",
    );
    const evidenceWorkspace = join(outputDirectory, "workspace");
    const evidenceTaskRoot = join(
      evidenceWorkspace,
      "docs",
      "tasks",
      "main",
      "knowledge-surfacing",
    );
    const rawDirectory = join(outputDirectory, "raw");
    const reportPath = join(taskRoot, "reviews", "task_review.md");
    await Promise.all([
      mkdir(taskRoot, { recursive: true }),
      mkdir(rawDirectory, { recursive: true }),
      mkdir(dirname(reportPath), { recursive: true }),
    ]);

    const { manifest, manifestHash } = await verifyFixture(fixtureRoot);
    await cp(join(fixtureRoot, "input"), taskRoot, { recursive: true });
    const beforeHashes = await hashProtectedInputs(taskRoot);
    const contractPath = join(fixtureRoot, configuration.contract);
    const contractHash = await hashFile(contractPath);
    const priceBasis = JSON.parse(await readFile(priceBasisPath, "utf8"));
    const priceBasisHash = await hashFile(priceBasisPath);
    const prompt = await loadPrompt(
      fixtureRoot,
      options.variant,
      taskRoot,
      reportPath,
    );
    const command = reviewerCommand(configuration, prompt, workspace, {
      command: options.reviewerCommand,
      args: options.reviewerArg,
    });
    const reviewerRuntime = await prepareReviewerRuntime(
      runRoot,
      configuration,
      reportPath,
      taskRoot,
    );
    stagedAuth = reviewerRuntime.stagedAuth;
    const {
      baseEnvironment,
      claudeHome,
      codexHome,
      environment,
      hostHome,
      reviewerUsesHostHome,
      spectreHome,
    } = reviewerRuntime;
    const claudeAuthentication = reviewerAuthentication(
      configuration,
      options.reviewerCommand,
      command.command,
      claudeHome,
      environment,
    );
    if (hooks.debugLog) {
      hooks.debugLog(
        `[🪳 TEMP CLAUDE_AUTH_HOME] host_home_bridge=${hostHome !== null} reviewer_home_keychain_bridge=${reviewerUsesHostHome}`,
      );
    }
    const version = commandVersion(command.command, environment);
    const preflightEnded = performance.now();

    const authenticationBlocked =
      configuration.runtime === "claude-code" &&
      claudeAuthentication.checked &&
      !claudeAuthentication.logged_in;
    if (hooks.beforeReviewer) {
      await hooks.beforeReviewer({ workspace, environment, prompt });
    }
    const preflightQuiescenceBlocked =
      pairedQuiescence && !pairedQuiescence.preClean;
    const reviewerExecution = authenticationBlocked ||
        preflightQuiescenceBlocked
      ? {
        processResult: {
          exitCode: null,
          signal: null,
          error: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          skipped: true,
          durationMs: 0,
        },
        quiescence: pairedQuiescence
          ? null
          : assessQuiescenceWithoutReviewer(
            hooks.processSnapshot ?? processSnapshot,
          ),
      }
      : pairedQuiescence
        ? {
          processResult: await runReviewer(
            command.command,
            command.args,
            {
              cwd: workspace,
              env: environment,
              timeoutMs,
              onSpawn(pid) {
                pairedQuiescence.setReviewerPid(pid);
              },
            },
          ),
          quiescence: null,
        }
        : await runReviewerWithQuiescence(command.command, command.args, {
          cwd: workspace,
          env: environment,
          timeoutMs,
        }, hooks);
    const { processResult } = reviewerExecution;
    const reviewerEnded = performance.now();
    const rawStdoutPath = join(rawDirectory, "reviewer.stdout.jsonl");
    const rawStderrPath = join(rawDirectory, "reviewer.stderr.txt");
    const rawEventsPath = join(rawDirectory, "reviewer.events.jsonl");
    const { events, rawEvents } = parseJsonLines(processResult.stdout);
    await Promise.all([
      writeFile(rawStdoutPath, processResult.stdout),
      writeFile(rawStderrPath, processResult.stderr),
      writeFile(rawEventsPath, rawEvents),
    ]);

    const blockedReasons = [];
    if (authenticationBlocked) {
      blockedReasons.push(
        `Claude authentication preflight failed: ${claudeAuthentication.unavailable_reason}`,
      );
    } else if (preflightQuiescenceBlocked) {
      blockedReasons.push(
        "preflight quiescence attestation is unclean or contaminated",
      );
    } else if (processResult.timedOut) {
      blockedReasons.push(`reviewer timeout after ${timeoutMs}ms`);
    } else if (processResult.error) {
      blockedReasons.push(`reviewer process error: ${processResult.error}`);
    } else if (processResult.exitCode !== 0) {
      blockedReasons.push(`reviewer exit ${processResult.exitCode}`);
    }

    if (hooks.beforeValidation) {
      await hooks.beforeValidation({ workspace, environment, prompt });
    }
    let report = null;
    if (await exists(reportPath)) {
      report = await readFile(reportPath, "utf8");
    } else {
      blockedReasons.push("review report is missing");
    }
    const reportValidation = report
      ? validateReport(report, configuration)
      : { valid: false, failures: ["report is missing"], metadata: {} };
    blockedReasons.push(...reportValidation.failures);
    const afterHashes = await hashProtectedInputs(taskRoot);
    const inputsUnchanged =
      canonicalJson(beforeHashes) === canonicalJson(afterHashes);
    if (!inputsUnchanged) {
      blockedReasons.push("protected input mutation detected");
    }
    const workspaceFiles = await filesBelow(workspace);
    const oraclePresent = workspaceFiles.some((path) =>
      /(^|\/)oracle(\/|$)|historical-task-review|findings\.json/i.test(path),
    );
    if (oraclePresent) {
      blockedReasons.push("oracle data is present in candidate workspace");
    }

    const oracle = JSON.parse(
      await readFile(join(fixtureRoot, "oracle", "findings.json"), "utf8"),
    );
    const quality = reportValidation.valid
      ? scoreFindings({
        oracleFindings: oracle.findings,
        candidateFindings: parseReportFindings(report),
      })
      : null;
    if (quality && quality.recall_by_severity.Blocker !== 1) {
      blockedReasons.push(
        `known Blocker recall must be 100%, found ${
          quality.recall_by_severity.Blocker == null
            ? "unavailable"
            : `${quality.recall_by_severity.Blocker * 100}%`
        }`,
      );
    }
    await cp(workspace, evidenceWorkspace, { recursive: true });
    const quiescence = pairedQuiescence
      ? pairedQuiescence.finish()
      : reviewerExecution.quiescence;
    if (pairedContext && !quiescence.clean) {
      blockedReasons.push("quiescence attestation is unclean or contaminated");
    }
    const validationEnded = performance.now();
    const intervals = {
      preflight_ms: preflightEnded - totalStarted,
      reviewer_ms: reviewerEnded - preflightEnded,
      validation_ms: validationEnded - reviewerEnded,
    };
    const totalMs = validationEnded - totalStarted;
    const intervalSum = Object.values(intervals).reduce(
      (sum, value) => sum + value,
      0,
    );
    const evidenceReportPath = join(
      evidenceTaskRoot,
      "reviews",
      "task_review.md",
    );
    const telemetry = normalizeTelemetry(
      configuration.runtime,
      events,
      priceBasis,
      configuration.model,
    );
    const result = {
      schema_version: SCHEMA_VERSION,
      id: attemptId,
      variant: options.variant,
      trial: scheduledTrialId,
      block: pairedContext?.block ?? options.block ?? null,
      ...(pairedContext
        ? {
          attempt_id: attemptId,
          attempt: pairedContext.attempt,
          freeze_manifest_sha256: pairedContext.freezeHash,
          schedule_sha256: pairedContext.scheduleHash,
        }
        : {}),
      status: blockedReasons.length === 0 ? "valid" : "blocked",
      blocked_reasons: blockedReasons,
      route: {
        primary_runtime: configuration.primaryRuntime,
        reviewer_runtime: configuration.runtime,
        model: configuration.model,
        effort: configuration.effort,
        invocation_route: configuration.route,
      },
      versions: {
        evaluator: EVALUATOR_VERSION,
        node: process.version,
        reviewer_cli: version,
      },
      hashes: {
        fixture_manifest: manifestHash,
        fixture_components: safeHashObject(manifest.components),
        contract: contractHash,
        prompt: sha256(prompt),
        normalized_prompt:
          pairedContext?.normalizedPromptHash ??
          await normalizedPromptHash(fixtureRoot, options.variant),
        price_basis: priceBasisHash,
        environment: safeHashObject({
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          path: baseEnvironment.PATH ?? null,
        }),
      },
      isolation: {
        workspace: evidenceWorkspace,
        task_root: evidenceTaskRoot,
        execution_workspace: workspace,
        execution_cwd: workspace,
        execution_isolated: true,
        contamination: {
          live_repository_accessible_from_workspace_ancestors: false,
          oracle_present: oraclePresent,
        },
        runtime_homes: {
          claude: claudeHome,
          codex: codexHome,
          spectre: spectreHome,
        },
        oracle_present: oraclePresent,
      },
      protected_inputs: {
        before: beforeHashes,
        after: afterHashes,
      },
      process: {
        command: command.command,
        args: command.args,
        exit_code: processResult.exitCode,
        signal: processResult.signal,
        timed_out: processResult.timedOut,
        timeout_ms: timeoutMs,
        launched: !processResult.skipped,
        attempts: 1,
        retries: telemetry.retries.value ?? 0,
        repairs: 0,
        fallback: {
          value: null,
          unavailable_reason:
            "No fallback route was configured or attempted by this evaluator run.",
        },
      },
      authentication: {
        claude: claudeAuthentication,
      },
      lock: {
        path: lockFile,
        exclusive: true,
        attestation: lockAttestation,
      },
      quiescence,
      validity: {
        first_pass: reportValidation.valid,
        report: reportValidation.valid,
        report_failures: reportValidation.failures,
        inputs_unchanged: inputsUnchanged,
        allowed_writes: !oraclePresent && inputsUnchanged,
      },
      telemetry,
      quality,
      evidence: {
        raw_stdout: relative(outputDirectory, rawStdoutPath),
        raw_stdout_sha256: await hashFile(rawStdoutPath),
        raw_stderr: relative(outputDirectory, rawStderrPath),
        raw_stderr_sha256: await hashFile(rawStderrPath),
        raw_events: relative(outputDirectory, rawEventsPath),
        raw_events_sha256: await hashFile(rawEventsPath),
        report: report
          ? relative(outputDirectory, evidenceReportPath)
          : null,
        report_sha256: report ? sha256(report) : null,
      },
      timing: {
        clock: "performance.now monotonic milliseconds",
        started_at: wallStarted,
        ended_at: new Date().toISOString(),
        total_ms: totalMs,
        intervals,
        reconciliation_error_ms: Math.abs(totalMs - intervalSum),
      },
    };
    await atomicWriteJson(join(outputDirectory, "result.json"), result);
    return result;
  } catch (error) {
    let failure = error;
    let failedQuiescence = null;
    if (pairedQuiescence) {
      try {
        failedQuiescence = pairedQuiescence.finish();
      } catch (monitorError) {
        failure = new Error(
          `${error.message}; quiescence monitor failed: ${monitorError.message}`,
        );
      }
    }
    if (outputCreated && !(await exists(join(outputDirectory, "result.json")))) {
      const failedAt = performance.now();
      await atomicWriteJson(join(outputDirectory, "result.json"), {
        schema_version: SCHEMA_VERSION,
        id: attemptId,
        variant: options.variant,
        trial: scheduledTrialId,
        block: pairedContext?.block ?? options.block ?? null,
        ...(pairedContext
          ? {
            attempt_id: attemptId,
            attempt: pairedContext.attempt,
            freeze_manifest_sha256: pairedContext.freezeHash,
            schedule_sha256: pairedContext.scheduleHash,
          }
          : {}),
        status: "blocked",
        blocked_reasons: [`evaluator error: ${failure.message}`],
        ...(failedQuiescence ? { quiescence: failedQuiescence } : {}),
        timing: {
          clock: "performance.now monotonic milliseconds",
          started_at: wallStarted,
          ended_at: new Date().toISOString(),
          total_ms: failedAt - totalStarted,
        },
      });
    }
    throw failure;
  } finally {
    if (stagedAuth) await rm(stagedAuth, { force: true });
    if (runRoot) await rm(runRoot, { recursive: true, force: true });
    await rm(lockFile, { force: true });
  }
}

async function readRunResults(runsPath) {
  const resolved = resolve(runsPath);
  const information = await stat(resolved);
  if (information.isFile()) {
    const value = JSON.parse(await readFile(resolved, "utf8"));
    return Array.isArray(value) ? value : [value];
  }
  const results = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.name === "result.json") {
        results.push(JSON.parse(await readFile(path, "utf8")));
      }
    }
  }
  await visit(resolved);
  return results;
}

const PAIRED_METRICS = [
  { path: ["latency_ms"], read: (run) => run.timing?.total_ms },
  { path: ["tokens", "input"], telemetry: ["tokens", "input"] },
  {
    path: ["tokens", "cached_input"],
    telemetry: ["tokens", "cached_input"],
  },
  { path: ["tokens", "output"], telemetry: ["tokens", "output"] },
  {
    path: ["tokens", "reasoning_output"],
    telemetry: ["tokens", "reasoning_output"],
  },
  { path: ["tokens", "total"], telemetry: ["tokens", "total"] },
  {
    path: ["cost", "actual_runtime_usd"],
    telemetry: ["cost", "actual_runtime_usd"],
    label: "actual",
  },
  {
    path: ["cost", "estimated_token_usd"],
    telemetry: ["cost", "estimated_token_usd"],
    label: "estimate",
  },
  { path: ["tool_calls"], telemetry: ["tool_calls"] },
  { path: ["messages"], telemetry: ["messages"] },
  {
    path: ["validity", "first_pass"],
    read: (run) => run.validity?.first_pass === true ? 1 : 0,
  },
  { path: ["process", "retries"], read: (run) => run.process?.retries ?? 0 },
  { path: ["process", "repairs"], read: (run) => run.process?.repairs ?? 0 },
  {
    path: ["process", "fallbacks"],
    read: (run) => run.process?.fallback?.value == null ? 0 : 1,
  },
  ...SEVERITIES.map((severity) => ({
    path: ["quality", "recall_by_severity", severity],
    read: (run) => run.quality?.recall_by_severity?.[severity],
  })),
  {
    path: ["quality", "weighted_recall"],
    read: (run) => run.quality?.weighted_recall,
  },
  {
    path: ["quality", "supported_precision"],
    read: (run) => run.quality?.supported_precision,
  },
  {
    path: ["quality", "duplicates"],
    read: (run) => run.quality?.duplicate_count,
  },
  {
    path: ["quality", "severity_drift"],
    read: (run) => run.quality?.severity_drift?.length ?? 0,
  },
  {
    path: ["quality", "false_scope_changes"],
    read: (run) => run.quality?.false_scope_change_count,
  },
  {
    path: ["quality", "unmatched_findings"],
    read: (run) =>
      (run.quality?.unmatched_known?.length ?? 0) +
      (run.quality?.unmatched_candidates?.length ?? 0),
  },
  {
    path: ["quality", "non_blocker_losses"],
    read: (run) =>
      (run.quality?.unmatched_known ?? []).filter(
        ({ severity }) => severity !== "Blocker",
      ).length,
  },
];

function valueAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return current;
}

function telemetryMetric(run, path) {
  const direct = valueAt(run.telemetry, path)?.value;
  if (typeof direct === "number") return direct;
  const derived = ["source", "repair"].map((part) =>
    valueAt(run.telemetry?.[part], path)?.value
  );
  return derived.some((value) => typeof value === "number")
    ? derived.reduce(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0,
    )
    : null;
}

function pairedMetricValue(run, metric) {
  const value = metric.telemetry
    ? telemetryMetric(run, metric.telemetry)
    : metric.read(run);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function setNested(target, path, value) {
  let current = target;
  for (const key of path.slice(0, -1)) {
    current[key] ??= {};
    current = current[key];
  }
  current[path.at(-1)] = value;
}

function aggregatePairedRuns(runs) {
  const variants = {};
  for (const variant of Object.keys(VARIANTS)) {
    const variantRuns = runs
      .filter((run) => run.variant === variant)
      .sort((left, right) => Number(left.block) - Number(right.block));
    const aggregate = {};
    for (const metric of PAIRED_METRICS) {
      const individual = variantRuns.map((run) =>
        pairedMetricValue(run, metric)
      );
      const available = individual.filter((value) => value !== null);
      setNested(aggregate, metric.path, {
        individual,
        median: median(available),
        range: available.length === 0
          ? []
          : [Math.min(...available), Math.max(...available)],
        ...(metric.label ? { label: metric.label } : {}),
      });
    }
    variants[variant] = aggregate;
  }

  const baselineByBlock = new Map(
    runs
      .filter((run) => run.variant === "baseline-opus-max")
      .map((run) => [Number(run.block), run]),
  );
  const pairedDeltas = {};
  for (const variant of Object.keys(VARIANTS).filter(
    (name) => name !== "baseline-opus-max",
  )) {
    pairedDeltas[variant] = runs
      .filter((run) => run.variant === variant)
      .sort((left, right) => Number(left.block) - Number(right.block))
      .map((candidate) => {
        const baseline = baselineByBlock.get(Number(candidate.block));
        const deltas = {};
        for (const metric of PAIRED_METRICS) {
          const candidateValue = pairedMetricValue(candidate, metric);
          const baselineValue = pairedMetricValue(baseline, metric);
          const available =
            candidateValue !== null && baselineValue !== null;
          const delta = available ? candidateValue - baselineValue : null;
          setNested(deltas, metric.path, {
            candidate: candidateValue,
            baseline: baselineValue,
            delta,
            percent_delta:
              available && baselineValue !== 0
                ? (delta / baselineValue) * 100
                : available
                  ? 0
                  : null,
            ...(metric.label ? { label: metric.label } : {}),
          });
        }
        return { block: Number(candidate.block), deltas };
      });
  }
  return { variants, pairedDeltas };
}

function assertCanonicalSchedule(schedule) {
  if (schedule.schema_version !== SCHEDULE_SCHEMA_VERSION) {
    throw new Error("unsupported paired schedule");
  }
  if (canonicalJson(schedule) !== canonicalJson(buildSchedule(schedule.seed))) {
    throw new Error("schedule must be a canonical seed-derived 3x3 matrix");
  }
}

function assertCompleteFreeze(freeze) {
  if (
    freeze.freeze_id !== expectedFreezeId(freeze) ||
    freeze.versions?.evaluator !== EVALUATOR_VERSION ||
    typeof freeze.versions?.node !== "string" ||
    freeze.versions.node.trim() === "" ||
    typeof freeze.versions?.reviewer_clis?.claude !== "string" ||
    freeze.versions.reviewer_clis.claude.trim() === "" ||
    typeof freeze.versions?.reviewer_clis?.codex !== "string" ||
    freeze.versions.reviewer_clis.codex.trim() === "" ||
    !/^[a-f0-9]{40}$/.test(freeze.repository?.commit ?? "") ||
    typeof freeze.repository?.dirty !== "boolean"
  ) {
    throw new Error("freeze manifest is incomplete or evaluator version mismatched");
  }
  const hashes = [
    freeze.repository.dirty_diff_sha256,
    freeze.hashes?.evaluator,
    freeze.hashes?.fixture_manifest,
    freeze.hashes?.fixture_components,
    freeze.hashes?.contracts?.baseline,
    freeze.hashes?.contracts?.candidate,
    freeze.hashes?.price_basis,
    freeze.hashes?.skills?.canonical,
    freeze.hashes?.skills?.generated,
    freeze.hashes?.helpers?.canonical,
    freeze.hashes?.helpers?.generated,
    ...Object.keys(VARIANTS).map(
      (variant) => freeze.hashes?.normalized_prompts?.[variant],
    ),
  ];
  if (hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash ?? ""))) {
    throw new Error("freeze manifest is incomplete or missing required hashes");
  }
}

function assertTelemetryAvailability(value, path = "telemetry") {
  if (!value || typeof value !== "object") return;
  if (Object.hasOwn(value, "value")) {
    if (
      value.value === null &&
      (typeof value.unavailable_reason !== "string" ||
        value.unavailable_reason.trim() === "")
    ) {
      throw new Error(
        `${path} telemetry is unavailable without an unavailable reason`,
      );
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assertTelemetryAvailability(nested, `${path}.${key}`);
  }
}

function assertCompleteTelemetry(telemetry, path = "telemetry") {
  if (
    telemetry?.source !== undefined ||
    telemetry?.repair !== undefined
  ) {
    if (!telemetry?.source || !telemetry?.repair) {
      throw new Error(
        `${path} telemetry is missing source or repair evidence`,
      );
    }
    assertCompleteTelemetry(telemetry.source, `${path}.source`);
    assertCompleteTelemetry(telemetry.repair, `${path}.repair`);
    return;
  }

  const requiredPaths = [
    ["tokens", "input"],
    ["tokens", "cached_input"],
    ["tokens", "cache_write_input"],
    ["tokens", "output"],
    ["tokens", "reasoning_output"],
    ["tokens", "total"],
    ["cost", "actual_runtime_usd"],
    ["cost", "estimated_token_usd"],
    ["tool_calls"],
    ["messages"],
    ["retries"],
    ["timing", "runtime_duration_ms"],
  ];
  for (const requiredPath of requiredPaths) {
    const observation = valueAt(telemetry, requiredPath);
    if (
      !observation ||
      typeof observation !== "object" ||
      !Object.hasOwn(observation, "value")
    ) {
      throw new Error(
        `${path} telemetry is missing ${requiredPath.join(".")}`,
      );
    }
  }
  if (telemetry.cost.actual_runtime_usd.label !== "actual") {
    throw new Error(`${path} telemetry actual cost label is invalid`);
  }
  if (telemetry.cost.estimated_token_usd.label !== "estimate") {
    throw new Error(`${path} telemetry estimated cost label is invalid`);
  }
  assertTelemetryAvailability(telemetry, path);
}

function assertCountableQuiescence(quiescence, trialId, label = "quiescence") {
  if (quiescence?.clean !== true) {
    throw new Error(
      `counted result ${label} is unclean or contaminated: ${trialId}`,
    );
  }
  for (const stage of ["pre", "continuous", "post"]) {
    if (
      quiescence?.[stage]?.clean !== true ||
      (quiescence?.[stage]?.contaminants?.length ?? 0) > 0
    ) {
      throw new Error(
        `counted result ${label} is unclean or missing samples during ${stage}: ${trialId}`,
      );
    }
  }
  const sampling = quiescence.sampling;
  if (
    quiescence.owned_reviewer_tree_excluded !== true ||
    sampling?.clean !== true ||
    !Number.isInteger(sampling?.sample_count) ||
    sampling.sample_count <= 0 ||
    !Number.isFinite(sampling?.elapsed_ms) ||
    sampling.elapsed_ms < 0 ||
    typeof sampling?.started_at !== "string" ||
    !Number.isFinite(Date.parse(sampling.started_at)) ||
    typeof sampling?.ended_at !== "string" ||
    !Number.isFinite(Date.parse(sampling.ended_at)) ||
    Date.parse(sampling.ended_at) < Date.parse(sampling.started_at) ||
    (sampling?.contaminants?.length ?? 0) > 0
  ) {
    throw new Error(
      `counted result ${label} sampling attestation is incomplete, unclean, or contaminated: ${trialId}`,
    );
  }
}

function assertExclusiveLock(run) {
  const lock = run.lock;
  const attestation = lock?.attestation;
  const attemptId = run.attempt_id ?? run.trial;
  if (
    lock?.exclusive !== true ||
    typeof lock?.path !== "string" ||
    !isAbsolute(lock.path) ||
    !attestation ||
    !Number.isInteger(attestation.pid) ||
    attestation.trial !== attemptId ||
    attestation.variant !== run.variant ||
    attestation.started_at !== run.timing?.started_at
  ) {
    throw new Error(
      `counted result lacks an exclusive timed-run lock attestation: ${run.trial}`,
    );
  }
  if (run.repair?.model_rerun === true) {
    const repairLock = lock.repair;
    if (
      lock.source?.exclusive !== true ||
      lock.source?.path !== lock.path ||
      repairLock?.exclusive !== true ||
      repairLock?.path !== lock.path ||
      repairLock?.attestation?.trial !==
        `${attemptId}-repair-model-1` ||
      repairLock?.attestation?.variant !== run.variant ||
      repairLock?.attestation?.operation !== "repair-model" ||
      !Number.isFinite(
        Date.parse(repairLock?.attestation?.started_at ?? ""),
      )
    ) {
      throw new Error(
        `counted repaired result lacks source and repair exclusive lock attestations: ${run.trial}`,
      );
    }
  }
  return lock.path;
}

function assertCompleteProcess(processEvidence, trialId) {
  const requiredInteger = (field, minimum) => {
    const value = processEvidence?.[field];
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(
        `counted result process ${field} is missing or invalid: ${trialId}`,
      );
    }
  };
  if (
    typeof processEvidence?.command !== "string" ||
    processEvidence.command.trim() === ""
  ) {
    throw new Error(
      `counted result process command is missing or invalid: ${trialId}`,
    );
  }
  if (!Array.isArray(processEvidence.args)) {
    throw new Error(
      `counted result process args are missing or invalid: ${trialId}`,
    );
  }
  if (
    !Object.hasOwn(processEvidence, "signal") ||
    (
      processEvidence.signal !== null &&
      typeof processEvidence.signal !== "string"
    )
  ) {
    throw new Error(
      `counted result process signal is missing or invalid: ${trialId}`,
    );
  }
  if (
    typeof processEvidence.timed_out !== "boolean" ||
    !Number.isFinite(processEvidence.timeout_ms) ||
    processEvidence.timeout_ms <= 0
  ) {
    throw new Error(
      `counted result process timeout evidence is missing or invalid: ${trialId}`,
    );
  }
  if (processEvidence.launched !== true) {
    throw new Error(
      `counted result process launched evidence is missing or invalid: ${trialId}`,
    );
  }
  requiredInteger("attempts", 1);
  requiredInteger("retries", 0);
  requiredInteger("repairs", 0);
  if (
    !processEvidence.fallback ||
    typeof processEvidence.fallback !== "object" ||
    !Object.hasOwn(processEvidence.fallback, "value")
  ) {
    throw new Error(
      `counted result process fallback is missing or invalid: ${trialId}`,
    );
  }
  if (processEvidence.attempts < processEvidence.repairs + 1) {
    throw new Error(
      `counted result process attempts do not cover repairs: ${trialId}`,
    );
  }
}

function assertLiveRouteIdentity(run, configuration) {
  if (
    configuration.runtime === "claude-code" &&
    (
      run.authentication?.claude?.checked !== true ||
      run.authentication?.claude?.logged_in !== true ||
      typeof run.authentication?.claude?.auth_method !== "string" ||
      run.authentication.claude.auth_method.trim() === "" ||
      typeof run.authentication?.claude?.api_provider !== "string" ||
      run.authentication.claude.api_provider.trim() === ""
    )
  ) {
    throw new Error(
      `counted Claude route lacks live authentication identity: ${run.trial}`,
    );
  }
}

async function loadCountedResults(options) {
  requireOptions(options, ["countedResults", "freeze", "schedule"]);
  const manifestPath = resolve(options.countedResults);
  const freezePath = resolve(options.freeze);
  const schedulePath = resolve(options.schedule);
  const [manifestBytes, freezeBytes, scheduleBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(freezePath),
    readFile(schedulePath),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const freeze = JSON.parse(freezeBytes);
  const schedule = JSON.parse(scheduleBytes);
  if (manifest.schema_version !== COUNTED_RESULTS_SCHEMA_VERSION) {
    throw new Error("unsupported counted-results manifest");
  }
  if (freeze.schema_version !== FREEZE_SCHEMA_VERSION) {
    throw new Error("unsupported freeze manifest");
  }
  assertCompleteFreeze(freeze);
  assertCanonicalSchedule(schedule);
  const freezeHash = sha256(freezeBytes);
  const scheduleHash = sha256(scheduleBytes);
  if (manifest.freeze_manifest_sha256 !== freezeHash) {
    throw new Error("counted-results freeze hash mismatch");
  }
  if (manifest.schedule_sha256 !== scheduleHash) {
    throw new Error("counted-results schedule hash mismatch");
  }
  if (!Array.isArray(manifest.results) || manifest.results.length !== 9) {
    throw new Error("counted-results must contain exactly nine results for a 3x3 matrix");
  }
  const expectedTrials = new Map(
    schedule.blocks.flatMap((block) =>
      block.trials.map((trial) => [
        trial.trial_id,
        { ...trial, block: block.block },
      ])
    ),
  );
  if (expectedTrials.size !== 9) {
    throw new Error("paired schedule must contain nine unique trial IDs");
  }
  const seenTrials = new Set();
  const seenAttempts = new Set();
  const seenPaths = new Set();
  const lockPaths = new Set();
  const runs = [];
  const manifestDirectory = dirname(manifestPath);
  for (const entry of manifest.results) {
    if (
      typeof entry.trial_id !== "string" ||
      seenTrials.has(entry.trial_id)
    ) {
      throw new Error(`duplicate or malformed counted trial: ${entry.trial_id}`);
    }
    if (
      typeof entry.attempt_id !== "string" ||
      seenAttempts.has(entry.attempt_id)
    ) {
      throw new Error(
        `duplicate or malformed counted attempt: ${entry.attempt_id}`,
      );
    }
    if (typeof entry.result !== "string") {
      throw new Error("counted result path must name an explicit result file");
    }
    const resultPath = resolve(manifestDirectory, entry.result);
    if (
      isAbsolute(entry.result) ||
      !isWithin(manifestDirectory, resultPath) ||
      seenPaths.has(resultPath)
    ) {
      throw new Error("duplicate or escaping counted result path");
    }
    const information = await stat(resultPath);
    if (!information.isFile()) {
      throw new Error("counted result must be an explicit file, not a directory");
    }
    const bytes = await readFile(resultPath);
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`counted result immutable hash mismatch: ${entry.trial_id}`);
    }
    const run = JSON.parse(bytes);
    const expected = expectedTrials.get(entry.trial_id);
    if (!expected) {
      throw new Error(`counted trial is absent from 3x3 schedule: ${entry.trial_id}`);
    }
    const attempt = pairedAttemptNumber(entry.trial_id, entry.attempt_id);
    if (attempt === null) {
      throw new Error(
        `counted attempt does not belong to scheduled trial: ${entry.trial_id}`,
      );
    }
    if (
      run.trial !== entry.trial_id ||
      run.id !== entry.attempt_id ||
      run.attempt_id !== entry.attempt_id ||
      run.attempt !== attempt ||
      Number(run.block) !== expected.block ||
      run.variant !== expected.variant
    ) {
      throw new Error(`counted result does not match scheduled trial: ${entry.trial_id}`);
    }
    if (run.freeze_manifest_sha256 !== freezeHash) {
      throw new Error(`freeze mismatch for counted trial ${entry.trial_id}`);
    }
    if (run.schedule_sha256 !== scheduleHash) {
      throw new Error(`schedule mismatch for counted trial ${entry.trial_id}`);
    }
    const configuration = VARIANTS[run.variant];
    const frozenContract = run.variant === "baseline-opus-max"
      ? freeze.hashes.contracts.baseline
      : freeze.hashes.contracts.candidate;
    if (
      run.hashes?.fixture_manifest !== freeze.hashes.fixture_manifest ||
      run.hashes?.fixture_components !== freeze.hashes.fixture_components ||
      run.hashes?.contract !== frozenContract ||
      run.hashes?.price_basis !== freeze.hashes.price_basis ||
      run.hashes?.normalized_prompt !==
        freeze.hashes.normalized_prompts[run.variant]
    ) {
      throw new Error(`fixture freeze mismatch for counted trial ${entry.trial_id}`);
    }
    if (
      canonicalJson(run.route) !== canonicalJson(expectedRoute(configuration))
    ) {
      throw new Error(`counted result route mismatch: ${entry.trial_id}`);
    }
    const frozenReviewerVersion =
      freeze.versions.reviewer_clis[
        configuration.runtime === "claude-code" ? "claude" : "codex"
      ];
    if (
      run.versions?.evaluator !== freeze.versions.evaluator ||
      run.versions?.node !== freeze.versions.node ||
      run.versions?.reviewer_cli?.value !== frozenReviewerVersion
    ) {
      throw new Error(`counted result reviewer CLI version mismatch: ${entry.trial_id}`);
    }
    assertLiveRouteIdentity(run, configuration);
    lockPaths.add(assertExclusiveLock(run));
    assertCompleteProcess(run.process, entry.trial_id);
    if (run.status !== "valid" || run.validity?.report !== true) {
      throw new Error(`counted result status/report must be valid: ${entry.trial_id}`);
    }
    if (run.process?.exit_code !== 0) {
      throw new Error(`counted result process exit must be 0: ${entry.trial_id}`);
    }
    if (run.process?.timed_out === true) {
      throw new Error(`counted result reviewer timed out: ${entry.trial_id}`);
    }
    if (
      run.validity?.inputs_unchanged !== true ||
      run.validity?.allowed_writes !== true ||
      canonicalJson(run.protected_inputs?.before) !==
        canonicalJson(run.protected_inputs?.after)
    ) {
      throw new Error(`counted result input mutation or mismatch: ${entry.trial_id}`);
    }
    if (
      run.isolation?.execution_isolated !== true ||
      run.isolation?.oracle_present !== false ||
      run.isolation?.contamination
          ?.live_repository_accessible_from_workspace_ancestors !== false ||
      run.isolation?.contamination?.oracle_present !== false
    ) {
      throw new Error(
        `counted result isolation is unclean or contaminated: ${entry.trial_id}`,
      );
    }
    assertCountableQuiescence(run.quiescence, entry.trial_id);
    if (run.repair?.model_rerun === true) {
      assertCountableQuiescence(
        run.quiescence?.source,
        entry.trial_id,
        "source quiescence",
      );
      assertCountableQuiescence(
        run.quiescence?.repair,
        entry.trial_id,
        "repair quiescence",
      );
    }
    assertCompleteTelemetry(run.telemetry);
    if (
      (run.quality?.unmatched_candidates ?? []).some(
        (candidate) =>
          candidate.route_blind !== true ||
          !["supported", "unsupported"].includes(candidate.status),
      )
    ) {
      throw new Error(
        `counted result has unmatched findings without route-blind adjudication: ${entry.trial_id}`,
      );
    }
    if (run.quality?.recall_by_severity?.Blocker !== 1) {
      throw new Error(`known Blocker recall must be 100%: ${entry.trial_id}`);
    }
    const frozenPrompt =
      freeze.hashes?.normalized_prompts?.[run.variant];
    if (
      frozenPrompt &&
      run.hashes?.normalized_prompt !== frozenPrompt
    ) {
      throw new Error(`normalized prompt freeze mismatch: ${entry.trial_id}`);
    }
    seenTrials.add(entry.trial_id);
    seenAttempts.add(entry.attempt_id);
    seenPaths.add(resultPath);
    runs.push(run);
  }
  if (
    seenTrials.size !== expectedTrials.size ||
    [...expectedTrials.keys()].some((trial) => !seenTrials.has(trial))
  ) {
    throw new Error("counted-results is missing a variant from the exact 3x3 matrix");
  }
  if (lockPaths.size !== 1) {
    throw new Error(
      "counted results must share one exclusive timed-run lock path",
    );
  }
  let priorEndedAt = null;
  const runByTrial = new Map(runs.map((run) => [run.trial, run]));
  for (const scheduled of schedule.blocks.flatMap((block) =>
    [...block.trials]
      .sort((left, right) => left.sequence - right.sequence)
      .map((trial) => ({ ...trial, block: block.block }))
  )) {
    const run = runByTrial.get(scheduled.trial_id);
    const startedAt = Date.parse(run?.timing?.started_at ?? "");
    const endedAt = Date.parse(run?.timing?.ended_at ?? "");
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      endedAt < startedAt ||
      (priorEndedAt !== null && startedAt < priorEndedAt)
    ) {
      throw new Error(
        `counted runs violate scheduled sequential order or overlap: ${scheduled.trial_id}`,
      );
    }
    priorEndedAt = endedAt;
  }
  return {
    runs,
    manifestHash: sha256(manifestBytes),
    freezeHash,
    scheduleHash,
  };
}

async function summarize(options) {
  if (options.runs !== undefined || options.countedResults === undefined) {
    throw new Error(
      "summarize requires a curated --counted-results manifest; recursive --runs discovery is not countable",
    );
  }
  requireOptions(options, ["output"]);
  const output = resolve(options.output);
  if (await exists(output)) {
    throw new Error(`summary output already exists; refusing overwrite: ${output}`);
  }
  const counted = await loadCountedResults(options);
  const { variants, pairedDeltas } = aggregatePairedRuns(counted.runs);
  const summary = {
    schema_version: PAIRED_AGGREGATE_SCHEMA_VERSION,
    counted_results: {
      manifest_sha256: counted.manifestHash,
      freeze_manifest_sha256: counted.freezeHash,
      schedule_sha256: counted.scheduleHash,
      count: counted.runs.length,
    },
    variants,
    paired_deltas: pairedDeltas,
  };
  await writeNewJson(output, summary, "summary");
  return summary;
}

async function immutableEvidenceSnapshot(sourceDirectory, source) {
  const paths = {
    result: join(sourceDirectory, "result.json"),
  };
  for (const key of ["raw_stdout", "raw_stderr", "raw_events", "report"]) {
    const path = source.evidence?.[key];
    if (path) paths[key] = resolve(sourceDirectory, path);
  }
  const hashes = {};
  for (const [key, path] of Object.entries(paths)) {
    hashes[key] = await hashFile(path);
  }
  return { paths, hashes };
}

async function loadAdjudicationSource(sourceResultPath, fixtureRoot) {
  if (basename(sourceResultPath) !== "result.json") {
    throw new Error("--source-result must point to a result.json file");
  }
  const sourceDirectory = dirname(sourceResultPath);
  const sourceResultBytes = await readFile(sourceResultPath);
  const source = JSON.parse(sourceResultBytes);
  if (
    !["valid", "blocked"].includes(source.status) ||
    source.validity?.report !== true
  ) {
    throw new Error(
      "adjudication source must be an otherwise-valid result with a valid report",
    );
  }
  const configuration = VARIANTS[source.variant];
  if (!configuration) {
    throw new Error(`unknown source variant: ${source.variant}`);
  }
  if (
    canonicalJson(source.route) !==
    canonicalJson(expectedRoute(configuration))
  ) {
    throw new Error("adjudication source route does not match its variant");
  }
  if (!hasCleanIsolationAttestation(source)) {
    throw new Error(
      "adjudication source lacks a clean isolated-execution attestation",
    );
  }

  const evidence = await immutableEvidenceSnapshot(sourceDirectory, source);
  if (evidence.hashes.result !== sha256(sourceResultBytes)) {
    throw new Error("source result changed while adjudication was starting");
  }
  for (const [key, path] of Object.entries(evidence.paths)) {
    if (!isWithin(sourceDirectory, path)) {
      throw new Error(`source ${key.replaceAll("_", " ")} escapes evidence`);
    }
  }
  for (const key of ["raw_stdout", "raw_stderr", "raw_events", "report"]) {
    if (!evidence.paths[key] || !source.evidence?.[`${key}_sha256`]) {
      throw new Error(
        `adjudication source is missing ${key.replaceAll("_", " ")} evidence`,
      );
    }
    if (
      evidence.hashes[key] !== source.evidence[`${key}_sha256`]
    ) {
      throw new Error(`source ${key.replaceAll("_", " ")} hash mismatch`);
    }
  }

  const sourceWorkspace = join(sourceDirectory, "workspace");
  if (
    !(await exists(sourceWorkspace)) ||
    source.isolation?.workspace !== sourceWorkspace ||
    !isWithin(sourceWorkspace, source.isolation?.task_root ?? "")
  ) {
    throw new Error("adjudication source workspace evidence is invalid");
  }
  const workspaceFiles = await filesBelow(sourceWorkspace);
  if (
    workspaceFiles.some((path) =>
      /(^|\/)oracle(\/|$)|historical-task-review|findings\.json/i.test(path)
    )
  ) {
    throw new Error("adjudication source workspace contains oracle data");
  }
  const currentInputs = await hashProtectedInputs(source.isolation.task_root);
  if (
    canonicalJson(currentInputs) !==
      canonicalJson(source.protected_inputs.before) ||
    canonicalJson(currentInputs) !==
      canonicalJson(source.protected_inputs.after)
  ) {
    throw new Error("adjudication source protected inputs changed");
  }

  const { manifestHash } = await verifyFixture(fixtureRoot);
  if (
    source.hashes?.fixture_manifest &&
    source.hashes.fixture_manifest !== manifestHash
  ) {
    throw new Error(
      "adjudication fixture manifest does not match source result",
    );
  }
  const report = await readFile(evidence.paths.report, "utf8");
  const reportValidation = validateReport(report, configuration);
  if (!reportValidation.valid) {
    throw new Error(
      `adjudication source report is invalid: ${reportValidation.failures.join("; ")}`,
    );
  }
  const oracle = JSON.parse(
    await readFile(join(fixtureRoot, "oracle", "findings.json"), "utf8"),
  );
  return {
    source,
    sourceDirectory,
    evidence,
    report,
    candidateFindings: parseReportFindings(report),
    oracleFindings: oracle.findings,
    manifestHash,
  };
}

function uniqueIds(records, field, label) {
  const ids = new Set();
  for (const record of records) {
    const id = record[field];
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`malformed ${label} id`);
    }
    if (ids.has(id)) {
      throw new Error(`duplicate ${label} id: ${id}`);
    }
    ids.add(id);
  }
  return ids;
}

function buildAdjudicationPacket(sourceData) {
  const candidateIds = uniqueIds(
    sourceData.candidateFindings,
    "id",
    "candidate",
  );
  uniqueIds(sourceData.oracleFindings, "id", "oracle");
  const score = scoreFindings({
    oracleFindings: sourceData.oracleFindings,
    candidateFindings: sourceData.candidateFindings,
  });
  const unmatchedCandidateIds = new Set(
    score.unmatched_candidates
      .filter(({ status }) => status === "unadjudicated")
      .map(({ id }) => id),
  );
  const unmatchedOracleIds = new Set(
    score.unmatched_known.map(({ id }) => id),
  );
  const candidates = sourceData.candidateFindings
    .filter(({ id }) =>
      candidateIds.has(id) && unmatchedCandidateIds.has(id)
    )
    .map((finding) => ({
      candidate_id: finding.id,
      lens: finding.lens,
      location: finding.location,
      finding: finding.finding,
      edit: finding.suggested_edit,
    }));
  const oracles = sourceData.oracleFindings
    .filter(({ id }) => unmatchedOracleIds.has(id))
    .map((finding) => ({
      oracle_id: finding.id,
      match: {
        defect_class: finding.match?.defect_class ?? null,
        lens: finding.match?.lens ?? [],
        locations: finding.match?.locations ?? [],
      },
      source_evidence: {
        historical_finding_id:
          finding.source_evidence?.historical_finding_id ?? null,
        report_location: finding.source_evidence?.report_location ?? null,
        finding: finding.source_evidence?.finding ?? null,
        suggested_edit: finding.source_evidence?.suggested_edit ?? null,
      },
    }));
  return {
    schema_version: ADJUDICATION_PACKET_SCHEMA_VERSION,
    source: {
      result_sha256: sourceData.evidence.hashes.result,
      report_sha256: sourceData.evidence.hashes.report,
      fixture_manifest_sha256: sourceData.manifestHash,
    },
    candidates,
    oracles,
  };
}

async function createAdjudicationPacket(options) {
  requireOptions(options, ["sourceResult", "fixture", "output"]);
  const output = resolve(options.output);
  if (await exists(output)) {
    throw new Error(`output already exists: ${output}`);
  }
  const sourceData = await loadAdjudicationSource(
    resolve(options.sourceResult),
    resolve(options.fixture),
  );
  const packet = buildAdjudicationPacket(sourceData);
  const afterEvidence = await immutableEvidenceSnapshot(
    sourceData.sourceDirectory,
    sourceData.source,
  );
  if (
    canonicalJson(sourceData.evidence.hashes) !==
    canonicalJson(afterEvidence.hashes)
  ) {
    throw new Error(
      "source evidence changed during immutable adjudication packet creation",
    );
  }
  await mkdir(dirname(output), { recursive: true });
  await atomicWriteJson(output, packet);
  return packet;
}

function validateAdjudications(records, packet) {
  if (!Array.isArray(records)) {
    throw new Error("adjudications JSON must be an array");
  }
  const candidateIds = new Set(
    packet.candidates.map(({ candidate_id }) => candidate_id),
  );
  const oracleIds = new Set(
    packet.oracles.map(({ oracle_id }) => oracle_id),
  );
  const seenCandidates = new Set();
  const seenOracles = new Set();
  const allowedFields = new Set([
    "candidate_id",
    "oracle_id",
    "route_blind",
    "disposition",
  ]);
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("malformed adjudication record");
    }
    for (const field of Object.keys(record)) {
      if (!allowedFields.has(field)) {
        if (/route|variant|model|runtime|cost|timing/i.test(field)) {
          throw new Error(`forbidden adjudication field: ${field}`);
        }
        throw new Error(`unknown adjudication field: ${field}`);
      }
    }
    if (
      typeof record.candidate_id !== "string" ||
      record.candidate_id.trim() === ""
    ) {
      throw new Error("malformed candidate id");
    }
    if (!candidateIds.has(record.candidate_id)) {
      throw new Error(`unknown candidate id: ${record.candidate_id}`);
    }
    if (seenCandidates.has(record.candidate_id)) {
      throw new Error(`duplicate candidate id: ${record.candidate_id}`);
    }
    seenCandidates.add(record.candidate_id);
    if (record.route_blind !== true) {
      throw new Error("adjudication route_blind must be true");
    }
    if (!["supported", "unsupported"].includes(record.disposition)) {
      throw new Error(
        "adjudication disposition must be supported or unsupported",
      );
    }
    if (record.disposition === "supported") {
      if (record.oracle_id !== undefined && record.oracle_id !== null) {
        if (
          typeof record.oracle_id !== "string" ||
          record.oracle_id.trim() === ""
        ) {
          throw new Error("malformed oracle id");
        }
        if (!oracleIds.has(record.oracle_id)) {
          throw new Error(`unknown oracle id: ${record.oracle_id}`);
        }
        if (seenOracles.has(record.oracle_id)) {
          throw new Error(`duplicate oracle id: ${record.oracle_id}`);
        }
        seenOracles.add(record.oracle_id);
      }
    } else if (record.oracle_id !== undefined && record.oracle_id !== null) {
      throw new Error("unsupported adjudication must omit oracle_id");
    }
  }
  return records;
}

function isQualityResolvableBlocker(reason) {
  return /^known Blocker recall must be 100%, found /i.test(reason);
}

async function adjudicateEvaluation(options) {
  requireOptions(options, [
    "sourceResult",
    "fixture",
    "adjudications",
    "outputDir",
  ]);
  const sourceResultPath = resolve(options.sourceResult);
  const fixtureRoot = resolve(options.fixture);
  const adjudicationsPath = resolve(options.adjudications);
  const outputDirectory = resolve(options.outputDir);
  if (await exists(outputDirectory)) {
    throw new Error(`output directory already exists: ${outputDirectory}`);
  }
  const sourceDirectory = dirname(sourceResultPath);
  if (
    isWithin(sourceDirectory, outputDirectory) ||
    isWithin(outputDirectory, sourceDirectory)
  ) {
    throw new Error("adjudication output must not overlap source evidence");
  }

  const sourceData = await loadAdjudicationSource(
    sourceResultPath,
    fixtureRoot,
  );
  const packet = buildAdjudicationPacket(sourceData);
  const adjudicationsBytes = await readFile(adjudicationsPath);
  const adjudications = validateAdjudications(
    JSON.parse(adjudicationsBytes),
    packet,
  );
  const quality = scoreFindings({
    oracleFindings: sourceData.oracleFindings,
    candidateFindings: sourceData.candidateFindings,
    adjudications,
  });
  const blockedReasons = (sourceData.source.blocked_reasons ?? [])
    .filter((reason) => !isQualityResolvableBlocker(reason));
  if (quality.recall_by_severity.Blocker !== 1) {
    blockedReasons.push(
      `known Blocker recall must be 100%, found ${
        quality.recall_by_severity.Blocker == null
          ? "unavailable"
          : `${quality.recall_by_severity.Blocker * 100}%`
      }`,
    );
  }

  const afterEvidence = await immutableEvidenceSnapshot(
    sourceData.sourceDirectory,
    sourceData.source,
  );
  if (
    canonicalJson(sourceData.evidence.hashes) !==
    canonicalJson(afterEvidence.hashes)
  ) {
    throw new Error("source evidence changed during immutable adjudication");
  }
  const currentInputs = await hashProtectedInputs(
    sourceData.source.isolation.task_root,
  );
  if (
    canonicalJson(currentInputs) !==
      canonicalJson(sourceData.source.protected_inputs.before) ||
    canonicalJson(currentInputs) !==
      canonicalJson(sourceData.source.protected_inputs.after)
  ) {
    throw new Error("source protected inputs changed during adjudication");
  }

  const result = {
    ...sourceData.source,
    id: sourceData.source.schedule_sha256
      ? sourceData.source.id
      : `${sourceData.source.id}-adjudicated-1`,
    trial: sourceData.source.schedule_sha256
      ? sourceData.source.trial
      : `${sourceData.source.trial}-adjudicated-1`,
    status: blockedReasons.length === 0 &&
        quality.recall_by_severity.Blocker === 1
      ? "valid"
      : "blocked",
    blocked_reasons: blockedReasons,
    validity: {
      ...sourceData.source.validity,
      first_pass:
        sourceData.source.status === "valid"
          ? sourceData.source.validity.first_pass
          : false,
    },
    quality,
    evidence: {
      ...sourceData.source.evidence,
      raw_stdout: sourceData.evidence.paths.raw_stdout,
      raw_stderr: sourceData.evidence.paths.raw_stderr,
      raw_events: sourceData.evidence.paths.raw_events,
      report: sourceData.evidence.paths.report,
      source_result: sourceResultPath,
      source_result_sha256: sourceData.evidence.hashes.result,
    },
    timing: {
      ...sourceData.source.timing,
      derived_at: new Date().toISOString(),
    },
    derivation: {
      kind: "route-blind-adjudication",
      source_result: sourceResultPath,
      source_result_sha256: sourceData.evidence.hashes.result,
      source_report: sourceData.evidence.paths.report,
      source_report_sha256: sourceData.evidence.hashes.report,
      source_raw_stdout_sha256: sourceData.evidence.hashes.raw_stdout,
      source_raw_stderr_sha256: sourceData.evidence.hashes.raw_stderr,
      source_raw_events_sha256: sourceData.evidence.hashes.raw_events,
      adjudication_packet_sha256: safeHashObject(packet),
      adjudications: adjudicationsPath,
      adjudications_sha256: sha256(adjudicationsBytes),
    },
    adjudication: {
      route_blind: true,
      records: adjudications,
    },
  };
  await mkdir(outputDirectory, { recursive: false });
  await atomicWriteJson(join(outputDirectory, "result.json"), result);
  return result;
}

function expectedRoute(configuration) {
  return {
    primary_runtime: configuration.primaryRuntime,
    reviewer_runtime: configuration.runtime,
    model: configuration.model,
    effort: configuration.effort,
    invocation_route: configuration.route,
  };
}

function hasCleanIsolationAttestation(source) {
  return (
    source.isolation?.execution_isolated === true &&
    source.isolation?.contamination
      ?.live_repository_accessible_from_workspace_ancestors === false &&
    source.isolation?.contamination?.oracle_present === false &&
    source.isolation?.oracle_present === false &&
    source.validity?.inputs_unchanged === true &&
    source.validity?.allowed_writes === true &&
    canonicalJson(source.protected_inputs?.before) ===
      canonicalJson(source.protected_inputs?.after)
  );
}

function workspaceWriteViolations(before, after, allowedPath) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => path !== allowedPath && before[path] !== after[path])
    .sort();
}

async function repairEvaluationWithModel(options, hooks = {}) {
  requireOptions(options, ["sourceResult", "fixture", "outputDir"]);
  const repairStarted = performance.now();
  const repairWallStarted = new Date().toISOString();
  const sourceResultPath = resolve(options.sourceResult);
  const sourceDirectory = dirname(sourceResultPath);
  const fixtureRoot = resolve(options.fixture);
  const outputDirectory = resolve(options.outputDir);
  const timeoutMs = Number(options.timeoutMs ?? 1_200_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (await exists(outputDirectory)) {
    throw new Error(`output directory already exists: ${outputDirectory}`);
  }
  if (
    isWithin(sourceDirectory, outputDirectory) ||
    isWithin(outputDirectory, sourceDirectory)
  ) {
    throw new Error(
      "repair-model output directory must not overlap source evidence",
    );
  }
  if (basename(sourceResultPath) !== "result.json") {
    throw new Error("--source-result must point to a result.json file");
  }

  const sourceResultBytes = await readFile(sourceResultPath);
  const source = JSON.parse(sourceResultBytes);
  if (source.status !== "blocked") {
    throw new Error("repair-model source must be a blocked evaluation result");
  }
  const configuration = VARIANTS[source.variant];
  if (!configuration) {
    throw new Error(`unknown source variant: ${source.variant}`);
  }
  if (canonicalJson(source.route) !== canonicalJson(expectedRoute(configuration))) {
    throw new Error("repair-model source route does not match its variant");
  }
  if (!hasCleanIsolationAttestation(source)) {
    throw new Error(
      "repair-model source lacks a clean isolated-execution attestation",
    );
  }

  const beforeEvidence = await immutableEvidenceSnapshot(
    sourceDirectory,
    source,
  );
  for (const [key, path] of Object.entries(beforeEvidence.paths)) {
    if (!isWithin(sourceDirectory, path)) {
      throw new Error(`source ${key.replaceAll("_", " ")} escapes evidence`);
    }
  }
  for (const key of ["raw_stdout", "raw_stderr", "raw_events"]) {
    if (!beforeEvidence.paths[key] || !source.evidence?.[`${key}_sha256`]) {
      throw new Error(`repair-model source is missing ${key.replaceAll("_", " ")} evidence`);
    }
  }
  if (beforeEvidence.hashes.result !== sha256(sourceResultBytes)) {
    throw new Error("source result changed while repair-model was starting");
  }
  for (const key of ["raw_stdout", "raw_stderr", "raw_events", "report"]) {
    if (
      beforeEvidence.paths[key] &&
      beforeEvidence.hashes[key] !== source.evidence?.[`${key}_sha256`]
    ) {
      throw new Error(`source ${key.replaceAll("_", " ")} hash mismatch`);
    }
  }

  const sourceWorkspace = join(sourceDirectory, "workspace");
  if (
    !(await exists(sourceWorkspace)) ||
    source.isolation?.workspace !== sourceWorkspace
  ) {
    throw new Error("repair-model source workspace evidence is missing");
  }
  const sourceTaskRelative = relative(
    sourceWorkspace,
    source.isolation.task_root,
  );
  if (
    sourceTaskRelative.startsWith("..") ||
    isAbsolute(sourceTaskRelative)
  ) {
    throw new Error("repair-model source task root escapes workspace evidence");
  }
  const expectedSourceReportPath = join(
    source.isolation.task_root,
    "reviews",
    "task_review.md",
  );
  if (
    beforeEvidence.paths.report &&
    beforeEvidence.paths.report !== expectedSourceReportPath
  ) {
    throw new Error("repair-model source report path is not canonical");
  }
  if (
    !beforeEvidence.paths.report &&
    await exists(expectedSourceReportPath)
  ) {
    throw new Error("repair-model source has an unattested report");
  }
  const sourceWorkspaceFiles = await filesBelow(sourceWorkspace);
  if (
    sourceWorkspaceFiles.some((path) =>
      /(^|\/)oracle(\/|$)|historical-task-review|findings\.json/i.test(path)
    )
  ) {
    throw new Error("repair-model source workspace contains oracle data");
  }

  const { manifest, manifestHash } = await verifyFixture(fixtureRoot);
  if (
    source.hashes?.fixture_manifest &&
    source.hashes.fixture_manifest !== manifestHash
  ) {
    throw new Error("repair-model fixture manifest does not match source result");
  }
  const contractPath = join(fixtureRoot, configuration.contract);
  const contractHash = await hashFile(contractPath);
  if (source.hashes?.contract && source.hashes.contract !== contractHash) {
    throw new Error("repair-model contract does not match source result");
  }
  const priceBasisPath = resolve(
    options.priceBasis ?? join(fixtureRoot, "pricing", "basis.json"),
  );
  const priceBasis = JSON.parse(await readFile(priceBasisPath, "utf8"));
  const priceBasisHash = await hashFile(priceBasisPath);
  if (
    source.hashes?.price_basis &&
    source.hashes.price_basis !== priceBasisHash
  ) {
    throw new Error("repair-model price basis does not match source result");
  }

  const lockFile = resolve(
    options.lockFile ?? join(tmpdir(), "spectre-task-review-evaluation.lock"),
  );
  if (
    source.schedule_sha256 &&
    (
      source.lock?.exclusive !== true ||
      typeof source.lock?.path !== "string" ||
      resolve(source.lock.path) !== lockFile
    )
  ) {
    throw new Error(
      "paired repair-model must reuse the source exclusive timed-run lock",
    );
  }
  const lockAttestation = {
    pid: process.pid,
    trial: `${source.attempt_id ?? source.trial}-repair-model-1`,
    variant: source.variant,
    operation: "repair-model",
    started_at: repairWallStarted,
  };
  if (hooks.beforeLock) await hooks.beforeLock({ lockFile });
  await acquireLock(lockFile, lockAttestation);

  let runRoot = null;
  let stagedAuth = null;
  let outputCreated = false;
  let repairQuiescenceMonitor = null;
  try {
    await mkdir(outputDirectory, { recursive: false });
    outputCreated = true;
    repairQuiescenceMonitor = source.freeze_manifest_sha256
      ? startQuiescenceMonitor(hooks)
      : null;
    runRoot = await mkdtemp(
      join(tmpdir(), "spectre-task-review-repair-model-"),
    );
    if (
      isWithin(EVALUATOR_REPOSITORY_ROOT, runRoot) ||
      isWithin(outputDirectory, runRoot) ||
      isWithin(runRoot, outputDirectory)
    ) {
      throw new Error(
        "OS temporary repair root must be outside the repository and evidence output",
      );
    }

    const workspace = join(runRoot, "workspace");
    const taskRoot = join(workspace, sourceTaskRelative);
    const reportPath = join(taskRoot, "reviews", "task_review.md");
    await mkdir(taskRoot, { recursive: true });
    for (const input of PROTECTED_INPUTS) {
      const destination = join(taskRoot, input);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(source.isolation.task_root, input), destination);
    }
    if (beforeEvidence.paths.report) {
      await mkdir(dirname(reportPath), { recursive: true });
      await cp(beforeEvidence.paths.report, reportPath);
    } else {
      await mkdir(dirname(reportPath), { recursive: true });
    }
    const beforeWorkspaceHashes = await hashFilesBelow(workspace);
    const beforeProtectedInputs = await hashProtectedInputs(taskRoot);
    if (
      canonicalJson(beforeProtectedInputs) !==
        canonicalJson(source.protected_inputs.before)
    ) {
      throw new Error(
        "repair-model staged protected inputs do not match source evidence",
      );
    }
    const oracleBefore = Object.keys(beforeWorkspaceHashes).some((path) =>
      /(^|\/)oracle(\/|$)|historical-task-review|findings\.json/i.test(path)
    );
    if (oracleBefore) {
      throw new Error("oracle data is present in repair-model workspace");
    }

    const rawDirectory = join(outputDirectory, "raw");
    await mkdir(rawDirectory, { recursive: true });

    const requiredTimestamp = new Date().toISOString();
    const prompt = buildRepairPrompt(
      taskRoot,
      reportPath,
      configuration,
      requiredTimestamp,
    );
    const command = reviewerCommand(configuration, prompt, workspace, {
      command: options.reviewerCommand,
      args: options.reviewerArg,
    });
    const reviewerRuntime = await prepareReviewerRuntime(
      runRoot,
      configuration,
      reportPath,
      taskRoot,
    );
    stagedAuth = reviewerRuntime.stagedAuth;
    const {
      baseEnvironment,
      claudeHome,
      codexHome,
      environment,
      spectreHome,
    } = reviewerRuntime;
    const claudeAuthentication = reviewerAuthentication(
      configuration,
      options.reviewerCommand,
      command.command,
      claudeHome,
      environment,
    );
    const version = commandVersion(command.command, environment);
    const preflightEnded = performance.now();
    const authenticationBlocked =
      configuration.runtime === "claude-code" &&
      claudeAuthentication.checked &&
      !claudeAuthentication.logged_in;
    if (hooks.beforeReviewer) {
      await hooks.beforeReviewer({ workspace, environment, prompt });
    }
    const preflightQuiescenceBlocked =
      repairQuiescenceMonitor && !repairQuiescenceMonitor.preClean;
    const reviewerExecution = authenticationBlocked ||
        preflightQuiescenceBlocked
      ? {
        processResult: {
          exitCode: null,
          signal: null,
          error: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          skipped: true,
          durationMs: 0,
        },
        quiescence: repairQuiescenceMonitor
          ? null
          : assessQuiescenceWithoutReviewer(
            hooks.processSnapshot ?? processSnapshot,
          ),
      }
      : repairQuiescenceMonitor
        ? {
          processResult: await runReviewer(
            command.command,
            command.args,
            {
              cwd: workspace,
              env: environment,
              timeoutMs,
              onSpawn(pid) {
                repairQuiescenceMonitor.setReviewerPid(pid);
              },
            },
          ),
          quiescence: null,
        }
        : await runReviewerWithQuiescence(command.command, command.args, {
          cwd: workspace,
          env: environment,
          timeoutMs,
        }, hooks);
    const { processResult } = reviewerExecution;
    const reviewerEnded = performance.now();

    const rawStdoutPath = join(rawDirectory, "reviewer.stdout.jsonl");
    const rawStderrPath = join(rawDirectory, "reviewer.stderr.txt");
    const rawEventsPath = join(rawDirectory, "reviewer.events.jsonl");
    const { events, rawEvents } = parseJsonLines(processResult.stdout);
    await Promise.all([
      writeFile(rawStdoutPath, processResult.stdout),
      writeFile(rawStderrPath, processResult.stderr),
      writeFile(rawEventsPath, rawEvents),
    ]);

    const blockedReasons = [];
    if (authenticationBlocked) {
      blockedReasons.push(
        `Claude authentication preflight failed: ${claudeAuthentication.unavailable_reason}`,
      );
    } else if (preflightQuiescenceBlocked) {
      blockedReasons.push(
        "repair-model preflight quiescence is unclean or contaminated",
      );
    } else if (processResult.timedOut) {
      blockedReasons.push(`reviewer timeout after ${timeoutMs}ms`);
    } else if (processResult.error) {
      blockedReasons.push(`reviewer process error: ${processResult.error}`);
    } else if (processResult.exitCode !== 0) {
      blockedReasons.push(`reviewer exit ${processResult.exitCode}`);
    }

    if (hooks.beforeValidation) {
      await hooks.beforeValidation({ workspace, environment, prompt });
    }
    const report = await exists(reportPath)
      ? await readFile(reportPath, "utf8")
      : null;
    if (report === null) blockedReasons.push("review report is missing");
    const reportValidation = report
      ? validateReport(report, configuration)
      : { valid: false, failures: ["report is missing"], metadata: {} };
    blockedReasons.push(...reportValidation.failures);
    if (
      reportValidation.valid &&
      reportValidation.metadata.timestamp !== requiredTimestamp
    ) {
      blockedReasons.push(
        `report metadata timestamp expected ${JSON.stringify(requiredTimestamp)}, found ${JSON.stringify(reportValidation.metadata.timestamp ?? null)}`,
      );
    }

    const afterProtectedInputs = await hashProtectedInputs(taskRoot);
    const inputsUnchanged =
      canonicalJson(beforeProtectedInputs) ===
      canonicalJson(afterProtectedInputs);
    if (!inputsUnchanged) {
      blockedReasons.push("protected input mutation detected during repair-model");
    }
    const afterWorkspaceHashes = await hashFilesBelow(workspace);
    const allowedReportPath = relative(workspace, reportPath);
    const writeViolations = workspaceWriteViolations(
      beforeWorkspaceHashes,
      afterWorkspaceHashes,
      allowedReportPath,
    );
    if (writeViolations.length > 0) {
      blockedReasons.push(
        `non-report write detected during repair-model: ${writeViolations.join(", ")}`,
      );
    }
    const oraclePresent = Object.keys(afterWorkspaceHashes).some((path) =>
      /(^|\/)oracle(\/|$)|historical-task-review|findings\.json/i.test(path)
    );
    if (oraclePresent) {
      blockedReasons.push("oracle data is present in repair-model workspace");
    }

    // Hidden quality data is loaded only after the reviewer has exited and the
    // workspace/report-only write boundary has been validated.
    const oracle = JSON.parse(
      await readFile(join(fixtureRoot, "oracle", "findings.json"), "utf8"),
    );
    const quality = reportValidation.valid
      ? scoreFindings({
        oracleFindings: oracle.findings,
        candidateFindings: parseReportFindings(report),
      })
      : null;
    if (quality?.recall_by_severity?.Blocker !== 1) {
      blockedReasons.push(
        `known Blocker recall must be 100%, found ${
          quality?.recall_by_severity?.Blocker == null
            ? "unavailable"
            : `${quality.recall_by_severity.Blocker * 100}%`
        }`,
      );
    }
    const afterEvidence = await immutableEvidenceSnapshot(
      sourceDirectory,
      source,
    );
    if (
      canonicalJson(beforeEvidence.hashes) !==
      canonicalJson(afterEvidence.hashes)
    ) {
      throw new Error("source evidence changed during immutable repair-model");
    }
    if (
      !beforeEvidence.paths.report &&
      await exists(expectedSourceReportPath)
    ) {
      throw new Error("source report appeared during immutable repair-model");
    }

    const sourceTotalMs = source.timing?.total_ms ?? 0;
    const evidenceWorkspace = join(outputDirectory, "workspace");
    await cp(workspace, evidenceWorkspace, { recursive: true });
    const repairQuiescence = repairQuiescenceMonitor
      ? repairQuiescenceMonitor.finish()
      : reviewerExecution.quiescence;
    const combinedQuiescence = {
      ...repairQuiescence,
      clean:
        (source.freeze_manifest_sha256
          ? source.quiescence?.clean === true
          : source.quiescence?.clean !== false) &&
        repairQuiescence.clean,
      source: source.quiescence ?? null,
      repair: repairQuiescence,
    };
    if (
      source.freeze_manifest_sha256 &&
      !combinedQuiescence.clean
    ) {
      blockedReasons.push(
        "repair-model quiescence attestation is unclean or contaminated",
      );
    }
    const validationEnded = performance.now();
    const repairIntervals = {
      preflight_ms: preflightEnded - repairStarted,
      reviewer_ms: reviewerEnded - preflightEnded,
      validation_ms: validationEnded - reviewerEnded,
    };
    const repairTotalMs = validationEnded - repairStarted;
    const evidenceReportPath = join(
      evidenceWorkspace,
      sourceTaskRelative,
      "reviews",
      "task_review.md",
    );
    const repairTelemetry = normalizeTelemetry(
      configuration.runtime,
      events,
      priceBasis,
      configuration.model,
    );
    const result = {
      ...source,
      id: source.schedule_sha256
        ? source.id
        : `${source.id}-repair-model-1`,
      trial: source.schedule_sha256
        ? source.trial
        : `${source.trial}-repair-model-1`,
      status: blockedReasons.length === 0 ? "valid" : "blocked",
      blocked_reasons: blockedReasons,
      route: expectedRoute(configuration),
      versions: {
        ...source.versions,
        reviewer_cli: version,
      },
      hashes: {
        ...source.hashes,
        fixture_components: safeHashObject(manifest.components),
        repair_contract: contractHash,
        repair_prompt: sha256(prompt),
        repair_price_basis: priceBasisHash,
      },
      isolation: {
        workspace: evidenceWorkspace,
        task_root: join(evidenceWorkspace, sourceTaskRelative),
        execution_workspace: workspace,
        execution_cwd: workspace,
        execution_isolated: true,
        contamination: {
          live_repository_accessible_from_workspace_ancestors: false,
          oracle_present: oraclePresent,
        },
        runtime_homes: {
          claude: claudeHome,
          codex: codexHome,
          spectre: spectreHome,
        },
        oracle_present: oraclePresent,
      },
      protected_inputs: {
        before: beforeProtectedInputs,
        after: afterProtectedInputs,
      },
      process: {
        command: command.command,
        args: command.args,
        exit_code: processResult.exitCode,
        signal: processResult.signal,
        timed_out: processResult.timedOut,
        timeout_ms: timeoutMs,
        launched: !processResult.skipped,
        attempts: (source.process?.attempts ?? 1) + 1,
        retries:
          (source.process?.retries ?? 0) +
          (repairTelemetry.retries.value ?? 0),
        repairs: (source.process?.repairs ?? 0) + 1,
        fallback: source.process?.fallback ?? {
          value: null,
          unavailable_reason:
            "No fallback route was configured or attempted by this evaluator run.",
        },
      },
      authentication: {
        claude: claudeAuthentication,
      },
      lock: source.schedule_sha256
        ? {
          ...source.lock,
          path: lockFile,
          exclusive: true,
          source: source.lock,
          repair: {
            path: lockFile,
            exclusive: true,
            attestation: lockAttestation,
          },
        }
        : {
          path: lockFile,
          exclusive: true,
          attestation: lockAttestation,
        },
      quiescence: combinedQuiescence,
      validity: {
        first_pass: false,
        report: reportValidation.valid,
        report_failures: [
          ...reportValidation.failures,
          ...(reportValidation.valid &&
              reportValidation.metadata.timestamp !== requiredTimestamp
            ? [
              `report metadata timestamp expected ${JSON.stringify(requiredTimestamp)}, found ${JSON.stringify(reportValidation.metadata.timestamp ?? null)}`,
            ]
            : []),
        ],
        inputs_unchanged: inputsUnchanged,
        allowed_writes:
          inputsUnchanged && writeViolations.length === 0 && !oraclePresent,
      },
      telemetry: {
        source: source.telemetry ?? null,
        repair: repairTelemetry,
      },
      quality,
      evidence: {
        raw_stdout: relative(outputDirectory, rawStdoutPath),
        raw_stdout_sha256: await hashFile(rawStdoutPath),
        raw_stderr: relative(outputDirectory, rawStderrPath),
        raw_stderr_sha256: await hashFile(rawStderrPath),
        raw_events: relative(outputDirectory, rawEventsPath),
        raw_events_sha256: await hashFile(rawEventsPath),
        report: report
          ? relative(outputDirectory, evidenceReportPath)
          : null,
        report_sha256: report ? sha256(report) : null,
        source_result: sourceResultPath,
        source_result_sha256: beforeEvidence.hashes.result,
      },
      timing: {
        clock: "performance.now monotonic milliseconds",
        started_at: source.timing?.started_at ?? repairWallStarted,
        ended_at: new Date().toISOString(),
        source_total_ms: sourceTotalMs,
        repair_total_ms: repairTotalMs,
        total_ms: sourceTotalMs + repairTotalMs,
        repair_intervals: repairIntervals,
      },
      derivation: {
        kind: "same-route-report-only",
        source_result: sourceResultPath,
        source_result_sha256: beforeEvidence.hashes.result,
        source_report: beforeEvidence.paths.report ?? null,
        source_report_sha256: beforeEvidence.hashes.report ?? null,
        source_raw_stdout_sha256: beforeEvidence.hashes.raw_stdout,
        source_raw_stderr_sha256: beforeEvidence.hashes.raw_stderr,
        source_raw_events_sha256: beforeEvidence.hashes.raw_events,
        source_total_ms: sourceTotalMs,
      },
      repair: {
        kind: "same-route-report-only",
        model_rerun: true,
        attempts: 1,
        elapsed_ms: repairTotalMs,
        started_at: repairWallStarted,
        ended_at: new Date().toISOString(),
        telemetry: repairTelemetry,
      },
    };
    await atomicWriteJson(join(outputDirectory, "result.json"), result);
    return result;
  } catch (error) {
    let failure = error;
    if (repairQuiescenceMonitor) {
      try {
        repairQuiescenceMonitor.finish();
      } catch (monitorError) {
        failure = new Error(
          `${error.message}; quiescence monitor failed: ${monitorError.message}`,
        );
      }
    }
    if (outputCreated && !(await exists(join(outputDirectory, "result.json")))) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
    throw failure;
  } finally {
    if (stagedAuth) await rm(stagedAuth, { force: true });
    if (runRoot) await rm(runRoot, { recursive: true, force: true });
    await rm(lockFile, { force: true });
  }
}

async function repairEvaluation(options) {
  requireOptions(options, ["sourceResult", "fixture", "outputDir"]);
  const repairStarted = performance.now();
  const repairWallStarted = new Date().toISOString();
  const sourceResultPath = resolve(options.sourceResult);
  const sourceDirectory = dirname(sourceResultPath);
  const outputDirectory = resolve(options.outputDir);
  if (await exists(outputDirectory)) {
    throw new Error(`output directory already exists: ${outputDirectory}`);
  }
  if (basename(sourceResultPath) !== "result.json") {
    throw new Error("--source-result must point to a result.json file");
  }

  const sourceResultBytes = await readFile(sourceResultPath);
  const source = JSON.parse(sourceResultBytes);
  if (source.status !== "blocked") {
    throw new Error("repair source must be a blocked evaluation result");
  }
  if (
    source.isolation?.execution_isolated !== true ||
    source.isolation?.contamination
      ?.live_repository_accessible_from_workspace_ancestors !== false
  ) {
    throw new Error(
      "repair source lacks an uncontaminated isolated-execution attestation",
    );
  }
  const configuration = VARIANTS[source.variant];
  if (!configuration) {
    throw new Error(`unknown source variant: ${source.variant}`);
  }
  if (!source.evidence?.report || !source.evidence?.report_sha256) {
    throw new Error("repair source is missing report evidence");
  }

  const beforeEvidence = await immutableEvidenceSnapshot(
    sourceDirectory,
    source,
  );
  if (beforeEvidence.hashes.result !== sha256(sourceResultBytes)) {
    throw new Error("source result changed while repair was starting");
  }
  for (const key of ["raw_stdout", "raw_stderr", "raw_events", "report"]) {
    if (
      beforeEvidence.paths[key] &&
      beforeEvidence.hashes[key] !== source.evidence[`${key}_sha256`]
    ) {
      throw new Error(`source ${key.replaceAll("_", " ")} hash mismatch`);
    }
  }

  const report = await readFile(beforeEvidence.paths.report, "utf8");
  const reportValidation = validateReport(report, configuration);
  const { manifestHash } = await verifyFixture(resolve(options.fixture));
  if (
    source.hashes?.fixture_manifest &&
    source.hashes.fixture_manifest !== manifestHash
  ) {
    throw new Error("repair fixture manifest does not match source result");
  }
  const oracle = JSON.parse(
    await readFile(
      join(resolve(options.fixture), "oracle", "findings.json"),
      "utf8",
    ),
  );
  const quality = reportValidation.valid
    ? scoreFindings({
      oracleFindings: oracle.findings,
      candidateFindings: parseReportFindings(report),
    })
    : null;

  const currentProtectedInputs = await hashProtectedInputs(
    source.isolation.task_root,
  );
  const inputsUnchanged =
    canonicalJson(currentProtectedInputs) ===
      canonicalJson(source.protected_inputs.before) &&
    canonicalJson(currentProtectedInputs) ===
      canonicalJson(source.protected_inputs.after);
  const blockedReasons = [
    ...(source.blocked_reasons ?? []).filter(
      (reason) =>
        !/^report (?:is missing|Findings table|metadata)/i.test(reason),
    ),
    ...reportValidation.failures,
  ];
  if (!inputsUnchanged) {
    blockedReasons.push("protected input mutation detected during repair");
  }
  if (quality?.recall_by_severity?.Blocker !== 1) {
    blockedReasons.push(
      `known Blocker recall must be 100%, found ${
        quality?.recall_by_severity?.Blocker == null
          ? "unavailable"
          : `${quality.recall_by_severity.Blocker * 100}%`
      }`,
    );
  }

  const afterEvidence = await immutableEvidenceSnapshot(
    sourceDirectory,
    source,
  );
  if (
    canonicalJson(beforeEvidence.hashes) !==
    canonicalJson(afterEvidence.hashes)
  ) {
    throw new Error("source evidence changed during immutable repair");
  }

  const repairEnded = performance.now();
  const result = {
    ...source,
    id: source.schedule_sha256 ? source.id : `${source.id}-repair-1`,
    trial: source.schedule_sha256
      ? source.trial
      : `${source.trial}-repair-1`,
    status: blockedReasons.length === 0 ? "valid" : "blocked",
    blocked_reasons: blockedReasons,
    process: {
      ...source.process,
      repairs: 1,
    },
    validity: {
      first_pass: false,
      report: reportValidation.valid,
      report_failures: reportValidation.failures,
      inputs_unchanged: inputsUnchanged,
      allowed_writes: source.validity?.allowed_writes === true &&
        inputsUnchanged,
    },
    quality,
    evidence: {
      ...source.evidence,
      raw_stdout: beforeEvidence.paths.raw_stdout,
      raw_stderr: beforeEvidence.paths.raw_stderr,
      raw_events: beforeEvidence.paths.raw_events,
      report: beforeEvidence.paths.report,
      source_result: sourceResultPath,
      source_result_sha256: beforeEvidence.hashes.result,
    },
    timing: {
      ...source.timing,
      repair_elapsed_ms: repairEnded - repairStarted,
      derived_at: new Date().toISOString(),
    },
    derivation: {
      kind: "immutable-revalidation",
      source_result: sourceResultPath,
      source_result_sha256: beforeEvidence.hashes.result,
      source_report: beforeEvidence.paths.report,
      source_report_sha256: beforeEvidence.hashes.report,
      source_raw_stdout_sha256: beforeEvidence.hashes.raw_stdout,
      source_raw_stderr_sha256: beforeEvidence.hashes.raw_stderr,
      source_raw_events_sha256: beforeEvidence.hashes.raw_events,
      source_total_ms: source.timing.total_ms,
    },
    repair: {
      model_rerun: false,
      attempts: 1,
      elapsed_ms: repairEnded - repairStarted,
      started_at: repairWallStarted,
      ended_at: new Date().toISOString(),
    },
  };
  await mkdir(outputDirectory, { recursive: false });
  await atomicWriteJson(join(outputDirectory, "result.json"), result);
  return result;
}

export async function runCli(args, hooks = {}) {
  const { command, options } = parseArguments(args);
  if (command === "schedule") return createSchedule(options);
  if (command === "freeze") return createFreeze(options);
  if (command === "run") return runEvaluation(options, hooks);
  if (command === "adjudication-packet") {
    return createAdjudicationPacket(options);
  }
  if (command === "adjudicate") return adjudicateEvaluation(options);
  if (command === "repair-model") {
    return repairEvaluationWithModel(options, hooks);
  }
  if (command === "repair") return repairEvaluation(options);
  if (command === "summarize") return summarize(options);
  throw new Error(
    "usage: evaluate-task-review.mjs <schedule|freeze|run|adjudication-packet|adjudicate|repair-model|repair|summarize> [options]",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "blocked") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
