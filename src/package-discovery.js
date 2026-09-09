const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const CONTRACT = /^[a-z][a-z0-9_.-]{0,95}\.v[1-9][0-9]*$/;
const EXECUTION_KINDS = new Set(["recipe", "runtime_asset", "managed_plugin", "remote_logic"]);

/**
 * The package-discovery module is the only seam between immutable accepted
 * catalog/assembly evidence and a host-loadable manifest. It deliberately has
 * no fixture or local-process fallback: a caller either receives a signed
 * package whose complete artifact lineage agrees, or an honest no-package.
 */
export async function canonicalSha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return hex(digest);
}

export function validDiscoveryRequest(value) {
  return exactKeys(value, ["schema_version", "request_id", "idempotency_key", "host_capabilities"])
    && ["1", "2"].includes(value.schema_version) && validId(value.request_id) && IDEMPOTENCY_KEY.test(value.idempotency_key || "")
    && validHostCapabilities(value.host_capabilities) && value.schema_version === value.host_capabilities.schema_version;
}

export async function acceptedCatalogRevision(value) {
  if (value?.schema_version === "2") return acceptedCatalogRevisionV2(value);
  if (!exactKeys(value, ["schema_version", "catalog_revision_id", "encounter_id", "revision", "state", "created_at", "acceptance", "modules", "catalog_sha256"])
    || value.schema_version !== "1" || !validId(value.catalog_revision_id) || !validId(value.encounter_id)
    || !positiveInteger(value.revision) || value.state !== "accepted" || !validTimestamp(value.created_at)
    || !validAcceptance(value.acceptance) || !Array.isArray(value.modules) || !value.modules.length
    || !value.modules.every(validCatalogModule) || !unique(value.modules.map((module) => `${module.module_id}@${module.revision}`))
    || !SHA256.test(value.catalog_sha256 || "")) return null;
  const withoutHash = { ...value };
  delete withoutHash.catalog_sha256;
  if (value.catalog_sha256 !== await canonicalSha256(withoutHash)) return null;
  return frozenClone(value);
}

export async function acceptedAssemblyReceipt(value) {
  if (value?.schema_version === "2") return acceptedAssemblyReceiptV2(value);
  if (!exactKeys(value, ["schema_version", "receipt_id", "encounter_id", "package_id", "package_revision", "package_manifest_sha256", "catalog_revision_id", "catalog_revision_sha256", "assembled_at", "acceptance", "selected_modules", "assembly_manifest", "receipt_sha256"])
    || value.schema_version !== "1" || !validId(value.receipt_id) || !validId(value.encounter_id) || !validId(value.package_id)
    || !positiveInteger(value.package_revision) || !SHA256.test(value.package_manifest_sha256 || "")
    || !validId(value.catalog_revision_id) || !SHA256.test(value.catalog_revision_sha256 || "")
    || !validTimestamp(value.assembled_at) || !validAcceptance(value.acceptance)
    || !Array.isArray(value.selected_modules) || !value.selected_modules.length || !value.selected_modules.every(validSelectedModule)
    || !unique(value.selected_modules.map((module) => `${module.module_id}@${module.revision}`))
    || !SHA256.test(value.receipt_sha256 || "") || !(await validGlbAssemblyManifest(value.assembly_manifest))) return null;
  const withoutHash = { ...value };
  delete withoutHash.receipt_sha256;
  if (value.receipt_sha256 !== await canonicalSha256(withoutHash)) return null;
  return frozenClone(value);
}

async function acceptedCatalogRevisionV2(value) {
  if (!exactKeys(value, ["schema_version", "catalog_revision_id", "encounter_id", "revision", "state", "created_at", "acceptance", "modules", "catalog_sha256"])
    || !validId(value.catalog_revision_id) || !validId(value.encounter_id) || !positiveInteger(value.revision)
    || value.state !== "accepted" || !validTimestamp(value.created_at) || !validAcceptance(value.acceptance)
    || !Array.isArray(value.modules) || !value.modules.length || !value.modules.every(validCatalogModuleV2)
    || !unique(value.modules.map((module) => `${module.module_id}@${module.revision}`)) || !SHA256.test(value.catalog_sha256 || "")) return null;
  const withoutHash = { ...value };
  delete withoutHash.catalog_sha256;
  return value.catalog_sha256 === await canonicalSha256(withoutHash) ? frozenClone(value) : null;
}

