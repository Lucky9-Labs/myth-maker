import { createHash } from "node:crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMANTIC_TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const CONTRACT_NAME = /^[a-z][a-z0-9_.-]{0,95}\.v[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXECUTION_KINDS = new Set(["recipe", "runtime_asset", "managed_plugin", "remote_logic"]);
const MODULE_FIELDS = new Set([
  "schema_version", "module_id", "revision", "execution_kind", "provides", "requires", "conflicts",
  "compatibility", "quality", "artifact", "entrypoint", "inline_recipe", "fallback_module_ids", "provenance",
]);
const PACKAGE_FIELDS = new Set([
  "schema_version", "package_id", "encounter_id", "revision", "state", "assembled_at", "frozen_at",
  "module_ids", "manifest_sha256", "fallback_provenance", "rejection_reasons",
]);

/**
 * Assemble the best compatible package from a host's known baseline and
 * candidates. V0 greedily assigns each declared `provides` tag to its highest-
 * ranked compatible provider. A multi-tag module remains selected when it owns
 * any slot, so partial upgrades can coexist with it; a future contract needs
 * explicit replacement groups to model atomic multi-capability swaps. The
 * caller supplies every varying input (including time and the previous package),
 * so this module has no clock, storage, or host side effects.
 */
export function assembleEncounterPackage({
  host,
  encounterId,
  packageId,
  baselineModules,
  candidateModules = [],
  previousPackage = undefined,
  assembledAt,
}) {
  assertHost(host);
  assertId(encounterId, "encounterId");
  assertId(packageId, "packageId");
  assertTimestamp(assembledAt, "assembledAt");
  if (!Array.isArray(baselineModules) || baselineModules.length === 0) {
    throw new TypeError("baselineModules must contain at least one module");
  }
  if (!Array.isArray(candidateModules)) throw new TypeError("candidateModules must be an array");

  const revision = nextRevision(previousPackage, encounterId, packageId);
  const rejections = [];
  const usedFallbackIds = new Set();
  const rejectedCandidates = [];
  const slotOwners = new Map();
  const baselineIds = new Set();

  for (const module of sortModules(baselineModules)) {
    const reasons = compatibilityReasons(module, host);
    if (reasons.length) {
      throw new TypeError(`baseline module ${moduleLabel(module)} is incompatible: ${reasons.join("; ")}`);
    }
    if (baselineIds.has(module.module_id)) {
      throw new TypeError(`baselineModules contains duplicate module_id ${module.module_id}`);
    }
    baselineIds.add(module.module_id);
    claimHigherRankedSlots(slotOwners, module, module.provides);
  }
  assertConflictFreeBaseline(activeModules(slotOwners));

  const candidates = sortModules(candidateModules);
  for (const module of candidates) {
    if (baselineIds.has(module.module_id)) {
      addRejection(rejections, module, [`module id already selected ${module.module_id}`]);
      rejectedCandidates.push(module);
      continue;
    }
    const reasons = compatibilityReasons(module, host);
    if (reasons.length) {
      addRejection(rejections, module, reasons);
      rejectedCandidates.push(module);
      continue;
    }

    const claims = sorted(module.provides).filter((tag) => isHigherRanked(module, slotOwners.get(tag)));
    if (claims.length === 0) {
      addRejection(rejections, module, module.provides.map((tag) =>
        `higher-ranked provider ${slotOwners.get(tag).module_id} selected for ${tag}`));
      rejectedCandidates.push(module);
      continue;
    }

    const tentativeSlots = new Map(slotOwners);
    claimHigherRankedSlots(tentativeSlots, module, claims);
    const tentativeSelection = activeModules(tentativeSlots);
    const conflictReasons = selectionConflictReasons(module, tentativeSelection);
    if (conflictReasons.length === 0) {
      slotOwners.clear();
      for (const [tag, owner] of tentativeSlots) slotOwners.set(tag, owner);
      continue;
    }

    addRejection(rejections, module, conflictReasons);
    rejectedCandidates.push(module);
  }

  const selected = activeModules(slotOwners);
  const selectedIds = new Set(selected.map((module) => module.module_id));
  for (const module of rejectedCandidates) selectDeclaredFallback(module, selectedIds, usedFallbackIds);
  const orderedRejections = rejections.sort(compareRejections);
  const packageWithoutHash = {
    schema_version: "1",
    package_id: packageId,
    encounter_id: encounterId,
    revision,
    state: "ready",
    assembled_at: assembledAt,
    module_ids: selected.map((module) => module.module_id).sort(),
    fallback_provenance: {
      used_fallback: usedFallbackIds.size > 0,
      module_ids: [...usedFallbackIds].sort(),
    },
    rejection_reasons: orderedRejections.flatMap((rejection) => rejection.reasons.map(
      (reason) => packageRejectionReason(rejection, reason),
    )),
  };
  const packageRecord = {
    ...packageWithoutHash,
    manifest_sha256: manifestSha256(packageWithoutHash),
  };

  return deepFreeze({ package: packageRecord, rejections: orderedRejections });
}

