import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const helperPath = join(
  repositoryRoot,
  "plugins",
  "spectre",
  "skills",
  "spectre-execute",
  "references",
  "scripts",
  "task-review-safety.mjs",
);

function parent(id, predecessor, unblocks) {
  return {
    id,
    title: `Parent ${id}`,
    description: "A deliberately small fixture parent.",
    status: "pending",
    predecessor,
    unblocks,
    subtasks: [
      {
        id: `${id}.1`,
        title: "Fixture subtask",
        type: "Build",
        status: "pending",
        produces: "fixture output",
        consumed_by: unblocks,
        replaces: "none",
        context: [],
        acceptance_criteria: [
          {
            type: "test",
            text: "The fixture behavior is observable.",
          },
        ],
      },
    ],
  };
}

function baseTasks() {
  return {
    meta: {
      feature: "consumer-safety-fixture",
      coverage_summary: {
        phases: 1,
        parent_tasks: 2,
        subtasks: 2,
        waves: 2,
      },
    },
    phases: [
      {
        id: "1",
        title: "Fixture phase",
        summary: "Exercises the live execute consumer boundary.",
        status: "pending",
        parents: [
          parent("1.1", "none", "1.2"),
          parent("1.2", "1.1", "terminal"),
        ],
      },
    ],
  };
}

function executeIndex({ planPath, scopePath, tasksPath }) {
  return `# Execute Index

## Document Manifest
- Scope: \`${scopePath}\`
- Plan: \`${planPath}\`

## Task Detail Source
- Tasks JSON: \`${tasksPath}\`

## Execution Summary
- Phases: 1
- Parent tasks: 2
- Subtasks: 2
- Waves: 2

## Wave Plan
- Wave 1: \`{ id: "wave-1", label: "First", parent_task_ids: ["1.1"], after: [], rationale: "First." }\`
- Wave 2: \`{ id: "wave-2", label: "Second", parent_task_ids: ["1.2"], after: ["wave-1"], rationale: "Second." }\`

## Parent Task Index
- Phase 1
  - \`{ id: "1.1", title: "Parent 1.1", subtasks: ["1.1.1"], predecessor: "none", unblocks: "1.2" }\`
  - \`{ id: "1.2", title: "Parent 1.2", subtasks: ["1.2.1"], predecessor: "1.1", unblocks: "terminal" }\`

## Slicing Rules
Slice selected parents only.
`;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "task-review-safety-"));
  const taskDir = join(root, "feature");
  const specsDir = join(taskDir, "specs");
  const reviewsDir = join(taskDir, "reviews");
  const conceptsDir = join(taskDir, "concepts");
  const planPath = join(specsDir, "plan.md");
  const executePath = join(specsDir, "execute.md");
  const tasksPath = join(specsDir, "tasks.json");
  const scopePath = join(conceptsDir, "scope.md");

  await mkdir(specsDir, { recursive: true });
  await mkdir(reviewsDir, { recursive: true });
  await mkdir(conceptsDir, { recursive: true });
  await writeFile(planPath, "# Plan\n");
  await writeFile(scopePath, "# Scope\n");
  await writeFile(tasksPath, `${JSON.stringify(baseTasks(), null, 2)}\n`);
  await writeFile(
    executePath,
    executeIndex({ planPath, scopePath, tasksPath }),
  );

  return {
    root,
    taskDir,
    planPath,
    executePath,
    tasksPath,
    scopePath,
    reportPath: join(reviewsDir, "task_review.md"),
  };
}

function runHelper(fixture, operation, args = []) {
  const result = spawnSync(
    process.execPath,
    [
      helperPath,
      operation,
      "--task-dir",
      fixture.taskDir,
      ...args,
      "--json",
    ],
    {
      cwd: fixture.root,
      encoding: "utf8",
    },
  );
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    output = null;
  }
  return { ...result, output };
}

function runPreflight(fixture) {
  return runHelper(fixture, "preflight", [
    "--tasks",
    fixture.tasksPath,
  ]);
}