async function acceptedAssemblyReceiptV2(value) {
  if (!exactKeys(value, ["schema_version", "receipt_id", "encounter_id", "package_id", "package_revision", "package_manifest_sha256", "catalog_revision_id", "catalog_revision_sha256", "assembled_at", "acceptance", "selected_modules", "runtime_artifact_manifest", "receipt_sha256"])
    || !validId(value.receipt_id) || !validId(value.encounter_id) || !validId(value.package_id)
    || !positiveInteger(value.package_revision) || !SHA256.test(value.package_manifest_sha256 || "")
    || !validId(value.catalog_revision_id) || !SHA256.test(value.catalog_revision_sha256 || "")
    || !validTimestamp(value.assembled_at) || !validAcceptance(value.acceptance)
    || !Array.isArray(value.selected_modules) || !value.selected_modules.length || !value.selected_modules.every(validSelectedModuleV2)
    || !unique(value.selected_modules.map((module) => `${module.module_id}@${module.revision}`))
    || !SHA256.test(value.receipt_sha256 || "") || !(await validRuntimeArtifactManifest(value.runtime_artifact_manifest))) return null;
  const withoutHash = { ...value };
  delete withoutHash.receipt_sha256;
  return value.receipt_sha256 === await canonicalSha256(withoutHash) ? frozenClone(value) : null;
}

async function compatibleFrozenPackageV2({ packageRecord, catalogRevision, assemblyReceipt, hostCapabilities }) {
  if (catalogRevision?.schema_version !== "2" || assemblyReceipt?.schema_version !== "2" || !validV2HostCapabilities(hostCapabilities)
    || packageRecord.encounter_id !== catalogRevision.encounter_id || packageRecord.encounter_id !== assemblyReceipt.encounter_id
    || packageRecord.package_id !== assemblyReceipt.package_id || packageRecord.revision !== assemblyReceipt.package_revision
    || packageRecord.manifest_sha256 !== assemblyReceipt.package_manifest_sha256
    || catalogRevision.catalog_revision_id !== assemblyReceipt.catalog_revision_id
    || catalogRevision.catalog_sha256 !== assemblyReceipt.catalog_revision_sha256
    || packageRecord.module_ids.length !== assemblyReceipt.selected_modules.length) return false;
  const catalogModules = new Map(catalogRevision.modules.map((module) => [`${module.module_id}@${module.revision}`, module]));
  const receiptModules = new Map(assemblyReceipt.selected_modules.map((module) => [`${module.module_id}@${module.revision}`, module]));
  if (receiptModules.size !== assemblyReceipt.selected_modules.length || !sameRuntimeArtifactModules(assemblyReceipt.selected_modules, assemblyReceipt.runtime_artifact_manifest.artifacts)) return false;
  for (const moduleId of packageRecord.module_ids) {
    const receiptModule = [...receiptModules.values()].find((item) => item.module_id === moduleId);
    const catalogModule = receiptModule && catalogModules.get(`${moduleId}@${receiptModule.revision}`);
    if (!catalogModule || !compatible(catalogModule.compatibility, hostCapabilities)
      || !sameRuntimeArtifacts(catalogModule.runtime_artifacts, receiptModule.runtime_artifacts)
      || !negotiateRuntimeArtifact(receiptModule.runtime_artifacts, hostCapabilities)) return false;
  }
  return true;
}

function negotiatedReceiptArtifacts(receipt, host) {
  const artifacts = receipt.selected_modules.map((module) => {
    const artifact = negotiateRuntimeArtifact(module.runtime_artifacts, host);
    return artifact && { module_id: module.module_id, revision: module.revision, ...artifact };
  });
  return artifacts.every(Boolean) ? artifacts.sort((left, right) => left.module_id.localeCompare(right.module_id) || left.revision - right.revision) : null;
}