/**
 * Return a new immutable frozen snapshot of a ready package. Time is explicit
 * so repeated calls with equal inputs produce byte-for-byte equal output.
 */
export function freezeEncounterPackage(readyPackage, frozenAt) {
  if (!readyPackage || readyPackage.state !== "ready" || packageShapeReasons(readyPackage).length) {
    throw new TypeError("only a valid ready package can be frozen");
  }
  const expectedHash = manifestSha256(withoutManifestHash(readyPackage));
  if (readyPackage.manifest_sha256 !== expectedHash) {
    throw new TypeError("ready package manifest_sha256 does not match its contents");
  }
  assertTimestamp(frozenAt, "frozenAt");

  const packageWithoutHash = {
    ...clone(readyPackage),
    state: "frozen",
    frozen_at: frozenAt,
  };
  delete packageWithoutHash.manifest_sha256;

  return deepFreeze({
    ...packageWithoutHash,
    manifest_sha256: manifestSha256(packageWithoutHash),
  });
}

function selectDeclaredFallback(module, selectedIds, usedFallbackIds) {
  for (const fallbackId of [...(module.fallback_module_ids || [])]) {
    if (selectedIds.has(fallbackId)) {
      usedFallbackIds.add(fallbackId);
      return;
    }
  }
}

function compatibilityReasons(module, host) {
  const reasons = moduleShapeReasons(module);
  if (reasons.length) return reasons;

  if (!host.execution_kinds.includes(module.execution_kind)) {
    reasons.push(`unsupported execution kind ${module.execution_kind}`);
  }
  for (const contract of sorted(module.requires)) {
    if (!host.contracts.includes(contract)) reasons.push(`missing host contract ${contract}`);
  }
  if (module.compatibility.host_contract_version !== "1") {
    reasons.push(`unsupported host contract version ${module.compatibility.host_contract_version}`);
  }
  if (module.compatibility.platforms && !module.compatibility.platforms.includes(host.platform)) {
    reasons.push(`unsupported platform ${host.platform}`);
  }
  if (module.compatibility.scripting_backends
    && !module.compatibility.scripting_backends.includes(host.scripting_backend)) {
    reasons.push(`unsupported scripting backend ${host.scripting_backend}`);
  }
  for (const binding of sorted(Object.keys(module.compatibility.bindings || {}))) {
    if (!host.loaders.includes(binding)) reasons.push(`missing host loader ${binding}`);
  }
  if (module.artifact?.byte_length !== undefined && host.limits.artifact_bytes !== undefined
    && module.artifact.byte_length > host.limits.artifact_bytes) {
    reasons.push(`artifact exceeds host byte limit ${host.limits.artifact_bytes}`);
  }
  return [...new Set(reasons)].sort();
}

function claimHigherRankedSlots(slotOwners, module, tags) {
  for (const tag of sorted(tags)) {
    if (isHigherRanked(module, slotOwners.get(tag))) slotOwners.set(tag, module);
  }
}

function isHigherRanked(module, existing) {
  return !existing || compareModules(module, existing) < 0;
}

function activeModules(slotOwners) {
  return [...new Map([...slotOwners.values()].map((module) => [module.module_id, module])).values()]
    .sort(compareModules);
}

