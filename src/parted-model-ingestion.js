import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Inspect the *source* GLB emitted by a parted-model provider.  This is a
 * provenance and compatibility boundary: it deliberately does not try to
 * segment a monolithic mesh or invent gameplay/rig semantics.
 */
export function inspectPartedGlb(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 20) throw new TypeError("GLB bytes are required");
  const { document, binaryBytes, binaryChunk } = parseGlb(bytes);
  if (document.asset?.version !== "2.0") throw new TypeError("only glTF 2.0 is supported");
  if (!Array.isArray(document.nodes) || !Array.isArray(document.meshes)) throw new TypeError("GLB must contain nodes and meshes");

  const parents = parentIndexes(document.nodes);
  const materials = (document.materials || []).map((material, index) => ({ index, name: material.name || `material-${index}` }));
  const parts = document.nodes.flatMap((node, nodeIndex) => {
    if (!Number.isInteger(node.mesh)) return [];
    const mesh = document.meshes[node.mesh];
    if (!mesh || !Array.isArray(mesh.primitives) || mesh.primitives.length !== 1) throw new TypeError(`node ${nodeIndex} must have exactly one primitive`);
    const primitiveStats = mesh.primitives.map((primitive, primitiveIndex) => primitiveInspection(document, binaryChunk, primitive, primitiveIndex));
    return [{
      node_index: nodeIndex,
      name: node.name || `part-${nodeIndex}`,
      parent_index: parents.get(nodeIndex) ?? null,
      mesh_index: node.mesh,
      primitive_count: primitiveStats.length,
      material_indexes: [...new Set(primitiveStats.flatMap((item) => item.material_index === null ? [] : [item.material_index]))],
      topology: sumTopology(primitiveStats),
      ...(primitiveStats[0].geometry ? { geometry: primitiveStats[0].geometry } : {}),
      transform: normalizedTransform(node),
    }];
  });
  const uniqueMeshes = new Set(parts.map((part) => part.mesh_index));
  const roots = document.scenes?.[document.scene ?? 0]?.nodes ?? [];
  const hasPartMaterials = parts.every((part) => part.material_indexes.length > 0);
  const inspection = {
    schema_version: "parted-model-inspection.v1",
    source_sha256: sha256(bytes),
    byte_length: bytes.byteLength,
    generator: document.asset.generator || "unknown",
    scene_root_nodes: roots,
    parts,
    materials,
    topology: sumTopology(parts.map((part) => part.topology)),
    source_features: {
      skins: document.skins?.length || 0,
      animations: document.animations?.length || 0,
      embedded_binary_bytes: binaryBytes,
      extensions_used: document.extensionsUsed || [],
    },
    suitability: {
      parted_model: parts.length >= 2 && uniqueMeshes.size === parts.length,
      distinct_meshes: uniqueMeshes.size === parts.length,
      material_bound_parts: hasPartMaterials,
      rigging: document.skins?.length ? "already-rigged" : "requires-rigging",
      reason: "Each provider part is retained as a source node; no mesh segmentation is performed.",
    },
  };
  validatePartedModelInspection(inspection);
  return inspection;
}

