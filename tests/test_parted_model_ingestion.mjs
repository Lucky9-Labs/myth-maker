import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPartedModelImportManifest, inspectPartedGlb } from "../src/parted-model-ingestion.js";

function glb(document) {
  let json = Buffer.from(JSON.stringify(document)); while (json.length % 4) json = Buffer.concat([json, Buffer.from(" ")]);
  const result = Buffer.alloc(20 + json.length);
  result.write("glTF", 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20);
  return result;
}
function fixture() { return glb({ asset: { version: "2.0", generator: "Tripo" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "reef-root", children: [1, 2] }, { name: "body", mesh: 0 }, { name: "claw", mesh: 1 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 1 }, material: 1 }] }], accessors: [{ count: 6 }, { count: 9 }], materials: [{ name: "shell" }, { name: "claw" }] }); }

test("inspects independent Tripo nodes without segmentation", () => {
  const bytes = fixture(); const result = inspectPartedGlb(bytes);
  assert.equal(result.generator, "Tripo"); assert.equal(result.parts.length, 2); assert.equal(result.parts[0].name, "body");
  assert.deepEqual(result.topology, { vertices: 15, triangles: 5 }); assert.equal(result.suitability.rigging, "requires-rigging");
  assert.equal(result.source_sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("creates a hash-bound, no-segmentation import manifest", () => {
  const inspection = inspectPartedGlb(fixture());
  const manifest = createPartedModelImportManifest({ model_id: "reef-skitter", source_path: "assets/reef-skitter/source/reef_skitter.tripo.glb", inspection, imported_at: "2026-09-12T22:00:00.000Z" });
  assert.equal(manifest.contract.segmentation, "forbidden"); assert.equal(manifest.contract.preserve_part_nodes, true); assert.equal(manifest.source.sha256, inspection.source_sha256);
});

test("rejects a monolithic or material-less source", () => {
  const bytes = glb({ asset: { version: "2.0" }, nodes: [{ name: "only", mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ count: 3 }] });
  assert.throws(() => inspectPartedGlb(bytes), /already-parted/);
});

test("rejects provider parts whose material binding does not resolve", () => {
  const document = { asset: { version: "2.0" }, nodes: [{ name: "a", mesh: 0 }, { name: "b", mesh: 1 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 1 }, material: 4 }] }], accessors: [{ count: 3 }, { count: 3 }], materials: [{ name: "only-real-material" }] };
  assert.throws(() => inspectPartedGlb(glb(document)), /material/);
});

test("rejects cyclic provider node hierarchies", () => {
  const document = { asset: { version: "2.0" }, nodes: [{ name: "a", mesh: 0, children: [1] }, { name: "b", mesh: 1, children: [0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 1 }, material: 0 }] }], accessors: [{ count: 3 }, { count: 3 }], materials: [{ name: "shell" }] };
  assert.throws(() => inspectPartedGlb(glb(document)), /cyclic/);
});

test("enforces one independently animated primitive and material per provider part", () => {
  const document = { asset: { version: "2.0" }, nodes: [{ name: "a", mesh: 0 }, { name: "b", mesh: 1 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 1 }, material: 1 }] }, { primitives: [{ attributes: { POSITION: 2 }, material: 2 }] }], accessors: [{ count: 3 }, { count: 3 }, { count: 3 }], materials: [{}, {}, {}] };
  assert.throws(() => inspectPartedGlb(glb(document)), /exactly one primitive/);
});