function selectionConflictReasons(module, selected) {
  const reasons = [];
  for (const existing of selected) {
    if (existing.module_id === module.module_id) continue;
    for (const tag of sorted(module.conflicts)) {
      if (existing.provides.includes(tag)) reasons.push(`conflicts with ${existing.module_id} via ${tag}`);
    }
    for (const tag of sorted(existing.conflicts)) {
      if (module.provides.includes(tag)) reasons.push(`conflicts with ${existing.module_id} via ${tag}`);
    }
  }
  return [...new Set(reasons)].sort();
}

function assertConflictFreeBaseline(selected) {
  for (const module of selected) {
    const reasons = selectionConflictReasons(module, selected);
    if (reasons.length) {
      throw new TypeError(`baseline module ${moduleLabel(module)} is incompatible: ${reasons.join("; ")}`);
    }
  }
}

function moduleShapeReasons(module) {
  if (!module || typeof module !== "object") return ["invalid encounter module"];
  const reasons = [];
  for (const key of Object.keys(module)) {
    if (!MODULE_FIELDS.has(key)) reasons.push(`undeclared field ${key}`);
  }
  if (module.schema_version !== "1") reasons.push("unsupported schema version");
  if (!ID.test(module.module_id || "")) reasons.push("invalid module id");
  if (!Number.isInteger(module.revision) || module.revision < 1) reasons.push("invalid module revision");
  if (!EXECUTION_KINDS.has(module.execution_kind)) reasons.push(`unknown execution kind ${module.execution_kind}`);
  if (!validUniqueArray(module.provides, SEMANTIC_TAG, true)) reasons.push("provides must contain unique semantic tags");
  if (!validUniqueArray(module.requires, CONTRACT_NAME)) reasons.push("requires must contain unique contract names");
  if (!validUniqueArray(module.conflicts, SEMANTIC_TAG)) reasons.push("conflicts must contain unique semantic tags");
  if (!validUniqueArray(module.fallback_module_ids, ID)) reasons.push("fallback_module_ids must contain unique module ids");
  reasons.push(...compatibilityShapeReasons(module.compatibility));
  reasons.push(...qualityShapeReasons(module.quality));
  reasons.push(...provenanceShapeReasons(module.provenance));
  if (module.execution_kind === "recipe"
    && (!module.inline_recipe || typeof module.inline_recipe !== "object" || Array.isArray(module.inline_recipe))) {
    reasons.push("recipe requires inline_recipe");
  }
  if (EXECUTION_KINDS.has(module.execution_kind) && module.execution_kind !== "recipe"
    && !validArtifact(module.artifact)) {
    reasons.push("non-recipe module requires an artifact");
  }
  if (module.execution_kind === "managed_plugin"
    && !nonEmptyString(module.entrypoint, 256)) {
    reasons.push("managed_plugin requires an entrypoint");
  }
  if (isRawBlenderArtifact(module.artifact)) {
    reasons.push("source artifact is not a loadable encounter module");
  }
  return reasons.sort();
}

function compatibilityShapeReasons(compatibility) {
  if (!isObject(compatibility)) return ["missing compatibility"];
  const reasons = [];
  for (const key of Object.keys(compatibility)) {
    if (!["host_contract_version", "platforms", "scripting_backends", "bindings"].includes(key)) {
      reasons.push(`undeclared compatibility field ${key}`);
    }
  }
  if (compatibility.host_contract_version !== "1") reasons.push("unsupported host contract version");
  if (compatibility.platforms !== undefined && !validUniqueArray(compatibility.platforms, nonEmptyString)) {
    reasons.push("compatibility.platforms must contain unique non-empty strings");
  }
  if (compatibility.scripting_backends !== undefined
    && !validUniqueArray(compatibility.scripting_backends, (value) => value === "mono" || value === "il2cpp")) {
    reasons.push("compatibility.scripting_backends must contain supported backends");
  }
  if (compatibility.bindings !== undefined && !validBindings(compatibility.bindings)) {
    reasons.push("compatibility.bindings must map semantic tags to non-empty strings");
  }
  return reasons;
}

