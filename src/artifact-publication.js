import { ingestGlbRuntimeCandidate } from "./glb-runtime-candidate-ingress.js";
import { canonicalSha256 } from "./package-discovery.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GLB_MEDIA_TYPE = "model/gltf-binary";

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

export function artifactRelativePath(digest) { return `sha256/${digest}.glb`; }

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
