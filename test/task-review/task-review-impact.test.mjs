import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
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

test("impact is retired so helper output cannot trigger or scope a semantic re-review", () => {
  const result = spawnSync(
    process.execPath,
    [
      helperPath,
      "impact",
      "--task-dir",
      repositoryRoot,
      "--previous-state",
      join(repositoryRoot, "does-not-matter.json"),
      "--json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.operation, "impact");
  assert.equal(output.status, "hard_failure");
  assert.deepEqual(
    output.hard_failures.map(({ code }) => code),
    ["IMPACT_RETIRED"],
  );
  assert.match(
    output.hard_failures[0].message,
    /Artifact changes never authorize or scope another semantic task review/,
  );
});