function negotiateRuntimeArtifact(artifacts, host) {
  return [...artifacts].sort(compareRuntimeArtifacts).find((artifact) => host.artifact_formats.some((format) =>
    format.media_type === artifact.media_type && format.loader && artifact.compatibility.loaders.includes(format.loader)
      && artifact.compatibility.platforms.includes(format.platform) && artifact.compatibility.builds.includes(format.build)
      && format.platform === host.platform && format.build === host.host_build
      && host.loaders.includes(format.loader)
      && (host.limits.artifact_bytes === undefined || artifact.byte_length <= host.limits.artifact_bytes))) || null;
}

function compareRuntimeArtifacts(left, right) {
  return left.media_type.localeCompare(right.media_type) || left.uri.localeCompare(right.uri) || left.sha256.localeCompare(right.sha256);
}

function sameRuntimeArtifactModules(left, right) {
  return left.length === right.length && left.every((module) => right.some((other) => module.module_id === other.module_id
    && module.revision === other.revision && sameRuntimeArtifacts(module.runtime_artifacts, other.runtime_artifacts)));
}

function sameRuntimeArtifacts(left, right) {
  return left.length === right.length && left.every((artifact) => right.some((other) => canonicalJson(artifact) === canonicalJson(other)));
}

export async function compatibleFrozenPackage({ packageRecord, catalogRevision, assemblyReceipt, hostCapabilities }) {
  if (!packageRecord || !["ready", "frozen"].includes(packageRecord.state) || !validHostCapabilities(hostCapabilities)) return false;
  if (catalogRevision?.schema_version === "2" || assemblyReceipt?.schema_version === "2") {
    return compatibleFrozenPackageV2({ packageRecord, catalogRevision, assemblyReceipt, hostCapabilities });
  }
  if (hostCapabilities.schema_version !== "1") return false;
  if (packageRecord.encounter_id !== catalogRevision.encounter_id || packageRecord.encounter_id !== assemblyReceipt.encounter_id
    || packageRecord.package_id !== assemblyReceipt.package_id || packageRecord.revision !== assemblyReceipt.package_revision
    || packageRecord.manifest_sha256 !== assemblyReceipt.package_manifest_sha256
    || catalogRevision.catalog_revision_id !== assemblyReceipt.catalog_revision_id
    || catalogRevision.catalog_sha256 !== assemblyReceipt.catalog_revision_sha256) return false;
  const catalogModules = new Map(catalogRevision.modules.map((module) => [`${module.module_id}@${module.revision}`, module]));
  const receiptModules = new Map(assemblyReceipt.selected_modules.map((module) => [`${module.module_id}@${module.revision}`, module]));
  if (packageRecord.module_ids.length !== receiptModules.size) return false;
  for (const moduleId of packageRecord.module_ids) {
    const receiptModule = [...receiptModules.values()].find((item) => item.module_id === moduleId);
    if (!receiptModule) return false;
    const catalogModule = catalogModules.get(`${moduleId}@${receiptModule.revision}`);
    if (!catalogModule || !compatible(catalogModule.compatibility, hostCapabilities) || !sameArtifact(catalogModule.artifact, receiptModule.artifact)) return false;
  }
  const assemblyArtifactHashes = new Set(assemblyReceipt.assembly_manifest.fragments.map((fragment) => fragment.runtime_artifact.sha256));
  return [...receiptModules.values()].every((module) => assemblyArtifactHashes.has(module.artifact.sha256));
}

