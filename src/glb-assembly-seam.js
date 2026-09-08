import { createHash } from "node:crypto";

import { ingestGlbRuntimeCandidate } from "./glb-runtime-candidate-ingress.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const COORDINATE_CONVENTION = Object.freeze({ handedness: "right", up_axis: "y", unit: "meter", transforms: "parent-relative" });

/**
 * Compose independently validated GLB components into one immutable runtime
 * assembly. The output is a loader-side composite asset: it deliberately keeps
 * every source GLB hash-addressed instead of rewriting mesh buffers, textures,
 * or animation channels into an opaque derived binary. The host loads the
 * root fragment and applies the deterministic attachment table as its scene
 * graph. There is no encounter- or creature-specific meaning in this format.
 */
export function assembleGlbRuntimeAsset({
  assemblyId,
  revision,
  assembledAt,
  coordinateConvention,
  rootSlotId,
  slots,
  fragments,
  attachments,
}) {
  assertId(assemblyId, "assemblyId");
  assertPositiveInteger(revision, "revision");
  assertTimestamp(assembledAt, "assembledAt");
  assertExact(coordinateConvention, COORDINATE_CONVENTION, "coordinateConvention");
  assertId(rootSlotId, "rootSlotId");
  if (!Array.isArray(slots) || !slots.length) throw new TypeError("slots must contain at least one slot");
  if (!Array.isArray(fragments)) throw new TypeError("fragments must be an array");
  if (!Array.isArray(attachments)) throw new TypeError("attachments must be an array");

  const checkedSlots = slots.map(validateSlot);
  assertUnique(checkedSlots.map((slot) => slot.slot_id), "slot_id");
  const slotById = new Map(checkedSlots.map((slot) => [slot.slot_id, slot]));
  if (!slotById.has(rootSlotId)) throw new TypeError("rootSlotId must name a slot");

  const fragmentResults = fragments.map(checkFragment);
  const fragmentIds = fragments.filter((fragment) => fragment && typeof fragment === "object").map((fragment) => fragment.fragment_id);
  assertUnique(fragmentIds.filter((id) => typeof id === "string"), "fragment_id");
  const validFragments = new Map();
  const rejections = [];
  for (const result of fragmentResults) {
    if (result.ok) validFragments.set(result.fragment.fragment_id, result.fragment);
    else rejections.push({ fragment_id: result.fragmentId, reasons: [result.reason] });
  }

  const selected = new Map();
  const missingSlots = [];
  const fallbackSlotIds = [];
  for (const slot of [...checkedSlots].sort(compareById("slot_id"))) {
    const primary = validFragments.get(slot.primary_fragment_id);
    const fallback = slot.fallback_fragment_id ? validFragments.get(slot.fallback_fragment_id) : undefined;
    if (primary) {
      selected.set(slot.slot_id, { slot, fragment: primary, selected_as: "primary" });
    } else if (fallback) {
      selected.set(slot.slot_id, { slot, fragment: fallback, selected_as: "fallback" });
      fallbackSlotIds.push(slot.slot_id);
    } else {
      const reason = primary ? "unreachable" : `primary fragment ${slot.primary_fragment_id} is absent or invalid`;
      if (slot.required) throw new TypeError(`required slot ${slot.slot_id} has no valid primary or fallback fragment: ${reason}`);
      missingSlots.push({ slot_id: slot.slot_id, reason });
    }
  }
  if (!selected.has(rootSlotId)) throw new TypeError("root slot must select a valid fragment");
  assertTargetCompatibility([...selected.values()].map((entry) => entry.fragment));

  const checkedAttachments = attachments.map(validateAttachment);
  assertUnique(checkedAttachments.map((attachment) => attachment.attachment_id), "attachment_id");
  const resolvedAttachments = [];
  const incoming = new Map();
  for (const attachment of [...checkedAttachments].sort(compareById("attachment_id"))) {
    const parent = selected.get(attachment.parent_slot_id);
    const child = selected.get(attachment.child_slot_id);
    if (!parent || !child) {
      if (attachment.required) throw new TypeError(`required attachment ${attachment.attachment_id} has an unselected endpoint`);
      continue;
    }
    if (attachment.child_slot_id === rootSlotId) throw new TypeError("root slot cannot be attached as a child");
    const parentSocket = socketFor(parent.fragment, attachment.parent_socket_id, "provide");
    const childSocket = socketFor(child.fragment, attachment.child_socket_id, "consume");
    if (parentSocket.kind !== childSocket.kind) throw new TypeError(`attachment ${attachment.attachment_id} joins incompatible socket kinds`);
    if (incoming.has(attachment.child_slot_id)) throw new TypeError(`selected child slot ${attachment.child_slot_id} has multiple attachments`);
    incoming.set(attachment.child_slot_id, attachment.attachment_id);
    resolvedAttachments.push({
      attachment_id: attachment.attachment_id,
      parent_slot_id: attachment.parent_slot_id,
      parent_fragment_id: parent.fragment.fragment_id,
      parent_socket_id: parentSocket.socket_id,
      child_slot_id: attachment.child_slot_id,
      child_fragment_id: child.fragment.fragment_id,
      child_socket_id: childSocket.socket_id,
      socket_kind: parentSocket.kind,
    });
  }
  for (const slotId of selected.keys()) {
    if (slotId !== rootSlotId && !incoming.has(slotId)) throw new TypeError(`selected non-root slot ${slotId} has no attachment`);
  }
  assertConnected(rootSlotId, selected, resolvedAttachments);

  const selectedFragments = [...selected.values()]
    .sort((a, b) => a.slot.slot_id.localeCompare(b.slot.slot_id))
    .map(({ slot, fragment, selected_as }) => ({
      slot_id: slot.slot_id,
      fragment_id: fragment.fragment_id,
      revision: fragment.revision,
      selected_as,
      runtime_artifact: fragment.runtime.loader_profile.artifact,
      runtime_linkage_sha256: fragment.runtime.linkage_sha256,
      material_slots: fragment.material_slots.map((slot) => ({ ...slot })),
      markers: fragment.markers.map((marker) => ({ ...marker, transform: clone(marker.transform) })),
      motion_binding: clone(fragment.motion_binding),
      provenance: clone(fragment.provenance),
    }));
  const manifest = {
    schema_version: "1",
    profile: "glb.assembly.v1",
    assembly_id: assemblyId,
    revision,
    assembled_at: assembledAt,
    coordinate_convention: clone(COORDINATE_CONVENTION),
    runtime_target: targetFor(selected.get(rootSlotId).fragment),
    root_slot_id: rootSlotId,
    fragments: selectedFragments,
    attachments: resolvedAttachments,
    missing_slots: missingSlots.sort(compareById("slot_id")),
    fallback_provenance: { used_fallback: fallbackSlotIds.length > 0, slot_ids: fallbackSlotIds.sort() },
    rejection_reasons: rejections.sort(compareById("fragment_id")),
  };
  return deepFreeze({ ...manifest, manifest_sha256: sha256(manifest) });
}