/** Verify the closed runtime-animation contract on an exported parted GLB. */
export function inspectAnimatedPartedGlb(bytes) {
  const inspection = inspectPartedGlb(bytes);
  const { document } = parseGlb(bytes);
  const expected = ["attack", "death", "idle", "run", "walk"];
  const animations = Array.isArray(document.animations) ? document.animations : [];
  const names = animations.map((animation) => animation.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new TypeError("animated GLB must contain the exact five clips");
  if ((document.skins?.length || 0) !== 1 || (document.scenes?.[document.scene ?? 0]?.nodes || []).length !== 1) {
    throw new TypeError("animated GLB must contain one rig and one scene root");
  }
  const sceneRoots = new Set(document.scenes?.[document.scene ?? 0]?.nodes || []);
  const clips = animations.map((animation) => {
    const channels = Array.isArray(animation.channels) ? animation.channels : [];
    const targets = channels.map((channel) => channel.target || {});
    if (channels.length !== inspection.parts.length
        || targets.some((target) => !Number.isInteger(target.node) || sceneRoots.has(target.node)
          || !["translation", "rotation", "scale"].includes(target.path))
        || new Set(targets.map((target) => target.node)).size !== inspection.parts.length) {
      throw new TypeError(`clip ${animation.name || "unnamed"} must have one transform track per retained part`);
    }
    return { name: animation.name, part_track_count: channels.length };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { schema_version: "parted-model-animation-inspection.v1", source_sha256: inspection.source_sha256,
    parts: inspection.parts.length, rig_count: document.skins.length, clips };
}

/** Create the immutable ingress record consumed by the animation pipeline. */
export function createPartedModelImportManifest({ model_id, source_path, inspection, imported_at, provider = "tripo" } = {}) {
  if (!ID.test(model_id || "")) throw new TypeError("model_id must be a stable id");
  if (typeof source_path !== "string" || !source_path || source_path.startsWith("/") || source_path.includes("..")) throw new TypeError("source_path must be a safe repository-relative path");
  if (!Number.isFinite(Date.parse(imported_at || ""))) throw new TypeError("imported_at must be an ISO timestamp");
  if (provider !== "tripo") throw new TypeError("only the explicit tripo parted-model contract is accepted");
  validatePartedModelInspection(inspection);
  return Object.freeze({
    schema_version: "parted-model-import.v1",
    model_id,
    provider,
    imported_at,
    source: { path: source_path, sha256: inspection.source_sha256, byte_length: inspection.byte_length, media_type: "model/gltf-binary" },
    contract: { kind: "already-parted-model", segmentation: "forbidden", preserve_part_nodes: true },
    inspection,
  });
}

export function validatePartedModelInspection(value) {
  if (!value || value.schema_version !== "parted-model-inspection.v1" || !SHA256.test(value.source_sha256 || "")
    || !Number.isInteger(value.byte_length) || value.byte_length < 20 || !Array.isArray(value.parts) || value.parts.length < 2
    || !Array.isArray(value.materials) || !value.suitability?.parted_model || !value.suitability?.distinct_meshes
    || !value.suitability?.material_bound_parts || !["requires-rigging", "already-rigged"].includes(value.suitability?.rigging)) {
    throw new TypeError("inspection does not satisfy the already-parted model contract");
  }
  const names = new Set(); const meshes = new Set();
  for (const part of value.parts) {
    if (!Number.isInteger(part.node_index) || !Number.isInteger(part.mesh_index) || typeof part.name !== "string" || !part.name
      || names.has(part.name) || meshes.has(part.mesh_index) || !Array.isArray(part.material_indexes) || part.material_indexes.length === 0
      || !validTopology(part.topology) || !validTransform(part.transform)) throw new TypeError("part record is invalid or not independently addressable");
    names.add(part.name); meshes.add(part.mesh_index);
  }
  return value;
}

function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new TypeError("invalid GLB header");
  let offset = 12; let json; let binaryBytes = 0; let binaryChunk;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new TypeError("invalid GLB chunk");
    const length = view.getUint32(offset, true); const type = view.getUint32(offset + 4, true); offset += 8;
    if (offset + length > bytes.byteLength) throw new TypeError("invalid GLB chunk length");
    if (type === 0x4e4f534a) { if (json) throw new TypeError("GLB has multiple JSON chunks"); json = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + length)).trim()); }
    else if (type === 0x004e4942) {
      if (binaryChunk) throw new TypeError("GLB has multiple BIN chunks");
      binaryChunk = bytes.subarray(offset, offset + length); binaryBytes += length;
    }
    else throw new TypeError("unsupported GLB chunk");
    offset += length;
  }
  if (!json) throw new TypeError("GLB has no JSON chunk");
  return { document: json, binaryBytes, binaryChunk };
}

function primitiveInspection(document, binaryChunk, primitive, primitiveIndex) {
  if ((primitive.mode ?? 4) !== 4 || !Number.isInteger(primitive.attributes?.POSITION)) throw new TypeError(`primitive ${primitiveIndex} is not a triangle mesh with POSITION`);
  const vertex = document.accessors?.[primitive.attributes.POSITION];
  const index = Number.isInteger(primitive.indices) ? document.accessors?.[primitive.indices] : undefined;
  if (!vertex || !Number.isInteger(vertex.count) || vertex.count < 3 || (index && (!Number.isInteger(index.count) || index.count % 3 !== 0))) throw new TypeError(`primitive ${primitiveIndex} has invalid topology`);
  if (primitive.material !== undefined && (!Number.isInteger(primitive.material) || primitive.material < 0 || primitive.material >= (document.materials?.length ?? 0))) throw new TypeError(`primitive ${primitiveIndex} has invalid material`);
  const geometry = binaryChunk ? inspectPrimitiveGeometry(document, binaryChunk, primitive) : undefined;
  return { material_index: primitive.material ?? null, vertices: vertex.count, triangles: (index?.count ?? vertex.count) / 3, ...(geometry ? { geometry } : {}) };
}

