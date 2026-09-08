import { createHash } from "node:crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EVIDENCE_TIERS = new Set(["local_orchestration", "local_unity_runner", "cloud_headless_validation", "cloud_rendered_preview", "not_observed"]);

/**
 * A local, generic encounter simulation seam. It accepts only an immutable
 * frozen package plus exact asset/animation revisions. It is intentionally not
 * a host-game combat implementation and never upgrades its evidence tier.
 */
export function createAssemblyReceipt({ assemblyId, frozenPackage, selected, assembledAt, provenance }) {
  assertId(assemblyId, "assemblyId");
  assertFrozenPackage(frozenPackage);
  assertSelection(selected);
  assertTimestamp(assembledAt, "assembledAt");
  assertProvenance(provenance);
  const unsigned = {
    schema_version: "1",
    assembly_id: assemblyId,
    encounter_id: frozenPackage.encounter_id,
    frozen_package: clone(frozenPackage),
    package_manifest_sha256: frozenPackage.manifest_sha256,
    selected_assets: sortedSelections(selected.assets, "asset_id"),
    selected_animations: sortedSelections(selected.animations, "animation_id"),
    assembled_at: assembledAt,
    provenance: clone(provenance),
  };
  const receipt = { ...unsigned, assembly_sha256: digest(unsigned) };
  validateAssemblyReceipt(receipt);
  return deepFreeze(receipt);
}

/**
 * Executes a deterministic damage script through the closed local Unity-runner
 * profile. This orchestration proof records no frame/clip because it did not
 * observe a player-facing renderer. A Unity process may emit a stronger receipt
 * using the same schema, but cloud profiles are rejected locally.
 */
export function runDeterministicEncounter({ assemblyReceipt, runtimeProfile, seed, script, startedAt, logPath = undefined }) {
  validateAssemblyReceipt(assemblyReceipt);
  assertLocalUnityProfile(runtimeProfile);
  if (!Number.isInteger(seed) || seed < 0) throw new TypeError("seed must be a non-negative integer");
  assertTimestamp(startedAt, "startedAt");
  if (!Array.isArray(script) || script.length < 2) throw new TypeError("script must contain a bidirectional damage exchange");
  const events = normaliseScript(script);
  const exchange = verifyExchange(events);
  const endedAt = new Date(Date.parse(startedAt) + events.at(-1).at_ms).toISOString();
  const receipt = {
    schema_version: "1",
    simulation_id: `simulation-${assemblyReceipt.assembly_id}-${seed}`,
    encounter_id: assemblyReceipt.encounter_id,
    assembly_sha256: assemblyReceipt.assembly_sha256,
    package_manifest_sha256: assemblyReceipt.package_manifest_sha256,
    runner: {
      runner_id: runtimeProfile.runner_id,
      runtime_id: runtimeProfile.runtime_id,
      build_profile_id: runtimeProfile.build_profile_id,
      profile_id: runtimeProfile.profile_id,
      profile_revision: runtimeProfile.profile_revision,
    },
    evidence_tiers: { source: "local_orchestration", runtime: runtimeProfile.evidence_tier, player: "not_observed" },
    deterministic: { seed, script_sha256: digest(events), event_count: events.length },
    status: exchange.verified ? "passed" : "failed",
    telemetry: { hit_exchange: exchange, passed_checks: exchange.verified ? ["bidirectional_damage_exchange"] : [], failed_checks: exchange.verified ? [] : ["bidirectional_damage_exchange"] },
    timings: { started_at: startedAt, ended_at: endedAt, duration_ms: events.at(-1).at_ms },
    logs: logPath ? [{ path: logPath, sha256: null }] : [],
    failure_codes: exchange.verified ? [] : ["missing_bidirectional_damage_exchange"],
    provenance: {
      assembly_id: assemblyReceipt.assembly_id,
      selected_assets: assemblyReceipt.selected_assets.map(({ asset_id, revision, sha256 }) => ({ asset_id, revision, sha256 })),
      selected_animations: assemblyReceipt.selected_animations.map(({ animation_id, revision, sha256 }) => ({ animation_id, revision, sha256 })),
    },
  };
  validateSimulationReceipt(receipt);
  return deepFreeze(receipt);
}