export async function createSignedManifest({ packageRecord, catalogRevision, assemblyReceipt, request, hostCapabilities, signingPrivateKey, issuedAt }) {
  if (!signingPrivateKey || typeof signingPrivateKey !== "string" || !validTimestamp(issuedAt)) return null;
  if (request?.schema_version === "2") {
    if (catalogRevision?.schema_version !== "2" || assemblyReceipt?.schema_version !== "2" || !validV2HostCapabilities(hostCapabilities)) return null;
    const artifacts = negotiatedReceiptArtifacts(assemblyReceipt, hostCapabilities);
    if (!artifacts) return null;
    const manifest = {
      schema_version: "2",
      manifest_id: `discovery-${request.request_id.slice(0, 48)}`,
      encounter_id: packageRecord.encounter_id,
      request_id: request.request_id,
      package_id: packageRecord.package_id,
      package_revision: packageRecord.revision,
      package_manifest_sha256: packageRecord.manifest_sha256,
      assembly_receipt_id: assemblyReceipt.receipt_id,
      assembly_receipt_sha256: assemblyReceipt.receipt_sha256,
      catalog_revision_id: catalogRevision.catalog_revision_id,
      catalog_revision_sha256: catalogRevision.catalog_sha256,
      artifacts,
      issued_at: issuedAt,
    };
    const signature = await ed25519Sign(canonicalJson(manifest), signingPrivateKey);
    return signature ? frozenClone({ ...manifest, signature: { algorithm: "Ed25519", key_id: "package-discovery-ed25519-v1", value: signature } }) : null;
  }
  const artifacts = assemblyReceipt.selected_modules
    .map((module) => ({ module_id: module.module_id, revision: module.revision, ...module.artifact }))
    .sort((left, right) => left.module_id.localeCompare(right.module_id) || left.revision - right.revision);
  const manifest = {
    schema_version: "1",
    manifest_id: `discovery-${request.request_id.slice(0, 48)}`,
    encounter_id: packageRecord.encounter_id,
    request_id: request.request_id,
    package_id: packageRecord.package_id,
    package_revision: packageRecord.revision,
    package_manifest_sha256: packageRecord.manifest_sha256,
    assembly_receipt_id: assemblyReceipt.receipt_id,
    assembly_receipt_sha256: assemblyReceipt.receipt_sha256,
    catalog_revision_id: catalogRevision.catalog_revision_id,
    catalog_revision_sha256: catalogRevision.catalog_sha256,
    artifacts,
    issued_at: issuedAt,
  };
  const signature = await ed25519Sign(canonicalJson(manifest), signingPrivateKey);
  if (!signature) return null;
  return frozenClone({ ...manifest, signature: { algorithm: "Ed25519", key_id: "package-discovery-ed25519-v1", value: signature } });
}

export function selectNewestCompatible(records) {
  return [...records]
    .filter((record) => record?.compatible === true)
    .sort((left, right) => right.catalog_revision.revision - left.catalog_revision.revision
      || right.package_record.revision - left.package_record.revision
      || left.package_record.package_id.localeCompare(right.package_record.package_id))[0];
}

export function noPackageResponse(encounterId, requestId, schemaVersion = "1") {
  return { schema_version: schemaVersion, status: "no_package", encounter_id: encounterId, request_id: requestId, reason: "no_accepted_compatible_package" };
}

function validHostCapabilities(value) { return validV1HostCapabilities(value) || validV2HostCapabilities(value); }

function validV1HostCapabilities(value) {
  const fields = ["schema_version", "host_id", "host_build", "platform", "scripting_backend", "execution_kinds", "loaders", "contracts", "limits"];
  if (!exactKeys(value, fields) || value.schema_version !== "1" || !validId(value.host_id)
    || !nonEmpty(value.host_build, 128) || !nonEmpty(value.platform, 64) || !["mono", "il2cpp"].includes(value.scripting_backend)
    || !validUniqueArray(value.execution_kinds, (kind) => EXECUTION_KINDS.has(kind), true)
    || !validUniqueArray(value.loaders, (loader) => TAG.test(loader))
    || !validUniqueArray(value.contracts, (contract) => CONTRACT.test(contract))) return false;
  return exactKeys(value.limits, ["memory_mb", "preload_seconds", "artifact_bytes", "actors"].filter((key) => key in (value.limits || {})))
    && positiveInteger(value.limits?.memory_mb) && nonNegativeInteger(value.limits?.preload_seconds)
    && (value.limits.artifact_bytes === undefined || nonNegativeInteger(value.limits.artifact_bytes))
    && (value.limits.actors === undefined || positiveInteger(value.limits.actors));
}