function checkFragment(value) {
  const fragmentId = value && typeof value === "object" && typeof value.fragment_id === "string" ? value.fragment_id : "invalid-fragment";
  try {
    return { ok: true, fragment: validateFragment(value) };
  } catch (error) {
    return { ok: false, fragmentId, reason: error instanceof Error ? error.message : "invalid fragment" };
  }
}

function validateFragment(value) {
  const keys = ["fragment_id", "revision", "runtime", "coordinate_convention", "sockets", "material_slots", "markers", "motion_binding", "provenance"];
  assertKeys(value, keys, "fragment");
  assertId(value.fragment_id, "fragment.fragment_id");
  assertPositiveInteger(value.revision, "fragment.revision");
  assertExact(value.coordinate_convention, COORDINATE_CONVENTION, "fragment.coordinate_convention");
  const runtime = ingestGlbRuntimeCandidate(value.runtime);
  const anchors = new Set(runtime.loader_profile.named_anchors.map((anchor) => anchor.node));
  const sockets = checkedList(value.sockets, validateSocket, "fragment.sockets");
  assertUnique(sockets.map((socket) => socket.socket_id), "socket_id");
  const materialSlots = checkedList(value.material_slots, validateMaterialSlot, "fragment.material_slots");
  assertUnique(materialSlots.map((slot) => slot.slot_id), "material slot_id");
  const markers = checkedList(value.markers, validateMarker, "fragment.markers");
  assertUnique(markers.map((marker) => marker.marker_id), "marker_id");
  const motionBinding = validateMotionBinding(value.motion_binding);
  const provenance = validateProvenance(value.provenance, runtime.loader_profile);
  for (const node of [...sockets.map((entry) => entry.node), ...materialSlots.map((entry) => entry.node), ...markers.map((entry) => entry.node), ...motionNodes(motionBinding)]) {
    if (!anchors.has(node)) throw new TypeError(`fragment ${value.fragment_id} references node ${node} that is not a checked GLB anchor`);
  }
  for (const slot of materialSlots) {
    if (!runtime.loader_profile.material_allowlist.includes(slot.material)) throw new TypeError(`material slot ${slot.slot_id} is not in the GLB material allowlist`);
  }
  return deepFreeze({
    fragment_id: value.fragment_id,
    revision: value.revision,
    runtime,
    coordinate_convention: clone(COORDINATE_CONVENTION),
    sockets,
    material_slots: materialSlots,
    markers,
    motion_binding: motionBinding,
    provenance,
  });
}

