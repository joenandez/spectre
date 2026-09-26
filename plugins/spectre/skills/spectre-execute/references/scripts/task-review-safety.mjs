#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const SCHEMA_VERSION = "task-review-safety/v1";
const STATE_SCHEMA_VERSION = "task-review-state/v1";
const PROMPT_VERSION = "task-review-prompt/v1";
const TERMINAL_REFS = new Set(["", "none", "terminal"]);
const ALL_LENSES = [
  "coverage",
  "executability",
  "integration",
  "reference-quality",
];
const LOCAL_LENSES = ["coverage", "executability"];

function parseArguments(argv) {
  const [operation, ...tokens] = argv;
  const options = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (name === "json") {
      options.json = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }

  if (!operation) {
    throw new Error("Missing operation");
  }
  if (!options["task-dir"]) {
    throw new Error("Missing --task-dir");
  }

  return { operation, options };
}

function hardFailure(code, message, details = {}) {
  return { code, message, ...details };
}

function resultFor(operation) {
  return {
    schema_version: SCHEMA_VERSION,
    operation,
    status: "pass",
    hard_failures: [],
    advisories: [],
  };
}

function finish(result) {
  const exitCode =
    result.status === "pass"
      ? 0
      : result.status === "hard_failure"
        ? 2
        : 3;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = exitCode;
}

async function isReadableFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveReadable(candidates) {
  const seen = new Set();
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    if (await isReadableFile(path)) {
      return path;
    }
  }
  return null;
}