function validV2HostCapabilities(value) {
  const fields = ["schema_version", "host_id", "host_build", "platform", "scripting_backend", "execution_kinds", "loaders", "contracts", "limits", "artifact_formats"];
  if (!exactKeys(value, fields) || value.schema_version !== "2" || !validId(value.host_id)
    || !nonEmpty(value.host_build, 128) || !nonEmpty(value.platform, 64) || !["mono", "il2cpp"].includes(value.scripting_backend)
    || !validUniqueArray(value.execution_kinds, (kind) => EXECUTION_KINDS.has(kind), true)
    || !validUniqueArray(value.loaders, (loader) => TAG.test(loader))
    || !validUniqueArray(value.contracts, (contract) => CONTRACT.test(contract))
    || !validUniqueArray(value.artifact_formats, validArtifactFormat, true)) return false;
  return validLimits(value.limits);
}

function validArtifactFormat(value) {
  return exactKeys(value, ["media_type", "loader", "platform", "build"])
    && nonEmpty(value.media_type, 128) && TAG.test(value.loader || "")
    && nonEmpty(value.platform, 64) && nonEmpty(value.build, 128);
}

function validLimits(value) {
  return exactKeys(value, ["memory_mb", "preload_seconds", "artifact_bytes", "actors"].filter((key) => key in (value || {})))
    && positiveInteger(value?.memory_mb) && nonNegativeInteger(value?.preload_seconds)
    && (value.artifact_bytes === undefined || nonNegativeInteger(value.artifact_bytes))
    && (value.actors === undefined || positiveInteger(value.actors));
}

function validCatalogModule(value) {
  return exactKeys(value, ["module_id", "revision", "artifact", "compatibility"])
    && validId(value.module_id) && positiveInteger(value.revision) && validArtifact(value.artifact) && validCompatibility(value.compatibility);
}

function validCatalogModuleV2(value) {
  return exactKeys(value, ["module_id", "revision", "runtime_artifacts", "compatibility"])
    && validId(value.module_id) && positiveInteger(value.revision) && validRuntimeArtifacts(value.runtime_artifacts)
    && validCompatibility(value.compatibility);
}

function validSelectedModule(value) {
  return exactKeys(value, ["module_id", "revision", "artifact"])
    && validId(value.module_id) && positiveInteger(value.revision) && validArtifact(value.artifact);
}

function validSelectedModuleV2(value) {
  return exactKeys(value, ["module_id", "revision", "runtime_artifacts"])
    && validId(value.module_id) && positiveInteger(value.revision) && validRuntimeArtifacts(value.runtime_artifacts);
}

function validArtifact(value) {
  if (!exactKeys(value, ["uri", "sha256", "media_type", "byte_length"].filter((key) => key in (value || {})))
    || typeof value?.uri !== "string" || value.uri.length > 2048 || !SHA256.test(value.sha256 || "")
    || !nonEmpty(value.media_type, 128) || (value.byte_length !== undefined && !nonNegativeInteger(value.byte_length))) return false;
  if (value.media_type !== "model/gltf-binary") return false;
  try {
    const url = new URL(value.uri);
    const locator = url.href.toLowerCase();
    return url.protocol === "https:" && !locator.includes("fixture") && !locator.includes("sprinter") && !url.pathname.toLowerCase().endsWith(".blend");
  } catch { return false; }
}

function validRuntimeArtifacts(value) {
  return validUniqueArray(value, validRuntimeArtifact, true);
}

function validRuntimeArtifact(value) {
  if (!exactKeys(value, ["uri", "sha256", "media_type", "byte_length", "compatibility"])
    || typeof value?.uri !== "string" || value.uri.length > 2048 || !SHA256.test(value.sha256 || "")
    || !nonEmpty(value.media_type, 128) || !nonNegativeInteger(value.byte_length)
    || !validArtifactCompatibility(value.compatibility)) return false;
  try {
    const url = new URL(value.uri);
    const locator = url.href.toLowerCase();
    return url.protocol === "https:" && !locator.includes("fixture") && !locator.includes("sprinter") && !url.pathname.toLowerCase().endsWith(".blend");
  } catch { return false; }
}