export function validateAssemblyReceipt(receipt) {
  if (!isObject(receipt) || Object.keys(receipt).some((key) => ![
    "schema_version", "assembly_id", "encounter_id", "frozen_package", "package_manifest_sha256", "selected_assets", "selected_animations", "assembled_at", "provenance", "assembly_sha256",
  ].includes(key))) throw new TypeError("assembly receipt must be a closed v1 record");
  if (receipt.schema_version !== "1") throw new TypeError("assembly receipt requires schema version 1");
  assertId(receipt.assembly_id, "assembly_id"); assertId(receipt.encounter_id, "encounter_id");
  assertFrozenPackage(receipt.frozen_package);
  if (receipt.frozen_package.encounter_id !== receipt.encounter_id || receipt.package_manifest_sha256 !== receipt.frozen_package.manifest_sha256) throw new TypeError("assembly receipt package identity mismatch");
  assertSelection({ assets: receipt.selected_assets, animations: receipt.selected_animations });
  assertTimestamp(receipt.assembled_at, "assembled_at"); assertProvenance(receipt.provenance);
  if (!SHA256.test(receipt.assembly_sha256 || "")) throw new TypeError("assembly receipt requires assembly_sha256");
  const { assembly_sha256, ...unsigned } = receipt;
  if (assembly_sha256 !== digest(unsigned)) throw new TypeError("assembly receipt hash mismatch");
  return true;
}

export function validateSimulationReceipt(receipt) {
  const fields = ["schema_version", "simulation_id", "encounter_id", "assembly_sha256", "package_manifest_sha256", "runner", "evidence_tiers", "deterministic", "status", "telemetry", "timings", "logs", "failure_codes", "provenance", "frame_or_clip_artifact"];
  if (!isObject(receipt) || Object.keys(receipt).some((key) => !fields.includes(key))) throw new TypeError("simulation receipt must be a closed v1 record");
  if (receipt.schema_version !== "1" || !ID.test(receipt.simulation_id || "") || !ID.test(receipt.encounter_id || "")) throw new TypeError("simulation receipt identity is invalid");
  if (!SHA256.test(receipt.assembly_sha256 || "") || !SHA256.test(receipt.package_manifest_sha256 || "")) throw new TypeError("simulation receipt requires input hashes");
  assertRunner(receipt.runner);
  if (!isObject(receipt.evidence_tiers) || !["source", "runtime", "player"].every((key) => EVIDENCE_TIERS.has(receipt.evidence_tiers[key]))) throw new TypeError("simulation receipt evidence tiers are invalid");
  if (!isObject(receipt.deterministic) || !Number.isInteger(receipt.deterministic.seed) || receipt.deterministic.seed < 0 || !SHA256.test(receipt.deterministic.script_sha256 || "") || !Number.isInteger(receipt.deterministic.event_count) || receipt.deterministic.event_count < 1) throw new TypeError("simulation receipt deterministic proof is invalid");
  if (!["passed", "failed"].includes(receipt.status)) throw new TypeError("simulation receipt status is invalid");
  if (!isObject(receipt.telemetry?.hit_exchange) || typeof receipt.telemetry.hit_exchange.verified !== "boolean" || !Array.isArray(receipt.telemetry.hit_exchange.events)) throw new TypeError("simulation receipt needs hit exchange telemetry");
  if (!isObject(receipt.timings) || !Number.isInteger(receipt.timings.duration_ms) || receipt.timings.duration_ms < 0) throw new TypeError("simulation receipt timings are invalid");
  assertTimestamp(receipt.timings.started_at, "timings.started_at"); assertTimestamp(receipt.timings.ended_at, "timings.ended_at");
  if (!Array.isArray(receipt.logs) || !Array.isArray(receipt.failure_codes) || !isObject(receipt.provenance)) throw new TypeError("simulation receipt evidence fields are invalid");
  if (receipt.frame_or_clip_artifact !== undefined && receipt.evidence_tiers.player === "not_observed") throw new TypeError("unobserved player evidence cannot name a frame or clip");
  if (receipt.status === "passed" && !receipt.telemetry.hit_exchange.verified) throw new TypeError("a passed simulation needs a verified hit exchange");
  return true;
}

