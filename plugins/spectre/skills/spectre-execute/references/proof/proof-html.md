# Proof HTML

For every visual journey, including TUI:

- Embed inspected screenshots of material states and a playable recording of the realistic public journey directly in `proof.html`. Use rendered `<img>` and `<video controls>` elements containing review-media bytes; textual paths, links, manifests, hashes, thumbnails, or unavailable sources do not qualify.
- Map each visual matrix row to screenshot and video ids through `evidence_ids`; one journey may prove multiple rows. In `proof.json`, each referenced evidence item records `id`, `kind: screenshot|video`, `inspected: true`, original `uri` and `sha256` provenance.
- Keep originals tool-owned; embed redacted/compressed review renditions as `data:` sources. Missing, broken, uninspected, or path-only required media forces `PARTIAL` with `PROOF_MEDIA_NOT_PRESENTED`, never `PASS`.
- After writing both artifacts, run `${CLAUDE_PLUGIN_ROOT}/skills/spectre-execute/references/proof/scripts/validate-proof-html.mjs --proof-dir {FEATURE_ROOT}/proof --json`. DONE requires its pass result.