function validArtifactCompatibility(value) {
  return exactKeys(value, ["platforms", "builds", "loaders"])
    && validUniqueArray(value.platforms, (platform) => nonEmpty(platform, 64), true)
    && validUniqueArray(value.builds, (build) => nonEmpty(build, 128), true)
    && validUniqueArray(value.loaders, (loader) => TAG.test(loader), true);
}

async function validRuntimeArtifactManifest(value) {
  if (!exactKeys(value, ["schema_version", "profile", "artifact_set_id", "artifacts", "manifest_sha256"])
    || value.schema_version !== "2" || value.profile !== "runtime-artifact-manifest.v2" || !validId(value.artifact_set_id)
    || !Array.isArray(value.artifacts) || !value.artifacts.length || !value.artifacts.every(validSelectedModuleV2)
    || !unique(value.artifacts.map((module) => `${module.module_id}@${module.revision}`)) || !SHA256.test(value.manifest_sha256 || "")) return false;
  const withoutHash = { ...value };
  delete withoutHash.manifest_sha256;
  return value.manifest_sha256 === await canonicalSha256(withoutHash);
}

function validCompatibility(value) {
  const fields = ["platforms", "scripting_backends", "execution_kinds", "loaders", "contracts", "limits"];
  return exactKeys(value, fields) && validUniqueArray(value.platforms, (platform) => nonEmpty(platform, 64))
    && validUniqueArray(value.scripting_backends, (backend) => ["mono", "il2cpp"].includes(backend))
    && validUniqueArray(value.execution_kinds, (kind) => EXECUTION_KINDS.has(kind), true)
    && validUniqueArray(value.loaders, (loader) => TAG.test(loader))
    && validUniqueArray(value.contracts, (contract) => CONTRACT.test(contract))
    && exactKeys(value.limits, ["artifact_bytes", "actors"].filter((key) => key in (value.limits || {})))
    && (value.limits.artifact_bytes === undefined || nonNegativeInteger(value.limits.artifact_bytes))
    && (value.limits.actors === undefined || positiveInteger(value.limits.actors));
}

async function validGlbAssemblyManifest(value) {
  const fields = ["schema_version", "profile", "assembly_id", "revision", "assembled_at", "coordinate_convention", "runtime_target", "root_slot_id", "fragments", "attachments", "missing_slots", "fallback_provenance", "rejection_reasons", "manifest_sha256"];
  if (!exactKeys(value, fields) || value.schema_version !== "1" || value.profile !== "glb.assembly.v1"
    || !validId(value.assembly_id) || !positiveInteger(value.revision) || !validTimestamp(value.assembled_at) || !validCoordinateConvention(value.coordinate_convention)
    || !validRuntimeTarget(value.runtime_target) || !validId(value.root_slot_id)
    || !Array.isArray(value.fragments) || !value.fragments.length || !value.fragments.every(validGlbAssemblyFragment)
    || !Array.isArray(value.attachments) || !value.attachments.every(validAssemblyAttachment)
    || !Array.isArray(value.missing_slots) || !value.missing_slots.every((slot) => exactKeys(slot, ["slot_id", "reason"]) && validId(slot.slot_id) && nonEmpty(slot.reason, 512))
    || !exactKeys(value.fallback_provenance, ["used_fallback", "slot_ids"]) || typeof value.fallback_provenance.used_fallback !== "boolean" || !validUniqueArray(value.fallback_provenance.slot_ids, validId)
    || !Array.isArray(value.rejection_reasons) || !value.rejection_reasons.every((rejection) => exactKeys(rejection, ["fragment_id", "reasons"]) && validId(rejection.fragment_id) && Array.isArray(rejection.reasons) && rejection.reasons.length && rejection.reasons.every((reason) => nonEmpty(reason, 512)))
    || !SHA256.test(value.manifest_sha256 || "")) return false;
  const withoutHash = { ...value };
  delete withoutHash.manifest_sha256;
  return value.manifest_sha256 === await canonicalSha256(withoutHash);
}

