import assert from "node:assert/strict";
import test from "node:test";

import { validateProofArtifacts } from "../plugins/spectre/skills/spectre-execute/references/proof/scripts/validate-proof-html.mjs";

const SHA256 = "a".repeat(64);
const IMAGE = `data:image/png;base64,${Buffer.from("embedded screenshot bytes").toString("base64")}`;
const VIDEO = `data:video/mp4;base64,${Buffer.from("embedded video bytes for proof").toString("base64")}`;

function visualProof(overrides = {}) {
  return {
    matrix: [{
      id: "journey",
      surface: "visual",
      visual_claim: "sequence",
      status: "PASS",
      evidence_ids: ["shot", "recording"],
    }],
    evidence: [
      { id: "shot", kind: "screenshot", inspected: true, uri: "raw/shot.png", sha256: SHA256 },
      { id: "recording", kind: "video", inspected: true, uri: "raw/video.mp4", sha256: SHA256 },
    ],
    ...overrides,
  };
}

test("proof HTML accepts embedded inspected screenshot and playable video evidence", () => {
  const html = `
    <img data-evidence-id="shot" src="${IMAGE}" alt="Observed result">
    <video data-evidence-id="recording" controls><source src="${VIDEO}" type="video/mp4"></video>
  `;

  assert.deepEqual(validateProofArtifacts(visualProof(), html), {
    schema_version: "proof-html/v1",
    ok: true,
    failures: [],
  });
});

test("proof HTML rejects path-only evidence for a visual PASS row", () => {
  const html = `
    <p>Screenshot: raw/shot.png</p>
    <a href="raw/video.mp4">Video recording</a>
  `;
  const result = validateProofArtifacts(visualProof(), html);

  assert.equal(result.ok, false);
  assert.equal(
    result.failures.filter(({ code }) => code === "PROOF_MEDIA_NOT_PRESENTED").length,
    2,
  );
});

test("proof HTML requires video for sequence claims", () => {
  const proof = visualProof({
    matrix: [{ id: "journey", surface: "tui", visual_claim: "sequence", status: "PASS", evidence_ids: ["shot"] }],
    evidence: [{ id: "shot", kind: "screenshot", inspected: true, uri: "raw/shot.png", sha256: SHA256 }],
  });
  const html = `<img data-evidence-id="shot" src="${IMAGE}" alt="TUI result">`;
  const result = validateProofArtifacts(proof, html);

  assert.equal(result.ok, false);
  assert.ok(result.failures.some(({ code, kind }) => code === "PROOF_MEDIA_NOT_PRESENTED" && kind === "video"));
});

test("proof HTML accepts a state claim with an inspected screenshot and rejects an undeclared claim", () => {
  const proof = visualProof({
    matrix: [{ id: "state", surface: "visual", visual_claim: "state", status: "PASS", evidence_ids: ["shot"] }],
    evidence: [{ id: "shot", kind: "screenshot", inspected: true, uri: "raw/shot.png", sha256: SHA256 }],
  });
  const html = `<img data-evidence-id="shot" src="${IMAGE}" alt="Observed state">`;

  assert.equal(validateProofArtifacts(proof, html).ok, true);
  const undeclared = { ...proof, matrix: [{ ...proof.matrix[0], visual_claim: undefined }] };
  assert.ok(validateProofArtifacts(undeclared, html).failures.some(
    ({ code }) => code === "PROOF_VISUAL_CLAIM_MISSING",
  ));
});

test("proof HTML permits non-visual PASS rows without media", () => {
  const proof = {
    matrix: [{ id: "api", surface: "non-visual", status: "PASS", evidence_ids: [] }],
    evidence: [],
  };

  assert.equal(validateProofArtifacts(proof, "<pre>200 OK</pre>").ok, true);
});

test("aggregate PASS requires Complete validation persisted for the same candidate and displayed in HTML", () => {
  const proof = {
    aggregate_status: "PASS",
    candidate: { base_sha: "b".repeat(40), head_sha: "c".repeat(40), diff_sha256: SHA256 },
    validation: {
      report: ".spectre/features/demo/validation/validation_gaps.md",
      status: "Complete",
      tuple: { base_sha: "b".repeat(40), head_sha: "c".repeat(40), diff_sha256: SHA256 },
    },
    matrix: [{ id: "api", surface: "non-visual", status: "PASS", evidence_ids: [] }],
    evidence: [],
  };
  const html = `<section id="validation"><h2>Validation</h2><p>${proof.validation.report}</p><p>Complete ${proof.candidate.base_sha} ${proof.candidate.head_sha} ${SHA256}</p></section>`;

  assert.equal(validateProofArtifacts(proof, html).ok, true);
  assert.ok(validateProofArtifacts({ ...proof, validation: undefined }, html).failures.some(
    ({ code }) => code === "PROOF_VALIDATION_REPORT_MISSING",
  ));
  assert.ok(validateProofArtifacts({
    ...proof,
    validation: { ...proof.validation, status: "Needs Work" },
  }, html).failures.some(({ code }) => code === "PROOF_VALIDATION_INCOMPLETE"));
  assert.ok(validateProofArtifacts({
    ...proof,
    validation: { ...proof.validation, tuple: { ...proof.validation.tuple, head_sha: "stale" } },
  }, html).failures.some(({ code }) => code === "PROOF_VALIDATION_TUPLE_MISMATCH"));
  assert.ok(validateProofArtifacts(proof, "<p>Validation omitted</p>").failures.some(
    ({ code }) => code === "PROOF_VALIDATION_NOT_DISPLAYED",
  ));
});
