import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGlbRuntimeAsset } from "../src/glb-assembly-seam.js";

const coordinate = { handedness: "right", up_axis: "y", unit: "meter", transforms: "parent-relative" };
const trs = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const outputDirectory = process.argv[2] || await mkdtemp(path.join(tmpdir(), "myth-maker-glb-assembly-proof-"));

const root = await createFragment(outputDirectory, "core", { sockets: [socket("body-socket", "provide")], markers: [marker("body-collider", "collision")], motion: { kind: "rig", skeleton_root: "rig-root", joint_nodes: ["rig-root", "joint-a"] } });
const extension = await createFragment(outputDirectory, "extension", { sockets: [socket("root-mount", "consume")], markers: [marker("impact-zone", "critical")], motion: { kind: "procedural", contract: "motion.sway", anchor_node: "motion-anchor" } });
const invalid = { ...await createFragment(outputDirectory, "invalid-extension", { sockets: [socket("root-mount", "consume")] }), coordinate_convention: { ...coordinate, unit: "centimeter" } };

const assembly = assembleGlbRuntimeAsset({
  assemblyId: "local-runtime-assembly", revision: 1, assembledAt: "2026-09-08T20:00:00.000Z", coordinateConvention: coordinate, rootSlotId: "root",
  slots: [
    { slot_id: "root", primary_fragment_id: "core", required: true },
    { slot_id: "extension", primary_fragment_id: "invalid-extension", fallback_fragment_id: "extension", required: true },
    { slot_id: "optional-detail", primary_fragment_id: "not-produced", required: false },
  ],
  fragments: [invalid, extension, root],
  attachments: [{ attachment_id: "extension-to-root", parent_slot_id: "root", parent_socket_id: "body-socket", child_slot_id: "extension", child_socket_id: "root-mount", required: true }],
});

console.log(JSON.stringify({
  evidence_scope: "local self-contained GLB fixture and deterministic assembly contract",
  artifact_directory: outputDirectory,
  generated_glb_artifacts: [root, extension, invalid].map((fragment) => ({ fragment_id: fragment.fragment_id, sha256: fragment.runtime.loaderProfile.artifact.sha256 })),
  selected_fragments: assembly.fragments.map(({ slot_id, fragment_id, selected_as }) => ({ slot_id, fragment_id, selected_as })),
  missing_slots: assembly.missing_slots,
  rejection_reasons: assembly.rejection_reasons,
  manifest_sha256: assembly.manifest_sha256,
  limitations: ["The fixture validates local GLB structure and assembly metadata; it does not run Blender, load the host game, or prove gameplay acceptance."],
}, null, 2));

async function createFragment(directory, id, { sockets = [], markers = [], motion = { kind: "procedural", contract: "motion.idle", anchor_node: "motion-anchor" } }) {
  const nodes = [...new Set(["material-anchor", ...sockets.map((entry) => entry.node), ...markers.map((entry) => entry.node), ...motionNodes(motion)])];
  const glb = createMinimalGlb(nodes);
  assertSelfContainedGlb(glb);
  await writeFile(path.join(directory, `${id}.glb`), glb);
  const outputHash = sha256(glb);
  const sourceHash = sha256(Buffer.from(`independent-source:${id}`));
  const artifact = { uri: `sha256:${outputHash}`, sha256: outputHash, media_type: "model/gltf-binary", byte_length: glb.length };
  return {
    fragment_id: id, revision: 1, coordinate_convention: coordinate,
    runtime: {
      module: { schema_version: "1", module_id: `${id}-module`, revision: 1, execution_kind: "runtime_asset", provides: ["encounter.body"], requires: ["encounter-module.v1"], conflicts: [], compatibility: { host_contract_version: "1", platforms: ["linux"], bindings: { gltf: "2.0", urp: "17" } }, quality: { tier: 1, score: 1 }, artifact, fallback_module_ids: [], provenance: { producer: "local-proof", created_at: "2026-09-08T20:00:00.000Z", parent_module_ids: [], label: id } },
      loaderProfile: { profile: "glb.v1", artifact, byte_cap: 4096, loader: { id: "gltf", version: "2.0" }, target: { platform: "linux", render_pipeline: { id: "urp", version: "17" } }, material_allowlist: ["standard"], extension_allowlist: [], named_anchors: nodes.map((node) => ({ name: node, node })), bounds: { minimum: [-1, -1, -1], maximum: [1, 1, 1] }, provenance: { source_receipt: { work_id: `${id}-work`, worker_id: "local-proof", created_at: "2026-09-08T20:00:00.000Z", native_name: `${id}-work.blend`, artifact: { uri: `sha256:${sourceHash}`, sha256: sourceHash, media_type: "application/x-blender", byte_length: 1 }, parent_module_ids: [] }, acceptance: { source_sha256: sourceHash, output_sha256: outputHash, status: "accepted", actor_kind: "automated_validator", actor_id: "glb-importer-validator", policy_id: "blender-export-v1", accepted_at: "2026-09-08T20:00:00.000Z", evidence: [{ evidence_id: "source-hash", result: "passed" }, { evidence_id: "glb-structure", result: "passed" }, { evidence_id: "glb-output-hash", result: "passed" }] }, converter: "LocalFixtureGenerator", converted_at: "2026-09-08T20:00:00.000Z" }, fallback_module_ids: [] },
    },
    sockets, material_slots: [{ slot_id: "surface", node: "material-anchor", material: "standard" }], markers, motion_binding: motion,
    provenance: { producer: "local-proof", created_at: "2026-09-08T20:00:00.000Z", source_sha256: sourceHash },
  };
}

function createMinimalGlb(nodes) {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: nodes.map((_, index) => index) }], scene: 0, nodes: nodes.map((name) => ({ name })), materials: [{ name: "standard" }] }));
  const padding = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
  const chunk = Buffer.concat([json, padding]);
  const header = Buffer.alloc(12);
  header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + chunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4E4F534A, 4);
  return Buffer.concat([header, chunkHeader, chunk]);
}

function assertSelfContainedGlb(bytes) {
  if (bytes.subarray(0, 4).toString() !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error("fixture GLB header is invalid");
  const length = bytes.readUInt32LE(12); const kind = bytes.readUInt32LE(16);
  if (kind !== 0x4E4F534A || 20 + length !== bytes.length) throw new Error("fixture GLB has an invalid JSON chunk");
  const document = JSON.parse(bytes.subarray(20).toString("utf8").trim());
  if (document.asset?.version !== "2.0" || document.buffers || document.images || document.materials?.some((material) => material.name !== "standard")) throw new Error("fixture GLB is not a self-contained standard-material document");
}

function socket(socket_id, mode) { return { socket_id, node: socket_id, mode, kind: "assembly.mount", transform: trs }; }
function marker(marker_id, kind) { return { marker_id, node: marker_id, kind, shape: "sphere", transform: trs }; }
function motionNodes(motion) { return motion.kind === "rig" ? [motion.skeleton_root, ...motion.joint_nodes] : [motion.anchor_node]; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