function qualityShapeReasons(quality) {
  if (!isObject(quality)) return ["invalid quality"];
  const reasons = [];
  for (const key of Object.keys(quality)) {
    if (!["tier", "score", "evidence"].includes(key)) reasons.push(`undeclared quality field ${key}`);
  }
  if (!Number.isInteger(quality.tier) || quality.tier < 0 || quality.tier > 4) {
    reasons.push("quality.tier must be an integer from 0 through 4");
  }
  if (!Number.isFinite(quality.score) || quality.score < 0) {
    reasons.push("quality.score must be a non-negative finite number");
  }
  if (quality.evidence !== undefined && (!Array.isArray(quality.evidence)
    || quality.evidence.some((value) => typeof value !== "string" || value.length > 512))) {
    reasons.push("quality.evidence must contain strings no longer than 512 characters");
  }
  return reasons;
}

function provenanceShapeReasons(provenance) {
  if (provenance === undefined) return [];
  if (!isObject(provenance)) return ["invalid provenance"];
  const reasons = [];
  for (const key of Object.keys(provenance)) {
    if (!["producer", "created_at", "parent_module_ids", "label"].includes(key)) reasons.push(`undeclared provenance field ${key}`);
  }
  if (!nonEmptyString(provenance.producer, 128) || !validTimestamp(provenance.created_at)) {
    reasons.push("provenance requires producer and created_at");
  }
  if (provenance.parent_module_ids !== undefined && !validUniqueArray(provenance.parent_module_ids, ID)) {
    reasons.push("provenance.parent_module_ids must contain unique module ids");
  }
  if (provenance.label !== undefined && (typeof provenance.label !== "string" || provenance.label.length > 128)) {
    reasons.push("provenance.label must be a string no longer than 128 characters");
  }
  return reasons;
}

function validArtifact(artifact) {
  if (!isObject(artifact)) return false;
  if (Object.keys(artifact).some((key) => !["uri", "sha256", "media_type", "byte_length"].includes(key))) return false;
  if (!validUrl(artifact.uri, 2048) || !SHA256.test(artifact.sha256 || "") || !nonEmptyString(artifact.media_type, 128)) return false;
  return artifact.byte_length === undefined || (Number.isInteger(artifact.byte_length) && artifact.byte_length >= 0);
}

function isRawBlenderArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  const mediaType = String(artifact.media_type || "").toLowerCase();
  if (mediaType.includes("blender")) return true;
  try {
    return new URL(artifact.uri).pathname.toLowerCase().endsWith(".blend");
  } catch {
    return false;
  }
}

function assertHost(host) {
  if (!isObject(host) || host.schema_version !== "1" || !ID.test(host.host_id || "")
    || !nonEmptyString(host.host_build, 128) || !nonEmptyString(host.platform, 64)
    || !["mono", "il2cpp"].includes(host.scripting_backend)
    || !validUniqueArray(host.execution_kinds, (value) => EXECUTION_KINDS.has(value), true)
    || !validUniqueArray(host.loaders, SEMANTIC_TAG) || !validUniqueArray(host.contracts, CONTRACT_NAME)
    || !validHostLimits(host.limits)
    || Object.keys(host).some((key) => !["schema_version", "host_id", "host_build", "platform", "scripting_backend", "execution_kinds", "loaders", "contracts", "limits"].includes(key))) {
    throw new TypeError("host must be a v1 HostCapabilityManifest");
  }
}

function validHostLimits(limits) {
  if (!isObject(limits)) return false;
  if (Object.keys(limits).some((key) => !["memory_mb", "preload_seconds", "artifact_bytes", "actors"].includes(key))) return false;
  if (!positiveInteger(limits.memory_mb) || !nonNegativeInteger(limits.preload_seconds)) return false;
  if (limits.artifact_bytes !== undefined && !nonNegativeInteger(limits.artifact_bytes)) return false;
  return limits.actors === undefined || positiveInteger(limits.actors);
}

