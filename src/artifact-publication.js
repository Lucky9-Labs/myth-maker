import { ingestGlbRuntimeCandidate } from "./glb-runtime-candidate-ingress.js";
import { canonicalSha256 } from "./package-discovery.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GLB_MEDIA_TYPE = "model/gltf-binary";
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const OPAQUE_EXTENSION = /^[a-z0-9]{1,16}$/;
const SCRIPTING_BACKENDS = new Set(["mono", "il2cpp"]);
export const DEFAULT_RUNTIME_ARTIFACT_MEDIA_TYPES = new Set([GLB_MEDIA_TYPE, "application/vnd.unity.assetbundle"]);

/**
 * Validate the already-accepted generic runtime candidate before a storage
 * adapter writes it. This module has no provider URL or local-bootstrap path.
 */
export async function prepareAcceptedArtifactPublication({ value, publicOrigin, publishedAt }) {
  const candidate = await acceptedCandidate(value);
  const origin = httpsOrigin(publicOrigin);
  const bytes = decodeBase64(value?.artifact_bytes_base64);
  if (!candidate || !origin || !bytes || !validTimestamp(publishedAt)
    || bytes.byteLength !== candidate.module.artifact.byte_length
    || candidate.module.artifact.sha256 !== await sha256(bytes)) return null;
  const artifact = {
    uri: new URL(`/v1/artifacts/${candidate.module.artifact.sha256}`, origin).href,
    sha256: candidate.module.artifact.sha256,
    media_type: GLB_MEDIA_TYPE,
    byte_length: bytes.byteLength,
  };
  const unsigned = {
    schema_version: "1",
    publication_id: value.publication_id,
    artifact,
    source_artifact_uri: candidate.module.artifact.uri,
    candidate_linkage_sha256: candidate.linkage_sha256,
    publication_request_sha256: await canonicalSha256(value),
    published_at: publishedAt,
  };
  return { bytes, receipt: { ...unsigned, publication_sha256: await canonicalSha256(unsigned) } };
}

/**
 * The v2 publication seam is intentionally format-neutral: it persists the
 * supplied bytes unchanged and binds them to a declared, host-selectable
 * runtime representation. The caller may choose only configured media types.
 */
export async function prepareRuntimeArtifactPublication({ value, publicOrigin, publishedAt, allowedMediaTypes = DEFAULT_RUNTIME_ARTIFACT_MEDIA_TYPES }) {
  const origin = httpsOrigin(publicOrigin);
  const candidate = acceptedRuntimeArtifact(value, allowedMediaTypes);
  const bytes = decodeBase64(value?.artifact_bytes_base64);
  if (!origin || !candidate || !bytes || !validTimestamp(publishedAt)
    || bytes.byteLength !== candidate.byte_length || candidate.sha256 !== await sha256(bytes)) return null;
  const artifact = {
    module_id: candidate.module_id,
    revision: candidate.revision,
    uri: new URL(`/v2/artifacts/${candidate.sha256}.${value.extension}`, origin).href,
    sha256: candidate.sha256,
    media_type: candidate.media_type,
    byte_length: candidate.byte_length,
    compatibility: structuredClone(candidate.compatibility),
  };
  const unsigned = {
    schema_version: "2",
    publication_id: value.publication_id,
    artifact,
    source_artifact_uri: candidate.source_artifact_uri,
    host_compatibility: structuredClone(value.host_compatibility),
    publication_request_sha256: await canonicalSha256(value),
    published_at: publishedAt,
  };
  return { bytes, extension: value.extension, receipt: { ...unsigned, publication_sha256: await canonicalSha256(unsigned) } };
}

export async function validPublicationReceipt(value) {
  const fields = ["schema_version", "publication_id", "artifact", "source_artifact_uri", "candidate_linkage_sha256", "publication_request_sha256", "published_at", "publication_sha256"];
  if (!exactKeys(value, fields) || value.schema_version !== "1" || !ID.test(value.publication_id || "")
    || !validPublishedArtifact(value.artifact) || value.source_artifact_uri !== `sha256:${value.artifact.sha256}`
    || !SHA256.test(value.candidate_linkage_sha256 || "") || !SHA256.test(value.publication_request_sha256 || "")
    || !validTimestamp(value.published_at) || !SHA256.test(value.publication_sha256 || "")) return null;
  const unsigned = { ...value };
  delete unsigned.publication_sha256;
  return value.publication_sha256 === await canonicalSha256(unsigned) ? structuredClone(value) : null;
}

export async function validRuntimePublicationReceipt(value, allowedMediaTypes = DEFAULT_RUNTIME_ARTIFACT_MEDIA_TYPES) {
  const fields = ["schema_version", "publication_id", "artifact", "source_artifact_uri", "host_compatibility", "publication_request_sha256", "published_at", "publication_sha256"];
  if (!exactKeys(value, fields) || value.schema_version !== "2" || !ID.test(value.publication_id || "")
    || !validRuntimePublishedArtifact(value.artifact, allowedMediaTypes) || value.source_artifact_uri !== `sha256:${value.artifact.sha256}`
    || !validHostCompatibility(value.host_compatibility) || !runtimeArtifactContainsTarget(value.artifact.compatibility, value.host_compatibility)
    || !SHA256.test(value.publication_request_sha256 || "") || !validTimestamp(value.published_at) || !SHA256.test(value.publication_sha256 || "")) return null;
  const unsigned = { ...value };
  delete unsigned.publication_sha256;
  return value.publication_sha256 === await canonicalSha256(unsigned) ? structuredClone(value) : null;
}

