import { createHash } from "node:crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const DOMAIN = new Set(["asset", "animation"]);
const RUNTIME_STATE = new Set(["not_started", "candidate", "accepted", "rejected"]);
const EVIDENCE_TIER = new Set(["source_declared", "source_observed", "accepted_runtime", "player_proven"]);

export class CatalogSeedValidationError extends Error {
  constructor(failures) {
    super(`catalog seed manifest is invalid: ${failures.map((failure) => failure.message).join("; ")}`);
    this.name = "CatalogSeedValidationError";
    this.failures = failures;
  }
}

/** A deterministic, opaque ID that does not expose a filesystem path. */
export function deriveCatalogStableId(domain, stableKey) {
  if (!DOMAIN.has(domain) || typeof stableKey !== "string" || !stableKey.trim()) throw new TypeError("domain and stableKey are required");
  const suffix = sha256(`${domain}\u0000${stableKey}`).slice(0, 12);
  const prefix = `catalog-${domain}-`;
  const maxSlugLength = 64 - prefix.length - suffix.length - 1;
  const slug = stableKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxSlugLength) || "item";
  return `${prefix}${slug}-${suffix}`;
}

/**
 * Validates a manifest without reading the filesystem. Source or runtime bytes
 * are only considered when callers explicitly provide them by manifest locator.
 */
export function inspectCatalogSeedManifest(manifest, { providedFiles = undefined } = {}) {
  const failures = [];
  const files = normaliseProvidedFiles(providedFiles, failures);
  const preview = [];
  if (!isObject(manifest)) return { valid: false, failures: [failure("manifest", "manifest must be an object")], preview };
  required(manifest, ["schema_version", "manifest_id", "revision", "created_at", "provenance", "items"], "manifest", failures);
  exactKeys(manifest, new Set(["schema_version", "manifest_id", "revision", "created_at", "provenance", "items"]), "manifest", failures);
  if (manifest.schema_version !== "1") failures.push(failure("manifest.schema_version", "schema_version must be 1"));
  stableId(manifest.manifest_id, "manifest.manifest_id", failures);
  positive(manifest.revision, "manifest.revision", failures);
  timestamp(manifest.created_at, "manifest.created_at", failures);
  validateManifestProvenance(manifest.provenance, failures);
  if (!Array.isArray(manifest.items) || !manifest.items.length) failures.push(failure("manifest.items", "items must be a non-empty array"));
  const keys = new Set();
  for (const [index, item] of (manifest.items || []).entries()) {
    const path = `manifest.items[${index}]`;
    validateItem(item, path, files, failures, preview);
    if (typeof item?.stable_key === "string") {
      const identity = `${item.domain}:${item.stable_key}`;
      if (keys.has(identity)) failures.push(failure(`${path}.stable_key`, "each domain/stable_key pair must be unique"));
      keys.add(identity);
    }
  }
  return { valid: failures.length === 0, failures, preview: preview.sort((a, b) => a.stable_id.localeCompare(b.stable_id)) };
}

/**
 * Imports a previously inspected manifest. No discovery, directory walk, copy,
 * upload, or host-runtime conversion occurs here.
 */
