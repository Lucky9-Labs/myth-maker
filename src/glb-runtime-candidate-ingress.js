import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;

/** Bind a checked glb.v1 sidecar to exactly one runtime module before assembly. */
export function ingestGlbRuntimeCandidate({ module, loaderProfile }) {
  validateProfile(loaderProfile);
  const moduleKeys = ["schema_version", "module_id", "revision", "execution_kind", "provides", "requires", "conflicts", "compatibility", "quality", "artifact", "entrypoint", "inline_recipe", "fallback_module_ids", "provenance"];
  if (!module || typeof module !== "object" || module.execution_kind !== "runtime_asset"
    || Object.keys(module).some((key) => !moduleKeys.includes(key))
    || !sameArray(module.fallback_module_ids, loaderProfile.fallback_module_ids)
    || !module.compatibility?.platforms?.includes(loaderProfile.target.platform)
    || module.compatibility?.bindings?.[loaderProfile.loader.id] !== loaderProfile.loader.version
    || module.compatibility?.bindings?.[loaderProfile.target.render_pipeline.id] !== loaderProfile.target.render_pipeline.version
    || !sameArtifact(module.artifact, loaderProfile.artifact)) {
    throw new TypeError("invalid runtime module or glb.v1 profile artifact linkage");
  }
  const linkage = createHash("sha256").update(JSON.stringify({
    module_id: module.module_id, artifact: module.artifact, loader_profile: loaderProfile,
  })).digest("hex");
  return deepFreeze({ module: structuredClone(module), loader_profile: structuredClone(loaderProfile), linkage_sha256: linkage });
}

function validateProfile(profile) {
  const keys = ["profile", "artifact", "byte_cap", "loader", "target", "material_allowlist", "extension_allowlist", "named_anchors", "bounds", "provenance", "fallback_module_ids"];
  if (!profile || typeof profile !== "object" || profile.profile !== "glb.v1" || !sameKeys(profile, keys)) throw new TypeError("invalid glb.v1 loader profile");
  const artifact = profile.artifact;
  if (!artifact || !sameKeys(artifact, ["uri", "sha256", "media_type", "byte_length"]) || artifact.media_type !== "model/gltf-binary" || !SHA256.test(artifact.sha256) || artifact.uri !== `sha256:${artifact.sha256}` || !Number.isInteger(artifact.byte_length) || artifact.byte_length < 0 || !Number.isInteger(profile.byte_cap) || profile.byte_cap < artifact.byte_length) throw new TypeError("invalid glb.v1 artifact");
  const p = profile.provenance;
  if (!p || !sameKeys(p, ["source_receipt", "acceptance", "converter", "converted_at"])) throw new TypeError("invalid glb.v1 provenance");
  const source = p.source_receipt;
  const acceptance = p.acceptance;
  if (!implementation(profile.loader) || !profile.target || !sameKeys(profile.target, ["platform", "render_pipeline"]) || !tag(profile.target.platform) || !implementation(profile.target.render_pipeline) || !stringList(profile.material_allowlist) || !stringList(profile.extension_allowlist) || !anchors(profile.named_anchors) || !bounds(profile.bounds) || !idList(profile.fallback_module_ids) || typeof p.converter !== "string" || !p.converter || !timestamp(p.converted_at)) throw new TypeError("invalid glb.v1 loader target");
  if (!source || !sameKeys(source, ["work_id", "worker_id", "created_at", "native_name", "artifact", "parent_module_ids"]) || !source.artifact || !sameKeys(source.artifact, ["uri", "sha256", "media_type", "byte_length"]) || source.artifact.media_type !== "application/x-blender" || !SHA256.test(source.artifact.sha256) || source.artifact.uri !== `sha256:${source.artifact.sha256}` || !Array.isArray(source.parent_module_ids)) throw new TypeError("invalid glb.v1 source receipt");
  if (!id(source.work_id) || !id(source.worker_id) || source.native_name !== `${source.work_id}.blend` || !timestamp(source.created_at) || !Number.isInteger(source.artifact.byte_length) || source.artifact.byte_length < 0 || !idList(source.parent_module_ids)) throw new TypeError("invalid glb.v1 source metadata");
  if (!acceptance || !sameKeys(acceptance, ["source_sha256", "output_sha256", "status", "actor_kind", "actor_id", "policy_id", "accepted_at", "evidence"]) || acceptance.status !== "accepted" || acceptance.actor_kind !== "automated_validator" || acceptance.actor_id !== "glb-importer-validator" || acceptance.policy_id !== "blender-export-v1" || acceptance.source_sha256 !== source.artifact.sha256 || acceptance.output_sha256 !== artifact.sha256 || !timestamp(acceptance.accepted_at) || !Array.isArray(acceptance.evidence) || acceptance.evidence.length !== 3 || acceptance.evidence.some((e) => !e || !sameKeys(e, ["evidence_id", "result"]) || !id(e.evidence_id) || e.result !== "passed") || new Set(acceptance.evidence.map((e) => e.evidence_id)).size !== 3 || !sameArray(acceptance.evidence.map((e) => e.evidence_id).sort(), ["glb-output-hash", "glb-structure", "source-hash"])) throw new TypeError("invalid or unbound glb.v1 acceptance");
}

function sameArtifact(a, b) { return !!a && !!b && a.uri === b.uri && a.sha256 === b.sha256 && a.media_type === b.media_type && a.byte_length === b.byte_length; }
function sameKeys(value, keys) { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function id(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value); }
function tag(value) { return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,95}$/.test(value); }
function timestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)); }
function implementation(value) { return value && sameKeys(value, ["id", "version"]) && tag(value.id) && typeof value.version === "string" && value.version.length > 0; }
function stringList(value) { return Array.isArray(value) && value.every((item) => typeof item === "string" && item) && new Set(value).size === value.length; }
function idList(value) { return Array.isArray(value) && value.every(id) && new Set(value).size === value.length; }
function sameArray(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]); }
function anchors(value) { return Array.isArray(value) && value.every((a) => a && sameKeys(a, ["name", "node"]) && typeof a.name === "string" && a.name && typeof a.node === "string" && a.node) && new Set(value.map((a) => a.name)).size === value.length; }
function bounds(value) { return value && sameKeys(value, ["minimum", "maximum"]) && [value.minimum, value.maximum].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) && value.minimum.every((v, i) => v <= value.maximum[i]); }