function validateSlot(value) {
  assertKeys(value, ["slot_id", "primary_fragment_id", "fallback_fragment_id", "required"].filter((key) => key in (value || {})), "slot");
  assertId(value?.slot_id, "slot.slot_id");
  assertId(value?.primary_fragment_id, "slot.primary_fragment_id");
  if (value.fallback_fragment_id !== undefined) assertId(value.fallback_fragment_id, "slot.fallback_fragment_id");
  if (typeof value.required !== "boolean") throw new TypeError("slot.required must be boolean");
  if (value.fallback_fragment_id === value.primary_fragment_id) throw new TypeError("slot fallback must differ from primary");
  return deepFreeze(clone(value));
}

function validateAttachment(value) {
  assertKeys(value, ["attachment_id", "parent_slot_id", "parent_socket_id", "child_slot_id", "child_socket_id", "required"], "attachment");
  for (const key of ["attachment_id", "parent_slot_id", "parent_socket_id", "child_slot_id", "child_socket_id"]) assertId(value[key], `attachment.${key}`);
  if (value.parent_slot_id === value.child_slot_id) throw new TypeError("attachment cannot self-attach a slot");
  if (typeof value.required !== "boolean") throw new TypeError("attachment.required must be boolean");
  return deepFreeze(clone(value));
}

function validateSocket(value) {
  assertKeys(value, ["socket_id", "node", "mode", "kind", "transform"], "socket");
  assertId(value.socket_id, "socket.socket_id");
  if (typeof value.node !== "string" || !value.node) throw new TypeError("socket.node must be non-empty");
  if (value.mode !== "provide" && value.mode !== "consume") throw new TypeError("socket.mode must be provide or consume");
  if (!TAG.test(value.kind)) throw new TypeError("socket.kind must be a semantic tag");
  return deepFreeze({ ...clone(value), transform: validateTransform(value.transform, "socket.transform") });
}

function validateMaterialSlot(value) {
  assertKeys(value, ["slot_id", "node", "material"], "material slot");
  assertId(value.slot_id, "material slot.slot_id");
  if (typeof value.node !== "string" || !value.node || typeof value.material !== "string" || !value.material) throw new TypeError("material slot requires node and material");
  return deepFreeze(clone(value));
}

function validateMarker(value) {
  assertKeys(value, ["marker_id", "node", "kind", "shape", "transform"], "marker");
  assertId(value.marker_id, "marker.marker_id");
  if (typeof value.node !== "string" || !value.node) throw new TypeError("marker.node must be non-empty");
  if (!new Set(["collision", "critical"]).has(value.kind)) throw new TypeError("marker.kind must be collision or critical");
  if (!new Set(["box", "sphere", "capsule"]).has(value.shape)) throw new TypeError("marker.shape must be box, sphere, or capsule");
  return deepFreeze({ ...clone(value), transform: validateTransform(value.transform, "marker.transform") });
}