export function importCatalogSeedManifest({ catalog, manifest, providedFiles = undefined } = {}) {
  if (!catalog || typeof catalog.getAsset !== "function" || typeof catalog.seedRevisions !== "function") {
    throw new TypeError("catalog must implement the catalog seeding port");
  }
  const inspection = inspectCatalogSeedManifest(manifest, { providedFiles });
  if (!inspection.valid) throw new CatalogSeedValidationError(inspection.failures);
  const files = normaliseProvidedFiles(providedFiles, []);
  const manifestSha256 = sha256(canonical(manifest));
  const items = [...manifest.items].sort((a, b) => deriveCatalogStableId(a.domain, a.stable_key).localeCompare(deriveCatalogStableId(b.domain, b.stable_key)));
  const existing = new Map();
  const pending = [];
  for (const item of items) {
    const stableId = deriveCatalogStableId(item.domain, item.stable_key);
    const current = item.domain === "asset" ? catalog.getAsset(stableId) : catalog.getAnimation(stableId);
    if (current?.seedMetadata?.manifestSha256 === manifestSha256) {
      existing.set(stableId, current);
      continue;
    }
    const expectedRevision = current ? current.revision + 1 : 1;
    if (item.catalog_revision !== expectedRevision) {
      throw new CatalogSeedValidationError([failure(`item:${stableId}`, `catalog_revision must be ${expectedRevision}; imports are append-only`)]);
    }
    const evidenceTier = actualEvidenceTier(item, files);
    const record = toCatalogRecord({ manifest, manifestSha256, item, stableId, current, evidenceTier });
    pending.push({ domain: item.domain, stableId, record });
  }
  const appended = catalog.seedRevisions(pending.map(({ domain, record }) => ({ domain, record })));
  const appendedByStableId = new Map(pending.map(({ stableId }, index) => [stableId, appended[index]]));
  const imported = items.map((item) => {
    const stableId = deriveCatalogStableId(item.domain, item.stable_key);
    return existing.get(stableId) || appendedByStableId.get(stableId);
  });
  return { manifest_id: manifest.manifest_id, manifest_sha256: manifestSha256, imported, preview: inspection.preview };
}

function toCatalogRecord({ manifest, manifestSha256, item, stableId, current, evidenceTier }) {
  const runtimeArtifact = item.runtime.artifact && {
    uri: item.runtime.artifact.locator,
    sha256: item.runtime.artifact.sha256,
    mediaType: item.runtime.artifact.media_type,
  };
  const provenance = {
    producer: manifest.provenance.producer,
    createdAt: item.created_at,
    label: `catalog seed manifest ${manifest.manifest_id}; source locator supplied explicitly`,
    ...(current ? { parentRefs: [{ domain: item.domain, stableId, revision: current.revision, contentSha256: current.contentSha256 }] } : {}),
  };
  const common = {
    revision: current?.revision || 1,
    createdAt: item.created_at,
    functionalTags: item.functional_tags,
    aestheticTags: item.aesthetic_tags,
    compatibility: {
      platforms: item.host_compatibility.platforms,
      loaders: item.host_compatibility.loaders,
      contracts: item.host_compatibility.contracts,
      bindingIds: item.host_compatibility.binding_ids,
    },
    sourceReceipt: {
      receiptId: `${manifest.manifest_id}:${stableId}:source`,
      uri: item.source.locator,
      sha256: item.source.sha256,
      receivedAt: item.created_at,
    },
    sourceAcceptanceState: "recorded",
    runtimeAcceptanceState: item.runtime.format_state === "not_started" ? "candidate" : item.runtime.format_state,
    ...(runtimeArtifact ? { runtimeArtifact } : {}),
    provenance,
    seedMetadata: {
      manifestId: manifest.manifest_id,
      manifestRevision: manifest.revision,
      manifestSha256,
      sourceLocator: item.source.locator,
      sourceFormat: item.source.format,
      sourceFormatState: item.source.format_state,
      runtimeFormat: item.runtime.format,
      runtimeState: item.runtime.format_state,
      evidenceTier,
      ...(item.evidence?.player_evidence ? { playerEvidence: item.evidence.player_evidence } : {}),
      ownershipNote: manifest.provenance.ownership_note,
      licenseNote: manifest.provenance.license_note,
      rigCompatibility: {
        skeletonId: item.rig_compatibility.skeleton_id,
        skeletonSha256: item.rig_compatibility.skeleton_sha256,
        bindingId: item.rig_compatibility.binding_id,
        modelBindingId: item.rig_compatibility.model_binding_id,
        animationCompatibility: item.rig_compatibility.animation_compatibility,
      },
    },
  };
  if (item.domain === "asset") return { ...common, assetId: stableId };
  return {
    ...common,
    animationId: stableId,
    kind: item.animation.kind,
    durationMs: item.animation.duration_ms,
    rigBinding: { rigBindingId: item.rig_compatibility.binding_id, modelBindingId: item.rig_compatibility.model_binding_id },
  };
}

