#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VISUAL_SURFACES = new Set(["visual", "ui", "tui"]);
const KNOWN_SURFACES = new Set([
  ...VISUAL_SURFACES,
  "non-visual",
  "non_visual",
  "nonvisual",
]);
const MEDIA_KINDS = new Set(["screenshot", "video"]);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    options[token.slice(2)] = value;
    index += 1;
  }
  if (!options["proof-dir"]) {
    throw new Error("Missing --proof-dir");
  }
  return options;
}

function attributes(openingTag) {
  const values = {};
  for (const match of openingTag.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    values[match[1].toLowerCase()] = match[3];
  }
  return values;
}

function embeddedMediaSource(source, kind) {
  const family = kind === "screenshot" ? "image" : "video";
  const match = String(source ?? "").match(
    new RegExp(`^data:${family}\\/[^;,]+(?:;[^,]*)?;base64,([A-Za-z0-9+/=\\s]+)$`, "i"),
  );
  if (!match) {
    return false;
  }
  try {
    return Buffer.from(match[1].replace(/\s/g, ""), "base64").length > 16;
  } catch {
    return false;
  }
}

function renderedEvidence(html, evidence) {
  if (evidence.kind === "screenshot") {
    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      const attrs = attributes(match[0]);
      if (attrs["data-evidence-id"] === evidence.id) {
        return embeddedMediaSource(attrs.src, evidence.kind);
      }
    }
    return false;
  }

  for (const match of html.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)) {
    const openingTag = match[0].match(/^<video\b[^>]*>/i)?.[0] ?? "";
    const attrs = attributes(openingTag);
    if (attrs["data-evidence-id"] !== evidence.id || !("controls" in attrs || /\scontrols(?:\s|>)/i.test(openingTag))) {
      continue;
    }
    if (embeddedMediaSource(attrs.src, evidence.kind)) {
      return true;
    }
    for (const sourceMatch of match[0].matchAll(/<source\b[^>]*>/gi)) {
      if (embeddedMediaSource(attributes(sourceMatch[0]).src, evidence.kind)) {
        return true;
      }
    }
  }
  return false;
}

function failure(code, message, details = {}) {
  return { code, message, ...details };
}

export function validateProofArtifacts(proof, html) {
  const failures = [];
  const aggregateStatus = proof?.aggregate_status;
  const candidate = proof?.candidate;
  const validation = proof?.validation;
  const tupleFields = ["base_sha", "head_sha", "diff_sha256"];
  const candidateTupleValid = /^[a-f\d]{40,64}$/i.test(candidate?.base_sha ?? "") &&
    /^[a-f\d]{40,64}$/i.test(candidate?.head_sha ?? "") &&
    /^[a-f\d]{64}$/i.test(candidate?.diff_sha256 ?? "");
  const validationTupleMatches = tupleFields.every((field) =>
    typeof validation?.tuple?.[field] === "string" && validation.tuple[field] === candidate?.[field],
  );

  if (aggregateStatus === "PASS") {
    if (typeof validation?.report !== "string" || !validation.report.trim()) {
      failures.push(failure(
        "PROOF_VALIDATION_REPORT_MISSING",
        "Aggregate PASS requires a persisted validation report path.",
      ));
    }
    if (!candidateTupleValid || !validationTupleMatches) {
      failures.push(failure(
        "PROOF_VALIDATION_TUPLE_MISMATCH",
        "Aggregate PASS requires a complete validation tuple matching the current candidate.",
      ));
    }
    if (validation?.status !== "Complete") {
      failures.push(failure(
        "PROOF_VALIDATION_INCOMPLETE",
        "Aggregate PASS requires validation status Complete.",
      ));
    }
    const validationSection = String(html).match(/<section\b[^>]*id=["']validation["'][^>]*>[\s\S]*?<\/section>/i)?.[0] ?? "";
    if (!validationSection || !validationSection.includes(validation?.report ?? "") ||
        !validationSection.includes(validation?.status ?? "") ||
        !validationTupleMatches || !tupleFields.every((field) => validationSection.includes(candidate[field]))) {
      failures.push(failure(
        "PROOF_VALIDATION_NOT_DISPLAYED",
        "Aggregate PASS requires a Validation section displaying the report and matching candidate tuple.",
      ));
    }
  }

  const matrix = Array.isArray(proof?.matrix) ? proof.matrix : [];
  const evidence = Array.isArray(proof?.evidence) ? proof.evidence : [];
  const evidenceById = new Map(
    evidence
      .filter((item) => item && typeof item.id === "string")
      .map((item) => [item.id, item]),
  );

  for (const row of matrix) {
    const rowId = typeof row?.id === "string" && row.id ? row.id : "<unknown>";
    if (!KNOWN_SURFACES.has(row?.surface)) {
      failures.push(failure(
        "PROOF_SURFACE_MISSING",
        `Matrix row ${rowId} must declare surface as visual or non-visual.`,
        { row_id: rowId },
      ));
      continue;
    }
    if (!VISUAL_SURFACES.has(row.surface) || row.status !== "PASS") {
      continue;
    }

    const evidenceIds = Array.isArray(row.evidence_ids) ? row.evidence_ids : [];
    const rowEvidence = evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
    for (const id of evidenceIds) {
      if (!evidenceById.has(id)) {
        failures.push(failure(
          "PROOF_EVIDENCE_MISSING",
          `Visual PASS row ${rowId} references unknown evidence ${id}.`,
          { row_id: rowId, evidence_id: id },
        ));
      }
    }

    for (const kind of MEDIA_KINDS) {
      if (!rowEvidence.some((item) => item.kind === kind)) {
        failures.push(failure(
          "PROOF_MEDIA_NOT_PRESENTED",
          `Visual PASS row ${rowId} requires displayed ${kind} evidence.`,
          { row_id: rowId, kind },
        ));
      }
    }

    for (const item of rowEvidence) {
      if (!MEDIA_KINDS.has(item.kind)) {
        continue;
      }
      if (item.inspected !== true) {
        failures.push(failure(
          "PROOF_MEDIA_UNINSPECTED",
          `Evidence ${item.id} was not recorded as inspected.`,
          { row_id: rowId, evidence_id: item.id },
        ));
      }
      if (typeof item.uri !== "string" || !item.uri || !/^[a-f\d]{64}$/i.test(item.sha256 ?? "")) {
        failures.push(failure(
          "PROOF_PROVENANCE_MISSING",
          `Evidence ${item.id} requires original URI and sha256 provenance.`,
          { row_id: rowId, evidence_id: item.id },
        ));
      }
      if (!renderedEvidence(html, item)) {
        failures.push(failure(
          "PROOF_MEDIA_NOT_PRESENTED",
          `Evidence ${item.id} must be embedded in a rendered ${item.kind} element.`,
          { row_id: rowId, evidence_id: item.id, kind: item.kind },
        ));
      }
    }
  }

  return {
    schema_version: "proof-html/v1",
    ok: failures.length === 0,
    failures,
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    const proofDir = resolve(options["proof-dir"]);
    const [proofSource, html] = await Promise.all([
      readFile(resolve(proofDir, "proof.json"), "utf8"),
      readFile(resolve(proofDir, "proof.html"), "utf8"),
    ]);
    const result = validateProofArtifacts(JSON.parse(proofSource), html);
    process.stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    const result = {
      schema_version: "proof-html/v1",
      ok: false,
      failures: [failure("PROOF_VALIDATION_FAILED", error.message)],
    };
    process.stdout.write(`${JSON.stringify(result, null, options?.json ? 2 : 0)}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