function runPairCheck(fixture) {
  return runHelper(fixture, "validate-pair", [
    "--execute",
    fixture.executePath,
    "--tasks",
    fixture.tasksPath,
  ]);
}

function failureCodes(result) {
  return result.output?.hard_failures?.map(({ code }) => code) ?? [];
}

async function mutateJson(path, mutate) {
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function mutateText(path, mutate) {
  await writeFile(path, mutate(await readFile(path, "utf8")));
}

function validReport() {
  return `# Task Review

## Findings

| # | Severity | Lens | Location | Finding | Suggested Edit |
|---|---|---|---|---|---|
| 1 | High | Coverage | specs/tasks.json parent 1.2 | A concrete problem. | Make the smallest concrete edit. |

## Dispositions

| Finding | Disposition | Resulting Task Edit |
|---|---|---|
| 1 | applied | Updated parent 1.2 description. |

## Review Metadata

- Mode: adversarial
- Reviewer Runtime: Claude Code
- Reviewer Model: opus
- Reviewer Effort: medium
- Invocation Route: Codex -> Claude Code
`;
}

function noFindingsReport() {
  return `# Task Review

## Findings

No findings.

## Review Metadata

- Mode: adversarial
- Reviewer Runtime: Codex
- Reviewer Model: gpt-5.6-sol
- Reviewer Effort: medium
- Invocation Route: Claude Code -> Codex
`;
}

async function writeProtectedHashes(fixture, preflightOutput) {
  const path = join(fixture.root, "protected-hashes.json");
  await writeFile(path, `${JSON.stringify(preflightOutput, null, 2)}\n`);
  return path;
}

async function snapshot(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        const content = await readFile(path);
        files.push([
          relative(root, path),
          createHash("sha256").update(content).digest("hex"),
        ]);
      }
    }
  }

  await visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