function validateItem(item, path, files, failures, preview) {
  if (!isObject(item)) { failures.push(failure(path, "item must be an object")); return; }
  const common = ["stable_key", "domain", "catalog_revision", "created_at", "source", "runtime", "host_compatibility", "rig_compatibility", "functional_tags", "aesthetic_tags"];
  const allowed = new Set([...common, "evidence", "animation"]);
  exactKeys(item, allowed, path, failures);
  required(item, common, path, failures);
  if (typeof item.stable_key !== "string" || !item.stable_key.trim()) failures.push(failure(`${path}.stable_key`, "stable_key is required"));
  if (!DOMAIN.has(item.domain)) failures.push(failure(`${path}.domain`, "domain must be asset or animation"));
  positive(item.catalog_revision, `${path}.catalog_revision`, failures);
  timestamp(item.created_at, `${path}.created_at`, failures);
  validateSource(item.source, `${path}.source`, files, failures);
  validateRuntime(item.runtime, `${path}.runtime`, files, failures);
  validateCompatibility(item.host_compatibility, `${path}.host_compatibility`, failures);
  validateRig(item.rig_compatibility, `${path}.rig_compatibility`, failures);
  tags(item.functional_tags, `${path}.functional_tags`, failures);
  tags(item.aesthetic_tags, `${path}.aesthetic_tags`, failures);
  if (item.domain === "animation") validateAnimation(item.animation, `${path}.animation`, failures);
  else if (item.animation !== undefined) failures.push(failure(`${path}.animation`, "asset entries cannot declare animation"));
  const requested = item.evidence?.tier;
  if (item.evidence !== undefined && (!isObject(item.evidence) || Object.keys(item.evidence).some((key) => !["tier", "player_evidence"].includes(key)) || !EVIDENCE_TIER.has(requested))) failures.push(failure(`${path}.evidence`, "evidence.tier is invalid"));
  if (requested !== "player_proven" && item.evidence?.player_evidence !== undefined) failures.push(failure(`${path}.evidence.player_evidence`, "player_evidence is allowed only for player_proven evidence"));
  const observedSource = hasMatchingFile(files, item?.source?.locator, item?.source?.sha256);
  const observedRuntime = hasMatchingFile(files, item?.runtime?.artifact?.locator, item?.runtime?.artifact?.sha256);
  if (item?.runtime?.format_state === "accepted" && !observedRuntime) failures.push(failure(`${path}.runtime`, "accepted runtime requires a matching explicit provided runtime file"));
  if (["source_observed", "accepted_runtime", "player_proven"].includes(requested) && !observedSource) failures.push(failure(`${path}.evidence`, "this evidence tier requires a matching explicit provided file for source"));
  if (["accepted_runtime", "player_proven"].includes(requested) && !observedRuntime) failures.push(failure(`${path}.evidence`, "this evidence tier requires a matching explicit provided file for runtime artifact"));
  if (requested === "player_proven") validatePlayerEvidence(item.evidence?.player_evidence, `${path}.evidence.player_evidence`, failures);
  if (typeof item?.stable_key === "string" && DOMAIN.has(item.domain)) {
    preview.push({
      stable_id: deriveCatalogStableId(item.domain, item.stable_key), domain: item.domain, revision: item.catalog_revision,
      source_format: item?.source?.format, runtime_format: item?.runtime?.format, runtime_state: item?.runtime?.format_state,
      evidence_tier: requested === "player_proven" ? "player_proven" : observedRuntime && item?.runtime?.format_state === "accepted" ? "accepted_runtime" : observedSource ? "source_observed" : "source_declared",
      thumbnail_state: "not_provided",
    });
  }
}

function validateManifestProvenance(value, failures) {
  if (!isObject(value)) { failures.push(failure("manifest.provenance", "provenance is required")); return; }
  exactKeys(value, new Set(["producer", "source_locator", "ownership_note", "license_note"]), "manifest.provenance", failures);
  required(value, ["producer", "source_locator", "ownership_note", "license_note"], "manifest.provenance", failures);
  for (const key of ["producer", "source_locator", "ownership_note", "license_note"]) if (typeof value[key] !== "string" || !value[key].trim()) failures.push(failure(`manifest.provenance.${key}`, `${key} is required`));
}