function inspectPrimitiveGeometry(document, binaryChunk, primitive) {
  const positions = readAccessor(document, binaryChunk, primitive.attributes.POSITION, "VEC3", [5126]);
  const indexes = Number.isInteger(primitive.indices)
    ? readAccessor(document, binaryChunk, primitive.indices, "SCALAR", [5121, 5123, 5125]).map((value) => value[0])
    : Array.from({ length: positions.length }, (_, index) => index);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= positions.length)) throw new TypeError("primitive index is out of bounds");

  const tolerance = 1e-5;
  const keyFor = (position) => position.map((value) => Math.round(value / tolerance)).join(":");
  const canonical = new Map();
  const triangleKeys = [];
  for (let offset = 0; offset < indexes.length; offset += 3) {
    const keys = indexes.slice(offset, offset + 3).map((index) => {
      const position = positions[index]; const key = keyFor(position);
      if (!canonical.has(key)) canonical.set(key, position);
      return key;
    });
    triangleKeys.push(keys);
  }

  const parent = new Map([...canonical.keys()].map((key) => [key, key]));
  const find = (key) => { let root = key; while (parent.get(root) !== root) root = parent.get(root); while (key !== root) { const next = parent.get(key); parent.set(key, root); key = next; } return root; };
  const union = (left, right) => { const leftRoot = find(left); const rightRoot = find(right); if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot); };
  triangleKeys.forEach(([first, second, third]) => { union(first, second); union(first, third); });

  const regions = new Map();
  canonical.forEach((position, key) => {
    const root = find(key); if (!regions.has(root)) regions.set(root, { positions: [], triangles: 0 }); regions.get(root).positions.push(position);
  });
  triangleKeys.forEach(([key]) => { regions.get(find(key)).triangles += 1; });
  const connectedRegions = [...regions.values()].map((region) => ({
    triangles: region.triangles,
    unique_positions: region.positions.length,
    local_bounds: bounds(region.positions),
  })).sort((left, right) => right.triangles - left.triangles || compareVectors(left.local_bounds.center, right.local_bounds.center));
  return {
    local_bounds: bounds(positions),
    weld_tolerance: tolerance,
    connected_region_count: connectedRegions.length,
    connected_regions: connectedRegions,
  };
}

function readAccessor(document, binaryChunk, accessorIndex, expectedType, allowedComponentTypes) {
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== expectedType || !allowedComponentTypes.includes(accessor.componentType) || accessor.sparse) throw new TypeError(`accessor ${accessorIndex} is unsupported`);
  const view = document.bufferViews?.[accessor.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) throw new TypeError(`accessor ${accessorIndex} must use the embedded GLB buffer`);
  const components = expectedType === "VEC3" ? 3 : 1;
  const componentBytes = new Map([[5121, 1], [5123, 2], [5125, 4], [5126, 4]]).get(accessor.componentType);
  const elementBytes = components * componentBytes; const stride = view.byteStride ?? elementBytes;
  if (stride < elementBytes || stride % componentBytes !== 0) throw new TypeError(`accessor ${accessorIndex} has invalid stride`);
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = start + (accessor.count - 1) * stride + elementBytes;
  if (!Number.isInteger(accessor.count) || accessor.count < 1 || start < 0 || end > binaryChunk.byteLength || end > (view.byteOffset ?? 0) + view.byteLength) throw new TypeError(`accessor ${accessorIndex} exceeds its buffer view`);
  const data = new DataView(binaryChunk.buffer, binaryChunk.byteOffset, binaryChunk.byteLength);
  const read = accessor.componentType === 5121 ? (offset) => data.getUint8(offset)
    : accessor.componentType === 5123 ? (offset) => data.getUint16(offset, true)
      : accessor.componentType === 5125 ? (offset) => data.getUint32(offset, true)
        : (offset) => data.getFloat32(offset, true);
  return Array.from({ length: accessor.count }, (_, index) => Array.from({ length: components }, (_unused, component) => read(start + index * stride + component * componentBytes)));
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((position) => position.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); }));
  const clean = (value) => Object.is(value, -0) ? 0 : value;
  return { min: min.map(clean), max: max.map(clean), center: min.map((value, axis) => clean((value + max[axis]) / 2)), size: min.map((value, axis) => clean(max[axis] - value)) };
}
function compareVectors(left, right) { for (let axis = 0; axis < left.length; axis += 1) { if (left[axis] !== right[axis]) return left[axis] - right[axis]; } return 0; }

function parentIndexes(nodes) {
  const result = new Map();
  nodes.forEach((node, index) => (node.children || []).forEach((child) => {
    if (!Number.isInteger(child) || child < 0 || child >= nodes.length || result.has(child)) throw new TypeError(`invalid parent for node ${index}`);
    result.set(child, index);
  }));
  const visiting = new Set(); const visited = new Set();
  const visit = (index) => {
    if (visiting.has(index)) throw new TypeError("provider node hierarchy is cyclic");
    if (visited.has(index)) return;
    visiting.add(index); for (const child of nodes[index].children || []) visit(child); visiting.delete(index); visited.add(index);
  };
  nodes.forEach((_, index) => visit(index));
  return result;
}
function normalizedTransform(node) { return { translation: node.translation || [0, 0, 0], rotation: node.rotation || [0, 0, 0, 1], scale: node.scale || [1, 1, 1] }; }
function validTransform(value) { return value && [value.translation, value.rotation, value.scale].every(Array.isArray) && value.translation.length === 3 && value.rotation.length === 4 && value.scale.length === 3 && [...value.translation, ...value.rotation, ...value.scale].every(Number.isFinite); }
function sumTopology(values) { return values.reduce((total, value) => ({ vertices: total.vertices + value.vertices, triangles: total.triangles + value.triangles }), { vertices: 0, triangles: 0 }); }
function validTopology(value) { return value && Number.isInteger(value.vertices) && value.vertices >= 3 && Number.isInteger(value.triangles) && value.triangles >= 1; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