function validCoordinateConvention(value) { return exactKeys(value, ["handedness", "up_axis", "unit", "transforms"]) && value.handedness === "right" && value.up_axis === "y" && value.unit === "meter" && value.transforms === "parent-relative"; }
function validRuntimeTarget(value) { return exactKeys(value, ["loader", "target"]) && validImplementation(value.loader) && exactKeys(value.target, ["platform", "render_pipeline"]) && nonEmpty(value.target.platform, 64) && validImplementation(value.target.render_pipeline); }
function validImplementation(value) { return exactKeys(value, ["id", "version"]) && TAG.test(value.id || "") && nonEmpty(value.version, 128); }
function validGlbAssemblyFragment(value) { return exactKeys(value, ["slot_id", "fragment_id", "revision", "selected_as", "runtime_artifact", "runtime_linkage_sha256", "material_slots", "markers", "motion_binding", "provenance"]) && validId(value.slot_id) && validId(value.fragment_id) && positiveInteger(value.revision) && ["primary", "fallback"].includes(value.selected_as) && validHashAddressedGlbArtifact(value.runtime_artifact) && SHA256.test(value.runtime_linkage_sha256 || "") && Array.isArray(value.material_slots) && Array.isArray(value.markers) && isObject(value.motion_binding) && isObject(value.provenance); }
function validHashAddressedGlbArtifact(value) { return exactKeys(value, ["uri", "sha256", "media_type", "byte_length"]) && SHA256.test(value.sha256 || "") && value.uri === `sha256:${value.sha256}` && value.media_type === "model/gltf-binary" && nonNegativeInteger(value.byte_length); }
function validAssemblyAttachment(value) { return exactKeys(value, ["attachment_id", "parent_slot_id", "parent_fragment_id", "parent_socket_id", "child_slot_id", "child_fragment_id", "child_socket_id", "socket_kind"]) && ["attachment_id", "parent_slot_id", "parent_fragment_id", "parent_socket_id", "child_slot_id", "child_fragment_id", "child_socket_id"].every((key) => validId(value[key])) && TAG.test(value.socket_kind || ""); }

function validAcceptance(value) {
  return exactKeys(value, ["decision_id", "policy_id", "accepted_at"])
    && validId(value?.decision_id) && CONTRACT.test(value.policy_id || "") && validTimestamp(value.accepted_at);
}

function compatible(requirements, host) {
  return (!requirements.platforms.length || requirements.platforms.includes(host.platform))
    && (!requirements.scripting_backends.length || requirements.scripting_backends.includes(host.scripting_backend))
    && requirements.execution_kinds.every((kind) => host.execution_kinds.includes(kind))
    && requirements.loaders.every((loader) => host.loaders.includes(loader))
    && requirements.contracts.every((contract) => host.contracts.includes(contract))
    && (requirements.limits.artifact_bytes === undefined || (host.limits.artifact_bytes !== undefined && requirements.limits.artifact_bytes <= host.limits.artifact_bytes))
    && (requirements.limits.actors === undefined || (host.limits.actors !== undefined && requirements.limits.actors <= host.limits.actors));
}

function sameArtifact(left, right) { return artifactIdentity(left) === artifactIdentity(right); }
function artifactIdentity(value) { return `${value.uri}\n${value.sha256}\n${value.media_type}\n${value.byte_length ?? ""}`; }
function validId(value) { return typeof value === "string" && ID.test(value); }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function positiveInteger(value) { return Number.isInteger(value) && value >= 1; }
function nonNegativeInteger(value) { return Number.isInteger(value) && value >= 0; }
function nonEmpty(value, maximum = Infinity) { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function validTimestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)); }
function exactKeys(value, expected) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => expected.includes(key)) && expected.every((key) => key in value); }
function validUniqueArray(value, predicate, required = false) { return Array.isArray(value) && (!required || value.length > 0) && value.every(predicate) && unique(value); }
function unique(values) { return new Set(values).size === values.length; }
export function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
async function ed25519Sign(value, privateKey) {
  try {
    const imported = await crypto.subtle.importKey("pkcs8", base64ToBytes(privateKey), { name: "Ed25519" }, false, ["sign"]);
    return base64Url(await crypto.subtle.sign({ name: "Ed25519" }, imported, new TextEncoder().encode(value)));
  } catch { return null; }
}
function base64ToBytes(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function base64Url(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function hex(buffer) { return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function frozenClone(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
