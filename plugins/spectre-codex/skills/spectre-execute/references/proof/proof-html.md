# Proof HTML

For visual journeys, including TUI:

- Capture material checkpoints, not every frame. Mark each visual row `visual_claim: state|sequence`: `state` needs an inspected screenshot; interaction, transition, motion, timing, or persistence across actions needs `sequence` and a playable video. Embed required media directly in `proof.html` as `<img>` or `<video controls>` containing review-media bytes; textual paths, links, manifests, hashes, thumbnails, or unavailable sources do not qualify.
- Map each row to required media ids through `evidence_ids`; one journey may prove multiple rows. In `proof.json`, each referenced item records `id`, `kind: screenshot|video`, `inspected: true`, original `uri` and `sha256` provenance.
- Keep originals tool-owned; embed redacted/compressed review renditions as `data:` sources. Missing, broken, uninspected, or path-only required media forces `PARTIAL` with `PROOF_MEDIA_NOT_PRESENTED`, never `PASS`.
- After writing both artifacts, run `${PLUGIN_ROOT}/skills/spectre-execute/references/proof/scripts/validate-proof-html.mjs --proof-dir {FEATURE_ROOT}/proof --json`. DONE requires its pass result.
