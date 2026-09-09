import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_RUNTIME_ARTIFACT_MEDIA_TYPES,
  artifactRelativePath,
  prepareAcceptedArtifactPublication,
  prepareRuntimeArtifactPublication,
  runtimeArtifactRelativePath,
  validPublicationReceipt,
  validRuntimePublicationReceipt,
} from "./artifact-publication.js";
import { acceptedAssemblyReceipt, acceptedCatalogRevision, canonicalSha256, compatibleFrozenPackage } from "./package-discovery.js";

const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_KINDS = new Set(["catalog", "package", "assembly"]);

/** A mounted-volume adapter: immutable bytes and their receipts survive restarts. */
export function createRailwayArtifactStore({ rootPath, publicOrigin, clock = () => new Date().toISOString(), runtimeArtifactMediaTypes = DEFAULT_RUNTIME_ARTIFACT_MEDIA_TYPES } = {}) {
  const root = resolveRequiredPath(rootPath, "rootPath");
  const origin = requireHttpsOrigin(publicOrigin);
  const allowedRuntimeArtifactMediaTypes = validatedMediaTypes(runtimeArtifactMediaTypes);
  return {
    async publish(value) {
      const prepared = await prepareAcceptedArtifactPublication({ value, publicOrigin: origin, publishedAt: clock() });
      if (!prepared) return { status: 400, value: { error: "invalid_accepted_artifact_publication" } };
      const receiptPath = within(root, `receipts/publications/${prepared.receipt.publication_id}.json`);
      const prior = await readJson(receiptPath);
      if (prior) {
        const receipt = await validPublicationReceipt(prior);
        if (!receipt) return { status: 500, value: { error: "corrupt_artifact_publication_receipt" } };
        return receipt.publication_request_sha256 === prepared.receipt.publication_request_sha256
          ? { status: 200, value: receipt }
          : { status: 409, value: { error: "publication_id_reused_with_different_request" } };
      }
      const artifactPath = within(root, artifactRelativePath(prepared.receipt.artifact.sha256));
      const write = await writeImmutable(artifactPath, prepared.bytes, prepared.receipt.artifact.sha256);
      if (!write) return { status: 409, value: { error: "artifact_digest_collision" } };
      const stored = await writeJsonImmutable(receiptPath, prepared.receipt);
      if (!stored) {
        const replay = await readJson(receiptPath);
        const receipt = await validPublicationReceipt(replay);
        return receipt?.publication_request_sha256 === prepared.receipt.publication_request_sha256
          ? { status: 200, value: receipt }
          : { status: 409, value: { error: "publication_id_reused_with_different_request" } };
      }
      return { status: 201, value: prepared.receipt };
    },

    async publishRuntimeArtifact(value) {
      const prepared = await prepareRuntimeArtifactPublication({
        value, publicOrigin: origin, publishedAt: clock(), allowedMediaTypes: allowedRuntimeArtifactMediaTypes,
      });
      if (!prepared) return { status: 400, value: { error: "invalid_runtime_artifact_publication" } };
      const receiptPath = within(root, `receipts/runtime-publications/${prepared.receipt.publication_id}.json`);
      const prior = await readJson(receiptPath);
      if (prior) {
        const receipt = await validRuntimePublicationReceipt(prior, allowedRuntimeArtifactMediaTypes);
        if (!receipt) return { status: 500, value: { error: "corrupt_runtime_artifact_publication_receipt" } };
        return receipt.publication_request_sha256 === prepared.receipt.publication_request_sha256
          ? { status: 200, value: receipt }
          : { status: 409, value: { error: "publication_id_reused_with_different_request" } };
      }
      const artifactPath = within(root, runtimeArtifactRelativePath(prepared.receipt.artifact.sha256, prepared.extension));
      const write = await writeImmutable(artifactPath, prepared.bytes, prepared.receipt.artifact.sha256);
      if (!write) return { status: 409, value: { error: "artifact_digest_collision" } };
      const index = { publication_id: prepared.receipt.publication_id, publication_sha256: prepared.receipt.publication_sha256, artifact: prepared.receipt.artifact };
      const digestIndexPath = within(root, `receipts/runtime-artifact-digests/${prepared.receipt.artifact.sha256}.json`);
      const indexedDigest = await writeJsonImmutable(digestIndexPath, { extension: prepared.extension, ...index });
      if (!indexedDigest && !sameRuntimeArtifactIndex(await readJson(digestIndexPath), { extension: prepared.extension, ...index })) {
        return { status: 409, value: { error: "runtime_artifact_digest_reused_with_different_metadata" } };
      }
      const indexPath = within(root, `receipts/runtime-artifact-paths/${prepared.receipt.artifact.sha256}.${prepared.extension}.json`);
      const pathIndex = { extension: prepared.extension, ...index };
      const indexed = await writeJsonImmutable(indexPath, pathIndex);
      if (!indexed && !sameRuntimeArtifactIndex(await readJson(indexPath), pathIndex)) {
        return { status: 409, value: { error: "runtime_artifact_path_reused_with_different_metadata" } };
      }
      const stored = await writeJsonImmutable(receiptPath, prepared.receipt);
      if (!stored) {
        const replay = await readJson(receiptPath);
        const receipt = await validRuntimePublicationReceipt(replay, allowedRuntimeArtifactMediaTypes);
        return receipt?.publication_request_sha256 === prepared.receipt.publication_request_sha256
          ? { status: 200, value: receipt }
          : { status: 409, value: { error: "publication_id_reused_with_different_request" } };
      }
      return { status: 201, value: prepared.receipt };
    },

    async readArtifact(digest) {
      if (!SHA256.test(digest || "")) return null;
      try {
        const bytes = await readFile(within(root, artifactRelativePath(digest)));
        return bytes.byteLength && sha256(bytes) === digest ? bytes : null;
      } catch { return null; }
    },

    async readRuntimeArtifact(digest, extension) {
      if (!SHA256.test(digest || "") || !/^[a-z0-9]{1,16}$/.test(extension || "")) return null;
      const indexPath = within(root, `receipts/runtime-artifact-paths/${digest}.${extension}.json`);
      const index = await readJson(indexPath);
      if (!validRuntimeArtifactIndex(index, digest, extension, allowedRuntimeArtifactMediaTypes)) return null;
      const receipt = await validRuntimePublicationReceipt(await readJson(within(root, `receipts/runtime-publications/${index.publication_id}.json`)), allowedRuntimeArtifactMediaTypes);
      if (!receipt || receipt.publication_sha256 !== index.publication_sha256 || !sameRuntimeArtifact(receipt.artifact, index.artifact)) return null;
      try {
        const bytes = await readFile(within(root, runtimeArtifactRelativePath(digest, extension)));
        return bytes.byteLength === index.artifact.byte_length && sha256(bytes) === digest ? { bytes, mediaType: index.artifact.media_type } : null;
      } catch { return null; }
    },

    async recordReceipt(kind, payload) {
      if (!RECEIPT_KINDS.has(kind)) return { status: 404, value: { error: "receipt_kind_not_found" } };
      const accepted = await validateReceipt(kind, payload);
      if (!accepted) return { status: 400, value: { error: "invalid_immutable_receipt" } };
      const id = receiptId(kind, accepted);
      const path = within(root, `receipts/${kind}/${id}.json`);
      const stored = await writeJsonImmutable(path, accepted);
      if (stored) return { status: 201, value: accepted };
      const prior = await readJson(path);
      return canonicalReceiptEquals(prior, accepted)
        ? { status: 200, value: prior }
        : { status: 409, value: { error: "receipt_id_reused_with_different_payload" } };
    },

    async publishBundle(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "assembly_receipt,catalog_revision,discovery_request,host_capabilities,package,publication,schema_version"
        || value.schema_version !== "1") return { status: 400, value: { error: "invalid_artifact_publication_bundle" } };
      const published = await this.publish(value.publication);
      if (published.status >= 400) return published;
      const catalog = await acceptedCatalogRevision(value.catalog_revision);
      const assembly = await acceptedAssemblyReceipt(value.assembly_receipt);
      const packageReceipt = await validateReceipt("package", value.package);
      if (!catalog || !assembly || !packageReceipt
        || !(await compatibleFrozenPackage({ packageRecord: value.package, catalogRevision: catalog, assemblyReceipt: assembly, hostCapabilities: value.host_capabilities }))) {
        return { status: 400, value: { error: "publication_bundle_receipt_mismatch" } };
      }
      const artifact = published.value.artifact;
      if (!catalog.modules.some((module) => sameArtifact(module.artifact, artifact))
        || !assembly.selected_modules.some((module) => sameArtifact(module.artifact, artifact))) {
        return { status: 409, value: { error: "publication_artifact_not_selected" } };
      }
      for (const [kind, payload] of [["catalog", catalog], ["package", packageReceipt], ["assembly", assembly]]) {
        const recorded = await this.recordReceipt(kind, payload);
        if (recorded.status >= 400) return recorded;
      }
      return { status: published.status, value: { schema_version: "1", publication: published.value, catalog_revision: catalog, package: packageReceipt, assembly_receipt: assembly, discovery_request: structuredClone(value.discovery_request) } };
    },

    async publishRuntimeBundle(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "assembly_receipt,catalog_revision,discovery_request,host_capabilities,package,publication,schema_version"
        || value.schema_version !== "2") return { status: 400, value: { error: "invalid_runtime_artifact_publication_bundle" } };
      const published = await this.publishRuntimeArtifact(value.publication);
      if (published.status >= 400) return published;
      const catalog = await acceptedCatalogRevision(value.catalog_revision);
      const assembly = await acceptedAssemblyReceipt(value.assembly_receipt);
      const packageReceipt = await validateReceipt("package", value.package);
      if (!catalog || catalog.schema_version !== "2" || !assembly || assembly.schema_version !== "2" || !packageReceipt
        || !(await compatibleFrozenPackage({ packageRecord: value.package, catalogRevision: catalog, assemblyReceipt: assembly, hostCapabilities: value.host_capabilities }))) {
        return { status: 400, value: { error: "runtime_publication_bundle_receipt_mismatch" } };
      }
      const artifact = published.value.artifact;
      if (!runtimeArtifactSelected(catalog.modules, artifact) || !runtimeArtifactSelected(assembly.selected_modules, artifact)) {
        return { status: 409, value: { error: "runtime_publication_artifact_not_selected" } };
      }
      for (const [kind, payload] of [["catalog", catalog], ["package", packageReceipt], ["assembly", assembly]]) {
        const recorded = await this.recordReceipt(kind, payload);
        if (recorded.status >= 400) return recorded;
      }
      return { status: published.status, value: { schema_version: "2", publication: published.value, catalog_revision: catalog, package: packageReceipt, assembly_receipt: assembly, discovery_request: structuredClone(value.discovery_request) } };
    },
  };
}