function section(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(
      `^##\\s+(?:\\d+\\.\\s*)?${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
      "im",
    ),
  );
  return match?.[1] ?? "";
}

function referencedPath(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(`${escaped}\\s*:\\s*(?:\`([^\`]+)\`|([^\\s]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? null;
}

async function resolveReference(rawPath, executePath, taskDir) {
  if (!rawPath) {
    return null;
  }
  const candidates = isAbsolute(rawPath)
    ? [rawPath]
    : [
        resolve(process.cwd(), rawPath),
        resolve(dirname(executePath), rawPath),
        resolve(taskDir, rawPath),
      ];
  return resolveReadable(candidates);
}

function inlineObjects(markdownSection) {
  return [...markdownSection.matchAll(/`\{([^`\n]+)\}`/g)].map(
    ([, body]) => body,
  );
}

function stringProperty(objectText, name) {
  const match = objectText.match(
    new RegExp(`\\b${name}\\s*:\\s*"([^"]*)"`, "i"),
  );
  return match?.[1] ?? null;
}

function arrayProperty(objectText, name) {
  const match = objectText.match(
    new RegExp(`\\b${name}\\s*:\\s*\\[([^\\]]*)\\]`, "i"),
  );
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map(([, value]) => value);
}

function splitReferences(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values
    .map((entry) => String(entry).trim())
    .filter((entry) => !TERMINAL_REFS.has(entry.toLowerCase()));
}

function hasCycle(nodes, adjacency) {
  const visiting = new Set();
  const visited = new Set();

  function visit(node) {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }
    visiting.add(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      if (visit(neighbor)) {
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  return nodes.some(visit);
}

function parentProjection(tasks, failures) {
  const parents = [];
  const seen = new Set();

  for (const phase of Array.isArray(tasks?.phases) ? tasks.phases : []) {
    for (const parent of Array.isArray(phase?.parents) ? phase.parents : []) {
      const id = typeof parent?.id === "string" ? parent.id.trim() : "";
      if (!id) {
        failures.push(
          hardFailure(
            "PARENT_ID_UNRESOLVABLE",
            "A parent required for targeted slicing has no resolvable id.",
          ),
        );
        continue;
      }
      if (seen.has(id)) {
        failures.push(
          hardFailure(
            "PARENT_ID_DUPLICATE",
            `Parent id ${id} is duplicated in the task graph.`,
            { parent_id: id },
          ),
        );
        continue;
      }
      seen.add(id);
      parents.push({
        id,
        title: typeof parent?.title === "string" ? parent.title.trim() : "",
        subtask_ids: (Array.isArray(parent?.subtasks) ? parent.subtasks : [])
          .map((subtask) => String(subtask?.id ?? "").trim())
          .filter(Boolean),
        predecessor: splitReferences(parent.predecessor),
        unblocks: splitReferences(parent.unblocks),
      });
    }
  }

  return parents;
}

function validateParentDependencies(parents, failures) {
  const parentIds = new Set(parents.map(({ id }) => id));
  const adjacency = new Map(
    parents.map(({ id }) => [id, new Set()]),
  );

  for (const parent of parents) {
    for (const predecessor of parent.predecessor) {
      if (!parentIds.has(predecessor)) {
        failures.push(
          hardFailure(
            "DEPENDENCY_PARENT_UNRESOLVED",
            `Parent ${parent.id} references missing predecessor ${predecessor}.`,
            { parent_id: parent.id, reference: predecessor },
          ),
        );
      } else {
        adjacency.get(predecessor).add(parent.id);
      }
    }
    for (const unblocked of parent.unblocks) {
      if (!parentIds.has(unblocked)) {
        failures.push(
          hardFailure(
            "DEPENDENCY_PARENT_UNRESOLVED",
            `Parent ${parent.id} references missing unblocked parent ${unblocked}.`,
            { parent_id: parent.id, reference: unblocked },
          ),
        );
      } else {
        adjacency.get(parent.id).add(unblocked);
      }
    }
  }

  if (
    !failures.some(
      ({ code }) => code === "DEPENDENCY_PARENT_UNRESOLVED",
    ) &&
    hasCycle([...parentIds], adjacency)
  ) {
    failures.push(
      hardFailure(
        "DEPENDENCY_CYCLE",
        "Declared parent dependencies contain a cycle.",
        { graph: "parents" },
      ),
    );
  }
}

function executeProjection(execute, parents, failures) {
  const parentIds = new Set(parents.map(({ id }) => id));
  const parentsById = new Map(parents.map((parent) => [parent.id, parent]));
  const indexRecords = inlineObjects(section(execute, "Parent Task Index"))
    .map((objectText) => ({
      id: stringProperty(objectText, "id"),
      title: stringProperty(objectText, "title") ?? "",
      subtasks: arrayProperty(objectText, "subtasks"),
      predecessor: splitReferences(stringProperty(objectText, "predecessor")),
      unblocks: splitReferences(stringProperty(objectText, "unblocks")),
    }))
    .filter(({ id }) => id);
  const indexEntries = indexRecords.map(({ id }) => id);
  const seenIndex = new Set();
  const sameValues = (left, right) =>
    [...left].sort().join("\0") === [...right].sort().join("\0");

  for (const record of indexRecords) {
    const { id } = record;
    if (seenIndex.has(id)) {
      failures.push(
        hardFailure(
          "INDEX_PARENT_DUPLICATE",
          `Parent Task Index repeats parent ${id}.`,
          { parent_id: id },
        ),
      );
    }
    seenIndex.add(id);
    if (!parentIds.has(id)) {
      failures.push(
        hardFailure(
          "INDEX_PARENT_UNRESOLVED",
          `Parent Task Index references missing parent ${id}.`,
          { parent_id: id },
        ),
      );
      continue;
    }
    const parent = parentsById.get(id);
    if (record.title !== parent.title) {
      failures.push(
        hardFailure(
          "INDEX_PARENT_MISMATCH",
          `Parent Task Index title does not match task parent ${id}.`,
          { parent_id: id },
        ),
      );
    }
    if (
      !sameValues(record.subtasks, parent.subtask_ids) ||
      !sameValues(record.predecessor, parent.predecessor) ||
      !sameValues(record.unblocks, parent.unblocks)
    ) {
      failures.push(
        hardFailure(
          "INDEX_DEPENDENCY_MISMATCH",
          `Parent Task Index fields do not match task parent ${id}.`,
          { parent_id: id },
        ),
      );
    }
  }
  const missingIndex = [...parentIds].filter((id) => !seenIndex.has(id));
  if (missingIndex.length > 0) {
    failures.push(
      hardFailure(
        "INDEX_PARENT_MISSING",
        "Parent Task Index omits task graph parents.",
        { parent_ids: missingIndex },
      ),
    );
  }

  const waves = inlineObjects(section(execute, "Wave Plan")).map(
    (objectText) => ({
      id: stringProperty(objectText, "id"),
      parent_task_ids: arrayProperty(objectText, "parent_task_ids"),
      after: arrayProperty(objectText, "after"),
    }),
  );
  const waveIds = new Set();
  for (const wave of waves) {
    if (!wave.id) {
      continue;
    }
    if (waveIds.has(wave.id)) {
      failures.push(
        hardFailure(
          "WAVE_ID_DUPLICATE",
          `Wave id ${wave.id} is duplicated.`,
          { wave_id: wave.id },
        ),
      );
    }
    waveIds.add(wave.id);
  }

  const selectedParents = new Set();
  const parentWave = new Map();
  for (const wave of waves) {
    for (const id of wave.parent_task_ids) {
      if (selectedParents.has(id)) {
        failures.push(
          hardFailure(
            "WAVE_PARENT_DUPLICATE",
            `Parent ${id} is selected more than once by the Wave Plan.`,
            { parent_id: id },
          ),
        );
      }
      selectedParents.add(id);
      if (wave.id && !parentWave.has(id)) {
        parentWave.set(id, wave.id);
      }
      if (!parentIds.has(id)) {
        failures.push(
          hardFailure(
            "WAVE_PARENT_UNRESOLVED",
            `Wave ${wave.id ?? "(missing id)"} references missing parent ${id}.`,
            { wave_id: wave.id, parent_id: id },
          ),
        );
      }
    }
    for (const dependency of wave.after) {
      if (!waveIds.has(dependency)) {
        failures.push(
          hardFailure(
            "WAVE_REFERENCE_UNRESOLVED",
            `Wave ${wave.id ?? "(missing id)"} references missing wave ${dependency}.`,
            { wave_id: wave.id, reference: dependency },
          ),
        );
      }
    }
  }
  const missingWaveParents = [...parentIds].filter(
    (id) => !selectedParents.has(id),
  );
  if (missingWaveParents.length > 0) {
    failures.push(
      hardFailure(
        "WAVE_PARENT_MISSING",
        "Wave Plan omits task graph parents.",
        { parent_ids: missingWaveParents },
      ),
    );
  }

  const waveAdjacency = new Map(
    [...waveIds].map((id) => [id, new Set()]),
  );
  for (const wave of waves) {
    if (!wave.id) {
      continue;
    }
    for (const dependency of wave.after) {
      if (waveIds.has(dependency)) {
        waveAdjacency.get(dependency).add(wave.id);
      }
    }
  }
  if (
    !failures.some(
      ({ code }) => code === "WAVE_REFERENCE_UNRESOLVED",
    ) &&
    hasCycle([...waveIds], waveAdjacency)
  ) {
    failures.push(
      hardFailure(
        "DEPENDENCY_CYCLE",
        "Declared wave dependencies contain a cycle.",
        { graph: "waves" },
      ),
    );
  }

  const wavesById = new Map(waves.map((wave) => [wave.id, wave]));
  function waveDependsOn(waveId, dependencyId, visited = new Set()) {
    if (waveId === dependencyId || visited.has(waveId)) {
      return false;
    }
    visited.add(waveId);
    return (wavesById.get(waveId)?.after ?? []).some(
      (afterId) =>
        afterId === dependencyId ||
        waveDependsOn(afterId, dependencyId, visited),
    );
  }
  const invalidWaveGraph = failures.some(({ code }) =>
    [
      "WAVE_REFERENCE_UNRESOLVED",
      "WAVE_PARENT_UNRESOLVED",
      "WAVE_PARENT_DUPLICATE",
      "WAVE_PARENT_MISSING",
      "DEPENDENCY_CYCLE",
    ].includes(code),
  );
  if (!invalidWaveGraph) {
    for (const parent of parents) {
      const currentWave = parentWave.get(parent.id);
      for (const predecessor of parent.predecessor) {
        const predecessorWave = parentWave.get(predecessor);
        if (
          currentWave &&
          predecessorWave &&
          !waveDependsOn(currentWave, predecessorWave)
        ) {
          failures.push(
            hardFailure(
              "WAVE_DEPENDENCY_MISMATCH",
              `Wave for parent ${parent.id} does not follow predecessor ${predecessor}.`,
              { parent_id: parent.id, predecessor },
            ),
          );
        }
      }
      for (const unblocked of parent.unblocks) {
        const unblockedWave = parentWave.get(unblocked);
        if (
          currentWave &&
          unblockedWave &&
          !waveDependsOn(unblockedWave, currentWave)
        ) {
          failures.push(
            hardFailure(
              "WAVE_DEPENDENCY_MISMATCH",
              `Wave for parent ${unblocked} does not follow declared unblock from ${parent.id}.`,
              { parent_id: unblocked, predecessor: parent.id },
            ),
          );
        }
      }
    }
  }

  return { index_parent_ids: indexEntries, waves };
}

function executionSummaryCounts(execute) {
  const summary = section(execute, "Execution Summary");
  const read = (label) => {
    const match = summary.match(
      new RegExp(`^\\s*[-*]\\s*${label}\\s*:\\s*(\\d+)\\s*$`, "im"),
    );
    return match ? Number(match[1]) : null;
  };
  return {
    phases: read("Phases"),
    parents: read("Parent tasks"),
    subtasks: read("Subtasks"),
    waves: read("Waves"),
  };
}

async function hashDescriptor(path) {
  const bytes = await readFile(path);
  return {
    path: await realpath(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function hashValue(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function semanticHash(value) {
  return hashValue(canonicalValue(value));
}

function parentEntries(tasks) {
  const entries = [];
  for (const phase of Array.isArray(tasks?.phases) ? tasks.phases : []) {
    for (const parent of Array.isArray(phase?.parents) ? phase.parents : []) {
      entries.push({
        phase_id: String(phase?.id ?? ""),
        parent,
      });
    }
  }
  return entries;
}

function selectedProperties(value, names) {
  return Object.fromEntries(
    names
      .filter((name) => Object.hasOwn(value ?? {}, name))
      .map((name) => [name, value[name]]),
  );
}

function remainingProperties(value, known) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([name]) => !known.has(name)),
  );
}

const KNOWN_PARENT_FIELDS = new Set([
  "id",
  "title",
  "description",
  "type",
  "status",
  "risk",
  "predecessor",
  "unblocks",
  "produces",
  "consumed_by",
  "replaces",
  "requirements",
  "subtasks",
]);
const KNOWN_SUBTASK_FIELDS = new Set([
  "id",
  "title",
  "description",
  "type",
  "status",
  "predecessor",
  "unblocks",
  "produces",
  "consumed_by",
  "replaces",
  "requirements",
  "context",
  "acceptance_criteria",
]);

function parentSemanticRecord(phaseId, parent) {
  const subtasks = Array.isArray(parent?.subtasks) ? parent.subtasks : [];
  const local = {
    parent: selectedProperties(parent, [
      "title",
      "description",
      "type",
      "risk",
      "replaces",
    ]),
    subtasks: subtasks.map((subtask) => ({
      id: subtask?.id,
      ...selectedProperties(subtask, [
        "title",
        "description",
        "type",
        "replaces",
        "context",
        "acceptance_criteria",
      ]),
    })),
  };
  const outputs = {
    parent: selectedProperties(parent, ["produces"]),
    subtasks: subtasks.map((subtask) => ({
      id: subtask?.id,
      ...selectedProperties(subtask, ["produces"]),
    })),
  };
  const edges = {
    parent: selectedProperties(parent, [
      "predecessor",
      "unblocks",
      "consumed_by",
    ]),
    subtasks: subtasks.map((subtask) => ({
      id: subtask?.id,
      ...selectedProperties(subtask, [
        "predecessor",
        "unblocks",
        "consumed_by",
      ]),
    })),
  };
  const requirements = {
    parent: parent?.requirements ?? [],
    subtasks: subtasks.map((subtask) => ({
      id: subtask?.id,
      requirements: subtask?.requirements ?? [],
    })),
  };
  const unknown = {
    parent: remainingProperties(parent, KNOWN_PARENT_FIELDS),
    subtasks: subtasks.map((subtask) => ({
      id: subtask?.id,
      fields: remainingProperties(subtask, KNOWN_SUBTASK_FIELDS),
    })),
  };
  const consumers = [
    ...splitReferences(parent?.consumed_by),
    ...subtasks.flatMap((subtask) =>
      splitReferences(subtask?.consumed_by),
    ),
  ];
  const predecessor = splitReferences(parent?.predecessor);
  const unblocks = splitReferences(parent?.unblocks);

  const record = {
    phase_id: phaseId,
    local_hash: semanticHash(local),
    output_hash: semanticHash(outputs),
    edge_hash: semanticHash(edges),
    requirement_hash: semanticHash(requirements),
    unknown_hash: semanticHash(unknown),
    predecessor,
    unblocks,
    consumers,
    output_reach: [...new Set(consumers)].sort(),
  };
  record.semantic_hash = semanticHash(record);
  return record;
}

function semanticSnapshot(tasks, sources) {
  const parents = {};
  for (const { phase_id: phaseId, parent } of parentEntries(tasks)) {
    if (typeof parent?.id !== "string" || !parent.id.trim()) {
      continue;
    }
    parents[parent.id] = parentSemanticRecord(phaseId, parent);
  }
  return {
    source_hashes: sources,
    parents,
  };
}

function descriptorMatches(left, right) {
  if (left == null && right == null) {
    return true;
  }
  return (
    typeof left?.sha256 === "string" &&
    typeof right?.sha256 === "string" &&
    left.sha256 === right.sha256
  );
}

function hashesMatchSnapshot(hashes, snapshot) {
  const sourceEntries = Object.entries(snapshot?.source_hashes ?? {});
  const parentEntriesValue = Object.entries(snapshot?.parents ?? {});
  return (
    sourceEntries.length > 0 &&
    parentEntriesValue.length > 0 &&
    sourceEntries.every(([name, descriptor]) =>
      descriptorMatches(hashes?.sources?.[name], descriptor),
    ) &&
    parentEntriesValue.every(
      ([id, record]) =>
        hashes?.parents?.[id] === record.semantic_hash,
    )
  );
}

function allParentIds(snapshot) {
  return Object.keys(snapshot.parents).sort((left, right) =>
    left.localeCompare(right),
  );
}

function changedSourceReasons(previous, current) {
  const labels = {
    plan: "Plan source changed.",
    scope: "Scope source changed.",
    requirements: "Requirement source changed.",
    prd: "PRD source changed.",
    ux: "UX source changed.",
    out_of_bounds: "Out-of-Bounds boundary changed.",
    manifest: "Artifact manifest changed.",
    coverage: "Requirement coverage map changed.",
  };
  return Object.entries(labels)
    .filter(
      ([name]) =>
        !descriptorMatches(
          previous?.source_hashes?.[name],
          current?.source_hashes?.[name],
        ),
    )
    .map(([, reason]) => reason);
}

function directNeighbors(record) {
  return new Set([
    ...(record?.predecessor ?? []),
    ...(record?.unblocks ?? []),
    ...(record?.consumers ?? []),
  ]);
}

function classifyImpact(previous, current) {
  const parents = allParentIds(current);
  const previousParents = allParentIds(previous);
  const full = (reasons) => ({
    mode: "full",
    parents,
    lenses: [...ALL_LENSES],
    reasons,
  });

  if (
    parents.length !== previousParents.length ||
    parents.some((id, index) => id !== previousParents[index])
  ) {
    return {
      mode: "full",
      parents,
      lenses: [...ALL_LENSES],
      reasons: [
        "Broad parent identity or renumbering changed the task graph.",
      ],
    };
  }

  const globalSourceReasons = changedSourceReasons(previous, current);
  if (globalSourceReasons.length > 0) {
    return full(globalSourceReasons);
  }

  const selectedParents = new Set();
  const selectedLenses = new Set();
  const reasons = [];
  for (const id of parents) {
    const before = previous.parents[id];
    const after = current.parents[id];
    if (before.semantic_hash === after.semantic_hash) {
      continue;
    }
    if (before.phase_id === "0" || after.phase_id === "0") {
      return full([
        `Phase-0 global prerequisite ${id} changed.`,
      ]);
    }
    if (before.requirement_hash !== after.requirement_hash) {
      return full([
        `Requirement trace for parent ${id} changed.`,
      ]);
    }
    if (before.unknown_hash !== after.unknown_hash) {
      return full([
        `Ambiguous unclassified semantic fields changed for parent ${id}.`,
      ]);
    }
    if (
      before.output_hash !== after.output_hash &&
      Math.max(
        before.output_reach?.length ?? 0,
        after.output_reach?.length ?? 0,
      ) > 1
    ) {
      return full([
        `Cross-cutting output reachability changed for parent ${id}.`,
      ]);
    }
    if (before.edge_hash !== after.edge_hash) {
      selectedParents.add(id);
      for (const neighbor of [
        ...directNeighbors(before),
        ...directNeighbors(after),
      ]) {
        if (current.parents[neighbor]) {
          selectedParents.add(neighbor);
        }
      }
      selectedLenses.add("integration");
      reasons.push(
        `Graph edge changed for ${id}; selected the parent and direct old/new neighbors.`,
      );
    }
    if (
      before.local_hash !== after.local_hash ||
      before.output_hash !== after.output_hash
    ) {
      selectedParents.add(id);
      for (const lens of LOCAL_LENSES) {
        selectedLenses.add(lens);
      }
      reasons.push(
        `Criterion, context, title, type, or output changed for parent ${id}.`,
      );
    }
    if (
      before.edge_hash === after.edge_hash &&
      before.local_hash === after.local_hash &&
      before.output_hash === after.output_hash
    ) {
      return full([
        `Ambiguous semantic change could not be safely classified for parent ${id}.`,
      ]);
    }
  }

  if (selectedParents.size === 0) {
    return {
      mode: "reuse",
      parents: [],
      lenses: [],
      reasons: [
        "No semantic source changed; prior complete regions may be reused.",
      ],
    };
  }
  return {
    mode: "slice",
    parents: [...selectedParents].sort((left, right) =>
      left.localeCompare(right),
    ),
    lenses: [...selectedLenses],
    reasons,
  };
}

function validatePreviousState(state) {
  if (!state) {
    return "Previous review state is missing or absent.";
  }
  if (state.schema_version !== STATE_SCHEMA_VERSION) {
    return "Previous review state schema version is incompatible.";
  }
  if (state.prompt_version !== PROMPT_VERSION) {
    return "Previous review prompt version is stale or incompatible.";
  }
  if (
    !state.semantic_snapshot ||
    !hashesMatchSnapshot(
      state.post_write_hashes,
      state.semantic_snapshot,
    )
  ) {
    return "Post-write hash mismatch invalidates previous review state.";
  }
  if (state.writeback?.status !== "complete") {
    return "Previous write-back was interrupted or incomplete.";
  }
  if (state.post_check?.status !== "pass") {
    return "Previous focused post-check failed or is missing.";
  }

  const findingIds = Array.isArray(state.prior_report?.finding_ids)
    ? state.prior_report.finding_ids
    : [];
  const dispositions = new Map();
  for (const entry of Array.isArray(state.finding_dispositions)
    ? state.finding_dispositions
    : []) {
    if (
      typeof entry?.id === "string" &&
      ["unresolved", "applied", "skipped", "scope-change"].includes(
        entry.disposition,
      )
    ) {
      dispositions.set(entry.id, entry.disposition);
    }
  }
  if (findingIds.some((id) => !dispositions.has(id))) {
    return "A prior finding is missing a valid disposition.";
  }
  return null;
}

function findingReuse(state, current, impact) {
  const findingIds = Array.isArray(state?.prior_report?.finding_ids)
    ? state.prior_report.finding_ids
    : [];
  const dispositionById = new Map(
    (Array.isArray(state?.finding_dispositions)
      ? state.finding_dispositions
      : []
    ).map((entry) => [entry.id, entry.disposition]),
  );
  const unresolvedById = new Map(
    (Array.isArray(state?.unresolved_findings)
      ? state.unresolved_findings
      : []
    ).map((finding) => [finding.id, finding]),
  );
  const reusable = [];
  const excluded = [];

  for (const id of findingIds) {
    const finding = unresolvedById.get(id);
    const region = finding?.affected_region;
    const sourceHashes = finding?.source_parent_hashes;
    const unchangedCompleteRegion =
      dispositionById.get(id) === "unresolved" &&
      region?.complete === true &&
      Array.isArray(region.parents) &&
      region.parents.length > 0 &&
      region.parents.every(
        (parentId) =>
          typeof sourceHashes?.[parentId] === "string" &&
          sourceHashes[parentId] ===
            current.parents[parentId]?.semantic_hash,
      );
    if (impact.mode !== "full" && unchangedCompleteRegion) {
      reusable.push(id);
    } else {
      excluded.push(id);
    }
  }

  return {
    eligible: reusable.length > 0,
    finding_ids: reusable,
    excluded_finding_ids: excluded,
  };
}

async function optionalSourceDescriptor(
  execute,
  executePath,
  taskDir,
  label,
) {
  const source = referencedPath(
    section(execute, "Document Manifest"),
    label,
  );
  const path = await resolveReference(source, executePath, taskDir);
  return path ? hashDescriptor(path) : null;
}

async function impactArtifacts(options, preflightResult) {
  const taskDir = resolve(options["task-dir"]);
  const executePath = preflightResult.protected_hashes.execute.path;
  const tasksPath = preflightResult.protected_hashes.tasks.path;
  const execute = await readFile(executePath, "utf8");
  const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  const sources = {
    plan: preflightResult.protected_hashes.plan,
    execute: preflightResult.protected_hashes.execute,
    tasks: preflightResult.protected_hashes.tasks,
    scope:
      preflightResult.protected_hashes.scope ??
      (await optionalSourceDescriptor(
        execute,
        executePath,
        taskDir,
        "Scope",
      )),
    requirements: await optionalSourceDescriptor(
      execute,
      executePath,
      taskDir,
      "Requirements",
    ),
    prd: await optionalSourceDescriptor(
      execute,
      executePath,
      taskDir,
      "PRD",
    ),
    ux: await optionalSourceDescriptor(
      execute,
      executePath,
      taskDir,
      "UX",
    ),
    out_of_bounds: await optionalSourceDescriptor(
      execute,
      executePath,
      taskDir,
      "Out-of-Bounds",
    ),
    manifest: await optionalSourceDescriptor(
      execute,
      executePath,
      taskDir,
      "Artifact Manifest",
    ),
    coverage: {
      path: executePath,
      sha256: hashValue(section(execute, "Requirement Coverage")),
    },
  };
  return { sources, tasks };
}

async function readPreviousState(path) {
  try {
    return {
      state: JSON.parse(await readFile(resolve(path), "utf8")),
      error: null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: null, error: "Previous review state is missing or absent." };
    }
    return {
      state: null,
      error: `Previous review state is malformed or invalid: ${error.message}`,
    };
  }
}

async function impact(options) {
  if (!options["previous-state"]) {
    throw new Error("impact requires --previous-state");
  }
  const preflightResult = await preflight(options);
  if (preflightResult.status !== "pass") {
    return {
      ...preflightResult,
      operation: "impact",
      preflight: preflightResult,
    };
  }

  const { sources, tasks } = await impactArtifacts(
    options,
    preflightResult,
  );
  const currentSnapshot = semanticSnapshot(tasks, sources);
  const preReviewHashes = {
    sources,
    parents: Object.fromEntries(
      Object.entries(currentSnapshot.parents).map(([id, record]) => [
        id,
        record.semantic_hash,
      ]),
    ),
  };
  const previousRead = await readPreviousState(
    options["previous-state"],
  );
  const invalidReason =
    previousRead.error ?? validatePreviousState(previousRead.state);
  const impactRegion = invalidReason
    ? {
        mode: "full",
        parents: allParentIds(currentSnapshot),
        lenses: [...ALL_LENSES],
        reasons: [invalidReason],
      }
    : classifyImpact(
        previousRead.state.semantic_snapshot,
        currentSnapshot,
      );
  impactRegion.reuse = invalidReason
    ? {
        eligible: false,
        finding_ids: [],
        excluded_finding_ids:
          previousRead.state?.prior_report?.finding_ids ?? [],
      }
    : findingReuse(
        previousRead.state,
        currentSnapshot,
        impactRegion,
      );

  return {
    ...resultFor("impact"),
    preflight: preflightResult,
    pre_review_hashes: preReviewHashes,
    impact: impactRegion,
    proposed_state: {
      schema_version: STATE_SCHEMA_VERSION,
      prompt_version: PROMPT_VERSION,
      pre_review_hashes: preReviewHashes,
      post_write_hashes: null,
      semantic_snapshot: currentSnapshot,
      reviewed_regions: [],
      prior_report: null,
      finding_dispositions: [],
      unresolved_findings: [],
      impact_reasons: [...impactRegion.reasons],
      writeback: { status: "pending" },
      post_check: { status: "pending" },
    },
  };
}

async function preflight(options) {
  const result = resultFor("preflight");
  const taskDir = resolve(options["task-dir"]);
  const tasksRequested = options.tasks
    ? resolve(options.tasks)
    : resolve(taskDir, "specs", "tasks.json");
  const tasksPath = await resolveReadable([tasksRequested]);
  const planCandidates = [
    resolve(taskDir, "specs", "plan.md"),
    resolve(dirname(tasksRequested), "plan.md"),
  ];
  if (basename(tasksRequested).endsWith(".tasks.json")) {
    planCandidates.push(
      resolve(
        dirname(tasksRequested),
        basename(tasksRequested).replace(/\.tasks\.json$/, ".plan.md"),
      ),
    );
  }
  const planPath = await resolveReadable(planCandidates);

  if (!planPath) {
    result.hard_failures.push(
      hardFailure(
        "ARTIFACT_MISSING",
        "Required plan artifact is missing or unreadable.",
        { artifact: "plan" },
      ),
    );
  }
  if (!tasksPath) {
    result.hard_failures.push(
      hardFailure(
        "ARTIFACT_MISSING",
        "Required task graph is missing or unreadable.",
        { artifact: "tasks" },
      ),
    );
  }
  if (!tasksPath) {
    result.status = "hard_failure";
    return result;
  }

  let tasks;
  try {
    tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  } catch (error) {
    result.hard_failures.push(
      hardFailure(
        "TASK_JSON_INVALID",
        "Task detail JSON does not parse.",
        { error: error.message },
      ),
    );
    result.status = "hard_failure";
    return result;
  }

  const parents = parentProjection(tasks, result.hard_failures);
  validateParentDependencies(parents, result.hard_failures);

  result.projection = {
    parents,
  };
  result.protected_hashes = {};
  result.stage_hashes = {
    tasks: await hashDescriptor(tasksPath),
  };
  if (planPath) {
    result.protected_hashes.plan = await hashDescriptor(planPath);
  }
  const scopePath = await resolveReadable([
    resolve(taskDir, "concepts", "scope.md"),
    resolve(taskDir, "specs", "prd.md"),
  ]);
  if (scopePath) {
    result.protected_hashes.scope = await hashDescriptor(scopePath);
  }

  if (result.hard_failures.length > 0) {
    result.status = "hard_failure";
  }
  return result;
}

async function validatePair(options) {
  const result = resultFor("validate-pair");
  const taskDir = resolve(options["task-dir"]);
  const executeRequested = options.execute
    ? resolve(options.execute)
    : resolve(taskDir, "specs", "execute.md");
  const executePath = await resolveReadable([executeRequested]);
  if (!executePath) {
    result.hard_failures.push(
      hardFailure(
        "ARTIFACT_MISSING",
        "Required execute index is missing or unreadable.",
        { artifact: "execute" },
      ),
    );
    result.status = "hard_failure";
    return result;
  }

  const execute = await readFile(executePath, "utf8");
  const declaredSource = referencedPath(
    section(execute, "Task Detail Source"),
    "Tasks JSON",
  );
  const fallbackSource = basename(executePath).endsWith(".execute.md")
    ? basename(executePath).replace(/\.execute\.md$/, ".tasks.json")
    : "tasks.json";
  const explicitTasks = options.tasks
    ? await resolveReadable([resolve(options.tasks)])
    : null;
  const declaredTasks = await resolveReference(
    declaredSource ?? fallbackSource,
    executePath,
    taskDir,
  );
  const tasksPath = explicitTasks ?? declaredTasks;
  if (!tasksPath) {
    result.hard_failures.push(
      hardFailure(
        "TASK_SOURCE_UNRESOLVABLE",
        "Task Detail Source does not resolve to a readable task graph.",
        { source: declaredSource ?? fallbackSource },
      ),
    );
    result.status = "hard_failure";
    return result;
  }
  if (
    explicitTasks &&
    (!declaredTasks || (await realpath(explicitTasks)) !== (await realpath(declaredTasks)))
  ) {
    result.hard_failures.push(
      hardFailure(
        "TASK_SOURCE_MISMATCH",
        "Task Detail Source does not identify the validated task graph.",
        { source: declaredSource ?? fallbackSource },
      ),
    );
  }

  let tasks;
  try {
    tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  } catch (error) {
    result.hard_failures.push(
      hardFailure(
        "TASK_JSON_INVALID",
        "Task detail JSON does not parse.",
        { error: error.message },
      ),
    );
    result.status = "hard_failure";
    return result;
  }

  const parents = parentProjection(tasks, result.hard_failures);
  validateParentDependencies(parents, result.hard_failures);
  const executeData = executeProjection(
    execute,
    parents,
    result.hard_failures,
  );
  result.projection = {
    parents,
    index_parent_ids: executeData.index_parent_ids,
    waves: executeData.waves,
  };
  const actualCounts = {
    phases: Array.isArray(tasks?.phases) ? tasks.phases.length : 0,
    parents: parents.length,
    subtasks: parents.reduce(
      (count, parent) => count + parent.subtask_ids.length,
      0,
    ),
    waves: executeData.waves.length,
  };
  const declaredCounts = executionSummaryCounts(execute);
  const countMismatches = Object.keys(actualCounts).filter(
    (key) => declaredCounts[key] !== actualCounts[key],
  );
  if (countMismatches.length > 0) {
    result.hard_failures.push(
      hardFailure(
        "EXECUTION_COUNT_MISMATCH",
        "Execution Summary counts do not match the final task graph and wave plan.",
        {
          fields: countMismatches,
          declared: declaredCounts,
          actual: actualCounts,
        },
      ),
    );
  }
  result.hashes = {
    execute: await hashDescriptor(executePath),
    tasks: await hashDescriptor(tasksPath),
  };
  if (result.hard_failures.length > 0) {
    result.status = "hard_failure";
  }
  return result;
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function reportFindings(report, failures) {
  const findingsSection = section(report, "Findings");
  if (/\bno findings\b/i.test(findingsSection)) {
    return { count: 0, explicit_no_findings: true, ids: [] };
  }

  const rows = findingsSection
    .split(/\r?\n/)
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) =>
      line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  const headerIndex = rows.findIndex((row) => {
    const normalized = row.map((cell) =>
      cell.toLowerCase().replace(/[^a-z]/g, ""),
    );
    return (
      normalized.includes("location") &&
      normalized.includes("finding") &&
      (normalized.includes("suggestededit") || normalized.includes("edit"))
    );
  });
  if (headerIndex < 0) {
    failures.push(
      hardFailure(
        "REPORT_FINDINGS_INVALID",
        "Report must contain a parseable Findings table or explicit no-findings form.",
      ),
    );
    return { count: 0, explicit_no_findings: false, ids: [] };
  }

  const headers = rows[headerIndex].map((cell) =>
    cell.toLowerCase().replace(/[^a-z]/g, ""),
  );
  const locationIndex = headers.indexOf("location");
  const findingIndex = headers.indexOf("finding");
  const editIndex = headers.includes("suggestededit")
    ? headers.indexOf("suggestededit")
    : headers.indexOf("edit");
  const findings = rows.slice(headerIndex + 1).filter((row) => {
    return !row.every((cell) => /^:?-{3,}:?$/.test(cell));
  });

  if (findings.length === 0) {
    failures.push(
      hardFailure(
        "REPORT_FINDINGS_INVALID",
        "Findings table contains no findings.",
      ),
    );
  } else if (
    findings.some(
      (row) =>
        !row[locationIndex]?.trim() ||
        !row[findingIndex]?.trim() ||
        !row[editIndex]?.trim(),
    )
  ) {
    failures.push(
      hardFailure(
        "REPORT_FINDING_FIELDS_MISSING",
        "Every finding requires nonempty location, finding, and edit fields.",
      ),
    );
  }

  return {
    count: findings.length,
    explicit_no_findings: false,
    ids: findings.map((row) => row[0]?.trim()).filter(Boolean),
  };
}

function reportDispositions(report, findingIds, failures) {
  if (findingIds.length === 0) {
    return { count: 0 };
  }
  const rows = section(report, "Dispositions")
    .split(/\r?\n/)
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) =>
      line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  const headerIndex = rows.findIndex((row) => {
    const normalized = row.map((cell) =>
      cell.toLowerCase().replace(/[^a-z]/g, ""),
    );
    return normalized.includes("finding") && normalized.includes("disposition");
  });
  if (headerIndex < 0) {
    failures.push(
      hardFailure(
        "REPORT_DISPOSITIONS_INVALID",
        "Every finding requires one parseable disposition.",
      ),
    );
    return { count: 0 };
  }

  const headers = rows[headerIndex].map((cell) =>
    cell.toLowerCase().replace(/[^a-z]/g, ""),
  );
  const findingIndex = headers.indexOf("finding");
  const dispositionIndex = headers.indexOf("disposition");
  const resultingEditIndex = headers.indexOf("resultingtaskedit");
  if (resultingEditIndex < 0) {
    failures.push(
      hardFailure(
        "REPORT_DISPOSITIONS_INVALID",
        "Disposition table requires a Resulting Task Edit column.",
      ),
    );
    return { count: 0 };
  }
  const allowed = new Set(["applied", "skipped", "unresolved", "scope-change"]);
  const dispositions = rows.slice(headerIndex + 1).filter((row) =>
    !row.every((cell) => /^:?-{3,}:?$/.test(cell)),
  );
  const byFinding = new Map();
  for (const row of dispositions) {
    const id = row[findingIndex]?.trim();
    const disposition = row[dispositionIndex]?.trim().toLowerCase();
    const resultingEdit = row[resultingEditIndex]?.trim();
    if (
      !id ||
      !allowed.has(disposition) ||
      byFinding.has(id) ||
      (disposition === "applied" && !resultingEdit)
    ) {
      failures.push(
        hardFailure(
          "REPORT_DISPOSITIONS_INVALID",
          "Disposition rows require a unique finding id and an allowed status.",
          { finding_id: id ?? null },
        ),
      );
      continue;
    }
    byFinding.set(id, disposition);
  }
  const missing = findingIds.filter((id) => !byFinding.has(id));
  if (missing.length > 0) {
    failures.push(
      hardFailure(
        "REPORT_DISPOSITIONS_INVALID",
        "Every finding requires exactly one disposition.",
        { finding_ids: missing },
      ),
    );
  }
  return { count: byFinding.size };
}

function metadataValue(report, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = report.match(
    new RegExp(
      `^\\s*[-*]?\\s*(?:\\*\\*)?${escaped}\\s*:(?:\\*\\*)?\\s*(.+?)\\s*$`,
      "im",
    ),
  );
  return match?.[1]?.replace(/\*\*$/u, "").trim() ?? "";
}

async function validateProtectedHashes(path, failures) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    failures.push(
      hardFailure(
        "PROTECTED_HASHES_INVALID",
        "Protected hash record is missing or invalid.",
        { error: error.message },
      ),
    );
    return {};
  }
  const hashes = parsed.protected_hashes ?? parsed;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    failures.push(
      hardFailure(
        "PROTECTED_HASHES_INVALID",
        "Protected hash record has no hash mapping.",
      ),
    );
    return {};
  }

  for (const [name, descriptor] of Object.entries(hashes)) {
    if (
      typeof descriptor?.path !== "string" ||
      typeof descriptor?.sha256 !== "string"
    ) {
      failures.push(
        hardFailure(
          "PROTECTED_HASHES_INVALID",
          `Protected hash descriptor ${name} is invalid.`,
          { artifact: name },
        ),
      );
      continue;
    }
    let actual = null;
    try {
      actual = (await hashDescriptor(descriptor.path)).sha256;
    } catch {
      // A missing protected artifact is a mismatch, not an internal error.
    }
    if (actual !== descriptor.sha256) {
      failures.push(
        hardFailure(
          "PROTECTED_HASH_MISMATCH",
          `Protected artifact ${name} changed or became unreadable.`,
          { artifact: name, path: descriptor.path },
        ),
      );
    }
  }
  return hashes;
}

async function validateReport(options) {
  if (!options.report || !options["protected-hashes"]) {
    throw new Error(
      "validate-report requires --report and --protected-hashes",
    );
  }
  const result = resultFor("validate-report");
  const taskDir = resolve(options["task-dir"]);
  const allowedDirectory = resolve(taskDir, "reviews");
  const reportPath = resolve(options.report);

  if (!isWithin(allowedDirectory, reportPath)) {
    result.hard_failures.push(
      hardFailure(
        "REPORT_PATH_OUTSIDE",
        "Report path escapes the allowed reviews directory.",
        { path: reportPath },
      ),
    );
  }

  let report = null;
  if (result.hard_failures.length === 0) {
    try {
      report = await readFile(reportPath, "utf8");
      const [allowedRealPath, reportRealPath] = await Promise.all([
        realpath(allowedDirectory),
        realpath(reportPath),
      ]);
      if (!isWithin(allowedRealPath, reportRealPath)) {
        result.hard_failures.push(
          hardFailure(
            "REPORT_PATH_OUTSIDE",
            "Report resolves outside the allowed reviews directory.",
            { path: reportRealPath },
          ),
        );
      }
    } catch (error) {
      result.hard_failures.push(
        hardFailure(
          "REPORT_UNREADABLE",
          "Report is missing or unreadable.",
          { error: error.message },
        ),
      );
    }
  }

  if (report !== null && result.hard_failures.length === 0) {
    result.report = reportFindings(report, result.hard_failures);
    result.dispositions = reportDispositions(
      report,
      result.report.ids,
      result.hard_failures,
    );
    const requiredMetadata = [
      "Mode",
      "Reviewer Runtime",
      "Reviewer Model",
      "Reviewer Effort",
      "Invocation Route",
    ];
    const missing = requiredMetadata.filter(
      (label) => !metadataValue(report, label),
    );
    if (missing.length > 0) {
      result.hard_failures.push(
        hardFailure(
          "REPORT_METADATA_MISSING",
          `Report is missing required route metadata: ${missing.join(", ")}.`,
          { fields: missing },
        ),
      );
    }
  }

  await validateProtectedHashes(
    options["protected-hashes"],
    result.hard_failures,
  );
  result.validated_report = reportPath;
  if (result.hard_failures.length > 0) {
    result.status = "hard_failure";
  }
  return result;
}

async function main() {
  let operation = "unknown";
  try {
    const parsed = parseArguments(process.argv.slice(2));
    operation = parsed.operation;
    if (operation === "preflight") {
      finish(await preflight(parsed.options));
      return;
    }
    if (operation === "validate-pair") {
      finish(await validatePair(parsed.options));
      return;
    }
    if (operation === "impact") {
      finish({
        ...resultFor("impact"),
        status: "hard_failure",
        hard_failures: [
          hardFailure(
            "IMPACT_RETIRED",
            "The impact operation is retired. Artifact changes never authorize or scope another semantic task review; only an explicit user request may start a new review round.",
          ),
        ],
      });
      return;
    }
    if (operation === "validate-report") {
      finish(await validateReport(parsed.options));
      return;
    }
    throw new Error(`Unknown operation: ${operation}`);
  } catch (error) {
    finish({
      ...resultFor(operation),
      status: "internal_error",
      hard_failures: [
        hardFailure("INTERNAL_ERROR", error.message),
      ],
    });
  }
}

await main();