test("tasks-first preflight returns projections and audit hashes without execute.md", async () => {
  const fixture = await createFixture();
  try {
    await rm(fixture.executePath);
    const before = await snapshot(fixture.root);
    const result = runPreflight(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.status, "pass");
    assert.deepEqual(result.output.hard_failures, []);
    assert.deepEqual(
      result.output.projection.parents.map(({ id }) => id),
      ["1.1", "1.2"],
    );
    assert.deepEqual(
      Object.keys(result.output.protected_hashes).sort(),
      ["plan", "scope"],
    );
    assert.deepEqual(Object.keys(result.output.stage_hashes), ["tasks"]);
    assert.equal(result.output.semantic_judgments, undefined);
    assert.deepEqual(await snapshot(fixture.root), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("tasks-first preflight hard-fails required artifact and parse failures", async (t) => {
  const cases = [
    {
      name: "missing plan",
      code: "ARTIFACT_MISSING",
      mutate: ({ planPath }) => rm(planPath),
    },
    {
      name: "missing task graph",
      code: "ARTIFACT_MISSING",
      mutate: ({ tasksPath }) => rm(tasksPath),
    },
    {
      name: "invalid task JSON",
      code: "TASK_JSON_INVALID",
      mutate: ({ tasksPath }) => writeFile(tasksPath, "{not-json"),
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await createFixture();
      try {
        await fixtureCase.mutate(fixture);
        const result = runPreflight(fixture);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.output.status, "hard_failure");
        assert.ok(failureCodes(result).includes(fixtureCase.code));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("tasks-first preflight hard-fails duplicate task parents", async (t) => {
  const cases = [
    {
      name: "duplicate task parent id",
      code: "PARENT_ID_DUPLICATE",
      mutate: ({ tasksPath }) =>
        mutateJson(tasksPath, (tasks) => {
          tasks.phases[0].parents[1].id = "1.1";
        }),
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await createFixture();
      try {
        await fixtureCase.mutate(fixture);
        const result = runPreflight(fixture);
        assert.equal(result.status, 2, result.stderr);
        assert.ok(failureCodes(result).includes(fixtureCase.code));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("tasks-first preflight hard-fails unresolved references and dependency cycles", async (t) => {
  const cases = [
    {
      name: "unresolved parent predecessor",
      code: "DEPENDENCY_PARENT_UNRESOLVED",
      mutate: ({ tasksPath }) =>
        mutateJson(tasksPath, (tasks) => {
          tasks.phases[0].parents[1].predecessor = "9.9";
        }),
    },
    {
      name: "unresolved parent unblock",
      code: "DEPENDENCY_PARENT_UNRESOLVED",
      mutate: ({ tasksPath }) =>
        mutateJson(tasksPath, (tasks) => {
          tasks.phases[0].parents[0].unblocks = "9.9";
        }),
    },
    {
      name: "parent dependency cycle",
      code: "DEPENDENCY_CYCLE",
      mutate: ({ tasksPath }) =>
        mutateJson(tasksPath, (tasks) => {
          tasks.phases[0].parents[0].predecessor = "1.2";
        }),
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await createFixture();
      try {
        await fixtureCase.mutate(fixture);
        const result = runPreflight(fixture);
        assert.equal(result.status, 2, result.stderr);
        assert.ok(failureCodes(result).includes(fixtureCase.code));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("schema and semantic imperfections outside the closed set remain launch-permitted", async () => {
  const fixture = await createFixture();
  try {
    await mutateJson(fixture.tasksPath, (tasks) => {
      tasks.meta.coverage_summary = {
        phases: 99,
        parent_tasks: 99,
        subtasks: 99,
        waves: 99,
      };
      delete tasks.meta.feature;
      tasks.phases[0].status = "unexpected-enum";
      const subtask = tasks.phases[0].parents[0].subtasks[0];
      subtask.consumed_by = "not-a-real-consumer";
      subtask.context = [
        {
          path: "missing-future-file.js",
          anchor: "not a real anchor",
          note: "Semantically irrelevant on purpose.",
        },
      ];
      subtask.acceptance_criteria = [
        {
          type: "invented-enum",
          text: "Trust the implementation without proving anything.",
        },
      ];
    });
    const result = runPreflight(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.status, "pass");
    assert.deepEqual(result.output.hard_failures, []);
    assert.ok(Array.isArray(result.output.advisories));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("validate-report accepts a findings table and explicit no-findings form", async (t) => {
  for (const [name, report] of [
    ["findings table", validReport()],
    ["explicit no findings", noFindingsReport()],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      try {
        const preflight = runPreflight(fixture);
        assert.equal(preflight.status, 0, preflight.stderr);
        const hashesPath = await writeProtectedHashes(
          fixture,
          preflight.output,
        );
        await writeFile(fixture.reportPath, report);

        const result = runHelper(fixture, "validate-report", [
          "--report",
          fixture.reportPath,
          "--protected-hashes",
          hashesPath,
        ]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output.status, "pass");
        assert.deepEqual(result.output.hard_failures, []);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("validate-report enforces path, readability, findings, and metadata", async (t) => {
  const cases = [
    {
      name: "report path outside reviews",
      code: "REPORT_PATH_OUTSIDE",
      reportPath: ({ root }) => join(root, "escaped-report.md"),
      report: validReport(),
    },
    {
      name: "missing report",
      code: "REPORT_UNREADABLE",
      reportPath: ({ reportPath }) => reportPath,
    },
    {
      name: "neither findings table nor no-findings",
      code: "REPORT_FINDINGS_INVALID",
      reportPath: ({ reportPath }) => reportPath,
      report: validReport().replace(
        /\| # \|[\s\S]+?\n\n## Review Metadata/,
        "A prose-only summary.\n\n## Review Metadata",
      ),
    },
    {
      name: "finding missing suggested edit",
      code: "REPORT_FINDING_FIELDS_MISSING",
      reportPath: ({ reportPath }) => reportPath,
      report: validReport().replace(
        "Make the smallest concrete edit.",
        "",
      ),
    },
    {
      name: "missing route metadata",
      code: "REPORT_METADATA_MISSING",
      reportPath: ({ reportPath }) => reportPath,
      report: validReport().replace(
        "- Invocation Route: Codex -> Claude Code\n",
        "",
      ),
    },
    {
      name: "finding missing disposition",
      code: "REPORT_DISPOSITIONS_INVALID",
      reportPath: ({ reportPath }) => reportPath,
      report: validReport().replace(
        /## Dispositions[\s\S]+?## Review Metadata/,
        "## Review Metadata",
      ),
    },
    {
      name: "applied finding missing resulting edit",
      code: "REPORT_DISPOSITIONS_INVALID",
      reportPath: ({ reportPath }) => reportPath,
      report: validReport().replace(
        "| 1 | applied | Updated parent 1.2 description. |",
        "| 1 | applied | |",
      ),
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await createFixture();
      try {
        const preflight = runPreflight(fixture);
        assert.equal(preflight.status, 0, preflight.stderr);
        const hashesPath = await writeProtectedHashes(
          fixture,
          preflight.output,
        );
        const reportPath = fixtureCase.reportPath(fixture);
        if (fixtureCase.report !== undefined) {
          await writeFile(reportPath, fixtureCase.report);
        }

        const result = runHelper(fixture, "validate-report", [
          "--report",
          reportPath,
          "--protected-hashes",
          hashesPath,
        ]);
        assert.equal(result.status, 2, result.stderr);
        assert.ok(failureCodes(result).includes(fixtureCase.code));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("validate-report permits reviewer-owned task edits but rejects upstream mutation", async (t) => {
  await t.test("tasks may change", async () => {
    const fixture = await createFixture();
    try {
      const preflight = runPreflight(fixture);
      assert.equal(preflight.status, 0, preflight.stderr);
      const hashesPath = await writeProtectedHashes(fixture, preflight.output);
      await writeFile(fixture.reportPath, validReport());
      await mutateJson(fixture.tasksPath, (tasks) => {
        tasks.phases[0].parents[1].description = "Reviewer-owned correction.";
      });

      const result = runHelper(fixture, "validate-report", [
        "--report",
        fixture.reportPath,
        "--protected-hashes",
        hashesPath,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output.status, "pass");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  for (const protectedName of ["plan", "scope"]) {
    await t.test(protectedName, async () => {
      const fixture = await createFixture();
      try {
        const preflight = runPreflight(fixture);
        assert.equal(preflight.status, 0, preflight.stderr);
        const hashesPath = await writeProtectedHashes(
          fixture,
          preflight.output,
        );
        await writeFile(fixture.reportPath, validReport());
        const protectedPath =
          preflight.output.protected_hashes[protectedName].path;
        const original = await readFile(protectedPath, "utf8");
        await writeFile(protectedPath, `${original}mutation\n`);

        const result = runHelper(fixture, "validate-report", [
          "--report",
          fixture.reportPath,
          "--protected-hashes",
          hashesPath,
        ]);
        assert.equal(result.status, 2, result.stderr);
        assert.ok(
          failureCodes(result).includes("PROTECTED_HASH_MISMATCH"),
        );
        assert.equal(
          await readFile(protectedPath, "utf8"),
          `${original}mutation\n`,
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("final pair validation accepts aligned output and rejects index drift", async (t) => {
  await t.test("aligned pair", async () => {
    const fixture = await createFixture();
    try {
      const result = runPairCheck(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output.status, "pass");
      assert.deepEqual(
        result.output.projection.index_parent_ids,
        ["1.1", "1.2"],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  const cases = [
    {
      name: "duplicate parent index id",
      code: "INDEX_PARENT_DUPLICATE",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace(
            "## Slicing Rules",
            `  - \`{ id: "1.1", title: "Again", subtasks: [], predecessor: "none", unblocks: "terminal" }\`

## Slicing Rules`,
          ),
        ),
    },
    {
      name: "missing parent index entry",
      code: "INDEX_PARENT_MISSING",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace(
            '  - `{ id: "1.2", title: "Parent 1.2", subtasks: ["1.2.1"], predecessor: "1.1", unblocks: "terminal" }`\n',
            "",
          ),
        ),
    },
    {
      name: "parent index dependency drift",
      code: "INDEX_DEPENDENCY_MISMATCH",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace(
            'id: "1.2", title: "Parent 1.2", subtasks: ["1.2.1"], predecessor: "1.1"',
            'id: "1.2", title: "Parent 1.2", subtasks: ["1.2.1"], predecessor: "none"',
          ),
        ),
    },
    {
      name: "parent index title drift",
      code: "INDEX_PARENT_MISMATCH",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace('title: "Parent 1.2"', 'title: "Stale title"'),
        ),
    },
    {
      name: "unresolved parent index id",
      code: "INDEX_PARENT_UNRESOLVED",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace('id: "1.2", title:', 'id: "9.9", title:'),
        ),
    },
    {
      name: "duplicate wave parent selection",
      code: "WAVE_PARENT_DUPLICATE",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace(
            'parent_task_ids: ["1.2"]',
            'parent_task_ids: ["1.1", "1.2"]',
          ),
        ),
    },
    {
      name: "missing wave parent",
      code: "WAVE_PARENT_MISSING",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace('parent_task_ids: ["1.2"]', "parent_task_ids: []"),
        ),
    },
    {
      name: "wave ordering ignores parent dependency",
      code: "WAVE_DEPENDENCY_MISMATCH",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace('after: ["wave-1"]', "after: []"),
        ),
    },
    {
      name: "wave ordering ignores declared unblock",
      code: "WAVE_DEPENDENCY_MISMATCH",
      mutate: async ({ executePath, tasksPath }) => {
        await mutateJson(tasksPath, (tasks) => {
          tasks.phases[0].parents[1].predecessor = "none";
        });
        await mutateText(executePath, (text) =>
          text
            .replace(
              'id: "1.2", title: "Parent 1.2", subtasks: ["1.2.1"], predecessor: "1.1"',
              'id: "1.2", title: "Parent 1.2", subtasks: ["1.2.1"], predecessor: "none"',
            )
            .replace('after: ["wave-1"]', "after: []"),
        );
      },
    },
    {
      name: "unresolved wave dependency",
      code: "WAVE_REFERENCE_UNRESOLVED",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace('after: ["wave-1"]', 'after: ["wave-missing"]'),
        ),
    },
    {
      name: "wave dependency cycle",
      code: "DEPENDENCY_CYCLE",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace(
            'parent_task_ids: ["1.1"], after: []',
            'parent_task_ids: ["1.1"], after: ["wave-2"]',
          ),
        ),
    },
    {
      name: "execution summary count drift",
      code: "EXECUTION_COUNT_MISMATCH",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace("- Parent tasks: 2", "- Parent tasks: 999"),
        ),
    },
    {
      name: "task detail source differs from validated graph",
      code: "TASK_SOURCE_MISMATCH",
      mutate: ({ executePath }) =>
        mutateText(executePath, (text) =>
          text.replace(/Tasks JSON: `[^`]+`/, "Tasks JSON: `other.json`"),
        ),
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await createFixture();
      try {
        await fixtureCase.mutate(fixture);
        const result = runPairCheck(fixture);
        assert.equal(result.status, 2, result.stderr);
        assert.ok(failureCodes(result).includes(fixtureCase.code));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("unexpected CLI failures use the internal-error exit contract", async () => {
  const fixture = await createFixture();
  try {
    const result = runHelper(fixture, "unknown-operation");
    assert.equal(result.status, 3, result.stderr);
    assert.equal(result.output.status, "internal_error");
    assert.ok(failureCodes(result).includes("INTERNAL_ERROR"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