export function createRailwayArtifactHandler({ store, publicationToken, coordinator } = {}) {
  if (!store || typeof store.publish !== "function" || typeof store.publishRuntimeArtifact !== "function" || typeof store.publishBundle !== "function" || typeof store.publishRuntimeBundle !== "function" || typeof store.readArtifact !== "function" || typeof store.readRuntimeArtifact !== "function" || typeof store.recordReceipt !== "function") throw new TypeError("artifact handler needs an artifact store");
  if (!publicationToken || typeof publicationToken !== "string") throw new TypeError("artifact handler needs a publication token");
  return async function handle(request) {
    const url = new URL(request.url);
    const artifact = url.pathname.match(/^\/v1\/artifacts\/([a-f0-9]{64})$/);
    if (artifact && request.method === "GET") {
      const bytes = await store.readArtifact(artifact[1]);
      return bytes ? binaryResponse(bytes, artifact[1]) : jsonResponse({ error: "artifact_not_found" }, 404);
    }
    const runtimeArtifact = url.pathname.match(/^\/v2\/artifacts\/([a-f0-9]{64})\.([a-z0-9]{1,16})$/);
    if (runtimeArtifact && request.method === "GET") {
      const stored = await store.readRuntimeArtifact(runtimeArtifact[1], runtimeArtifact[2]);
      return stored ? binaryResponse(stored.bytes, runtimeArtifact[1], stored.mediaType) : jsonResponse({ error: "artifact_not_found" }, 404);
    }
    if (request.headers.get("authorization") !== `Bearer ${publicationToken}`) return jsonResponse({ error: "unauthorized" }, 401);
    if (request.method === "POST" && url.pathname === "/v1/artifact-publications") {
      return resultResponse(await store.publish(await jsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/v2/artifact-publications") {
      return resultResponse(await store.publishRuntimeArtifact(await jsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/encounter-artifact-publications") {
      if (!coordinator || typeof coordinator.freezeAndDiscover !== "function") return jsonResponse({ error: "coordinator_publication_unavailable" }, 503);
      const bundle = await store.publishBundle(await jsonBody(request));
      if (bundle.status >= 400) return resultResponse(bundle);
      try {
        const discovery = await coordinator.freezeAndDiscover(bundle.value);
        return jsonResponse({ ...bundle.value, discovery }, bundle.status);
      } catch { return jsonResponse({ error: "coordinator_package_discovery_failed" }, 502); }
    }
    if (request.method === "POST" && url.pathname === "/v2/encounter-artifact-publications") {
      if (!coordinator || typeof coordinator.freezeAndDiscover !== "function") return jsonResponse({ error: "coordinator_publication_unavailable" }, 503);
      const bundle = await store.publishRuntimeBundle(await jsonBody(request));
      if (bundle.status >= 400) return resultResponse(bundle);
      try { return jsonResponse({ ...bundle.value, discovery: await coordinator.freezeAndDiscover(bundle.value) }, bundle.status); }
      catch { return jsonResponse({ error: "coordinator_package_discovery_failed" }, 502); }
    }
    const receipt = url.pathname.match(/^\/v1\/artifact-receipts\/(catalog|package|assembly)$/);
    if (receipt && request.method === "POST") return resultResponse(await store.recordReceipt(receipt[1], await jsonBody(request)));
    return jsonResponse({ error: "not_found" }, 404);
  };
}

export function createCoordinatorArtifactPublicationClient({ coordinatorUrl, ingressToken, catalogAcceptanceToken, fetcher = fetch } = {}) {
  if (!coordinatorUrl || !ingressToken || !catalogAcceptanceToken) throw new TypeError("coordinatorUrl, ingressToken, and catalogAcceptanceToken are required");
  const base = coordinatorUrl.replace(/\/$/, "");
  return {
    async freezeAndDiscover(bundle) {
      const encounterId = bundle.catalog_revision.encounter_id;
      const headers = { authorization: `Bearer ${ingressToken}`, "content-type": "application/json" };
      await expectOk(await fetcher(`${base}/v1/encounters/${encounterId}/catalog-revisions`, {
        method: "POST", headers: { ...headers, "x-catalog-acceptance-token": catalogAcceptanceToken }, body: JSON.stringify({ catalog_revision: bundle.catalog_revision }),
      }));
      await expectOk(await fetcher(`${base}/v1/encounters/${encounterId}/freeze`, {
        method: "POST", headers, body: JSON.stringify({ package: bundle.package, catalog_revision_id: bundle.catalog_revision.catalog_revision_id, assembly_receipt: bundle.assembly_receipt, host_capabilities: bundle.discovery_request.host_capabilities }),
      }));
      return expectOk(await fetcher(`${base}/v1/encounters/${encounterId}/package-discoveries`, { method: "POST", headers, body: JSON.stringify(bundle.discovery_request) }));
    },
  };
}

async function validateReceipt(kind, payload) {
  if (kind === "catalog") return acceptedCatalogRevision(payload);
  if (kind === "assembly") return acceptedAssemblyReceipt(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !SHA256.test(payload.manifest_sha256 || "")
    || typeof payload.package_id !== "string" || typeof payload.encounter_id !== "string" || !Number.isInteger(payload.revision)) return null;
  const unsigned = structuredClone(payload);
  delete unsigned.manifest_sha256;
  return payload.manifest_sha256 === await canonicalSha256(unsigned) ? structuredClone(payload) : null;
}

function receiptId(kind, value) {
  if (kind === "catalog") return value.catalog_revision_id;
  if (kind === "assembly") return value.receipt_id;
  return `${value.package_id}-${value.revision}-${value.manifest_sha256}`;
}

async function writeImmutable(path, bytes, expectedDigest) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: "wx" }); return true; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try { const existing = await readFile(path); return existing.byteLength === bytes.byteLength && sha256(existing) === expectedDigest; } catch { return false; }
  }
}