function assertFrozenPackage(value) {
  if (!isObject(value) || value.schema_version !== "1" || value.state !== "frozen" || !ID.test(value.package_id || "") || !ID.test(value.encounter_id || "") || !SHA256.test(value.manifest_sha256 || "") || !Array.isArray(value.module_ids) || value.module_ids.length === 0 || !value.module_ids.every((id) => ID.test(id)) || !value.fallback_provenance || !ISO.test(value.frozen_at || "")) throw new TypeError("assembly input must be an immutable frozen playable encounter package");
}

function assertSelection(value) {
  if (!isObject(value) || !Array.isArray(value.assets) || !Array.isArray(value.animations)) throw new TypeError("selected assets and animations are required");
  assertReferences(value.assets, "asset_id"); assertReferences(value.animations, "animation_id");
}

function assertReferences(values, idKey) {
  if (values.length === 0 || values.some((value) => !isObject(value) || !ID.test(value[idKey] || "") || !Number.isInteger(value.revision) || value.revision < 1 || !SHA256.test(value.sha256 || "") || typeof value.uri !== "string" || value.uri.length === 0) || new Set(values.map((value) => value[idKey])).size !== values.length) throw new TypeError(`selected ${idKey} references require exact id, revision, sha256, and uri`);
}

function assertLocalUnityProfile(profile) {
  if (!isObject(profile) || profile.schema_version !== "1" || profile.evidence_tier !== "local_unity_runner" || profile.execution_mode !== "headless" || !isObject(profile.unity) || profile.unity.editor_version !== "6000.6.0f1" || profile.unity.scripting_backend !== "mono" || profile.unity.platform !== "macos") throw new TypeError("runner requires a closed local runtime profile");
  assertRunner(profile);
}

function assertRunner(runner) {
  if (!isObject(runner) || !ID.test(runner.runner_id || "") || !nonEmpty(runner.runtime_id) || !nonEmpty(runner.build_profile_id) || !ID.test(runner.profile_id || "") || !Number.isInteger(runner.profile_revision) || runner.profile_revision < 1) throw new TypeError("runner identity is invalid");
}

function assertProvenance(value) { if (!isObject(value) || !nonEmpty(value.producer) || !ISO.test(value.observed_at || "")) throw new TypeError("provenance requires producer and observed_at"); }
function normaliseScript(script) {
  let lastAt = -1;
  return script.map((event, index) => {
    if (!isObject(event) || !Number.isInteger(event.at_ms) || event.at_ms < 0 || event.at_ms <= lastAt || !["player", "encounter-target"].includes(event.actor) || !["player", "encounter-target"].includes(event.target) || event.actor === event.target || !Number.isFinite(event.damage) || event.damage <= 0) throw new TypeError(`script event ${index} is invalid`);
    lastAt = event.at_ms;
    return { at_ms: event.at_ms, actor: event.actor, target: event.target, damage: event.damage };
  });
}
function verifyExchange(events) { const playerHits = events.filter((event) => event.actor === "player" && event.target === "encounter-target"); const targetHits = events.filter((event) => event.actor === "encounter-target" && event.target === "player"); return { verified: playerHits.length > 0 && targetHits.length > 0, events }; }
function sortedSelections(values, idKey) { return clone(values).sort((left, right) => left[idKey].localeCompare(right[idKey]) || left.revision - right.revision); }
function digest(value) { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assertId(value, name) { if (!ID.test(value || "")) throw new TypeError(`${name} must be a stable identifier`); }
function assertTimestamp(value, name) { if (!ISO.test(value || "")) throw new TypeError(`${name} must be an ISO-8601 UTC timestamp`); }
function nonEmpty(value) { return typeof value === "string" && value.length > 0 && value.length <= 128; }
