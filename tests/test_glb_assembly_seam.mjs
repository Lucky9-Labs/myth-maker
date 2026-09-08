import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { assembleGlbRuntimeAsset } from "../src/glb-assembly-seam.js";

const coordinate = { handedness: "right", up_axis: "y", unit: "meter", transforms: "parent-relative" };
const trs = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

test("deterministically composes independent fragments and uses an accepted fallback for an incompatible candidate", () => {
  const root = fragment("core", { sockets: [socket("body-socket", "provide", "assembly.mount")] });
  const fallback = fragment("extension-baseline", {
    sockets: [socket("root-mount", "consume", "assembly.mount")],
    markers: [marker("impact-zone", "critical")],
    motion: { kind: "procedural", contract: "motion.sway", anchor_node: "motion-anchor" },
  });
  const incompatible = { ...fragment("extension-candidate", { sockets: [socket("root-mount", "consume", "assembly.mount")] }), coordinate_convention: { ...coordinate, unit: "centimeter" } };
  const input = assemblyInput({ fragments: [incompatible, fallback, root] });
  const one = assembleGlbRuntimeAsset(input);
  const two = assembleGlbRuntimeAsset({ ...input, fragments: [root, incompatible, fallback] });

  assert.equal(one.profile, "glb.assembly.v1");
  assert.equal(one.manifest_sha256, two.manifest_sha256);
  assert.deepEqual(one.fragments.map(({ slot_id, fragment_id, selected_as }) => ({ slot_id, fragment_id, selected_as })), [
    { slot_id: "extension", fragment_id: "extension-baseline", selected_as: "fallback" },
    { slot_id: "root", fragment_id: "core", selected_as: "primary" },
  ]);
  assert.deepEqual(one.missing_slots, [{ slot_id: "optional-detail", reason: "primary fragment missing-detail is absent or invalid" }]);
  assert.deepEqual(one.fallback_provenance, { used_fallback: true, slot_ids: ["extension"] });
  assert.match(one.rejection_reasons[0].reasons[0], /coordinate_convention\.unit/);
  assert.deepEqual(one.attachments, [{
    attachment_id: "extension-to-root", parent_slot_id: "root", parent_fragment_id: "core", parent_socket_id: "body-socket",
    child_slot_id: "extension", child_fragment_id: "extension-baseline", child_socket_id: "root-mount", socket_kind: "assembly.mount",
  }]);
  assert.ok(Object.isFrozen(one));
});

test("keeps material, collision/critical markers, rig binding, and checked Blender provenance in the assembled runtime asset", () => {
  const root = fragment("core", {
    sockets: [socket("body-socket", "provide", "assembly.mount")],
    markers: [marker("body-collider", "collision")],
    motion: { kind: "rig", skeleton_root: "rig-root", joint_nodes: ["rig-root", "joint-a"] },
  });
  const extension = fragment("extension", { sockets: [socket("root-mount", "consume", "assembly.mount")] });
  const result = assembleGlbRuntimeAsset(assemblyInput({ fragments: [extension, root], extensionPrimary: "extension" }));
  const rootResult = result.fragments.find((entry) => entry.slot_id === "root");
  assert.deepEqual(rootResult.material_slots, [{ slot_id: "surface", node: "material-anchor", material: "standard" }]);
  assert.equal(rootResult.markers[0].kind, "collision");
  assert.deepEqual(rootResult.motion_binding, { kind: "rig", skeleton_root: "rig-root", joint_nodes: ["rig-root", "joint-a"] });
  assert.equal(rootResult.provenance.source_sha256, sourceHash("core"));
  assert.equal(result.fallback_provenance.used_fallback, false);
});

test("fails closed when a selected component cannot make one valid connected asset", () => {
  const root = fragment("core", { sockets: [socket("body-socket", "provide", "assembly.mount")] });
  const extension = fragment("extension", { sockets: [socket("root-mount", "consume", "assembly.other")] });
  assert.throws(() => assembleGlbRuntimeAsset(assemblyInput({ fragments: [root, extension], extensionPrimary: "extension" })), /incompatible socket kinds/);

  const scaled = fragment("extension-baseline", { sockets: [socket("root-mount", "consume", "assembly.mount", { ...trs, scale: [2, 1, 1] })] });
  assert.throws(() => assembleGlbRuntimeAsset(assemblyInput({ fragments: [root, scaled] })), /required slot extension has no valid/);
});