async function writeJsonImmutable(path, value) {
  if (await readJson(path)) return false;
  const bytes = Buffer.from(JSON.stringify(value));
  return writeImmutable(path, bytes, sha256(bytes));
}
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
function canonicalReceiptEquals(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sameArtifact(left, right) { return left?.uri === right?.uri && left?.sha256 === right?.sha256 && left?.media_type === right?.media_type && left?.byte_length === right?.byte_length; }
function sameRuntimeArtifact(left, right) { return sameArtifact(left, right) && left?.module_id === right?.module_id && left?.revision === right?.revision && JSON.stringify(left?.compatibility) === JSON.stringify(right?.compatibility); }
function runtimeArtifactSelected(modules, artifact) { return modules.some((module) => module.module_id === artifact.module_id && module.revision === artifact.revision && module.runtime_artifacts?.some((candidate) => sameRuntimeArtifactContent(candidate, artifact))); }
function sameRuntimeArtifactContent(left, right) { return left?.sha256 === right?.sha256 && left?.media_type === right?.media_type && left?.byte_length === right?.byte_length && JSON.stringify(left?.compatibility) === JSON.stringify(right?.compatibility); }
async function expectOk(response) { if (!response?.ok) throw new Error("coordinator request failed"); return response.json(); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function resolveRequiredPath(value, name) { if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`); return resolve(value); }
function requireHttpsOrigin(value) { const url = new URL(value); if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new TypeError("publicOrigin must be an HTTPS origin"); return url.href; }
function within(root, relative) { const path = resolve(root, relative); if (!path.startsWith(`${root}/`)) throw new TypeError("artifact path escapes mounted volume"); return path; }
async function jsonBody(request) { try { return await request.json(); } catch { return null; } }
function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function resultResponse(result) { return jsonResponse(result.value, result.status); }
function binaryResponse(bytes, digest, mediaType = "model/gltf-binary") { return new Response(bytes, { headers: { "content-type": mediaType, "content-length": String(bytes.byteLength), "digest": `sha-256=${digest}`, "cache-control": "public, immutable, max-age=31536000", "x-content-type-options": "nosniff" } }); }
function validatedMediaTypes(value) {
  if (!(value instanceof Set) || !value.size || [...value].some((mediaType) => typeof mediaType !== "string" || !mediaType || mediaType.length > 128)) throw new TypeError("runtimeArtifactMediaTypes must be a non-empty Set of media types");
  return new Set(value);
}
function sameRuntimeArtifactIndex(left, right) { return left?.extension === right?.extension && left?.publication_id === right?.publication_id && left?.publication_sha256 === right?.publication_sha256 && sameRuntimeArtifact(left?.artifact, right?.artifact); }
function validRuntimeArtifactIndex(value, digest, extension, allowedMediaTypes) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "artifact,extension,publication_id,publication_sha256"
    || value.extension !== extension
    || typeof value.publication_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.publication_id)
    || !SHA256.test(value.publication_sha256 || "")) return false;
  const artifact = value.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
    || Object.keys(artifact).sort().join(",") !== "byte_length,compatibility,media_type,module_id,revision,sha256,uri"
    || typeof artifact.module_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(artifact.module_id)
    || !Number.isInteger(artifact.revision) || artifact.revision < 1
    || artifact.sha256 !== digest || !allowedMediaTypes.has(artifact.media_type)
    || !Number.isInteger(artifact.byte_length) || artifact.byte_length < 0
    || !artifact.compatibility || typeof artifact.compatibility !== "object" || Array.isArray(artifact.compatibility)
    || Object.keys(artifact.compatibility).sort().join(",") !== "builds,loaders,platforms") return false;
  try {
    const url = new URL(artifact.uri);
    return url.protocol === "https:" && url.pathname === `/v2/artifacts/${digest}.${extension}`;
  } catch { return false; }
}