function validateMotionBinding(value) {
  if (!value || typeof value !== "object" || typeof value.kind !== "string") throw new TypeError("motion_binding is required");
  if (value.kind === "rig") {
    assertKeys(value, ["kind", "skeleton_root", "joint_nodes"], "rig motion_binding");
    if (typeof value.skeleton_root !== "string" || !value.skeleton_root || !Array.isArray(value.joint_nodes) || !value.joint_nodes.length || value.joint_nodes.some((node) => typeof node !== "string" || !node) || new Set(value.joint_nodes).size !== value.joint_nodes.length) throw new TypeError("rig motion_binding requires unique joint_nodes");
  } else if (value.kind === "procedural") {
    assertKeys(value, ["kind", "contract", "anchor_node"], "procedural motion_binding");
    if (!TAG.test(value.contract) || typeof value.anchor_node !== "string" || !value.anchor_node) throw new TypeError("procedural motion_binding requires a contract and anchor_node");
  } else throw new TypeError("motion_binding.kind must be rig or procedural");
  return deepFreeze(clone(value));
}

function validateProvenance(value, profile) {
  assertKeys(value, ["producer", "created_at", "source_sha256"], "fragment.provenance");
  if (typeof value.producer !== "string" || !value.producer || !TIMESTAMP.test(value.created_at) || Number.isNaN(Date.parse(value.created_at))) throw new TypeError("fragment.provenance requires producer and created_at");
  const expected = profile.provenance.source_receipt.artifact.sha256;
  if (value.source_sha256 !== expected) throw new TypeError("fragment.provenance source_sha256 must bind the checked Blender receipt");
  return deepFreeze(clone(value));
}

function validateTransform(value, label) {
  assertKeys(value, ["translation", "rotation", "scale"], label);
  if (!arrayOfFinite(value.translation, 3) || !arrayOfFinite(value.rotation, 4) || !arrayOfFinite(value.scale, 3)) throw new TypeError(`${label} must contain finite TRS values`);
  if (value.scale.some((component) => component !== 1)) throw new TypeError(`${label}.scale must be unit scale`);
  const magnitude = Math.hypot(...value.rotation);
  if (Math.abs(magnitude - 1) > 1e-6) throw new TypeError(`${label}.rotation must be a normalized quaternion`);
  return deepFreeze(clone(value));
}

function socketFor(fragment, socketId, mode) {
  const socket = fragment.sockets.find((candidate) => candidate.socket_id === socketId);
  if (!socket || socket.mode !== mode) throw new TypeError(`fragment ${fragment.fragment_id} lacks a ${mode} socket ${socketId}`);
  return socket;
}

function assertTargetCompatibility(fragments) {
  const rootTarget = JSON.stringify(targetFor(fragments[0]));
  for (const fragment of fragments.slice(1)) {
    if (JSON.stringify(targetFor(fragment)) !== rootTarget) throw new TypeError(`fragment ${fragment.fragment_id} has an incompatible GLB runtime target`);
  }
}

function targetFor(fragment) {
  const profile = fragment.runtime.loader_profile;
  return { loader: clone(profile.loader), target: clone(profile.target) };
}

function assertConnected(rootSlotId, selected, attachments) {
  const edges = new Map();
  for (const attachment of attachments) {
    const children = edges.get(attachment.parent_slot_id) || [];
    children.push(attachment.child_slot_id);
    edges.set(attachment.parent_slot_id, children);
  }
  const seen = new Set([rootSlotId]);
  const pending = [rootSlotId];
  while (pending.length) {
    for (const child of edges.get(pending.pop()) || []) if (!seen.has(child)) { seen.add(child); pending.push(child); }
  }
  if (seen.size !== selected.size) throw new TypeError("selected attachments do not form one connected runtime asset");
}

function motionNodes(binding) { return binding.kind === "rig" ? [binding.skeleton_root, ...binding.joint_nodes] : [binding.anchor_node]; }
function sha256(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function clone(value) { return structuredClone(value); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function assertKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new TypeError(`${label} has an invalid shape`); }
function assertExact(value, expected, label) { assertKeys(value, Object.keys(expected), label); for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) throw new TypeError(`${label}.${key} must be ${expectedValue}`); }
function assertId(value, label) { if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${label} must be a stable id`); }
function assertPositiveInteger(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); }
function assertTimestamp(value, label) { if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an RFC3339 timestamp`); }
function assertUnique(values, label) { if (new Set(values).size !== values.length) throw new TypeError(`${label} values must be unique`); }
function checkedList(values, validate, label) { if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`); return values.map(validate); }
function arrayOfFinite(value, length) { return Array.isArray(value) && value.length === length && value.every(Number.isFinite); }
function compareById(key) { return (a, b) => String(a[key]).localeCompare(String(b[key])); }
