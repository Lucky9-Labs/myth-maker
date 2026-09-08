# GLB runtime assembly seam (`glb.assembly.v1`)

`glb.assembly.v1` (published as `GlbAssemblyManifest` v1) assembles many independently produced, already-accepted
`glb.v1` candidates into one immutable **loader-side runtime asset**. It does
not concatenate or re-export mesh buffers. Re-exporting would make the source
GLBs, their Blender receipts, material bindings, and motion provenance hard to
audit. Instead, a host loads each hash-addressed GLB as a child of the selected
root and applies the immutable attachment table. That is one coherent runtime
asset with explicit dependencies, not an opaque new source artifact.

The seam is intentionally encounter-generic. Example fragments happen to have
root and extension slots; no field, code path, or validator encodes an
encounter shape, creature, or genre.

## Closed fragment contract

Each fragment carries an exact `glb.v1` runtime candidate accepted by the
existing importer plus these assembly fields:

```json
{
  "fragment_id": "stable-id",
  "revision": 1,
  "runtime": { "module": { "...": "EncounterModule" }, "loaderProfile": { "...": "glb.v1" } },
  "coordinate_convention": {
    "handedness": "right",
    "up_axis": "y",
    "unit": "meter",
    "transforms": "parent-relative"
  },
  "sockets": [{
    "socket_id": "stable-id",
    "node": "checked-glb-anchor",
    "mode": "provide",
    "kind": "assembly.mount",
    "transform": {
      "translation": [0, 0, 0],
      "rotation": [0, 0, 0, 1],
      "scale": [1, 1, 1]
    }
  }],
  "material_slots": [{ "slot_id": "stable-id", "node": "checked-glb-anchor", "material": "standard" }],
  "markers": [{
    "marker_id": "stable-id",
    "node": "checked-glb-anchor",
    "kind": "collision",
    "shape": "box",
    "transform": { "translation": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] }
  }],
  "motion_binding": { "kind": "procedural", "contract": "motion.idle", "anchor_node": "checked-glb-anchor" },
  "provenance": {
    "producer": "worker-id",
    "created_at": "2026-09-08T20:00:00.000Z",
    "source_sha256": "the checked Blender source receipt SHA-256"
  }
}
```

`motion_binding` is alternatively a rig binding with one `skeleton_root` and
unique `joint_nodes`. Sockets, material slots, collision and critical-spot
markers, and motion nodes must all name anchors already checked in the
fragment's `glb.v1` profile. Material slots must use that profile's material
allowlist. Every transform uses a normalized quaternion and unit scale; this
rejects hidden conversion or parent-scale compensation.

The selected fragments must share exactly one GLB loader, platform, and render
pipeline target. Each attachment joins one `provide` socket to one `consume`
socket of the same semantic kind. The selected graph must be connected, have
one root, and give each non-root component exactly one parent.

## Determinism and partial-package behavior

The caller declares ordered-independent slots: primary fragment, optional
fallback fragment, and whether the slot is required. Validation rejects a bad
candidate locally. The assembler then selects primary, valid fallback, or (for
an optional slot) emits an explicit `missing_slots` entry. A required slot with
neither valid primary nor valid fallback fails closed.

The output sorts slots, attachments, missing slots, fallbacks, and rejection
reasons before SHA-256 hashing the exact manifest. Equal inputs therefore
produce the same frozen runtime plan regardless of fragment input order.

## Local proof

Run the focused executable proof:

```sh
node --test tests/test_glb_assembly_seam.mjs
npm run example:glb-assembly
```

The example writes three independently constructed, self-contained GLB files
to a temporary directory and prints their SHA-256 identities with the assembled
manifest. The tests prove the same three `glb.v1` fragment records are
assembled deterministically, records a malformed coordinate convention as a
rejection, selects a valid fallback, preserves an absent optional slot, and
fails closed for incompatible sockets or scale. It also asserts material slot,
collision marker, critical marker, rig/procedural-motion binding, and Blender
source-hash provenance in the composed output.

This is a local contract proof, not an assertion that the host game has loaded
the composite asset, accepted collision/critical gameplay, or run combat.