export function artifactRelativePath(digest) { return `sha256/${digest}.glb`; }
export function runtimeArtifactRelativePath(digest, extension) { return `runtime/sha256/${digest}.${extension}`; }

async function acceptedCandidate(value) {
  if (!exactKeys(value, ["schema_version", "publication_id", "idempotency_key", "accepted_candidate", "artifact_bytes_base64"])
    || value.schema_version !== "1" || !ID.test(value.publication_id || "") || !IDEMPOTENCY_KEY.test(value.idempotency_key || "")
    || !value.accepted_candidate || !exactKeys(value.accepted_candidate, ["module", "loader_profile"])) return null;
  try {
    const candidate = ingestGlbRuntimeCandidate({ module: value.accepted_candidate.module, loaderProfile: value.accepted_candidate.loader_profile });
    return candidate.module.artifact.uri === `sha256:${candidate.module.artifact.sha256}` ? candidate : null;
  } catch { return null; }
}

function validPublishedArtifact(value) {
  if (!exactKeys(value, ["uri", "sha256", "media_type", "byte_length"])
    || !SHA256.test(value?.sha256 || "") || value.media_type !== GLB_MEDIA_TYPE
    || !Number.isInteger(value.byte_length) || value.byte_length < 0) return false;
  try {
    const url = new URL(value.uri);
    return url.protocol === "https:" && url.pathname === `/v1/artifacts/${value.sha256}`;
  } catch { return false; }
}

function acceptedRuntimeArtifact(value, allowedMediaTypes) {
  if (!exactKeys(value, ["schema_version", "publication_id", "idempotency_key", "runtime_artifact", "host_compatibility", "extension", "artifact_bytes_base64"])
    || value.schema_version !== "2" || !ID.test(value.publication_id || "") || !IDEMPOTENCY_KEY.test(value.idempotency_key || "")
    || !OPAQUE_EXTENSION.test(value.extension || "") || !validHostCompatibility(value.host_compatibility)
    || !validRuntimeCandidate(value.runtime_artifact, allowedMediaTypes)
    || !runtimeArtifactContainsTarget(value.runtime_artifact.compatibility, value.host_compatibility)) return null;
  return value.runtime_artifact;
}

function validRuntimeCandidate(value, allowedMediaTypes) {
  return exactKeys(value, ["module_id", "revision", "source_artifact_uri", "sha256", "media_type", "byte_length", "compatibility"])
    && ID.test(value.module_id || "") && Number.isInteger(value.revision) && value.revision >= 1
    && SHA256.test(value.sha256 || "") && value.source_artifact_uri === `sha256:${value.sha256}`
    && allowedMediaTypes instanceof Set && allowedMediaTypes.has(value.media_type)
    && Number.isInteger(value.byte_length) && value.byte_length >= 0 && validRuntimeCompatibility(value.compatibility);
}

function validRuntimePublishedArtifact(value, allowedMediaTypes) {
  if (!exactKeys(value, ["module_id", "revision", "uri", "sha256", "media_type", "byte_length", "compatibility"])
    || !ID.test(value?.module_id || "") || !Number.isInteger(value.revision) || value.revision < 1
    || !SHA256.test(value?.sha256 || "") || !(allowedMediaTypes instanceof Set) || !allowedMediaTypes.has(value.media_type)
    || !Number.isInteger(value.byte_length) || value.byte_length < 0 || !validRuntimeCompatibility(value.compatibility)) return false;
  try {
    const url = new URL(value.uri);
    const match = url.pathname.match(/^\/v2\/artifacts\/([a-f0-9]{64})\.([a-z0-9]{1,16})$/);
    return url.protocol === "https:" && Boolean(match) && match[1] === value.sha256;
  } catch { return false; }
}

function validRuntimeCompatibility(value) {
  return exactKeys(value, ["platforms", "builds", "loaders"])
    && validStringList(value.platforms, 64) && validStringList(value.builds, 128)
    && Array.isArray(value.loaders) && value.loaders.length > 0 && value.loaders.every((loader) => TAG.test(loader || "")) && new Set(value.loaders).size === value.loaders.length;
}

function validHostCompatibility(value) {
  return exactKeys(value, ["platform", "engine_build", "scripting_backend", "loader"])
    && validString(value.platform, 64) && validString(value.engine_build, 128)
    && SCRIPTING_BACKENDS.has(value.scripting_backend) && TAG.test(value.loader || "");
}

function runtimeArtifactContainsTarget(compatibility, target) {
  return compatibility.platforms.includes(target.platform) && compatibility.builds.includes(target.engine_build) && compatibility.loaders.includes(target.loader);
}

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

function decodeBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); } catch { return null; }
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validTimestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)); }
function exactKeys(value, expected) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => expected.includes(key)) && expected.every((key) => key in value); }
function validString(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function validStringList(value, maximum) { return Array.isArray(value) && value.length > 0 && value.every((item) => validString(item, maximum)) && new Set(value).size === value.length; }
