import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyFrozenEncounterPackage } from "./encounter-package-assembler.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ASSEMBLY_FIELDS = ["schema_version", "assembly_id", "encounter_id", "frozen_package", "package_manifest_sha256", "selected_assets", "selected_animations", "assembled_at", "source_evidence", "assembly_sha256"];
const HANDOFF_FIELDS = ["schema_version", "handoff_id", "assembly_receipt", "load_deadline_ms", "evidence", "concept_lineage", "handoff_sha256"];

/**
 * Bind one or more real, host-resolvable GLBs to an immutable frozen package.
 * It deliberately proves bytes and package identity only; it makes no Unity or
 * player-facing observation claim.
 */
export async function createAssemblyReceipt({ assemblyId, frozenPackage, selectedAssets, selectedAnimations = [], assembledAt, sourceEvidence }) {
  assertId(assemblyId, "assemblyId");
  assertFrozenPackage(frozenPackage);
  assertTimestamp(assembledAt, "assembledAt");
  const assets = await validateSelections(selectedAssets, "asset_id", true);
  const animations = await validateSelections(selectedAnimations, "animation_id", false);
  assertSourceEvidence(sourceEvidence, [...assets, ...animations], frozenPackage);
  const unsigned = {
    schema_version: "1",
    assembly_id: assemblyId,
    encounter_id: frozenPackage.encounter_id,
    frozen_package: clone(frozenPackage),
    package_manifest_sha256: frozenPackage.manifest_sha256,
    selected_assets: assets,
    selected_animations: animations,
    assembled_at: assembledAt,
    source_evidence: clone(sourceEvidence),
  };
  const receipt = { ...unsigned, assembly_sha256: digest(unsigned) };
  await validateAssemblyReceipt(receipt);
  return deepFreeze(receipt);
}

/** Produce the exact, machine-readable input a Unity adapter needs to attempt a bounded GLB load. */
export async function createUnityHostHandoff({ handoffId, assemblyReceipt, loadDeadlineMs = 8000, conceptLineage }) {
  assertId(handoffId, "handoffId");
  await validateAssemblyReceipt(assemblyReceipt);
  if (!Number.isInteger(loadDeadlineMs) || loadDeadlineMs < 1 || loadDeadlineMs > 60000) throw new TypeError("loadDeadlineMs must be a bounded positive integer");
  assertConceptLineage(conceptLineage);
  const unsigned = {
    schema_version: "1",
    handoff_id: handoffId,
    assembly_receipt: clone(assemblyReceipt),
    load_deadline_ms: loadDeadlineMs,
    evidence: { source: "local_blender_cli_observed", host_load: "not_observed", player_facing: "not_observed" },
    concept_lineage: clone(conceptLineage),
  };
  const handoff = { ...unsigned, handoff_sha256: digest(unsigned) };
  await validateUnityHostHandoff(handoff);
  return deepFreeze(handoff);
}

