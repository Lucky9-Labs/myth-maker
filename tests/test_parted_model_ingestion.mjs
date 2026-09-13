import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPartedModelImportManifest, inspectAnimatedPartedGlb, inspectPartedGlb } from "../src/parted-model-ingestion.js";

function glb(document) {
  let json = Buffer.from(JSON.stringify(document)); while (json.length % 4) json = Buffer.concat([json, Buffer.from(" ")]);
  const result = Buffer.alloc(20 + json.length);
  result.write("glTF", 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20);
  return result;
}

function binaryGlb(document, binary) {
  let json = Buffer.from(JSON.stringify(document)); while (json.length % 4) json = Buffer.concat([json, Buffer.from(" ")]);
  let bin = Buffer.from(binary); while (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(1)]);
  const result = Buffer.alloc(28 + json.length + bin.length);
  result.write("glTF", 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20);
  const binaryHeader = 20 + json.length;
  result.writeUInt32LE(bin.length, binaryHeader); result.writeUInt32LE(0x004e4942, binaryHeader + 4); bin.copy(result, binaryHeader + 8);
  return result;
}

function weldedGeometryFixture() {
  // Four triangles: two pairs share positions but use duplicate provider vertex
  // indexes. A topology-only union would incorrectly report four components.
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    1, 0, 0, 1, 1, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
    11, 0, 0, 11, 1, 0, 10, 1, 0,
  ]);
  const indices = new Uint16Array(Array.from({ length: 12 }, (_, index) => index));
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const primitive = { attributes: { POSITION: 0 }, indices: 1, material: 0 };
  const document = {
    asset: { version: "2.0", generator: "Tripo" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: "two-regions", mesh: 0 }, { name: "other", mesh: 1 }],
    meshes: [{ primitives: [primitive] }, { primitives: [primitive] }], materials: [{ name: "shell" }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 12, type: "VEC3", min: [0, 0, 0], max: [11, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 12, type: "SCALAR" },
    ],
  };
  return binaryGlb(document, binary);
}
function fixture() { return glb({ asset: { version: "2.0", generator: "Tripo" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "reef-root", children: [1, 2] }, { name: "body", mesh: 0 }, { name: "claw", mesh: 1 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 1 }, material: 1 }] }], accessors: [{ count: 6 }, { count: 9 }], materials: [{ name: "shell" }, { name: "claw" }] }); }

test("inspects independent Tripo nodes without segmentation", () => {
  const bytes = fixture(); const result = inspectPartedGlb(bytes);
  assert.equal(result.generator, "Tripo"); assert.equal(result.parts.length, 2); assert.equal(result.parts[0].name, "body");
  assert.deepEqual(result.topology, { vertices: 15, triangles: 5 }); assert.equal(result.suitability.rigging, "requires-rigging");
  assert.equal(result.source_sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("reports spatial bounds and welds duplicate face vertices into anatomical regions", () => {
  const result = inspectPartedGlb(weldedGeometryFixture());
  const geometry = result.parts[0].geometry;

  assert.deepEqual(geometry.local_bounds, { min: [0, 0, 0], max: [11, 1, 0], center: [5.5, 0.5, 0], size: [11, 1, 0] });
  assert.equal(geometry.weld_tolerance, 1e-5);
  assert.equal(geometry.connected_region_count, 2);
  assert.deepEqual(geometry.connected_regions.map((region) => region.triangles), [2, 2]);
  assert.deepEqual(geometry.connected_regions.map((region) => region.unique_positions), [4, 4]);
  assert.deepEqual(geometry.connected_regions.map((region) => region.local_bounds.center), [[0.5, 0.5, 0], [10.5, 0.5, 0]]);
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

test("accepts only the exact five clips with one transform track per retained part", () => {
  const nodes = [{ name: "reef-root", children: Array.from({ length: 15 }, (_, index) => index + 1) },
    ...Array.from({ length: 15 }, (_, index) => ({ name: `part-${index}`, mesh: index }))];
  const animations = ["idle", "walk", "run", "attack", "death"].map((name) => ({ name,
    channels: Array.from({ length: 15 }, (_, index) => ({ target: { node: index + 1, path: "rotation" }, sampler: index })),
    samplers: Array.from({ length: 15 }, () => ({ input: 15, output: 16 })) }));
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes: Array.from({ length: 15 }, (_, index) => ({ primitives: [{ attributes: { POSITION: index }, material: index }] })),
    accessors: [...Array.from({ length: 15 }, () => ({ count: 3 })), { count: 2 }, { count: 2 }],
    materials: Array.from({ length: 15 }, (_, index) => ({ name: `material-${index}` })), skins: [{}], animations };

  const result = inspectAnimatedPartedGlb(glb(document));

  assert.equal(result.parts, 15);
  assert.deepEqual(result.clips.map((clip) => clip.name), ["attack", "death", "idle", "run", "walk"]);
  assert.ok(result.clips.every((clip) => clip.part_track_count === 15));
  document.animations.pop();
  assert.throws(() => inspectAnimatedPartedGlb(glb(document)), /exact five clips/);
});