function validateSource(value, path, files, failures) {
  if (!isObject(value)) { failures.push(failure(path, "source is required")); return; }
  exactKeys(value, new Set(["locator", "sha256", "media_type", "format", "format_state"]), path, failures);
  required(value, ["locator", "sha256", "media_type", "format", "format_state"], path, failures);
  text(value.locator, `${path}.locator`, failures); hash(value.sha256, `${path}.sha256`, failures); text(value.media_type, `${path}.media_type`, failures); text(value.format, `${path}.format`, failures);
  if (!new Set(["declared", "available", "rejected"]).has(value.format_state)) failures.push(failure(`${path}.format_state`, "source format_state is invalid"));
  if (files.has(value.locator) && !hasMatchingFile(files, value.locator, value.sha256)) failures.push(failure(path, "explicit provided source file sha256 does not match manifest"));
}

function validateRuntime(value, path, files, failures) {
  if (!isObject(value)) { failures.push(failure(path, "runtime is required")); return; }
  exactKeys(value, new Set(["format", "format_state", "artifact", "acceptance"]), path, failures);
  required(value, ["format", "format_state"], path, failures);
  text(value.format, `${path}.format`, failures);
  if (!RUNTIME_STATE.has(value.format_state)) failures.push(failure(`${path}.format_state`, "runtime format_state is invalid"));
  if (value.artifact !== undefined) {
    if (!isObject(value.artifact)) failures.push(failure(`${path}.artifact`, "runtime artifact must be an object"));
    else { exactKeys(value.artifact, new Set(["locator", "sha256", "media_type"]), `${path}.artifact`, failures); required(value.artifact, ["locator", "sha256", "media_type"], `${path}.artifact`, failures); text(value.artifact.locator, `${path}.artifact.locator`, failures); hash(value.artifact.sha256, `${path}.artifact.sha256`, failures); text(value.artifact.media_type, `${path}.artifact.media_type`, failures); if (files.has(value.artifact.locator) && !hasMatchingFile(files, value.artifact.locator, value.artifact.sha256)) failures.push(failure(`${path}.artifact`, "explicit provided runtime file sha256 does not match manifest")); }
  }
  if (value.format_state === "accepted") {
    if (!value.artifact) failures.push(failure(path, "accepted runtime requires runtime artifact"));
    if (!isObject(value.acceptance)) failures.push(failure(path, "accepted runtime requires host acceptance receipt"));
    else { exactKeys(value.acceptance, new Set(["accepted_by", "accepted_at", "host_build"]), `${path}.acceptance`, failures); required(value.acceptance, ["accepted_by", "accepted_at", "host_build"], `${path}.acceptance`, failures); text(value.acceptance.accepted_by, `${path}.acceptance.accepted_by`, failures); timestamp(value.acceptance.accepted_at, `${path}.acceptance.accepted_at`, failures); text(value.acceptance.host_build, `${path}.acceptance.host_build`, failures); }
  } else if (value.acceptance !== undefined) failures.push(failure(`${path}.acceptance`, "only accepted runtime may include host acceptance"));
}

function validateCompatibility(value, path, failures) {
  if (!isObject(value)) { failures.push(failure(path, "host compatibility is required")); return; }
  exactKeys(value, new Set(["platforms", "loaders", "contracts", "binding_ids"]), path, failures);
  required(value, ["platforms", "loaders", "contracts", "binding_ids"], path, failures);
  for (const field of ["platforms", "loaders", "contracts", "binding_ids"]) strings(value[field], `${path}.${field}`, failures);
}

function validateRig(value, path, failures) {
  if (!isObject(value)) { failures.push(failure(path, "rig compatibility is required")); return; }
  exactKeys(value, new Set(["skeleton_id", "skeleton_sha256", "binding_id", "model_binding_id", "animation_compatibility"]), path, failures);
  required(value, ["skeleton_id", "binding_id", "model_binding_id", "animation_compatibility"], path, failures);
  for (const field of ["skeleton_id", "binding_id", "model_binding_id", "animation_compatibility"]) text(value[field], `${path}.${field}`, failures);
  if (value.skeleton_sha256 !== undefined) hash(value.skeleton_sha256, `${path}.skeleton_sha256`, failures);
  if (!new Set(["unknown", "compatible", "incompatible"]).has(value.animation_compatibility)) failures.push(failure(`${path}.animation_compatibility`, "animation compatibility is invalid"));
}

