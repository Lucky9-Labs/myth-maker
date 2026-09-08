# GLB loader profile (`glb.v1`)

`glb.v1` is an additive importer sidecar, not a change to the published
`contracts/v1` schemas. It accompanies one ordinary v1 `EncounterModule` whose
`execution_kind` is `runtime_asset`. The module keeps generic selection metadata;
the sidecar says how a host may load the bytes.

## Acceptance gate

`GlbSourceImporter.import_validated(...)` accepts all of the following, or emits
no candidate:

1. An immutable `SourceArtifactReceipt` for `application/x-blender`, addressed
   exactly as `sha256:<digest>`.
2. Source bytes with the receipt's byte count and SHA-256.
3. The importer produces its `AcceptanceReceipt` only after source-hash, GLB
   structure, and output-hash validation pass. It is not an input and cannot be
   caller-issued. V0 records only its fixed `automated_validator` identity and
   `blender-export-v1` policy. A human/API steer is an active-generation
   instruction, never an artifact-acceptance path.
4. A host that advertises `runtime_asset`, the requested platform, and both the
   requested GLB loader and render-pipeline IDs.

The conversion adapter is the only varying seam. This checkout discovers either
`blender` on `PATH` or the macOS application executable and uses
`BlenderCliGlbConverter` for a deterministic real `.blend` fixture export in
the importer suite. Check the executable and version with:

```sh
python3 modal/glb_source_importer.py --check-live-conversion
```

## Closed sidecar record

```json
{
  "profile": "glb.v1",
  "artifact": {
    "uri": "sha256:<64 lowercase hex>",
    "sha256": "<64 lowercase hex>",
    "media_type": "model/gltf-binary",
    "byte_length": 1234
  },
  "byte_cap": 50000000,
  "loader": { "id": "gltf", "version": "2.0" },
  "target": {
    "platform": "linux",
    "render_pipeline": { "id": "urp", "version": "17" }
  },
  "material_allowlist": ["standard"],
  "extension_allowlist": [],
  "named_anchors": [{ "name": "encounter-origin", "node": "encounter-origin" }],
  "bounds": { "minimum": [-1, 0, -1], "maximum": [1, 2, 1] },
  "provenance": {
    "source_receipt": { "...": "immutable source receipt" },
    "acceptance": {
      "source_sha256": "<64 lowercase hex>",
      "output_sha256": "<the artifact sha256>",
      "status": "accepted",
      "actor_kind": "automated_validator",
      "actor_id": "glb-importer-validator",
      "policy_id": "blender-export-v1",
      "accepted_at": "2026-09-08T20:00:00Z",
      "evidence": [
        { "evidence_id": "source-hash", "result": "passed" },
        { "evidence_id": "glb-structure", "result": "passed" },
        { "evidence_id": "glb-output-hash", "result": "passed" }
      ]
    },
    "converter": "AdapterName",
    "converted_at": "2026-09-08T20:00:00Z"
  },
  "fallback_module_ids": ["baseline-arena-body"]
}
```

The GLB is verified as glTF 2.0 with a matching header/output hash, a single
JSON chunk, no unknown chunks, no external buffers or images, and only allowed
material names and extensions. Declared anchors must name GLB nodes. The byte
cap is the stricter of the v1 host artifact limit and an optional target cap.

This sidecar does **not** create collision, navigation, hit volumes, attacks,
animation, AI, or an objective from visual data. `provides`, quality, conflicts,
and fallback IDs are explicit caller declarations; gameplay contracts require a
separate host-owned authoring and acceptance path.

When Build Room has selected an observed local Blender CLI candidate, its
consumer bridge writes a separate `unity-host-handoff.json` beside the immutable
asset manifest. That handoff resolves and re-hashes the GLB at a local `file:`
URI under an 8-second budget, but still records Unity host load and player
evidence as `not_observed`. See
[`unity-host-consumer.md`](unity-host-consumer.md).
