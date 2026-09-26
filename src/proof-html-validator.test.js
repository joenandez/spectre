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

test("proof HTML requires both screenshot and video evidence for visual PASS rows", () => {
  const proof = visualProof({
    matrix: [{ id: "journey", surface: "tui", status: "PASS", evidence_ids: ["shot"] }],
    evidence: [{ id: "shot", kind: "screenshot", inspected: true, uri: "raw/shot.png", sha256: SHA256 }],
  });
  const html = `<img data-evidence-id="shot" src="${IMAGE}" alt="TUI result">`;
  const result = validateProofArtifacts(proof, html);

  assert.equal(result.ok, false);
  assert.ok(result.failures.some(({ code, kind }) => code === "PROOF_MEDIA_NOT_PRESENTED" && kind === "video"));
});

test("proof HTML permits non-visual PASS rows without media", () => {
  const proof = {
    matrix: [{ id: "api", surface: "non-visual", status: "PASS", evidence_ids: [] }],
    evidence: [],
  };

  assert.equal(validateProofArtifacts(proof, "<pre>200 OK</pre>").ok, true);
});