function validateAnimation(value, path, failures) {
  if (!isObject(value)) { failures.push(failure(path, "animation metadata is required")); return; }
  exactKeys(value, new Set(["kind", "duration_ms"]), path, failures);
  required(value, ["kind", "duration_ms"], path, failures);
  if (!new Set(["clip", "recipe"]).has(value.kind)) failures.push(failure(`${path}.kind`, "animation kind must be clip or recipe"));
  if (!Number.isInteger(value.duration_ms) || value.duration_ms < 0) failures.push(failure(`${path}.duration_ms`, "duration_ms must be non-negative integer"));
}
function validatePlayerEvidence(value, path, failures) {
  if (!isObject(value)) { failures.push(failure(path, "player_proven evidence requires an explicit player receipt")); return; }
  exactKeys(value, new Set(["observer", "observed_at", "session_locator", "assertion_sha256"]), path, failures);
  required(value, ["observer", "observed_at", "session_locator", "assertion_sha256"], path, failures);
  text(value.observer, `${path}.observer`, failures); timestamp(value.observed_at, `${path}.observed_at`, failures); text(value.session_locator, `${path}.session_locator`, failures); hash(value.assertion_sha256, `${path}.assertion_sha256`, failures);
}

function actualEvidenceTier(item, files) {
  if (item.evidence?.tier === "player_proven") return "player_proven";
  if (item.runtime.format_state === "accepted" && hasMatchingFile(files, item.runtime.artifact?.locator, item.runtime.artifact?.sha256)) return "accepted_runtime";
  if (hasMatchingFile(files, item.source.locator, item.source.sha256)) return "source_observed";
  return "source_declared";
}
function normaliseProvidedFiles(input, failures) {
  if (input === undefined) return new Map();
  const entries = input instanceof Map ? [...input.entries()] : isObject(input) ? Object.entries(input) : [];
  if (!(input instanceof Map) && !isObject(input)) failures.push(failure("providedFiles", "providedFiles must be a Map or object keyed by manifest locator"));
  const files = new Map();
  for (const [locator, value] of entries) {
    if (typeof locator !== "string" || !locator) { failures.push(failure("providedFiles", "provided file locator must be a string")); continue; }
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === "string")) { failures.push(failure(`providedFiles.${locator}`, "provided file must be bytes or text")); continue; }
    files.set(locator, Buffer.from(value));
  }
  return files;
}
function hasMatchingFile(files, locator, digest) { return typeof locator === "string" && HASH.test(digest || "") && files.has(locator) && sha256(files.get(locator)) === digest; }
function canonical(value) { return JSON.stringify(sort(value)); }
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!isObject(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function failure(path, message) { return { path, message }; }
function exactKeys(value, allowed, path, failures) { if (isObject(value)) for (const key of Object.keys(value)) if (!allowed.has(key)) failures.push(failure(`${path}.${key}`, "field is not allowed")); }
function required(value, fields, path, failures) { if (!isObject(value)) return; for (const key of fields) if (value[key] === undefined) failures.push(failure(`${path}.${key}`, "field is required")); }
function text(value, path, failures) { if (typeof value !== "string" || !value.trim()) failures.push(failure(path, "non-empty string is required")); }
function stableId(value, path, failures) { if (!ID.test(value || "")) failures.push(failure(path, "must be a stable lowercase id")); }
function hash(value, path, failures) { if (!HASH.test(value || "")) failures.push(failure(path, "must be sha256")); }
function positive(value, path, failures) { if (!Number.isInteger(value) || value < 1) failures.push(failure(path, "must be a positive integer")); }
function timestamp(value, path, failures) { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) failures.push(failure(path, "must be ISO-8601")); }
function tags(value, path, failures) { if (!Array.isArray(value) || new Set(value).size !== value.length || value.some((tag) => !TAG.test(tag || ""))) failures.push(failure(path, "must be unique semantic tags")); }
function strings(value, path, failures) { if (!Array.isArray(value) || new Set(value).size !== value.length || value.some((item) => typeof item !== "string" || !item)) failures.push(failure(path, "must be a unique array of non-empty strings")); }