/** Write the closed handoff document without changing its content-addressed identity. */
export async function writeUnityHostHandoff(path, handoff) {
  await validateUnityHostHandoff(handoff);
  await writeFile(path, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  return path;
}

export async function validateAssemblyReceipt(receipt) {
  assertExactKeys(receipt, ASSEMBLY_FIELDS, "assembly receipt");
  if (receipt.schema_version !== "1") throw new TypeError("assembly receipt requires schema version 1");
  assertId(receipt.assembly_id, "assembly_id");
  assertId(receipt.encounter_id, "encounter_id");
  assertFrozenPackage(receipt.frozen_package);
  if (receipt.encounter_id !== receipt.frozen_package.encounter_id || receipt.package_manifest_sha256 !== receipt.frozen_package.manifest_sha256) throw new TypeError("assembly receipt package identity mismatch");
  assertTimestamp(receipt.assembled_at, "assembled_at");
  const assets = await validateSelections(receipt.selected_assets, "asset_id", true);
  const animations = await validateSelections(receipt.selected_animations, "animation_id", false);
  assertSourceEvidence(receipt.source_evidence, [...assets, ...animations], receipt.frozen_package);
  if (!SHA256.test(receipt.assembly_sha256 || "")) throw new TypeError("assembly receipt requires assembly_sha256");
  const { assembly_sha256, ...unsigned } = receipt;
  if (assembly_sha256 !== digest(unsigned)) throw new TypeError("assembly receipt hash mismatch");
  return true;
}

export async function validateUnityHostHandoff(handoff) {
  assertExactKeys(handoff, HANDOFF_FIELDS, "Unity host handoff");
  if (handoff.schema_version !== "1") throw new TypeError("Unity host handoff requires schema version 1");
  assertId(handoff.handoff_id, "handoff_id");
  await validateAssemblyReceipt(handoff.assembly_receipt);
  if (!Number.isInteger(handoff.load_deadline_ms) || handoff.load_deadline_ms < 1 || handoff.load_deadline_ms > 60000) throw new TypeError("Unity host handoff load deadline is invalid");
  assertExactKeys(handoff.evidence, ["source", "host_load", "player_facing"], "Unity host handoff evidence");
  if (handoff.evidence.source !== "local_blender_cli_observed" || handoff.evidence.host_load !== "not_observed" || handoff.evidence.player_facing !== "not_observed") throw new TypeError("Unity host handoff cannot upgrade evidence");
  assertConceptLineage(handoff.concept_lineage);
  if (!SHA256.test(handoff.handoff_sha256 || "")) throw new TypeError("Unity host handoff requires handoff_sha256");
  const { handoff_sha256, ...unsigned } = handoff;
  if (handoff_sha256 !== digest(unsigned)) throw new TypeError("Unity host handoff hash mismatch");
  return true;
}

async function validateSelections(values, idKey, requireOne) {
  if (!Array.isArray(values) || (requireOne && values.length === 0)) throw new TypeError(`selected ${idKey} references are required`);
  const normalized = [];
  const ids = new Set();
  for (const value of values) {
    assertExactKeys(value, [idKey, "revision", "uri", "path", "sha256", "media_type", "byte_length"], `selected ${idKey}`);
    if (!ID.test(value[idKey] || "") || !Number.isInteger(value.revision) || value.revision < 1 || !SHA256.test(value.sha256 || "") || value.media_type !== "model/gltf-binary" || !Number.isInteger(value.byte_length) || value.byte_length < 0) throw new TypeError(`selected ${idKey} is invalid`);
    if (ids.has(value[idKey])) throw new TypeError(`selected ${idKey} values must be unique`);
    ids.add(value[idKey]);
    const path = await resolveFileReference(value.uri, value.path);
    const bytes = await readFile(path);
    if (bytes.byteLength !== value.byte_length || createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new TypeError(`selected ${idKey} bytes do not match its immutable reference`);
    normalized.push({ [idKey]: value[idKey], revision: value.revision, uri: pathToFileURL(path).href, path, sha256: value.sha256, media_type: value.media_type, byte_length: value.byte_length });
  }
  return normalized.sort((left, right) => left[idKey].localeCompare(right[idKey]) || left.revision - right.revision);
}

async function resolveFileReference(uri, declaredPath) {
  if (typeof uri !== "string" || typeof declaredPath !== "string") throw new TypeError("selected artifact requires a file URI and path");
  let uriPath;
  try { uriPath = fileURLToPath(uri); } catch { throw new TypeError("selected artifact URI must be a resolvable file URI"); }
  const [resolvedUriPath, resolvedDeclaredPath] = await Promise.all([realpath(uriPath), realpath(resolve(declaredPath))]);
  if (resolvedUriPath !== resolvedDeclaredPath) throw new TypeError("selected artifact URI/path mismatch");
  return resolvedUriPath;
}

function assertSourceEvidence(value, selectedAssets, frozenPackage) {
  assertExactKeys(value, ["kind", "scope", "observed_at", "build_room_assembly_receipt"], "source evidence");
  if (value.kind !== "local_blender_cli" || value.scope !== "local_blender_cli_only") throw new TypeError("fixtures or unobserved sources cannot be labeled observed");
  assertTimestamp(value.observed_at, "source evidence observed_at");
  assertBuildRoomReceipt(value.build_room_assembly_receipt, selectedAssets, frozenPackage);
}

function assertBuildRoomReceipt(receipt, selectedAssets, frozenPackage) {
  const fields = ["schema_version", "receipt_id", "package_id", "package_revision", "package_manifest_sha256", "assembled_at", "selected_modules", "fallback_provenance", "validation", "concept_first_lineage", "host_acceptance", "preserved_fallback_history", "receipt_sha256"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).some((key) => !fields.includes(key))) throw new TypeError("source evidence Build Room receipt is invalid");
  const required = ["schema_version", "receipt_id", "package_id", "package_revision", "package_manifest_sha256", "assembled_at", "selected_modules", "fallback_provenance", "validation", "host_acceptance", "receipt_sha256"];
  if (required.some((key) => !(key in receipt)) || receipt.schema_version !== "1" || !ID.test(receipt.receipt_id || "") || receipt.package_id !== frozenPackage.package_id || receipt.package_revision !== frozenPackage.revision || !SHA256.test(receipt.package_manifest_sha256 || "") || receipt.host_acceptance !== "not_observed" || !SHA256.test(receipt.receipt_sha256 || "")) throw new TypeError("source evidence Build Room receipt is invalid");
  const { receipt_sha256, ...unsigned } = receipt;
  if (createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== receipt_sha256) throw new TypeError("source evidence Build Room receipt hash mismatch");
  if (!Array.isArray(receipt.selected_modules) || receipt.selected_modules.length === 0 || receipt.selected_modules.some((module) => !module || typeof module !== "object" || !ID.test(module.module_id || "") || !Number.isInteger(module.revision) || module.revision < 1 || !SHA256.test(module.artifact_sha256 || ""))) throw new TypeError("source evidence Build Room receipt selections are invalid");
  for (const asset of selectedAssets) {
    if (!receipt.selected_modules.some((module) => module.revision === asset.revision && module.artifact_sha256 === asset.sha256)) throw new TypeError("source evidence Build Room receipt does not bind the selected GLB");
  }
}

function assertConceptLineage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("concept lineage is required");
  if (value.kind === "not_recorded") {
    assertExactKeys(value, ["kind", "reason"], "unrecorded concept lineage");
    if (value.reason !== "pre_gate_bootstrap") throw new TypeError("unrecorded lineage reason is invalid");
    return;
  }
  if (value.kind === "reuse_maintenance_waiver") {
    assertExactKeys(value, ["kind", "waiver"], "bootstrap waiver");
    const waiver = value.waiver;
    assertExactKeys(waiver, ["kind", "bounded_reason", "approver", "approved_at", "expires_at", "asset_ids"], "bootstrap waiver details");
    if (!["reuse", "maintenance"].includes(waiver.kind) || !ID.test(waiver.approver || "") || typeof waiver.bounded_reason !== "string" || waiver.bounded_reason.length < 1 || waiver.bounded_reason.length > 512 || !Array.isArray(waiver.asset_ids) || waiver.asset_ids.length === 0 || waiver.asset_ids.some((id) => !ID.test(id)) || new Set(waiver.asset_ids).size !== waiver.asset_ids.length) throw new TypeError("bootstrap waiver is invalid");
    assertTimestamp(waiver.approved_at, "waiver approved_at"); assertTimestamp(waiver.expires_at, "waiver expires_at");
    if (Date.parse(waiver.expires_at) <= Date.parse(waiver.approved_at)) throw new TypeError("bootstrap waiver must expire after approval");
    return;
  }
  if (value.kind === "concept_lineage") {
    assertExactKeys(value, ["kind", "encounter_intent", "art_direction_revision", "concept_reference_revision"], "concept lineage");
    for (const reference of [value.encounter_intent, value.art_direction_revision, value.concept_reference_revision]) assertRevisionReference(reference);
    return;
  }
  throw new TypeError("concept lineage kind is invalid");
}

function assertRevisionReference(value) {
  assertExactKeys(value, ["id", "revision", "content_sha256"], "concept lineage revision");
  if (!ID.test(value.id || "") || !Number.isInteger(value.revision) || value.revision < 1 || !SHA256.test(value.content_sha256 || "")) throw new TypeError("concept lineage revision is invalid");
}
function assertFrozenPackage(value) { try { verifyFrozenEncounterPackage(value); } catch { throw new TypeError("assembly input must be an immutable frozen playable encounter package"); } }
function assertExactKeys(value, keys, name) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new TypeError(`${name} must be a closed record`); }
function assertId(value, name) { if (!ID.test(value || "")) throw new TypeError(`${name} must be a stable identifier`); }
function assertTimestamp(value, name) { if (!ISO.test(value || "") || Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO-8601 UTC timestamp`); }
function digest(value) { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