function packageShapeReasons(packageRecord) {
  if (!isObject(packageRecord)) return ["invalid package"];
  const reasons = [];
  for (const key of Object.keys(packageRecord)) {
    if (!PACKAGE_FIELDS.has(key)) reasons.push(`undeclared package field ${key}`);
  }
  if (packageRecord.schema_version !== "1") reasons.push("unsupported package schema version");
  if (!ID.test(packageRecord.package_id || "") || !ID.test(packageRecord.encounter_id || "")) reasons.push("invalid package ids");
  if (!Number.isInteger(packageRecord.revision) || packageRecord.revision < 1) reasons.push("invalid package revision");
  if (!["candidate", "preloading", "ready", "frozen", "rejected"].includes(packageRecord.state)) reasons.push("invalid package state");
  if (!validTimestamp(packageRecord.assembled_at)) reasons.push("invalid assembled_at");
  if (packageRecord.state === "frozen" && !validTimestamp(packageRecord.frozen_at)) reasons.push("frozen package requires frozen_at");
  if (!validUniqueArray(packageRecord.module_ids, ID, true)) reasons.push("module_ids must contain unique module ids");
  if (!SHA256.test(packageRecord.manifest_sha256 || "")) reasons.push("invalid manifest_sha256");
  if (!validFallbackProvenance(packageRecord.fallback_provenance)) reasons.push("invalid fallback_provenance");
  if (packageRecord.rejection_reasons !== undefined && (!Array.isArray(packageRecord.rejection_reasons)
    || packageRecord.rejection_reasons.some((value) => typeof value !== "string" || value.length === 0 || value.length > 512))) {
    reasons.push("invalid rejection_reasons");
  }
  return reasons;
}

function validFallbackProvenance(value) {
  return isObject(value)
    && Object.keys(value).every((key) => ["used_fallback", "module_ids"].includes(key))
    && typeof value.used_fallback === "boolean"
    && validUniqueArray(value.module_ids, ID);
}

function nextRevision(previousPackage, encounterId, packageId) {
  if (previousPackage === undefined) return 1;
  if (!previousPackage || packageShapeReasons(previousPackage).length
    || previousPackage.manifest_sha256 !== manifestSha256(withoutManifestHash(previousPackage))
    || previousPackage.encounter_id !== encounterId || previousPackage.package_id !== packageId) {
    throw new TypeError("previousPackage must be a valid immutable package revision for this encounter and package");
  }
  if (previousPackage.state === "frozen") {
    throw new TypeError("a frozen package cannot be revised");
  }
  return previousPackage.revision + 1;
}

function assertId(value, name) {
  if (!ID.test(value || "")) throw new TypeError(`${name} must be a stable lowercase id`);
}

function assertTimestamp(value, name) {
  if (!validTimestamp(value)) {
    throw new TypeError(`${name} must be an ISO-8601 timestamp`);
  }
}

function sortModules(modules) {
  return [...modules].sort(compareModules);
}

function compareModules(left, right) {
  return right.quality?.score - left.quality?.score
    || right.quality?.tier - left.quality?.tier
    || String(left.module_id).localeCompare(String(right.module_id))
    || right.revision - left.revision;
}

function addRejection(rejections, module, reasons) {
  const normalized = [...new Set(reasons)].sort();
  if (!rejections.some((item) => item.module_id === module.module_id && item.revision === module.revision
    && JSON.stringify(item.reasons) === JSON.stringify(normalized))) {
    rejections.push({ module_id: module.module_id, revision: module.revision, reasons: normalized });
  }
}

function compareRejections(left, right) {
  return String(left.module_id).localeCompare(String(right.module_id))
    || left.revision - right.revision
    || JSON.stringify(left.reasons).localeCompare(JSON.stringify(right.reasons));
}

function moduleLabel(module) {
  return `${module.module_id}@${module.revision}`;
}

function packageRejectionReason(module, reason) {
  const prefix = `${String(module.module_id).slice(0, 64)}@${module.revision}: `;
  return `${prefix}${String(reason).slice(0, 512 - prefix.length)}`;
}

function sorted(values) {
  return [...values].sort();
}

function manifestSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutManifestHash(packageRecord) {
  const value = { ...packageRecord };
  delete value.manifest_sha256;
  return value;
}

function validUniqueArray(value, predicate, minimumOne = false) {
  const accepts = predicate instanceof RegExp ? (item) => predicate.test(item) : predicate;
  return Array.isArray(value) && (!minimumOne || value.length > 0)
    && value.every((item) => accepts(item)) && new Set(value).size === value.length;
}

function validBindings(value) {
  return isObject(value) && Object.entries(value).every(([key, item]) => SEMANTIC_TAG.test(key) && nonEmptyString(item, 128));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, maximumLength = Infinity) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validUrl(value, maximumLength = Infinity) {
  if (typeof value !== "string" || value.length > maximumLength) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