function assemblyInput({ fragments, extensionPrimary = "extension-candidate" }) {
  return {
    assemblyId: "runtime-assembly", revision: 1, assembledAt: "2026-09-08T20:00:00.000Z", coordinateConvention: coordinate, rootSlotId: "root",
    slots: [
      { slot_id: "root", primary_fragment_id: "core", required: true },
      { slot_id: "extension", primary_fragment_id: extensionPrimary, fallback_fragment_id: "extension-baseline", required: true },
      { slot_id: "optional-detail", primary_fragment_id: "missing-detail", required: false },
    ],
    fragments,
    attachments: [{ attachment_id: "extension-to-root", parent_slot_id: "root", parent_socket_id: "body-socket", child_slot_id: "extension", child_socket_id: "root-mount", required: true }],
  };
}

function fragment(id, { sockets = [], markers = [], motion = { kind: "procedural", contract: "motion.idle", anchor_node: "motion-anchor" } } = {}) {
  const artifactSha = hash(`runtime:${id}`);
  const sourceSha = sourceHash(id);
  const anchors = [...new Set(["material-anchor", "motion-anchor", "rig-root", "joint-a", ...sockets.map((entry) => entry.node), ...markers.map((entry) => entry.node), ...motionNodes(motion)])];
  const artifact = { uri: `sha256:${artifactSha}`, sha256: artifactSha, media_type: "model/gltf-binary", byte_length: 128 };
  return {
    fragment_id: id, revision: 1, coordinate_convention: coordinate,
    runtime: {
      module: {
        schema_version: "1", module_id: `${id}-module`, revision: 1, execution_kind: "runtime_asset", provides: ["encounter.body"], requires: ["encounter-module.v1"], conflicts: [],
        compatibility: { host_contract_version: "1", platforms: ["linux"], bindings: { gltf: "2.0", urp: "17" } }, quality: { tier: 1, score: 1 }, artifact, fallback_module_ids: [],
        provenance: { producer: "fixture-worker", created_at: "2026-09-08T20:00:00.000Z", parent_module_ids: [], label: id },
      },
      loaderProfile: {
        profile: "glb.v1", artifact, byte_cap: 4096, loader: { id: "gltf", version: "2.0" }, target: { platform: "linux", render_pipeline: { id: "urp", version: "17" } },
        material_allowlist: ["standard"], extension_allowlist: [], named_anchors: anchors.map((node) => ({ name: node, node })), bounds: { minimum: [-1, -1, -1], maximum: [1, 1, 1] },
        provenance: {
          source_receipt: { work_id: `${id}-work`, worker_id: "fixture-worker", created_at: "2026-09-08T20:00:00.000Z", native_name: `${id}-work.blend`, artifact: { uri: `sha256:${sourceSha}`, sha256: sourceSha, media_type: "application/x-blender", byte_length: 64 }, parent_module_ids: [] },
          acceptance: { source_sha256: sourceSha, output_sha256: artifactSha, status: "accepted", actor_kind: "automated_validator", actor_id: "glb-importer-validator", policy_id: "blender-export-v1", accepted_at: "2026-09-08T20:00:00.000Z", evidence: [{ evidence_id: "source-hash", result: "passed" }, { evidence_id: "glb-structure", result: "passed" }, { evidence_id: "glb-output-hash", result: "passed" }] },
          converter: "FixtureBlender", converted_at: "2026-09-08T20:00:00.000Z",
        },
        fallback_module_ids: [],
      },
    },
    sockets, material_slots: [{ slot_id: "surface", node: "material-anchor", material: "standard" }], markers, motion_binding: motion,
    provenance: { producer: "fixture-worker", created_at: "2026-09-08T20:00:00.000Z", source_sha256: sourceSha },
  };
}

function socket(socket_id, mode, kind, transform = trs) { return { socket_id, node: socket_id, mode, kind, transform }; }
function marker(marker_id, kind) { return { marker_id, node: marker_id, kind, shape: "sphere", transform: trs }; }
function motionNodes(motion) { return motion.kind === "rig" ? [motion.skeleton_root, ...motion.joint_nodes] : [motion.anchor_node]; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function sourceHash(id) { return hash(`source:${id}`); }
